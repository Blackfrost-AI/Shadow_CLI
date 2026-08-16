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
export const M_SESSION_SET_MODE = 'session/set_mode';
export const M_SESSION_SET_MODEL = 'session/set_model';

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

/** v0 accepts TEXT ONLY; anything else is refused (see promptCapabilities). */
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
