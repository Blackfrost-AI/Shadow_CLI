/**
 * Non-streaming response parsers — map a complete JSON message/completion into
 * the same ProviderEvent sequence the SSE parsers emit, so streamWithRetry can
 * fall back without the agent loop knowing which transport was used.
 */
import type { ProviderEvent, StopReason } from './provider.js';
import { parseToolArgs } from './toolJson.js';
import { ThinkingSplitter } from '../util/thinkingTags.js';

interface AntContentBlock {
  type?: string;
  text?: string;
  thinking?: string;
  signature?: string;
  data?: string; // redacted_thinking payload
  id?: string;
  name?: string;
  input?: unknown;
}

interface AntMessage {
  content?: AntContentBlock[];
  stop_reason?: string;
  usage?: {
    input_tokens?: number;
    output_tokens?: number;
    cache_read_input_tokens?: number;
    cache_creation_input_tokens?: number;
  };
  error?: { type?: string; message?: string };
}

interface OAICompletion {
  error?: { message?: string; code?: string | number; type?: string };
  choices?: {
    message?: {
      content?: string | null;
      reasoning_content?: string;
      reasoning?: string;
      tool_calls?: {
        id?: string;
        type?: string;
        function?: { name?: string; arguments?: string };
        extra_content?: { google?: { thought_signature?: string } };
      }[];
    };
    finish_reason?: string | null;
  }[];
  usage?: {
    prompt_tokens?: number;
    completion_tokens?: number;
    prompt_tokens_details?: { cached_tokens?: number };
  };
}

/** Parse a complete Anthropic Messages API JSON body into ProviderEvents. */
export function* eventsFromAnthropicMessage(msg: unknown): Generator<ProviderEvent> {
  const m = msg as AntMessage;
  if (m.error) {
    const code = m.error.type ?? 'api_error';
    const recoverable = code === 'overloaded_error' || code === 'api_error';
    yield { type: 'error', recoverable, code, message: m.error.message ?? 'api error' };
    return;
  }

  let stopReason: StopReason = 'end_turn';
  let sawToolUse = false;

  for (const block of m.content ?? []) {
    switch (block.type) {
      case 'text':
        if (typeof block.text === 'string' && block.text) {
          yield { type: 'text', delta: block.text };
        }
        break;
      case 'thinking': {
        const thinking = block.thinking ?? '';
        const signature = block.signature ?? '';
        if (thinking) yield { type: 'thinking', delta: thinking };
        if (thinking || signature) yield { type: 'thinking_block', thinking, signature };
        break;
      }
      case 'redacted_thinking': {
        const data = block.data ?? '';
        if (data) yield { type: 'redacted_thinking_block', data };
        break;
      }
      case 'tool_use': {
        sawToolUse = true;
        const name = block.name ?? '';
        const id = block.id ?? '';
        const raw = block.input;
        const args =
          raw === undefined || raw === null
            ? '{}'
            : typeof raw === 'string'
              ? raw
              : JSON.stringify(raw);
        const parsed = parseToolArgs(args);
        if (parsed.ok) {
          yield { type: 'tool_call', call: { id, name, input: parsed.value } };
        } else {
          yield {
            type: 'error',
            recoverable: true,
            code: 'bad_tool_json',
            message: `tool "${name}" ${parsed.error}`,
          };
        }
        break;
      }
      default:
        break;
    }
  }

  const u = m.usage;
  const inputTokens = typeof u?.input_tokens === 'number' ? u.input_tokens : 0;
  const outputTokens = typeof u?.output_tokens === 'number' ? u.output_tokens : 0;
  const cacheReadTokens = typeof u?.cache_read_input_tokens === 'number' ? u.cache_read_input_tokens : 0;
  const cacheWriteTokens =
    typeof u?.cache_creation_input_tokens === 'number' ? u.cache_creation_input_tokens : 0;

  if (m.stop_reason) stopReason = mapAnthropicStop(m.stop_reason);
  if (sawToolUse && stopReason === 'end_turn') stopReason = 'tool_use';

  yield { type: 'usage', inputTokens, outputTokens, cacheReadTokens, cacheWriteTokens };
  yield { type: 'done', stopReason };
}

/** Parse a complete OpenAI Chat Completions JSON body into ProviderEvents. */
export function* eventsFromOpenAICompletion(obj: unknown): Generator<ProviderEvent> {
  const o = obj as OAICompletion;

  if (o.error) {
    const message = o.error.message ?? 'provider returned an error';
    const code = o.error.code ?? o.error.type ?? 'provider_error';
    yield { type: 'error', recoverable: true, code: String(code), message: String(message) };
    return;
  }

  let inputTokens = 0;
  let outputTokens = 0;
  let cacheReadTokens = 0;
  let stopReason: StopReason = 'end_turn';
  const splitter = new ThinkingSplitter();

  if (o.usage) {
    const cached = o.usage.prompt_tokens_details?.cached_tokens ?? 0;
    cacheReadTokens = cached;
    if (typeof o.usage.prompt_tokens === 'number') inputTokens = Math.max(0, o.usage.prompt_tokens - cached);
    if (typeof o.usage.completion_tokens === 'number') outputTokens = o.usage.completion_tokens;
  }

  const choice = o.choices?.[0];
  const message = choice?.message;
  if (message) {
    const reasoning = message.reasoning_content ?? message.reasoning;
    if (typeof reasoning === 'string' && reasoning) yield { type: 'thinking', delta: reasoning };

    if (typeof message.content === 'string' && message.content) {
      for (const span of splitter.push(message.content)) {
        yield span.kind === 'thinking' ? { type: 'thinking', delta: span.text } : { type: 'text', delta: span.text };
      }
    }

    const toolCalls = message.tool_calls ?? [];
    let idx = 0;
    const usedIds = new Set<string>();
    for (const tc of toolCalls) {
      const name = tc.function?.name ?? '';
      const args = tc.function?.arguments ?? '';
      if (!name && !args) continue;
      let id = tc.id || `call_${idx}`;
      while (usedIds.has(id)) id = `call_${idx}_${usedIds.size}`;
      usedIds.add(id);
      const sig = tc.extra_content?.google?.thought_signature;
      const parsed = parseToolArgs(args);
      if (parsed.ok) {
        yield {
          type: 'tool_call',
          call: { id, name, input: parsed.value, ...(typeof sig === 'string' && sig ? { signature: sig } : {}) },
        };
      } else {
        yield {
          type: 'error',
          recoverable: true,
          code: 'bad_tool_json',
          message: `tool "${name}" ${parsed.error}`,
        };
      }
      idx++;
    }

    if (toolCalls.length > 0 && stopReason === 'end_turn') stopReason = 'tool_use';
  }

  if (choice?.finish_reason) stopReason = mapOpenAIFinishLocal(choice.finish_reason);

  for (const span of splitter.flush()) {
    yield span.kind === 'thinking' ? { type: 'thinking', delta: span.text } : { type: 'text', delta: span.text };
  }

  yield { type: 'usage', inputTokens, outputTokens, cacheReadTokens };
  yield { type: 'done', stopReason };
}

function mapAnthropicStop(reason: string): StopReason {
  switch (reason) {
    case 'tool_use':
      return 'tool_use';
    case 'max_tokens':
      return 'max_tokens';
    case 'pause_turn':
      return 'pause_turn';
    case 'end_turn':
    case 'stop_sequence':
    case 'refusal':
    default:
      return 'end_turn';
  }
}

function mapOpenAIFinishLocal(reason: string): StopReason {
  switch (reason) {
    case 'tool_calls':
      return 'tool_use';
    case 'length':
      return 'max_tokens';
    case 'stop':
    case 'content_filter':
    default:
      return 'end_turn';
  }
}