// LSP service (plan 3.1): one supervisor per workspace, owning the per-server connections,
// the note budget, and the note deduper. This is the layer the loop hook talks to.
//
// Lifetime: services are cached at MODULE level (index.ts, gguf.ts `servers` pattern) — an
// AgentLoop is built per user message, but a language server takes seconds to warm, so the
// service and its children must outlive every individual turn.
//
// Failure policy: `collect` NEVER throws and NEVER blocks a write for long — worst case it
// burns its deadline and answers null/[] . A server that dies is restarted at most
// RESTART_CAP times per process, then disabled for the session with ONE notice.

import { existsSync, readFileSync, statSync } from 'node:fs';
import { extname } from 'node:path';
import { pathToFileURL } from 'node:url';
import { insideProject } from '../formatter.js';
import { createLspConnection, type ServerConnection } from './client.js';
import { createTsserverConnection } from './tsserver.js';
import { detectLspServers, localTsserverPath, type DetectLspOptions, type LspServerOverride, type LspServerSpec } from './detect.js';
import { createLspNoteBudget, type LspNoteBudgetConfig, type LspNoteBudgetState } from './noteBudget.js';
import { NoteDeduper } from './note.js';
import { MAX_FILE_BYTES, SERVER_BY_EXT, SERVER_DEADLINE_MS, type LspDiagnostic, type LspServerFlavor } from './protocol.js';

/** The `lsp` config block (src/config.ts). All fields optional; defaults applied here. */
export interface LspServiceConfig {
  enabled?: boolean; // default true — a no-op until a server is detected
  /** Per-collect diagnostics deadline in ms (default 3_000, SERVER_DEADLINE_MS). */
  timeoutMs?: number;
  /** Trusted-global-config server overrides (also the fake-server test seam). */
  servers?: Record<string, LspServerOverride>;
  /**
   * Opt-in (trusted GLOBAL config only) to spawn servers found in the project's own
   * node_modules (its typescript/tsserver.js). Default false: that file is repo content —
   * spawning it executes repo code, so a cloned repo must never be able to trigger it alone.
   */
  trustNodeModules?: boolean;
  /** Note char budgets (default 8k/turn, 60k/session). */
  notes?: LspNoteBudgetConfig;
}

/** Total spawn attempts per server id per process; after that, disabled for the session. */
export const RESTART_CAP = 2;

export interface LspServerStatus {
  id: string;
  flavor: LspServerFlavor;
  state: 'idle' | 'starting' | 'ready' | 'dead' | 'disabled';
  starts: number;
}

export interface LspServiceSnapshot {
  enabled: boolean;
  servers: LspServerStatus[];
}

export interface CollectOptions {
  deadlineMs?: number;
  signal?: AbortSignal;
}

export interface CreateLspServiceOptions {
  projectDir: string;
  config?: LspServiceConfig;
  /** Env for spawned servers (defaults to scrubbedEnv() inside the connections). */
  env?: NodeJS.ProcessEnv;
  /** Detection seam (defaults to detectLspServers on the real fs/PATH). */
  detect?: DetectLspOptions;
}

export interface LspService {
  /**
   * Diagnostics for a file the agent just wrote. null = skipped (no server, not ready yet,
   * outside the workspace, too big, unreadable); [] = server answered clean/late-empty.
   * NEVER throws.
   */
  collect(absPath: string, opts?: CollectOptions): Promise<LspDiagnostic[] | null>;
  /** The server id that would handle this file, or null when none is configured. */
  serverIdFor(absPath: string): string | null;
  noteBudget(): LspNoteBudgetState;
  noteDeduper(): NoteDeduper;
  beginTurn(): void;
  stop(): void;
  snapshot(): LspServiceSnapshot;
  /** Session-level notices (server disabled after repeated failures). Returns an unsubscribe. */
  onNotice(fn: (message: string) => void): () => void;
}

export function createLspService(opts: CreateLspServiceOptions): LspService {
  const enabled = opts.config?.enabled !== false;
  const timeoutMs = opts.config?.timeoutMs ?? SERVER_DEADLINE_MS;

  // Lazy, resolved once: detection reads the fs/PATH the first time a relevant file is written.
  let specs: LspServerSpec[] | null = null;
  const specById = new Map<string, LspServerSpec>();
  let noticedUntrusted = false;
  const resolveSpecs = (): void => {
    if (specs) return;
    specs = enabled
      ? detectLspServers(opts.projectDir, {
          overrides: opts.config?.servers,
          trustNodeModules: opts.config?.trustNodeModules === true,
          ...opts.detect,
        })
      : [];
    for (const s of specs) specById.set(s.id, s);
    // A repo-local typescript the user has NOT opted into is silently skipped by detection —
    // tell them once how to enable it (or they just see LSP "not working" in TS projects).
    if (enabled && opts.config?.trustNodeModules !== true && !noticedUntrusted && existsSync(localTsserverPath(opts.projectDir))) {
      noticedUntrusted = true;
      notify(
        'A typescript install was found in this project\'s node_modules and was NOT started ' +
          '(a repo-controlled file — a cloned repo must not be able to make Shadow execute it). ' +
          'To enable it for projects you trust, set "trustNodeModules": true in the lsp block of ~/.shadow/config.json.',
      );
    }
  };

  const conns = new Map<string, ServerConnection>();
  const ready = new Set<string>();
  const starts = new Map<string, number>();
  const disabled = new Set<string>();
  const noticedDisable = new Set<string>();
  const versions = new Map<string, number>();
  const listeners: Array<(message: string) => void> = [];
  let budget: LspNoteBudgetState | null = null;
  let deduper: NoteDeduper | null = null;

  const notify = (message: string): void => {
    for (const fn of [...listeners]) {
      try {
        fn(message);
      } catch {
        /* a listener bug never breaks the service */
      }
    }
  };

  /** Start (or restart) the server for `id`. Returns a READY connection, or null when the
   *  answer must be "not this time": still starting (cold-start honesty), missing, or disabled. */
  const ensureReady = (id: string): ServerConnection | null => {
    const spec = specById.get(id);
    if (!spec || disabled.has(id)) return null;
    let conn = conns.get(id);
    if (conn?.dead()) {
      conns.delete(id);
      ready.delete(id);
      conn = undefined;
    }
    if (!conn) {
      if ((starts.get(id) ?? 0) >= RESTART_CAP) {
        disabled.add(id);
        if (!noticedDisable.has(id)) {
          noticedDisable.add(id);
          notify(`LSP server "${id}" stopped responding and is disabled for this session.`);
        }
        return null;
      }
      const make = spec.flavor === 'tsserver' ? createTsserverConnection : createLspConnection;
      const c = make(spec, { workspaceRoot: opts.projectDir, env: opts.env });
      conns.set(id, c);
      starts.set(id, (starts.get(id) ?? 0) + 1);
      // Fire-and-forget start: this write's note is skipped, the server warms for the next.
      void c.start(timeoutMs).then(
        () => ready.add(id),
        () => {
          /* dead now; the next collect sees it and restarts (within the cap) */
        },
      );
      return null;
    }
    return ready.has(id) ? conn : null;
  };

  const service: LspService = {
    async collect(absPath, collectOpts) {
      try {
        if (!enabled) return null;
        if (!insideProject(opts.projectDir, absPath)) return null;
        resolveSpecs();
        const id = serverIdForExt(absPath);
        const spec = id ? specById.get(id) : undefined;
        if (!id || !spec) return null;
        const conn = ensureReady(id);
        if (!conn) return null;
        const st = statSync(absPath); // throws for a vanished file → null
        if (!st.isFile() || st.size > MAX_FILE_BYTES) return null;
        const text = readFileSync(absPath, 'utf8'); // throws for unreadable → null
        const uri = pathToFileURL(absPath).href;
        const version = (versions.get(uri) ?? 0) + 1;
        versions.set(uri, version);
        if (version === 1) conn.notifyOpen(absPath, text, version);
        else conn.notifyChange(absPath, text, version);
        return await conn.awaitDiagnostics(uri, collectOpts?.deadlineMs ?? timeoutMs, collectOpts?.signal);
      } catch {
        return null; // an LSP problem never fails the write
      }
    },

    serverIdFor(absPath) {
      resolveSpecs();
      const id = serverIdForExt(absPath);
      return id && specById.has(id) ? id : null;
    },

    noteBudget() {
      budget ??= createLspNoteBudget(opts.config?.notes);
      return budget;
    },

    noteDeduper() {
      deduper ??= new NoteDeduper();
      return deduper;
    },

    beginTurn() {
      this.noteBudget().beginTurn();
    },

    stop() {
      for (const [, conn] of conns) conn.stop();
      conns.clear();
      ready.clear();
    },

    snapshot() {
      resolveSpecs();
      const servers: LspServerStatus[] = [];
      for (const [id, spec] of specById) {
        const state = disabled.has(id)
          ? 'disabled'
          : conns.has(id)
            ? ready.has(id)
              ? 'ready'
              : conns.get(id)!.dead()
                ? 'dead'
                : 'starting'
            : 'idle';
        servers.push({ id, flavor: spec.flavor, state, starts: starts.get(id) ?? 0 });
      }
      return { enabled, servers };
    },

    onNotice(fn) {
      listeners.push(fn);
      return () => {
        const i = listeners.indexOf(fn);
        if (i >= 0) listeners.splice(i, 1);
      };
    },
  };

  function serverIdForExt(absPath: string): string | null {
    return SERVER_BY_EXT[extname(absPath).slice(1).toLowerCase()] ?? null;
  }

  return service;
}
