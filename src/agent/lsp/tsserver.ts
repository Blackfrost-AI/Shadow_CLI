// tsserver flavor adapter (plan 3.1): the local node_modules TypeScript install speaks its
// NATIVE {seq, type, command, arguments} protocol — it is NOT JSON-RPC, so it gets this
// ~150-line seq-keyed mini peer instead of RpcPeer.
//
// Wire facts the adapter encodes (verified against typescript 5.9.3 — the E2E probe caught
// that the input direction is NOT framed, only the output is):
//   - STDIN is line-delimited JSON (one message per \n-terminated line); stdout is
//     Content-Length framed. Sending framed input makes tsserver JSON.parse each header
//     line as a message and answer `success:false` "unknown" forever.
//   - every request gets a `{type:'response', request_seq, success}` reply — we key a handshake
//     on `configure`, the cheapest always-answered command (start() then has a REAL readiness
//     check; a spawn failure or silent binary rejects instead of hanging).
//   - diagnostics arrive as EVENTS, not responses: `syntaxDiag` / `semanticDiag` / `suggestionDiag`
//     carry `{file, diagnostics:[{start:{line,offset}, text, code, category}]}` — lines/offsets
//     are 1-BASED (unlike LSP), and only 'error'/'warning' categories survive mapping.
//   - there is no didChange: re-`open` with the new content reloads the buffer, then `geterr`
//     {delay:0} pulls a fresh diagnostic round for that file.
// Supervision (spawn/kill/unref/dead-settles-waiters) mirrors client.ts deliberately.

import { spawn, type ChildProcess } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { scrubbedEnv } from '../../util/safeEnv.js';
import { LspDecoder } from './framing.js';
import { KILL_GRACE_MS, type LspDiagnostic } from './protocol.js';
import type { LspServerSpec } from './detect.js';
import { killTree, type ConnectionState, type CreateConnectionOptions, type ServerConnection } from './client.js';

/** tsserver commands we ever send. Everything else is the wider protocol, untouched. */
type Pending = { resolve: () => void; reject: (err: Error) => void };

function toUri(file: string): string {
  return file.startsWith('file:') ? file : pathToFileURL(file).href;
}

// tsserver categories: 'error' | 'warning' | 'suggestion' | 'message' — only the first two ride.
function mapDiags(uri: string, raw: unknown): LspDiagnostic[] {
  if (!Array.isArray(raw)) return [];
  const out: LspDiagnostic[] = [];
  for (const item of raw) {
    if (typeof item !== 'object' || item === null) continue;
    const d = item as {
      category?: unknown;
      text?: unknown;
      code?: unknown;
      start?: { line?: unknown; offset?: unknown };
    };
    if (typeof d.text !== 'string') continue;
    const severity = d.category === 'error' ? 'error' : d.category === 'warning' ? 'warning' : null;
    if (!severity) continue; // suggestion/message diagnostics are noise for a write hook
    out.push({
      uri,
      line: typeof d.start?.line === 'number' ? d.start.line : 1, // already 1-based
      col: typeof d.start?.offset === 'number' ? d.start.offset : 1,
      severity,
      message: d.text,
      ...(typeof d.code === 'string' || typeof d.code === 'number' ? { code: String(d.code) } : {}),
      source: 'ts',
    });
  }
  return out;
}

export function createTsserverConnection(spec: LspServerSpec, opts: CreateConnectionOptions): ServerConnection {
  let child: ChildProcess | null = null;
  let state: ConnectionState = 'idle';
  let epoch = 0;
  let startPromise: Promise<void> | null = null;
  let stderrTail = '';
  let seq = 1;
  const decoder = new LspDecoder();
  const pending = new Map<number, Pending>();
  /** Per-uri diagnostic slots for the CURRENT geterr round (cleared on every open). */
  const slots = new Map<string, { syntax?: LspDiagnostic[]; semantic?: LspDiagnostic[] }>();
  const waiters = new Map<string, Array<(d: LspDiagnostic[]) => void>>();

  const write = (text: string): void => {
    try {
      child?.stdin?.write(text);
    } catch {
      /* EPIPE after death — the exit handler cleans up */
    }
  };

  const send = (command: string, args: Record<string, unknown>): number => {
    const mySeq = seq++;
    // stdin wants ONE JSON message per line — never Content-Length framing (see header).
    write(JSON.stringify({ seq: mySeq, type: 'request', command, arguments: args }) + '\n');
    return mySeq;
  };

  const merged = (uri: string): LspDiagnostic[] | null => {
    const s = slots.get(uri);
    if (!s || !s.syntax || !s.semantic) return null;
    return [...s.syntax, ...s.semantic];
  };

  const settle = (uri: string): void => {
    const diags = merged(uri);
    if (diags === null) return;
    const list = waiters.get(uri);
    if (!list) return;
    waiters.delete(uri);
    for (const resolve of list) resolve(diags);
  };

  const markDead = (): void => {
    if (state === 'dead') return;
    state = 'dead';
    epoch++;
    for (const [, p] of pending) p.reject(new Error('tsserver connection closed'));
    pending.clear();
    for (const [, list] of waiters) for (const resolve of list) resolve([]);
    waiters.clear();
  };

  const onFrame = (jsonText: string): void => {
    let msg: unknown;
    try {
      msg = JSON.parse(jsonText);
    } catch {
      return; // a malformed body is dropped; framing resyncs at the byte layer
    }
    if (typeof msg !== 'object' || msg === null) return;
    const m = msg as { type?: unknown; request_seq?: unknown; event?: unknown; body?: unknown };
    if (m.type === 'response') {
      const p = typeof m.request_seq === 'number' ? pending.get(m.request_seq) : undefined;
      if (p) {
        pending.delete(m.request_seq as number);
        p.resolve(); // success/failure of configure is equally "the wire works"
      }
      return;
    }
    if (m.type !== 'event') return;
    if (m.event !== 'syntaxDiag' && m.event !== 'semanticDiag') return; // suggestionDiag dropped
    const body = (m.body ?? {}) as { file?: unknown; diagnostics?: unknown };
    if (typeof body.file !== 'string') return;
    const uri = toUri(body.file);
    const slot = slots.get(uri) ?? {};
    const diags = mapDiags(uri, body.diagnostics);
    if (m.event === 'syntaxDiag') slot.syntax = diags;
    else slot.semantic = diags;
    slots.set(uri, slot);
    settle(uri);
  };

  const spawnChild = (): void => {
    child = spawn(spec.command, spec.args, {
      cwd: opts.workspaceRoot,
      env: opts.env ?? scrubbedEnv(),
      stdio: ['pipe', 'pipe', 'pipe'],
      detached: process.platform !== 'win32', // own group → stop() reaches workers too
    });
    // A server is plumbing, not purpose: it must never keep the process alive.
    child.unref();
    for (const s of [child.stdout, child.stderr, child.stdin]) (s as { unref?: () => void } | null)?.unref?.();
    child.stdout?.on('data', (d: Buffer) => {
      for (const text of decoder.push(d)) onFrame(text);
    });
    child.stderr?.on('data', (d: Buffer) => {
      stderrTail = (stderrTail + d.toString()).slice(-2048);
    });
    child.on('error', () => markDead());
    child.on('exit', () => markDead());
    child.stdin?.on('error', () => markDead());
  };

  const openFile = (absPath: string, text: string): void => {
    if (state !== 'ready') return;
    const uri = toUri(absPath);
    slots.set(uri, {}); // fresh round: both slots must re-arrive before waiters settle
    send('open', { file: absPath, fileContent: text });
    send('geterr', { delay: 0, files: [absPath] });
  };

  const connection: ServerConnection = {
    start(deadlineMs, signal) {
      if (state === 'ready') return Promise.resolve();
      if (state === 'dead') return Promise.reject(new Error('connection is dead'));
      if (startPromise) return startPromise;
      const epochAtStart = epoch;
      state = 'starting';
      startPromise = new Promise<void>((resolve, reject) => {
        spawnChild();
        if (epoch !== epochAtStart) {
          if (child?.pid) killTree(child);
          reject(new Error('connection stopped during start'));
          return;
        }
        const mySeq = send('configure', { hostInfo: 'shadow-cli' }); // handshake probe
        const p: Pending = { resolve, reject };
        pending.set(mySeq, p);
        const giveUp = (): void => {
          if (pending.delete(mySeq)) {
            markDead();
            if (child?.pid) killTree(child); // timed-out-but-alive is still ours to kill
            reject(new Error('tsserver did not answer its handshake in time'));
          }
        };
        const timer = setTimeout(giveUp, deadlineMs);
        timer.unref();
        signal?.addEventListener('abort', giveUp, { once: true });
      }).then(
        () => {
          state = 'ready';
        },
        (err: unknown) => {
          markDead();
          throw err;
        },
      );
      // startPromise tracks readiness state only; single-flight identity lives here.
      const tracked = startPromise.finally(() => {
        startPromise = null;
      });
      startPromise = tracked;
      return tracked;
    },

    notifyOpen(absPath, text) {
      openFile(absPath, text);
    },

    notifyChange(absPath, text) {
      // tsserver has no didChange: re-open reloads the buffer, then re-pull diagnostics.
      openFile(absPath, text);
    },

    awaitDiagnostics(uri, deadlineMs, signal) {
      if (state === 'dead') return Promise.resolve([]);
      if (signal?.aborted) return Promise.resolve([]); // a post-Esc write answers now, not at the deadline
      const ready = merged(uri);
      if (ready !== null) return Promise.resolve(ready);
      return new Promise((resolve) => {
        let settled = false;
        const done = (d: LspDiagnostic[]): void => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          signal?.removeEventListener('abort', onAbort);
          const list = waiters.get(uri);
          if (list) {
            const remaining = list.filter((fn) => fn !== done);
            if (remaining.length === 0) waiters.delete(uri);
            else waiters.set(uri, remaining);
          }
          resolve(d);
        };
        const timer = setTimeout(() => done(merged(uri) ?? []), deadlineMs);
        const onAbort = (): void => done([]);
        signal?.addEventListener('abort', onAbort, { once: true });
        const list = waiters.get(uri) ?? [];
        list.push(done);
        waiters.set(uri, list);
      });
    },

    stop() {
      markDead();
      if (child?.pid) {
        try {
          if (process.platform !== 'win32' && typeof child.pid === 'number') process.kill(-child.pid, 'SIGTERM');
          else child.kill('SIGTERM');
        } catch {
          /* already gone */
        }
        const c = child;
        setTimeout(() => {
          try {
            if (c.exitCode === null && !c.killed) killTree(c);
          } catch {
            /* already gone */
          }
        }, KILL_GRACE_MS).unref();
      }
    },

    dead() {
      return state === 'dead';
    },

    lastError() {
      return stderrTail.trim() === '' ? null : stderrTail.trim();
    },
  };

  return connection;
}
