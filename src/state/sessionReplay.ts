import type { Message, ToolUseBlock } from '../provider/provider.js';
import { redact } from '../util/redact.js';
import { approvalText } from '../util/approvalText.js';

export type ReplayItem =
  | { kind: 'user' | 'assistant' | 'reasoning'; text: string }
  | { kind: 'tool'; call: { name: string; input: unknown }; result: { ok: boolean; summary: string; data: { stdout: string } }; unavailable: boolean };

const OUTPUT_LIMIT = 12_000;
export const HISTORICAL_OUTPUT_UNAVAILABLE = '[Historical tool output unavailable in this saved context]';

/** Pure recorded-data replay: no provider, tool registry, process launch, or file mutation. */
export function sessionReplay(messages: Message[]): ReplayItem[] {
  const out: ReplayItem[] = [];
  const calls = new Map<string, ToolUseBlock>();
  const resultIds = new Set(messages.flatMap((message) => message.content
    .filter((block) => block.type === 'tool_result').map((block) => block.toolCallId)));
  const safe = (text: string) => (redact(text) as string).split('\n').map((line) => approvalText(line)).join('\n');
  const safeInput = (input: unknown): unknown => {
    if (typeof input === 'string') return safe(input);
    if (Array.isArray(input)) return input.map(safeInput);
    if (input && typeof input === 'object') return Object.fromEntries(Object.entries(input).map(([key, value]) => [safe(key), safeInput(value)]));
    return input;
  };
  const tool = (id: string, ok: boolean, content: string) => {
    const call = calls.get(id);
    const unavailable = !content.trim() || content.includes('[Old tool result content cleared]');
    const clean = unavailable ? HISTORICAL_OUTPUT_UNAVAILABLE : safe(content);
    const body = clean.length > OUTPUT_LIMIT ? `${clean.slice(0, OUTPUT_LIMIT)}\n[Historical display truncated at ${OUTPUT_LIMIT} characters]` : clean;
    out.push({ kind: 'tool', call: { name: safe(call?.name ?? 'unknown tool'), input: safeInput(redact(call?.input ?? {})) },
      result: { ok, summary: unavailable ? HISTORICAL_OUTPUT_UNAVAILABLE : body.split('\n')[0]!, data: { stdout: body } }, unavailable });
  };
  for (const message of messages) {
    if (message.role === 'assistant' && !message.content.some((block) => block.type === 'thinking') && message.providerReasoning?.text) {
      out.push({ kind: 'reasoning', text: safe(message.providerReasoning.text) });
    }
    const hasResults = message.content.some((block) => block.type === 'tool_result');
    for (const block of message.content) {
      if (block.type === 'thinking' && message.role === 'assistant') out.push({ kind: 'reasoning', text: safe(block.thinking) });
      else if (block.type === 'text' && block.text.trim() && (message.role === 'assistant' || (message.role === 'user' && !hasResults))) {
        out.push({ kind: message.role as 'assistant' | 'user', text: safe(block.text) });
      } else if (block.type === 'tool_use') {
        calls.set(block.id, block);
        if (!resultIds.has(block.id)) tool(block.id, false, '');
      } else if (block.type === 'tool_result') tool(block.toolCallId, block.ok, block.content);
    }
  }
  return out;
}
