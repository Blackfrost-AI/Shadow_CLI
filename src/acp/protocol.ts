/**
 * Pinned ACP (Agent Client Protocol) surface — the exact wire names this adapter speaks.
 * ACP (agentclientprotocol.org) is JSON-RPC 2.0, one message per line (NDJSON), over stdio:
 * the EDITOR (Zed et al.) is the client, Shadow is the AGENT. Pinning the strings here keeps
 * the wire contract grep-able and test-able in one place — never inline a method name.
 */

/** ACP protocol version this adapter implements (negotiated in `initialize`). */
export const ACP_PROTOCOL_VERSION = 1;

export const AGENT_NAME = 'Shadow CLI';

// --- client → agent ----------------------------------------------------------
export const M_INITIALIZE = 'initialize';
export const M_AUTHENTICATE = 'authenticate';
export const M_SESSION_NEW = 'session/new';
export const M_SESSION_LOAD = 'session/load';
export const M_SESSION_PROMPT = 'session/prompt';
/** A NOTIFICATION (no response) — the editor cancels the running turn. */
export const M_SESSION_CANCEL = 'session/cancel';
export const M_SESSION_CLOSE = 'session/close';
export const M_SESSION_SET_MODE = 'session/set_mode';
export const M_SESSION_SET_MODEL = 'session/set_model';
export const M_SESSION_SET_CONFIG_OPTION = 'session/set_config_option';
/** Versioned Shadow extensions; ACP reserves underscore-prefixed methods for extensions. */
export const M_SHADOW_WORK_LIST = '_shadow/work/list';
export const M_SHADOW_WORK_CONTROL = '_shadow/work/control';
/**
 * m-7 op-cancellation surface (pinned names for the versioned gate). The peer-level
 * mechanism — one AbortController per inbound operation, a cancel method that aborts
 * it and answers with a typed error — is real and tested; NO production handler is
 * registered for `tool_call` today, so `tool_cancel` stays dormant on the live wire
 * until such a surface exists. The real editor cancellation path remains
 * `session/cancel` → registry.interrupt → stopReason `cancelled`.
 */
export const M_TOOL_CALL = 'tool_call';
export const M_TOOL_CANCEL = 'tool_cancel';

// --- agent → client ----------------------------------------------------------
/** Notification carrying one streamed session update (see U_* below). */
export const M_SESSION_UPDATE = 'session/update';
/** Request: the editor answers a tool-approval on the user's behalf. */
export const M_SESSION_REQUEST_PERMISSION = 'session/request_permission';

// --- session/update discriminators --------------------------------------------
export const U_AGENT_MESSAGE_CHUNK = 'agent_message_chunk';
export const U_AGENT_THOUGHT_CHUNK = 'agent_thought_chunk';
export const U_TOOL_CALL = 'tool_call';
export const U_TOOL_CALL_UPDATE = 'tool_call_update';
export const U_PLAN = 'plan';

// --- stopReason values (session/prompt response) -------------------------------
export const STOP_END_TURN = 'end_turn';
export const STOP_CANCELLED = 'cancelled';
export const STOP_MAX_TOKENS = 'max_tokens';
export const STOP_REFUSAL = 'refusal';

// --- tool kinds (tool_call / request_permission) -------------------------------
export type ToolKind = 'read' | 'edit' | 'search' | 'execute' | 'think' | 'other';

// --- JSON-RPC 2.0 error codes (the standard set; ACP adds none) -----------------
export const E_PARSE = -32700;
export const E_INVALID_REQUEST = -32600;
export const E_METHOD_NOT_FOUND = -32601;
export const E_INVALID_PARAMS = -32602;
export const E_INTERNAL = -32603;

// --- m-7 gate: JSON-RPC 2.0 reserves -32000..-32099 for implementation-defined
// server errors. Every refusal below is SPECIFIC (code + message) — never a silent
// drop, and never a generic -32603 that hides which gate fired.
/** A single frame exceeded the transport frame bound — the connection is dead. */
export const E_ACP_FRAME_TOO_LARGE = -32000;
/** The first request was not `initialize` — nothing executes until the handshake does. */
export const E_ACP_INITIALIZE_REQUIRED = -32001;
/** `initialize` named an unsupported protocol version — the connection is dead. */
export const E_ACP_UNSUPPORTED_VERSION = -32002;
/** The method belongs to a capability class the client never negotiated at initialize. */
export const E_ACP_CAPABILITY_NOT_NEGOTIATED = -32003;
/** The peer is at its in-flight bound — the caller must stop reading until it drains. */
export const E_ACP_OVERLOAD = -32004;
/** An in-flight operation was cancelled by the client. */
export const E_ACP_OP_CANCELLED = -32005;
/** A request id was reused for different content. */
export const E_ACP_ID_REUSE = -32006;

// --- payload types --------------------------------------------------------------
export type RpcId = number | string;

export interface RpcErrorBody {
  code: number;
  message: string;
  data?: unknown;
}

export interface RpcMessage {
  jsonrpc: '2.0';
  id?: RpcId | null;
  method?: string;
  params?: unknown;
  result?: unknown;
  error?: RpcErrorBody;
}

export interface AcpTextBlock {
  type: 'text';
  text: string;
}

/** This ACP v1 adapter accepts text only; anything else is refused (see promptCapabilities). */
export type AcpContentBlock = AcpTextBlock | { type: string; [k: string]: unknown };

export interface SessionNewParams {
  cwd?: string;
  mcpServers?: unknown;
}

export interface SessionPromptParams {
  sessionId?: string;
  /** The ContentBlock[] — named `prompt` on the ACP v1 wire (PromptRequest schema). */
  prompt?: AcpContentBlock[];
  /** Legacy alias accepted for older/spec-drift clients; `prompt` wins when both are present. */
  content?: AcpContentBlock[];
}

export interface RequestPermissionOption {
  optionId: string;
  kind: 'reject_once' | 'reject_always' | 'allow_once' | 'allow_always';
  name: string;
}

export interface RequestPermissionParams {
  sessionId: string;
  toolCall: {
    toolCallId: string;
    title: string;
    description: string;
    kind: ToolKind;
    rawInput?: unknown;
  };
  options: RequestPermissionOption[];
}

export interface RequestPermissionResult {
  outcome?: { outcome: 'selected'; optionId: string } | { outcome: 'cancelled' };
}

export interface SessionUpdateNotification {
  sessionId: string;
  update: Record<string, unknown>;
}
