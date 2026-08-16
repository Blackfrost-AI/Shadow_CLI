/**
 * The ACP method router + session manager. Composition root for `shadow acp`: owns the mapping
 * between ACP requests and the web-console machinery (registry + run lock + jail), and NOTHING
 * else — transport is the injected RpcPeer seam, agent building is the registry's injected
 * builder, the trust boundary is the injected resolveJail.
 *
 * v0 unsupported methods fail with `-32601` and a reason that says exactly what is unsupported —
 * the capabilities in `initialize` advertise the same (loadSession=false, no auth methods, no
 * modes/models), so a conforming editor never calls them.
 */
import { basename } from 'node:path';
import { RpcFailure } from './jsonrpc.js';
import { mapEventToUpdate } from './events.js';
import { AcpPermissionGate, type PermissionAsk } from './gate.js';
import {
  ACP_PROTOCOL_VERSION,
  AGENT_NAME,
  E_INTERNAL,
  E_INVALID_PARAMS,
  E_METHOD_NOT_FOUND,
  M_AUTHENTICATE,
  M_INITIALIZE,
  M_SESSION_CANCEL,
  M_SESSION_LOAD,
  M_SESSION_NEW,
  M_SESSION_PROMPT,
  M_SESSION_SET_MODE,
  M_SESSION_SET_MODEL,
  M_SESSION_UPDATE,
  STOP_CANCELLED,
  STOP_END_TURN,
  STOP_MAX_TOKENS,
  type AcpTextBlock,
  type SessionNewParams,
  type SessionPromptParams,
} from './protocol.js';
import type { StopReasonExt } from '../agent/events.js';
import type { ApprovalGate } from '../agent/approval.js';
import { redact } from '../util/redact.js';
import { resolveJail as defaultResolveJail } from '../web/projects.js';
import type { JailCapability, SessionRegistry, WebSession } from '../web/registry.js';

/** The bus reason a turn ended → the ACP stopReason the editor receives. Pinned by tests. */
export function toAcpStopReason(reason: StopReasonExt): string {
  switch (reason) {
    case 'interrupted':
      return STOP_CANCELLED;
    case 'max_tokens':
      return STOP_MAX_TOKENS;
    default:
      // end_turn, tool_use, pause_turn, budget, max_iterations, fatal_tool_error,
      // provider_error — the turn is OVER either way; the editor has no richer bucket for them.
      return STOP_END_TURN;
  }
}

export interface AcpServerDeps {
  registry: SessionRegistry;
  /** Trust boundary for session/new. Injectable so tests skip the global allowlist. */
  resolveJail?: (root: string) => JailCapability;
  version: string;
  /** Outbound seam: send a notification (session/update) to the editor. */
  notify(method: string, params?: unknown): void;
  /** Outbound seam: ask the editor for a tool approval (session/request_permission). */
  askPermission: PermissionAsk;
}

export interface AcpServer {
  handleRequest(method: string, params: unknown): Promise<unknown>;
  handleNotification(method: string, params: unknown): void;
  /** The gate a turn under `session` runs with — editor-mediated approvals, fail-closed floor. */
  gateFor(session: WebSession): ApprovalGate;
  /** Unsubscribe every session bus and close every session. */
  close(): Promise<void>;
}

export function createAcpServer(deps: AcpServerDeps): AcpServer {
  const resolve = deps.resolveJail ?? defaultResolveJail;
  /** One session bus subscription per created session; removed on close(). */
  const subscriptions = new Map<string, () => void>();

  const unsupported = (method: string, why: string): RpcFailure =>
    new RpcFailure(E_METHOD_NOT_FOUND, `${method}: not supported — ${why}`);

  function sessionNew(params: unknown): Record<string, unknown> {
    const p = (params ?? {}) as SessionNewParams;
    const cwd = typeof p.cwd === 'string' && p.cwd.trim() ? p.cwd : process.cwd();
    let jail: JailCapability;
    try {
      jail = resolve(cwd);
    } catch (err) {
      throw new RpcFailure(
        E_INVALID_PARAMS,
        `${err instanceof Error ? err.message : String(err)} — add it to the allowlist with: shadow acp --add-project ${cwd}`,
      );
    }
    let session: WebSession;
    try {
      session = deps.registry.create({
        projectRoot: jail.workspaceRoot,
        title: basename(jail.workspaceRoot),
        origin: 'acp',
        // v0 decision: auto-edit with the ACP permission gate — what reaches the gate is
        // editor-mediated (strictly more than the web console's deny-only gate); the
        // fail-closed floor and the denylist force-confirm are unchanged.
        autonomy: 'auto-edit',
      });
    } catch (err) {
      throw new RpcFailure(E_INTERNAL, err instanceof Error ? err.message : String(err));
    }
    // Bus → editor. mapEventToUpdate is the single source of truth for the wire shape; events
    // with no ACP meaning return null and stay local. Redaction happens HERE, at the bus→wire
    // boundary — the same seam and the same function as the web console's stream
    // (sessionStream.ts): tool inputs, finding bodies, and text deltas ride this wire into the
    // editor's PERSISTED thread store, so they are scrubbed before they leave the process.
    const off = session.bus.on((e) => {
      const update = mapEventToUpdate(e);
      if (update) deps.notify(M_SESSION_UPDATE, { sessionId: session.id, update: redact(update) });
    });
    subscriptions.set(session.id, off);
    return {
      sessionId: session.id,
      modes: { modes: [] },
      models: { models: [] },
    };
  }

  async function sessionPrompt(params: unknown): Promise<Record<string, unknown>> {
    const p = (params ?? {}) as SessionPromptParams;
    const id = p.sessionId;
    if (typeof id !== 'string' || !id) throw new RpcFailure(E_INVALID_PARAMS, 'sessionId is required');
    const session = deps.registry.get(id);
    if (!session) throw new RpcFailure(E_INVALID_PARAMS, `unknown session: ${id}`);

    // v0 is TEXT-ONLY and says so in initialize (image/audio/embeddedContext false). A non-text
    // block is a typed error, not a silent drop — the editor must know its attachment was refused.
    // The block array is `prompt` on the ACP v1 wire; `content` is a legacy alias (both accepted).
    const content = Array.isArray(p.prompt) ? p.prompt : Array.isArray(p.content) ? p.content : [];
    if (content.length === 0) throw new RpcFailure(E_INVALID_PARAMS, 'content must contain at least one block');
    const texts: string[] = [];
    for (const block of content) {
      const b = block as AcpTextBlock;
      if (b && typeof b === 'object' && b.type === 'text' && typeof b.text === 'string') {
        texts.push(b.text);
      } else {
        throw new RpcFailure(
          E_INVALID_PARAMS,
          `unsupported content block "${String((block as { type?: unknown })?.type)}" — v0 accepts text only`,
        );
      }
    }
    const prompt = texts.join('\n').trim();
    if (!prompt) throw new RpcFailure(E_INVALID_PARAMS, 'empty prompt');

    // The turn's completion signal is the bus's TERMINAL `stop` frame — registry.drive()
    // guarantees one on every path (normal stop, interrupt, build failure, turn throw).
    // Subscribe BEFORE submit so no path can finish between accept and listen.
    let offStop: (() => void) | undefined;
    const stopped = new Promise<StopReasonExt>((resolveStop) => {
      offStop = session.bus.on((e) => {
        if (e.type !== 'stop') return;
        offStop?.();
        resolveStop(e.reason);
      });
    });

    const accepted = await deps.registry.submit(id, prompt);
    if (!accepted.ok) {
      offStop?.();
      throw new RpcFailure(accepted.code === 404 ? E_INVALID_PARAMS : E_INTERNAL, accepted.reason);
    }
    const reason = await stopped;
    return { stopReason: toAcpStopReason(reason) };
  }

  return {
    async handleRequest(method: string, params: unknown): Promise<unknown> {
      switch (method) {
        case M_INITIALIZE:
          return {
            protocolVersion: ACP_PROTOCOL_VERSION,
            agentCapabilities: {
              loadSession: false,
              promptCapabilities: { image: false, audio: false, embeddedContext: false },
            },
            authMethods: [],
            agentInfo: { name: AGENT_NAME, version: deps.version },
          };
        case M_AUTHENTICATE:
          throw unsupported(method, 'Shadow resolves credentials from its own vault/env, never from the editor');
        case M_SESSION_NEW:
          return sessionNew(params);
        case M_SESSION_LOAD:
          throw unsupported(method, 'no session persistence in v0; create a new session');
        case M_SESSION_PROMPT:
          return sessionPrompt(params);
        case M_SESSION_SET_MODE:
          throw unsupported(method, 'no modes advertised (v0)');
        case M_SESSION_SET_MODEL:
          throw unsupported(method, 'no models advertised (v0); the model comes from Shadow config');
        default:
          throw new RpcFailure(E_METHOD_NOT_FOUND, `unknown method: ${method}`);
      }
    },

    handleNotification(method: string, params: unknown): void {
      if (method !== M_SESSION_CANCEL) return; // unknown notifications are dropped per JSON-RPC
      const id = (params as { sessionId?: unknown } | undefined)?.sessionId;
      if (typeof id === 'string' && id) deps.registry.interrupt(id);
    },

    gateFor(session: WebSession): ApprovalGate {
      return new AcpPermissionGate(
        session.id,
        deps.askPermission,
        // Surface gate notices on the session bus → they reach the editor as thought chunks.
        (title, body) => session.bus.emit({ type: 'finding', title, body, severity: 'warn' }),
      );
    },

    async close(): Promise<void> {
      for (const off of subscriptions.values()) off();
      subscriptions.clear();
      await deps.registry.closeAll();
    },
  };
}
