/**
 * The m-7 ACP gate policy: protocol-version handshake, capability negotiation, and the
 * cancellation surface. Wired ONLY by the production entry point (`shadow acp`, see cli.ts);
 * every other RpcPeer consumer (LSP, MCP endpoint discovery, tests) runs without a policy and
 * gets the transport bounds alone.
 *
 * EDITOR COMPATIBILITY (deliberate, documented): a client that does not negotiate a capability
 * is refused with `capability not negotiated: X` — fail closed by design. Editors that send
 * ACP v1's currently-empty `clientCapabilities: {}` therefore cannot use session/prompt until
 * they declare Shadow's versioned capability set (via `capabilities` or
 * `clientCapabilities._meta.shadowCapabilities`). This is the versioned-hardening contract of
 * this slice, not an oversight: the negotiation names are pinned by test/acp-rpc.test.ts.
 */
import type { RpcPolicy } from './jsonrpc.js';
import type { RpcId } from './protocol.js';
import {
  ACP_PROTOCOL_VERSION,
  M_INITIALIZE,
  M_SESSION_CANCEL,
  M_SESSION_CLOSE,
  M_SESSION_NEW,
  M_SESSION_LOAD,
  M_SESSION_PROMPT,
  M_SESSION_SET_CONFIG_OPTION,
  M_SESSION_SET_MODE,
  M_SESSION_SET_MODEL,
  M_SHADOW_WORK_CONTROL,
  M_SHADOW_WORK_LIST,
  M_TOOL_CALL,
  M_TOOL_CANCEL,
} from './protocol.js';

/** Capability classes a client may negotiate at initialize. */
export const ACP_CAPABILITY_APPROVALS = 'approvals';
export const ACP_CAPABILITY_SESSION = 'session';
export const ACP_CAPABILITY_PROMPT = 'prompt';
export const ACP_CAPABILITY_WORK = 'work';
export const ACP_CAPABILITY_CANCELLATION = 'cancellation';
export const ACP_CAPABILITIES: readonly string[] = [
  ACP_CAPABILITY_APPROVALS,
  ACP_CAPABILITY_SESSION,
  ACP_CAPABILITY_PROMPT,
  ACP_CAPABILITY_WORK,
  ACP_CAPABILITY_CANCELLATION,
];

/** Session-lifecycle methods (the `session` capability class). */
const SESSION_METHODS: readonly string[] = [
  M_SESSION_NEW,
  M_SESSION_LOAD,
  M_SESSION_CLOSE,
  M_SESSION_SET_MODE,
  M_SESSION_SET_MODEL,
  M_SESSION_SET_CONFIG_OPTION,
];

/** The m-7 op-cancellation surface (the `cancellation` capability class). */
const CANCELLATION_METHODS: readonly string[] = [M_SESSION_CANCEL, M_TOOL_CALL, M_TOOL_CANCEL];

/** The m-7 policy object handed to the RpcPeer by cli.ts. */
export function acpPolicy(): RpcPolicy {
  return {
    handshakeMethod: M_INITIALIZE,
    supportedVersions: [ACP_PROTOCOL_VERSION],
    supportedCapabilities: ACP_CAPABILITIES,
    capabilityOf(method: string): string | null {
      if (SESSION_METHODS.includes(method)) return ACP_CAPABILITY_SESSION;
      if (method === M_SESSION_PROMPT) return ACP_CAPABILITY_PROMPT;
      if (method === M_SHADOW_WORK_LIST || method === M_SHADOW_WORK_CONTROL) return ACP_CAPABILITY_WORK;
      if (CANCELLATION_METHODS.includes(method)) return ACP_CAPABILITY_CANCELLATION;
      // `initialize` is handled by the handshake gate; unknown methods are unclassified here and
      // answered -32601 by the server router.
      return null;
    },
    cancelTargets(
      method: string,
      params: unknown,
      liveOps: Array<{ id: RpcId; method: string; params: unknown }>,
    ): { force: RpcId[]; signal: RpcId[] } {
      // session/cancel: cooperative — abort matching prompt ops so a well-behaved handler
      // settles; the REAL turn interruption stays registry.interrupt (server.ts), which this
      // notification still reaches.
      if (method === M_SESSION_CANCEL) {
        const sid = (params as { sessionId?: unknown } | undefined)?.sessionId;
        const targets = liveOps
          .filter((op) => op.method === M_SESSION_PROMPT && (op.params as { sessionId?: unknown } | undefined)?.sessionId === sid)
          .map((op) => op.id);
        return { force: [], signal: targets };
      }
      // tool_cancel: force — the op is aborted AND answered with the typed cancel error, because
      // a stuck tool handler would otherwise never settle on its own.
      if (method === M_TOOL_CANCEL) {
        const toolCallId = (params as { toolCallId?: unknown } | undefined)?.toolCallId;
        const targets = liveOps
          .filter(
            (op) =>
              op.method === M_TOOL_CALL &&
              ((op.params as { toolCallId?: unknown } | undefined)?.toolCallId === toolCallId || op.id === toolCallId),
          )
          .map((op) => op.id);
        return { force: targets, signal: [] };
      }
      return { force: [], signal: [] };
    },
  };
}
