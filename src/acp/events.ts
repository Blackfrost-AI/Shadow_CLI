/**
 * Pure mapper: bus `LoopEvent` → one ACP `session/update` payload (or null when the event has no
 * editor-visible meaning). The ACP server subscribes to each session bus and forwards whatever
 * this returns; keeping it a pure function makes the wire shape pin-able in tests without any
 * transport, registry, or provider.
 *
 * Deliberately NOT mapped (and why):
 *  - `assistant_done` / `reasoning_done` — the full text was already streamed as
 *    `text`/`thinking` deltas; re-emitting would render every answer twice in the editor.
 *  - `shell_output` / `shell_pid` — live shell streaming is deferred (v0 decision: the final
 *    result arrives via `tool_end`; a coalescer would be new machinery).
 *  - `usage` / `latency` / `compaction` / `autonomy` / `mode` / `retry` / `debug` / `stop` /
 *    `user` / `plan_mode` / `subagent_*` / `task_notification` / `cancel_subagent` /
 *    `model_fallback` / `bg_agent_launched` — no ACP update type carries them in v0; `stop`
 *    terminates the `session/prompt` response instead (see server.ts).
 */
import type { LoopEvent } from '../agent/events.js';
import type { ToolCall } from '../provider/provider.js';
import type { ToolRisk } from '../tools/types.js';
import {
  U_AGENT_MESSAGE_CHUNK,
  U_AGENT_THOUGHT_CHUNK,
  U_TOOL_CALL,
  U_TOOL_CALL_UPDATE,
  U_PLAN,
  type ToolKind,
} from './protocol.js';

/** Known tool → ACP kind. Anything unlisted falls through to the risk-based kind. */
const KIND_BY_TOOL: Record<string, ToolKind> = {
  run_shell: 'execute',
  bg_shell: 'execute',
  read_file: 'read',
  view_image: 'read',
  glob: 'search',
  grep: 'search',
  web_fetch: 'search',
  web_search: 'search',
  tool_search: 'search',
  write_file: 'edit',
  edit_file: 'edit',
  multi_edit: 'edit',
  apply_patch: 'edit',
};

/** The loop's risk classes map onto ACP kinds; network has no ACP kind of its own. */
export function riskKind(risk: ToolRisk): ToolKind {
  switch (risk) {
    case 'read':
      return 'read';
    case 'write':
      return 'edit';
    case 'exec':
      return 'execute';
    case 'network':
      return 'other';
  }
}

/** ACP kind for a tool call: the known-tool table first, then the risk class. */
export function toolKindFor(call: ToolCall, risk?: ToolRisk): ToolKind {
  return KIND_BY_TOOL[call.name] ?? (risk ? riskKind(risk) : 'other');
}

/** Sub-agent tool activity is tagged on the bus (SubagentBus); the editor sees it as a prefix. */
export function toolCallTitle(call: ToolCall, subagent?: string): string {
  return subagent ? `[subagent ${subagent}] ${call.name}` : call.name;
}

/** ACP ToolCallContent: the simple text-content variant (no diff/terminal payloads in v0). */
const textContent = (text: string): Record<string, unknown> => ({
  type: 'content',
  content: { type: 'text', text },
});

/**
 * Map one bus event to its `session/update.update` payload, or null. The payload NEVER includes
 * the sessionId — the server wraps it (one session bus ↔ one sessionId).
 */
export function mapEventToUpdate(e: LoopEvent): Record<string, unknown> | null {
  switch (e.type) {
    case 'text':
      return e.delta ? { sessionUpdate: U_AGENT_MESSAGE_CHUNK, content: { type: 'text', text: e.delta } } : null;
    case 'thinking':
      return e.delta ? { sessionUpdate: U_AGENT_THOUGHT_CHUNK, content: { type: 'text', text: e.delta } } : null;
    case 'finding':
      return {
        sessionUpdate: U_AGENT_THOUGHT_CHUNK,
        content: { type: 'text', text: `${e.severity === 'error' ? '[error] ' : ''}${e.title}\n${e.body}` },
      };
    case 'error':
      return { sessionUpdate: U_AGENT_THOUGHT_CHUNK, content: { type: 'text', text: `[error] ${e.message}` } };
    case 'tool_start':
      return {
        sessionUpdate: U_TOOL_CALL,
        toolCallId: e.call.id,
        title: toolCallTitle(e.call, e.subagent),
        kind: toolKindFor(e.call, e.risk),
        status: 'in_progress',
        rawInput: e.call.input,
      };
    case 'tool_end': {
      const text = e.result.ok
        ? e.result.summary
        : (e.result.error?.message ?? e.result.summary ?? 'failed');
      return {
        sessionUpdate: U_TOOL_CALL_UPDATE,
        toolCallId: e.call.id,
        status: e.result.ok ? 'completed' : 'failed',
        ...(text ? { content: [textContent(text)] } : {}),
      };
    }
    case 'tool_denied':
      return {
        sessionUpdate: U_TOOL_CALL_UPDATE,
        toolCallId: e.call.id,
        status: 'failed',
        content: [textContent(`denied: ${e.reason}`)],
      };
    case 'todo':
      // TodoItem.status ('pending' | 'in_progress' | 'completed') is already the ACP plan-entry
      // vocabulary — a 1:1 map.
      return {
        sessionUpdate: U_PLAN,
        entries: e.items.map((i) => ({ content: i.subject, priority: 'medium', status: i.status })),
      };
    default:
      return null;
  }
}
