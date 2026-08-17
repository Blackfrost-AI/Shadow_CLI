import { randomBytes } from 'node:crypto';
import { EventBus } from '../agent/events.js';
import { SessionApprovals } from '../agent/approval.js';
import type { ApprovalDecision } from '../agent/approval.js';
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

/** Hard ceiling on externally-created sessions (browser 'web' + editor 'acp') — see create(). */
export const MAX_WEB_SESSIONS = 8;

/**
 * How long a parked approval waits after the last browser detaches before it settles as
 * cancelled (transport-gone). Long enough that a refresh or brief tab switch keeps the ask
 * alive; short enough that a closed tab cannot hold the process-wide run lock hostage.
 */
export const TRANSPORT_GONE_MS = 120_000;

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
 * 'acp'    = created by an ACP editor via `shadow acp` (src/acp/server.ts).
 */
export type SessionOrigin = 'mirror' | 'local' | 'web' | 'acp';

/** Thrown by the lazy build. Message is ANSI-stripped and redacted before it escapes. */
export class SessionStartupError extends Error {
  readonly kind = 'startup';
}

export interface McpHandle {
  stop(): void;
}

/**
 * One parked approval ask (WebApprovalGate, src/web/approvalGate.ts). The registry holds these so
 * the HTTP decision route can reach the resolver without importing the gate: POST
 * /api/sessions/:id/approvals/:approvalId → decide() → settle(). `receivedAt` orders a refresh's
 * re-render when more than one ask is open.
 */
export interface PendingApproval {
  settle(decision: ApprovalDecision, label?: 'approved' | 'session' | 'denied' | 'cancelled'): void;
  receivedAt: number;
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
  /** Session-lifetime "allow for this session" grants — ONE instance shared by every turn's
   *  AgentLoop. Each turn builds a fresh loop; grants held on the loop die with it (the exact
   *  alarm-fatigue bug approval.ts exists to fix — see the TUI's sessionApprovalsRef pattern).
   *  The ACP editor's "Allow for this session" option lands here. */
  readonly approvals: SessionApprovals;
  /** Asks parked by WebApprovalGate, keyed by approval id — answered via registry.decide().
   *  Empty for the mirror/local sessions (nothing gates through them). */
  readonly pendingApprovals: Map<string, PendingApproval>;
  /** Unsubscribes the sessionAgent bus→sessionLog wiring; called by close() so a closed session
   *  cannot write another event (and the built agent is not pinned alive by the closure). */
  detachLog?: () => void;

  close(): Promise<void>;
}

/** Internal shape: the reserved session's interrupt reaches an abort controller it does not own. */
interface WebSessionInternal extends WebSession {
  getAbort?: () => AbortController | null;
  /** Only for browser-created sessions (create()) — swaps the mutable autonomy the getter reads. */
  setAutonomy?: (level: AutonomyLevel) => void;
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
  /** Who is driving the session. Defaults to 'web' (the browser). */
  origin?: 'web' | 'acp';
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
  /** Answer a parked approval ask. False = unknown session, or no pending ask with that id. */
  decide(id: string, approvalId: string, decision: ApprovalDecision): boolean;
  /** Change a browser-created session's autonomy (the composer's access pill). */
  setAutonomy(id: string, level: AutonomyLevel): boolean;
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
    // Transport-gone path for parked approvals (the deny branch approvalGate.ts documents):
    // when the LAST browser detaches while an ask is pending, arm a grace timer — a tab that
    // comes back within the window (refresh, brief switch) stands it down; anything longer
    // settles the ask as cancelled so the turn resolves 'denied' and releases the run lock
    // instead of parking it forever behind a ghost grant.
    let goneTimer: ReturnType<typeof setTimeout> | null = null;
    const armTransportGone = (): void => {
      if (goneTimer || s.status === 'closed') return;
      goneTimer = setTimeout(() => {
        goneTimer = null;
        if (s.status === 'closed' || s.stream.clientCount() > 0 || s.pendingApprovals.size === 0) return;
        for (const [id, pending] of [...s.pendingApprovals]) {
          s.pendingApprovals.delete(id);
          try {
            pending.settle('deny', 'cancelled');
          } catch {
            /* the gate emits its own resolved frame; never block the timer */
          }
        }
      }, TRANSPORT_GONE_MS);
    };
    const stream = createSessionStream({
      bus: init.bus,
      allocClientId,
      onClientsChange: (n) => {
        if (n > 0) {
          if (goneTimer) clearTimeout(goneTimer);
          goneTimer = null;
        } else if (s && s.pendingApprovals.size > 0) {
          armTransportGone();
        }
      },
    });
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
      approvals: new SessionApprovals(),
      pendingApprovals: new Map<string, PendingApproval>(),
      getAbort: init.getAbort,
      async close(): Promise<void> {
        this.status = 'closed';
        if (goneTimer) {
          clearTimeout(goneTimer);
          goneTimer = null;
        }
        // A closed session must not leave an approval parked: settle every ask as cancelled so
        // the gate's promise resolves (denied), the wire gets its terminal frame, and no tab
        // shows a strip that can never be answered.
        for (const [id, pending] of [...this.pendingApprovals]) {
          this.pendingApprovals.delete(id);
          try {
            pending.settle('deny', 'cancelled');
          } catch {
            /* the gate emits its own resolved frame; never block teardown */
          }
        }
        this.detachLog?.();
        this.detachLog = undefined;
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
  /** Terminal frame for every early return out of drive(), so the browser can clear its state. */
  const emitInterrupted = (s: WebSessionInternal): void => {
    s.bus.emit({ type: 'stop', reason: 'interrupted', finalAnswer: '' });
  };

  const disposeBuilt = (built: { agent: AgentSession; mcp: McpHandle[] }): void => {
    for (const c of built.mcp) {
      try { c.stop(); } catch { /* best-effort */ }
    }
    try { built.agent.bg.killAll(); } catch { /* best-effort */ }
    try { built.agent.wakeup.clear(); } catch { /* best-effort */ }
  };

  async function drive(s: WebSessionInternal, prompt: string): Promise<void> {
    // E3a — interruptible from the FIRST tick, including the build.
    //
    // The controller used to be created AFTER `await s.building`, so during 'initializing' —
    // which this code itself notes can take MINUTES (MCP servers, model warmup) — interrupt()
    // read a null `s.abort`, returned {interrupted:false}, and the turn then ran anyway. The
    // comment claiming "s.abort is set BEFORE acquiring so an interrupt cancels the queued wait
    // too" was true of the queue and false of the build.
    s.abort = new AbortController();
    try {
      if (!s.agent) {
        if (!s.building) {
          s.status = 'initializing';
          s.building = deps
            .builder(s)
            .then((built) => {
              // close() may win while the lazy build is awaiting credentials, MCP, or a local
              // model. A closed session can never own the result: dispose it at the handoff.
              if (s.status === 'closed') {
                disposeBuilt(built);
                return built.agent;
              }
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
      if (s.status === 'closed') return;
      // Interrupted DURING the build: stop here rather than running the turn the user cancelled.
      if (s.abort.signal.aborted) {
        s.status = 'idle';
        emitInterrupted(s);
        return;
      }
      // Serialize the actual turn through the process-wide run lock — one at a time across the TUI
      // and every session. Web sessions wait WITHOUT priority (the operator's TUI jumps ahead).
      s.status = 'queued';
      let release: (() => void) | null = null;
      try {
        release = await runLock.acquire(s.id, { signal: s.abort.signal });
      } catch {
        s.status = 'idle'; // interrupted while queued
        // E3b — the browser set an optimistic running state on send, and clears it ONLY on a
        // `stop` frame. Returning silently here left the textarea disabled and the Interrupt
        // button visible until the view was re-mounted.
        emitInterrupted(s);
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
      // E2b — a hard ceiling. Each externally-created session costs an agent context, its own
      // MCP stdio children and a 2 MB SSE replay ring — so "+ new session" was an unbounded
      // allocation driven by a mouse click (web) or an editor RPC (acp). Both count.
      let live = 0;
      for (const existing of sessions.values()) if (existing.origin === 'web' || existing.origin === 'acp') live++;
      if (live >= MAX_WEB_SESSIONS) {
        throw new Error(`session limit reached (${MAX_WEB_SESSIONS}) — close one first`);
      }
      // Q1: browser-created sessions default to auto-edit. Mutable via setAutonomy (the
      // composer's access pill) — held in a closure the getter and the setter share.
      let autonomy: AutonomyLevel = spec.autonomy ?? 'auto-edit';
      const s = makeSession({
        id: randomBytes(8).toString('hex'),
        origin: spec.origin ?? 'web',
        title: spec.title ?? 'New session',
        displayPath: spec.projectRoot,
        bus: new EventBus(),
        canPrompt: true,
        canInterrupt: true,
        model: () => spec.model ?? '',
        autonomy: () => autonomy,
      });
      s.setAutonomy = (level) => {
        autonomy = level;
      };
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

    decide(id: string, approvalId: string, decision: ApprovalDecision): boolean {
      const s = sessions.get(id);
      const pending = s?.pendingApprovals.get(approvalId);
      if (!s || !pending) return false; // late, duplicate, or already-cancelled — not pending
      s.pendingApprovals.delete(approvalId);
      pending.settle(decision); // emits approval_resolved + resolves the gate's promise
      return true;
    },

    setAutonomy(id: string, level: AutonomyLevel): boolean {
      const s = sessions.get(id);
      if (!s || !s.canPrompt || !s.setAutonomy) return false; // mirror/local sessions are read-only
      s.setAutonomy(level);
      s.bus.emit({ type: 'autonomy', level });
      return true;
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
