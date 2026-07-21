import { randomBytes } from 'node:crypto';
import { EventBus } from '../agent/events.js';
import type { AgentSession } from '../agent/bootstrap.js';
import type { AutonomyLevel } from '../safety/permissions.js';
import { redactString } from '../util/redact.js';
import { stripAnsi } from '../util/lc.js';
import { createSessionStream, type SessionStream } from './sessionStream.js';
import { runLock } from './runLock.js';

/**
 * The session registry: a Map<id, WebSession>, each with its own EventBus + SSE stream, a
 * status, and a LAZILY-built AgentSession. The reserved 'cli' session mirrors the live terminal
 * (observed, never driven under `shadow --web`); browser-created sessions build their agent on
 * the first prompt and nowhere else.
 *
 * This file imports NO bootstrap: the real agent build is injected as `builder` (see
 * sessionAgent.ts, C6), so the registry is unit-testable with no credentials, MCP or model
 * server. The run-lock and the routes are layered on later — C3 ships the structure, the
 * reserved session, and the read path (GET /api/sessions).
 */

export const CLI_SESSION_ID = 'cli';

/**
 * The frozen jail a session runs under. Produced by resolveJail() (projects.ts, C4) and consumed
 * at buildLoopDeps (runTurn.ts, C6). Defined here because the registry is the first consumer and
 * is created before projects.ts exists; projects.ts imports it from here.
 */
export interface JailCapability {
  readonly workspaceRoot: string;
  readonly additionalRoots: readonly string[];
}

export type SessionStatus =
  | 'idle'
  | 'initializing' // createAgentSession is running; can be MINUTES
  | 'queued' // built, waiting on the run-lock (C5)
  | 'running'
  | 'error'
  | 'closed';

/**
 * 'mirror' = the live `shadow --web` terminal session, observed and never driven.
 * 'local'  = the inert reserved session under standalone `shadow web` (no CLI behind it).
 * 'web'    = created by the browser.
 */
export type SessionOrigin = 'mirror' | 'local' | 'web';

/** Thrown by the lazy build. Message is ANSI-stripped and redacted before it escapes. */
export class SessionStartupError extends Error {
  readonly kind = 'startup';
}

export interface McpHandle {
  stop(): void;
}

export interface WebSession {
  readonly id: string;
  readonly origin: SessionOrigin;
  readonly createdAt: number;
  title: string;

  /** Display-only. NOT authoritative for the jail — resolveJail() re-derives that at build time. */
  readonly displayPath: string;

  readonly bus: EventBus;
  readonly stream: SessionStream;

  status: SessionStatus;
  /** redactString(stripAnsi(msg)), capped at 2 KB. Surfaced by GET /api/sessions. */
  lastError: string | null;

  /** GETTERS, not snapshots — the mirror tracks the terminal's live model/autonomy. */
  model: () => string;
  autonomy: () => AutonomyLevel;

  /** False for 'mirror' and 'local'. */
  readonly canPrompt: boolean;
  readonly canInterrupt: boolean;

  /** ALWAYS null for 'mirror'/'local'. Null until the first prompt for 'web'. */
  agent: AgentSession | null;
  /** The frozen jail the built agent runs under. Set by the same call that builds it. */
  jail: JailCapability | null;
  /** The ONLY handle to this session's MCP stdio children. */
  mcpClients: McpHandle[];
  /** In-flight lazy build, coalescing concurrent submits. Discarded on rejection. */
  building: Promise<AgentSession> | null;
  /** Set while a turn is in flight, so interrupt cancels it. */
  abort: AbortController | null;

  close(): Promise<void>;
}

/** Internal shape: the reserved session's interrupt reaches an abort controller it does not own. */
interface WebSessionInternal extends WebSession {
  getAbort?: () => AbortController | null;
}

export interface SessionSummary {
  id: string;
  origin: SessionOrigin;
  title: string;
  displayPath: string;
  status: SessionStatus;
  model: string;
  autonomy: AutonomyLevel;
  canPrompt: boolean;
  canInterrupt: boolean;
  lastError: string | null;
  createdAt: number;
  clients: number;
}

export interface CreateSessionSpec {
  projectRoot: string;
  title?: string;
  model?: string;
  autonomy?: AutonomyLevel;
}

/** Injected so the registry is unit-testable with no credentials, MCP or model server. */
export type AgentBuilder = (s: WebSession) => Promise<{
  agent: AgentSession;
  mcp: McpHandle[];
  jail: JailCapability;
}>;

/** Injected likewise: assembles LoopDeps from a built session and runs one turn. */
export type TurnRunner = (s: WebSession, prompt: string) => Promise<void>;

export interface SessionRegistry {
  get(id: string): WebSession | undefined;
  list(): SessionSummary[];
  /** Registers the already-live CLI bus. Never builds anything. Throws if one exists. */
  attachReserved(o: {
    bus: EventBus;
    displayPath: string;
    origin: 'mirror' | 'local';
    model?: () => string;
    autonomy?: () => AutonomyLevel;
    getAbort?: () => AbortController | null;
  }): WebSession;
  /** Browser-owned. Builds a stream + bus ONLY. Rejects the reserved id. */
  create(spec: CreateSessionSpec): WebSession;
  /** Admits and detaches. Resolves once ACCEPTED (202), not once the turn is done. */
  submit(id: string, prompt: string): Promise<{ ok: true } | { ok: false; code: number; reason: string }>;
  interrupt(id: string): boolean;
  remove(id: string): Promise<boolean>;
  each(fn: (s: WebSession) => void): void;
  totalClients(): number;
  allocClientId(): number;
  closeAll(): Promise<void>;
}

export function createSessionRegistry(deps: { builder: AgentBuilder; runTurn: TurnRunner }): SessionRegistry {
  const sessions = new Map<string, WebSessionInternal>();
  let nextClientId = 1;
  const allocClientId = (): number => nextClientId++;

  const scrub = (msg: string): string => redactString(stripAnsi(msg)).slice(0, 2048);

  /** Guaranteed terminal frame so a detached 202 never leaves the browser spinner hanging. */
  const emitTerminalError = (s: WebSessionInternal, msg: string): void => {
    s.bus.emit({ type: 'error', message: msg });
    s.bus.emit({ type: 'stop', reason: 'fatal_tool_error', finalAnswer: '' });
  };

  function makeSession(init: {
    id: string;
    origin: SessionOrigin;
    title: string;
    displayPath: string;
    bus: EventBus;
    canPrompt: boolean;
    canInterrupt: boolean;
    model: () => string;
    autonomy: () => AutonomyLevel;
    getAbort?: () => AbortController | null;
  }): WebSessionInternal {
    const stream = createSessionStream({ bus: init.bus, allocClientId });
    const s: WebSessionInternal = {
      id: init.id,
      origin: init.origin,
      createdAt: nowMs(),
      title: init.title,
      displayPath: init.displayPath,
      bus: init.bus,
      stream,
      status: 'idle',
      lastError: null,
      model: init.model,
      autonomy: init.autonomy,
      canPrompt: init.canPrompt,
      canInterrupt: init.canInterrupt,
      agent: null,
      jail: null,
      mcpClients: [],
      building: null,
      abort: null,
      getAbort: init.getAbort,
      async close(): Promise<void> {
        this.status = 'closed';
        runLock.releaseFor(this.id); // idempotent; drops this session's grant + de-queues its waiters
        this.abort?.abort();
        this.stream.close();
        for (const c of this.mcpClients) {
          try {
            c.stop();
          } catch {
            /* best-effort */
          }
        }
        this.mcpClients = [];
        this.agent?.bg.killAll();
        this.agent?.wakeup.clear();
        this.agent = null;
        this.jail = null;
      },
    };
    return s;
  }

  /** The build+run flow behind submit(). Streams progress on the session bus; never awaited by
   *  the route (submit returns 202). The run-lock (C5) and the real builder/runTurn (C6) plug in
   *  without changing this shape. */
  async function drive(s: WebSessionInternal, prompt: string): Promise<void> {
    try {
      if (!s.agent) {
        if (!s.building) {
          s.status = 'initializing';
          s.building = deps
            .builder(s)
            .then((built) => {
              s.agent = built.agent;
              s.mcpClients = built.mcp;
              s.jail = built.jail;
              return built.agent;
            })
            .catch((err: unknown) => {
              s.building = null; // discard the memo so a retry re-runs the build
              throw err;
            });
        }
        await s.building;
      }
      // Serialize the actual turn through the process-wide run lock — one at a time across the TUI
      // and every session. Web sessions wait WITHOUT priority (the operator's TUI jumps ahead).
      // s.abort is set BEFORE acquiring so an interrupt cancels the queued wait too.
      s.abort = new AbortController();
      s.status = 'queued';
      let release: (() => void) | null = null;
      try {
        release = await runLock.acquire(s.id, { signal: s.abort.signal });
      } catch {
        s.status = 'idle'; // interrupted while queued
        return;
      }
      try {
        s.status = 'running';
        await deps.runTurn(s, prompt);
        s.status = 'idle';
      } finally {
        // Release ONLY here, in the finally around the turn — never off a `stop` event (a
        // sub-agent reuses the parent bus, so its stop is byte-identical). Idempotent.
        release();
      }
    } catch (err) {
      s.status = 'error';
      s.lastError = scrub(err instanceof Error ? err.message : String(err));
      emitTerminalError(s, s.lastError);
    } finally {
      s.abort = null;
    }
  }

  return {
    get(id: string): WebSession | undefined {
      return sessions.get(id);
    },

    list(): SessionSummary[] {
      return [...sessions.values()].map((s) => ({
        id: s.id,
        origin: s.origin,
        title: s.title,
        displayPath: s.displayPath,
        status: s.status,
        model: s.model(),
        autonomy: s.autonomy(),
        canPrompt: s.canPrompt,
        canInterrupt: s.canInterrupt,
        lastError: s.lastError,
        createdAt: s.createdAt,
        clients: s.stream.clientCount(),
      }));
    },

    attachReserved(o): WebSession {
      if (sessions.has(CLI_SESSION_ID)) {
        throw new Error('a reserved session already exists');
      }
      const s = makeSession({
        id: CLI_SESSION_ID,
        origin: o.origin,
        title: o.origin === 'mirror' ? 'Terminal (mirror)' : 'Web console',
        displayPath: o.displayPath,
        bus: o.bus,
        canPrompt: false, // §5: the mirror is observed, never driven
        canInterrupt: Boolean(o.getAbort), // true only once the terminal's controller is wired (C5)
        model: o.model ?? (() => ''),
        autonomy: o.autonomy ?? (() => 'manual'),
        getAbort: o.getAbort,
      });
      sessions.set(s.id, s);
      return s;
    },

    create(spec: CreateSessionSpec): WebSession {
      const s = makeSession({
        id: randomBytes(8).toString('hex'),
        origin: 'web',
        title: spec.title ?? 'New session',
        displayPath: spec.projectRoot,
        bus: new EventBus(),
        canPrompt: true,
        canInterrupt: true,
        // Q1: browser-created sessions default to auto-edit (the WebDenyGate denies exec/network).
        model: () => spec.model ?? '',
        autonomy: () => spec.autonomy ?? 'auto-edit',
      });
      sessions.set(s.id, s);
      return s;
    },

    async submit(id, prompt) {
      const s = sessions.get(id);
      if (!s) return { ok: false, code: 404, reason: 'unknown session' };
      if (!s.canPrompt) return { ok: false, code: 409, reason: 'session_is_mirror' };
      if (s.status === 'closed') return { ok: false, code: 409, reason: 'closed' };
      // One turn per session: a build/turn already in flight is busy. Cross-session serialization
      // is the run-lock's job (C5). status 'error'/'idle' may (re)start.
      if (s.status === 'initializing' || s.status === 'queued' || s.status === 'running') {
        return { ok: false, code: 409, reason: 'busy' };
      }
      void drive(s, prompt);
      return { ok: true };
    },

    interrupt(id: string): boolean {
      const s = sessions.get(id);
      if (!s) return false;
      const ctrl = s.getAbort ? s.getAbort() : s.abort;
      if (ctrl) {
        ctrl.abort();
        return true;
      }
      return false;
    },

    async remove(id: string): Promise<boolean> {
      if (id === CLI_SESSION_ID) return false; // the reserved session is never removable
      const s = sessions.get(id);
      if (!s) return false;
      await s.close();
      sessions.delete(id);
      return true;
    },

    each(fn: (s: WebSession) => void): void {
      for (const s of sessions.values()) fn(s);
    },

    totalClients(): number {
      let n = 0;
      for (const s of sessions.values()) n += s.stream.clientCount();
      return n;
    },

    allocClientId,

    async closeAll(): Promise<void> {
      await Promise.all(
        [...sessions.values()].map((s) =>
          s.close().catch(() => {
            /* teardown is best-effort */
          }),
        ),
      );
    },
  };
}

/** Wall-clock ms. Wrapped so the registry has one obvious place time enters (tests can't stub
 *  Date in a workflow, but production reads the real clock here). */
function nowMs(): number {
  return Date.now();
}
