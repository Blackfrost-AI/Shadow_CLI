// LSP client connection (plan 3.1): one stdio child per server, Content-Length framing on top
// of the in-tree RpcPeer (src/acp/jsonrpc.ts — JSON-RPC 2.0 pending map, abortable requests).
//
// Supervision posture (gguf.ts + mcp/client.ts patterns):
//   - scrubbedEnv() only — no credentials are inherited (safeEnv.ts).
//   - child.unref() + unref all three pipes: a server never keeps a one-shot run alive.
//   - single-flight start with an epoch guard: a stop() racing a start kills the child, never
//     leaks it; a child exit bumps the epoch so a late start cannot attach to a dead wire.
//   - any failure marks the connection dead, cancels pending requests, and settles diagnostic
//     waiters with [] — an LSP problem NEVER rejects past the caller's hook.
//   - `awaitDiagnostics` resolves on the publish that reflects the version we SENT (stale
//     batches from a previous write never satisfy the wait), or [] at the deadline.

import { spawn, type ChildProcess } from 'node:child_process';
import { extname } from 'node:path';
import { pathToFileURL } from 'node:url';
import { RpcPeer } from '../../acp/jsonrpc.js';
import { scrubbedEnv } from '../../util/safeEnv.js';
import { frameMessage, LspDecoder } from './framing.js';
import { KILL_GRACE_MS, SERVER_LANGUAGE, type LspDiagnostic } from './protocol.js';
import type { LspServerSpec } from './detect.js';

export type ConnectionState = 'idle' | 'starting' | 'ready' | 'dead';

export interface ServerConnection {
  /** Initialize handshake (LSP flavor) / spawn verification. Rejects only on start failure. */
  start(deadlineMs: number, signal?: AbortSignal): Promise<void>;
  /** textDocument/didOpen with full text (first open of a file in this session). */
  notifyOpen(absPath: string, text: string, version: number): void;
  /** textDocument/didChange with FULL text (Shadow sends whole-file sync — no ranges). */
  notifyChange(absPath: string, text: string, version: number): void;
  /** Diagnostics reflecting the last sent version, or [] by the deadline. NEVER rejects. */
  awaitDiagnostics(uri: string, deadlineMs: number, signal?: AbortSignal): Promise<LspDiagnostic[]>;
  /** SIGTERM the tree → SIGKILL after the grace window. Idempotent. */
  stop(): void;
  dead(): boolean;
  /** Last ~2 KB of the server's stderr — failure forensics for the disable notice. */
  lastError(): string | null;
}

export interface CreateConnectionOptions {
  workspaceRoot: string;
  /** Env for the child (defaults to scrubbedEnv()); injectable for tests. */
  env?: NodeJS.ProcessEnv;
}

/** Kill the child's whole process group (a server may spawn workers holding the pipes). */
export function killTree(child: ChildProcess): void {
  try {
    if (process.platform !== 'win32' && typeof child.pid === 'number') process.kill(-child.pid, 'SIGKILL');
    else child.kill('SIGKILL');
  } catch {
    /* already gone */
  }
}

interface PublishRecord {
  /** The document version this batch reflects (params.version, else the version last sent). */
  atVersion: number;
  diags: LspDiagnostic[];
}

export function createLspConnection(spec: LspServerSpec, opts: CreateConnectionOptions): ServerConnection {
  let child: ChildProcess | null = null;
  let peer: RpcPeer | null = null;
  let state: ConnectionState = 'idle';
  let epoch = 0;
  let startPromise: Promise<void> | null = null;
  let stderrTail = '';
  const decoder = new LspDecoder();
  const sentVersion = new Map<string, number>();
  const published = new Map<string, PublishRecord>();
  const waiters = new Map<string, Array<{ atVersion: number; resolve: (d: LspDiagnostic[]) => void }>>();

  const write = (line: string): void => {
    try {
      child?.stdin?.write(frameMessage(line));
    } catch {
      /* EPIPE after death — the exit handler cleans up */
    }
  };

  const settleWaiters = (uri: string, record: PublishRecord): void => {
    const list = waiters.get(uri);
    if (!list || list.length === 0) return;
    const remaining = list.filter((w) => {
      if (record.atVersion >= w.atVersion) {
        w.resolve(record.diags);
        return false;
      }
      return true;
    });
    if (remaining.length === 0) waiters.delete(uri);
    else waiters.set(uri, remaining);
  };

  const markDead = (): void => {
    if (state === 'dead') return;
    state = 'dead';
    epoch++;
    peer?.cancelPending('lsp connection closed');
    peer = null;
    for (const [, list] of waiters) for (const w of list) w.resolve([]);
    waiters.clear();
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
      for (const text of decoder.push(d)) peer?.feed(text + '\n');
    });
    child.stderr?.on('data', (d: Buffer) => {
      stderrTail = (stderrTail + d.toString()).slice(-2048);
    });
    child.on('error', () => markDead());
    child.on('exit', () => markDead());
    child.stdin?.on('error', () => markDead());
  };

  const peer_ = (): RpcPeer =>
    new RpcPeer(write, {
      request: async (method) => {
        // Server→client requests answered defensively: a server awaiting a response must never
        // hang the handshake. Empty-ish answers satisfy every known capability probe.
        if (method === 'workspace/workspaceFolders') return [];
        return {};
      },
      notification: (method, params) => {
        if (method !== 'textDocument/publishDiagnostics') return;
        const p = params as { uri?: unknown; version?: unknown; diagnostics?: unknown } | undefined;
        if (typeof p?.uri !== 'string') return;
        const record: PublishRecord = {
          atVersion:
            typeof p.version === 'number' ? p.version : (sentVersion.get(p.uri) ?? 0),
          diags: mapDiagnostics(p.uri, Array.isArray(p.diagnostics) ? p.diagnostics : []),
        };
        published.set(p.uri, record);
        settleWaiters(p.uri, record);
      },
    });

  const connection: ServerConnection = {
    start(deadlineMs, signal) {
      if (state === 'ready') return Promise.resolve();
      if (state === 'dead') return Promise.reject(new Error('connection is dead'));
      if (startPromise) return startPromise;
      const epochAtStart = epoch;
      state = 'starting';
      startPromise = (async () => {
        spawnChild();
        if (epoch !== epochAtStart) {
          // A stop() raced this start — kill what we spawned; nothing was promised.
          if (child?.pid) killTree(child);
          throw new Error('connection stopped during start');
        }
        peer = peer_();
        const ac = new AbortController();
        const timer = setTimeout(() => ac.abort(), deadlineMs);
        const onOuterAbort = (): void => ac.abort();
        signal?.addEventListener('abort', onOuterAbort, { once: true });
        try {
          await peer.request(
            'initialize',
            {
              processId: process.pid,
              rootUri: pathToFileURL(opts.workspaceRoot).href,
              capabilities: { textDocument: { diagnostic: { dynamicRegistration: false } } },
            },
            { signal: ac.signal },
          );
          peer.notify('initialized');
          state = 'ready';
        } catch (err) {
          // Handshake failed (timeout, abort, or the child died): the connection is dead, not
          // merely un-started — the service's restart budget must see it that way. A timed-out
          // child is still OURS: kill the tree, never leak a half-initialized server.
          markDead();
          if (child?.pid) killTree(child);
          throw err;
        } finally {
          clearTimeout(timer);
          signal?.removeEventListener('abort', onOuterAbort);
        }
      })().finally(() => {
        startPromise = null;
      });
      return startPromise;
    },

    notifyOpen(absPath, text, version) {
      if (state !== 'ready' || !peer) return;
      const uri = pathToFileURL(absPath).href;
      sentVersion.set(uri, version);
      const languageId = SERVER_LANGUAGE[spec.id] ?? (extname(absPath).slice(1) || 'plaintext');
      peer.notify('textDocument/didOpen', { textDocument: { uri, languageId, version, text } });
    },

    notifyChange(absPath, text, version) {
      if (state !== 'ready' || !peer) return;
      const uri = pathToFileURL(absPath).href;
      sentVersion.set(uri, version);
      peer.notify('textDocument/didChange', {
        textDocument: { uri, version },
        contentChanges: [{ text }],
      });
    },

    awaitDiagnostics(uri, deadlineMs, signal) {
      if (state === 'dead') return Promise.resolve([]);
      if (signal?.aborted) return Promise.resolve([]); // a post-Esc write answers now, not at the deadline
      const target = sentVersion.get(uri) ?? 0;
      const existing = published.get(uri);
      if (existing && existing.atVersion >= target) return Promise.resolve(existing.diags);
      return new Promise((resolve) => {
        let settled = false;
        const done = (d: LspDiagnostic[]): void => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          signal?.removeEventListener('abort', onAbort);
          const list = waiters.get(uri);
          if (list) {
            const remaining = list.filter((w) => w.resolve !== doneResolve);
            if (remaining.length === 0) waiters.delete(uri);
            else waiters.set(uri, remaining);
          }
          resolve(d);
        };
        const doneResolve = done; // self-reference for waiter removal
        const timer = setTimeout(() => done([]), deadlineMs);
        const onAbort = (): void => done([]);
        signal?.addEventListener('abort', onAbort, { once: true });
        const list = waiters.get(uri) ?? [];
        list.push({ atVersion: target, resolve: doneResolve });
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

// LSP severity → ours (1=Error 2=Warning 3=Information 4=Hint); ranges are 0-based → 1-based.
function mapDiagnostics(uri: string, raw: unknown[]): LspDiagnostic[] {
  const out: LspDiagnostic[] = [];
  for (const item of raw) {
    if (typeof item !== 'object' || item === null) continue;
    const d = item as {
      severity?: unknown;
      message?: unknown;
      code?: unknown;
      source?: unknown;
      range?: { start?: { line?: unknown; character?: unknown } };
    };
    if (typeof d.message !== 'string') continue;
    const severity =
      d.severity === 1 ? 'error' : d.severity === 2 ? 'warning' : d.severity === 3 ? 'info' : 'hint';
    const line = typeof d.range?.start?.line === 'number' ? d.range.start.line + 1 : 1;
    const col = typeof d.range?.start?.character === 'number' ? d.range.start.character + 1 : 1;
    out.push({
      uri,
      line,
      col,
      severity,
      message: d.message,
      ...(typeof d.code === 'string' || typeof d.code === 'number' ? { code: String(d.code) } : {}),
      ...(typeof d.source === 'string' ? { source: d.source } : {}),
    });
  }
  return out;
}
