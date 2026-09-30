/**
 * The ACP method router + session manager. Composition root for `shadow acp`: owns the mapping
 * between ACP requests and the web-console machinery (registry + run lock + jail), and NOTHING
 * else — transport is the injected RpcPeer seam, agent building is the registry's injected
 * builder, the trust boundary is the injected resolveJail.
 *
 * Unsupported methods fail with `-32601` and a reason that says exactly what is unsupported.
 * ACP v1 capabilities, persisted session loading, modes, and model options are advertised by
 * `initialize`; Shadow's versioned `_shadow/work/*` extension exposes Work Center state.
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
  M_SESSION_CLOSE,
  M_SESSION_LOAD,
  M_SESSION_NEW,
  M_SESSION_PROMPT,
  M_SESSION_SET_MODE,
  M_SESSION_SET_MODEL,
  M_SESSION_SET_CONFIG_OPTION,
  M_SHADOW_WORK_LIST,
  M_SHADOW_WORK_CONTROL,
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
import { loadConfig } from '../config.js';
import { SessionLog } from '../state/session.js';
import { resumeSession } from '../state/resume.js';
import { readLatestWorkCenterSnapshot } from '../state/workCenterPersistence.js';

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

  const modeState = (session: WebSession) => ({
    currentModeId: session.autonomy(),
    availableModes: [
      { id: 'manual', name: 'Manual', description: 'Ask before write, execution, and network actions.' },
      { id: 'auto-edit', name: 'Auto edit', description: 'Allow reads and workspace edits; gate execution and network actions.' },
      { id: 'full', name: 'Full', description: 'Allow normal actions while retaining the denylist and jail.' },
    ],
  });

  const modelOptions = (session: WebSession) => {
    const cfg = loadConfig(session.displayPath);
    const models = cfg.models ?? [];
    if (!models.length) return [];
    const current = session.model()
      || models.find((entry) => entry.provider === cfg.provider && entry.model === cfg.model)?.label
      || cfg.model;
    return [{
      id: 'model',
      name: 'Model',
      description: 'Model preset for this session (change before the first prompt).',
      category: 'model',
      type: 'select',
      currentValue: current,
      options: models.map((entry) => ({ value: entry.label, name: entry.label || entry.model })),
    }];
  };

  const sessionResponse = (session: WebSession) => ({
    sessionId: session.id,
    modes: modeState(session),
    configOptions: modelOptions(session),
  });

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
        // ACP adapter decision: auto-edit with the ACP permission gate — what reaches the gate is
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
    return sessionResponse(session);
  }

  function sessionLoad(params: unknown): Record<string, unknown> {
    const p = (params ?? {}) as { sessionId?: unknown; cwd?: unknown; mcpServers?: unknown; additionalDirectories?: unknown };
    if (typeof p.sessionId !== 'string' || !p.sessionId) throw new RpcFailure(E_INVALID_PARAMS, 'sessionId is required');
    const cwd = typeof p.cwd === 'string' && p.cwd.trim() ? p.cwd : process.cwd();
    if (Array.isArray(p.mcpServers) && p.mcpServers.length) {
      throw new RpcFailure(E_INVALID_PARAMS, 'client-supplied MCP servers are not accepted; configure trusted MCP servers in Shadow');
    }
    if (Array.isArray(p.additionalDirectories) && p.additionalDirectories.length) {
      throw new RpcFailure(E_INVALID_PARAMS, 'additionalDirectories are not supported by this adapter');
    }
    let jail: JailCapability;
    try { jail = resolve(cwd); } catch (err) {
      throw new RpcFailure(E_INVALID_PARAMS, err instanceof Error ? err.message : String(err));
    }
    const path = SessionLog.list(jail.workspaceRoot).find((candidate) => {
      const id = SessionLog.sessionIdFromPath(candidate);
      return id === p.sessionId || id.endsWith(p.sessionId as string) || candidate === p.sessionId;
    });
    if (!path) throw new RpcFailure(E_INVALID_PARAMS, `unknown persisted session: ${p.sessionId}`);
    const storedId = SessionLog.sessionIdFromPath(path);
    let session: WebSession;
    try {
      session = deps.registry.create({
        id: storedId,
        projectRoot: jail.workspaceRoot,
        title: basename(jail.workspaceRoot),
        origin: 'acp',
        autonomy: 'auto-edit',
        resumeSessionPath: path,
      });
    } catch (err) {
      throw new RpcFailure(E_INTERNAL, err instanceof Error ? err.message : String(err));
    }
    const off = session.bus.on((e) => {
      const update = mapEventToUpdate(e);
      if (update) deps.notify(M_SESSION_UPDATE, { sessionId: session.id, update: redact(update) });
    });
    subscriptions.set(session.id, off);
    session.workCenter.restore(readLatestWorkCenterSnapshot(path));
    try {
      const cfg = loadConfig(jail.workspaceRoot);
      const { context } = resumeSession(path, {
        contextBudget: cfg.contextBudget,
        triggerRatio: cfg.summarizeTriggerRatio,
        keepLastTurns: cfg.keepLastTurns,
      });
      for (const message of context.messages()) {
        const text = message.content.filter((block) => block.type === 'text').map((block) => block.text).join('\n');
        if (!text) continue;
        deps.notify(M_SESSION_UPDATE, {
          sessionId: session.id,
          update: redact({
            sessionUpdate: message.role === 'user' ? 'user_message_chunk' : 'agent_message_chunk',
            content: { type: 'text', text },
          }),
        });
      }
    } catch (err) {
      void deps.registry.remove(session.id);
      subscriptions.delete(session.id);
      off();
      throw new RpcFailure(E_INTERNAL, `failed to load session: ${err instanceof Error ? err.message : String(err)}`);
    }
    const response = sessionResponse(session);
    delete (response as { sessionId?: string }).sessionId;
    return response;
  }

  async function sessionPrompt(params: unknown): Promise<Record<string, unknown>> {
    const p = (params ?? {}) as SessionPromptParams;
    const id = p.sessionId;
    if (typeof id !== 'string' || !id) throw new RpcFailure(E_INVALID_PARAMS, 'sessionId is required');
    const session = deps.registry.get(id);
    if (!session) throw new RpcFailure(E_INVALID_PARAMS, `unknown session: ${id}`);

    // This ACP v1 adapter is TEXT-ONLY and says so in initialize
    // (image/audio/embeddedContext false). A non-text
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
          `unsupported content block "${String((block as { type?: unknown })?.type)}" — this adapter accepts text only`,
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
              loadSession: true,
              promptCapabilities: { image: false, audio: false, embeddedContext: false },
              sessionCapabilities: { close: {} },
              _meta: { shadowWorkExtension: 1 },
            },
            authMethods: [],
            agentInfo: { name: AGENT_NAME, version: deps.version },
          };
        case M_AUTHENTICATE:
          throw unsupported(method, 'Shadow resolves credentials from its own vault/env, never from the editor');
        case M_SESSION_NEW:
          return sessionNew(params);
        case M_SESSION_LOAD:
          return sessionLoad(params);
        case M_SESSION_PROMPT:
          return sessionPrompt(params);
        case M_SESSION_CLOSE:
          {
            const id = (params as { sessionId?: unknown } | undefined)?.sessionId;
            if (typeof id !== 'string' || !id) throw new RpcFailure(E_INVALID_PARAMS, 'sessionId is required');
            const off = subscriptions.get(id);
            off?.();
            subscriptions.delete(id);
            if (!(await deps.registry.remove(id))) throw new RpcFailure(E_INVALID_PARAMS, 'unknown session');
            return {};
          }
        case M_SESSION_SET_MODE:
          {
            const p = (params ?? {}) as { sessionId?: unknown; modeId?: unknown };
            if (typeof p.sessionId !== 'string' || typeof p.modeId !== 'string') throw new RpcFailure(E_INVALID_PARAMS, 'sessionId and modeId are required');
            if (!['manual', 'auto-edit', 'full'].includes(p.modeId)) throw new RpcFailure(E_INVALID_PARAMS, 'unknown modeId');
            if (!deps.registry.setAutonomy(p.sessionId, p.modeId as 'manual' | 'auto-edit' | 'full')) throw new RpcFailure(E_INVALID_PARAMS, 'unknown or read-only session');
            deps.notify(M_SESSION_UPDATE, { sessionId: p.sessionId, update: { sessionUpdate: 'current_mode_update', currentModeId: p.modeId } });
            return {};
          }
        case M_SESSION_SET_MODEL:
          {
            const p = (params ?? {}) as { sessionId?: unknown; modelId?: unknown };
            if (typeof p.sessionId !== 'string' || typeof p.modelId !== 'string') throw new RpcFailure(E_INVALID_PARAMS, 'sessionId and modelId are required');
            const session = deps.registry.get(p.sessionId);
            if (!session) throw new RpcFailure(E_INVALID_PARAMS, 'unknown session');
            const models = loadConfig(session.displayPath).models ?? [];
            // Standard config-option values are preset labels. Keep accepting the legacy raw
            // wire id when it names exactly one preset, then normalize to the label so duplicate
            // model ids on different endpoints never select the wrong credential/base URL.
            const exact = models.find((entry) => entry.label === p.modelId);
            const byWire = models.filter((entry) => entry.model === p.modelId);
            const selected = exact ?? (byWire.length === 1 ? byWire[0] : undefined);
            if (!selected) throw new RpcFailure(E_INVALID_PARAMS, 'unknown or ambiguous model preset');
            if (!deps.registry.setModel(p.sessionId, selected.label)) throw new RpcFailure(E_INVALID_PARAMS, 'model can only change before the first prompt');
            return {};
          }
        case M_SESSION_SET_CONFIG_OPTION:
          {
            const p = (params ?? {}) as { sessionId?: unknown; configId?: unknown; value?: unknown };
            if (p.configId !== 'model') throw new RpcFailure(E_INVALID_PARAMS, 'unknown configId');
            return this.handleRequest(M_SESSION_SET_MODEL, { sessionId: p.sessionId, modelId: p.value });
          }
        case M_SHADOW_WORK_LIST:
          {
            const p = (params ?? {}) as { sessionId?: unknown; workId?: unknown };
            if (typeof p.sessionId !== 'string') throw new RpcFailure(E_INVALID_PARAMS, 'sessionId is required');
            const session = deps.registry.get(p.sessionId);
            if (!session) throw new RpcFailure(E_INVALID_PARAMS, 'unknown session');
            if (typeof p.workId === 'string') return { version: 1, item: session.workCenter.get(p.workId) ?? null };
            return { version: 1, items: session.workCenter.list() };
          }
        case M_SHADOW_WORK_CONTROL:
          {
            const p = (params ?? {}) as { sessionId?: unknown; workId?: unknown; action?: unknown; confirm?: unknown; priority?: unknown };
            if (typeof p.sessionId !== 'string' || typeof p.workId !== 'string' || typeof p.action !== 'string') throw new RpcFailure(E_INVALID_PARAMS, 'sessionId, workId, and action are required');
            const session = deps.registry.get(p.sessionId);
            const item = session?.workCenter.get(p.workId);
            if (!session || !item) throw new RpcFailure(E_INVALID_PARAMS, 'unknown session or work item');
            if (p.action === 'kill') {
              if (item.type !== 'bgshell' || item.status !== 'running' || !session.agent?.bg.kill(item.id)) throw new RpcFailure(E_INVALID_PARAMS, 'item is not a running background shell');
            } else if (p.action === 'cancel' || p.action === 'pause' || p.action === 'resume') {
              if (item.type !== 'subagent' || !item.background) throw new RpcFailure(E_INVALID_PARAMS, 'item is not a controllable background subagent');
              if (p.action === 'cancel' && !['queued', 'running', 'paused'].includes(item.status)) throw new RpcFailure(E_INVALID_PARAMS, `cannot cancel ${item.status} subagent`);
              if (p.action === 'pause' && !['queued', 'running'].includes(item.status)) throw new RpcFailure(E_INVALID_PARAMS, `cannot pause ${item.status} subagent`);
              if (p.action === 'resume' && item.status !== 'paused' && item.currentActivity !== 'pause requested') throw new RpcFailure(E_INVALID_PARAMS, 'subagent is not paused');
              session.bus.emit({ type: p.action === 'cancel' ? 'cancel_subagent' : p.action === 'pause' ? 'pause_subagent' : 'resume_subagent', taskId: item.id });
            } else if (p.action === 'retry') {
              if (p.confirm !== true) throw new RpcFailure(E_INVALID_PARAMS, 'retry requires confirm:true because it may duplicate external effects');
              if (
                item.type !== 'subagent'
                || !['completed', 'failed', 'cancelled'].includes(item.status)
                || !item.retryable
                || (item.retryCount ?? 0) >= 3
              ) throw new RpcFailure(E_INVALID_PARAMS, 'item cannot be retried');
              session.bus.emit({ type: 'retry_subagent', taskId: item.id });
            } else if (p.action === 'priority') {
              if (item.type !== 'subagent' || item.status !== 'queued' || !['low', 'normal', 'high'].includes(String(p.priority))) throw new RpcFailure(E_INVALID_PARAMS, 'priority requires a queued subagent and low|normal|high');
              session.bus.emit({ type: 'set_subagent_priority', taskId: item.id, priority: p.priority as 'low' | 'normal' | 'high' });
            } else {
              throw new RpcFailure(E_INVALID_PARAMS, 'unknown work action');
            }
            return { accepted: true };
          }
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
