/**
 * OpenAI Responses API adapter (`/v1/responses`) for Codex-class backends.
 * Maps the same provider-neutral CompletionRequest as the Chat Completions path.
 */
import {
  estimateTokensFromMessages,
  type CompletionRequest,
  type Provider,
  type ProviderEvent,
  type StopReason,
} from './provider.js';
import { streamWithRetry } from './stream.js';
import { buildOpenAIBody, toOpenAIMessages } from './openai.js';
import { parseToolArgs } from './toolJson.js';
import { ThinkingSplitter } from '../util/thinkingTags.js';

const DEFAULT_BASE_URL = 'https://api.openai.com/v1';

/** Build a Responses API body from a completion request. */
export function buildResponsesBody(req: CompletionRequest, fallbackModel: string, stream = true): Record<string, unknown> {
  const chat = buildOpenAIBody(req, fallbackModel, false);
  const input = (chat.messages as unknown[]) ?? toOpenAIMessages(req);
  const body: Record<string, unknown> = {
    model: chat.model ?? fallbackModel,
    input,
    stream,
  };
  // /v1/responses wants tools FLATTENED ({type,name,description,parameters}), not the Chat-Completions
  // nesting ({type:'function', function:{name,...}}) that buildOpenAIBody produces — otherwise the API
  // 400s any request that carries tools.
  if (chat.tools) {
    body.tools = (chat.tools as Array<{ type?: string; function?: { name?: string; description?: string; parameters?: unknown } }>).map((t) =>
      t.function
        ? { type: 'function', name: t.function.name, description: t.function.description, parameters: t.function.parameters }
        : t,
    );
  }
  if (chat.tool_choice) body.tool_choice = chat.tool_choice;
  if (chat.max_completion_tokens) body.max_output_tokens = chat.max_completion_tokens;
  else if (chat.max_tokens) body.max_output_tokens = chat.max_tokens;
  if (chat.reasoning_effort) body.reasoning = { effort: chat.reasoning_effort };
  return body;
}

interface ResponsesOutputItem {
  type?: string;
  name?: string;
  call_id?: string;
  arguments?: string;
  content?: Array<{ type?: string; text?: string }>;
}

interface ResponsesPayload {
  status?: string;
  output?: ResponsesOutputItem[];
  usage?: {
    input_tokens?: number;
    output_tokens?: number;
    input_tokens_details?: { cached_tokens?: number };
  };
  error?: { message?: string; code?: string | number; type?: string };
}

interface ResponsesSSE {
  type?: string;
  delta?: string;
  response?: ResponsesPayload;
  error?: { message?: string; code?: string | number; type?: string };
}

function* yieldSplitSpans(splitter: ThinkingSplitter): Generator<ProviderEvent> {
  for (const span of splitter.flush()) {
    yield span.kind === 'thinking' ? { type: 'thinking', delta: span.text } : { type: 'text', delta: span.text };
  }
}

function* yieldTextThroughSplitter(text: string, splitter: ThinkingSplitter): Generator<ProviderEvent> {
  for (const span of splitter.push(text)) {
    yield span.kind === 'thinking' ? { type: 'thinking', delta: span.text } : { type: 'text', delta: span.text };
  }
}

function* yieldResponsesOutputItems(
  output: ResponsesOutputItem[],
  opts: { emitText: boolean; splitter?: ThinkingSplitter },
  calls: Map<string, { id: string; name: string; args: string }>,
  keySeq: { n: number },
): Generator<ProviderEvent> {
  const splitter = opts.splitter ?? new ThinkingSplitter();
  for (const item of output) {
    if (opts.emitText && item.type === 'message') {
      for (const c of item.content ?? []) {
        if (c.type === 'output_text' && c.text) yield* yieldTextThroughSplitter(c.text, splitter);
      }
    }
    if (item.type === 'function_call' || item.type === 'tool_call') {
      const id = item.call_id ?? `call_${keySeq.n++}`;
      const name = item.name ?? '';
      const args = item.arguments ?? '';
      calls.set(id, { id, name, args });
    }
  }
}

function readResponsesUsage(usage: ResponsesPayload['usage']): {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
} {
  if (!usage) return { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0 };
  const cached = usage.input_tokens_details?.cached_tokens ?? 0;
  const inputTokens =
    typeof usage.input_tokens === 'number' ? Math.max(0, usage.input_tokens - cached) : 0;
  const outputTokens = typeof usage.output_tokens === 'number' ? usage.output_tokens : 0;
  return { inputTokens, outputTokens, cacheReadTokens: cached };
}

/** Terminal usage + done — always emitted so non-stream matches SSE turn shape. */
function* finishResponsesTurn(
  stopReason: StopReason,
  usage: { inputTokens: number; outputTokens: number; cacheReadTokens: number },
): Generator<ProviderEvent> {
  yield {
    type: 'usage',
    inputTokens: usage.inputTokens,
    outputTokens: usage.outputTokens,
    cacheReadTokens: usage.cacheReadTokens,
  };
  yield { type: 'done', stopReason };
}

function* yieldResponsesToolCalls(
  calls: Map<string, { id: string; name: string; args: string }>,
  keySeq: { n: number },
): Generator<ProviderEvent> {
  for (const c of calls.values()) {
    if (!c.name) continue;
    const parsed = parseToolArgs(c.args);
    if (parsed.ok) yield { type: 'tool_call', call: { id: c.id || `call_${keySeq.n++}`, name: c.name, input: parsed.value } };
    else
      yield {
        type: 'error',
        recoverable: true,
        code: 'bad_tool_json',
        message: `tool "${c.name}" ${parsed.error}`,
      };
  }
}

/**
 * Parse a complete Responses API JSON body (non-stream fallback) into ProviderEvents.
 * Handles both bare response objects and `{ response: … }` envelopes.
 */
export function* eventsFromResponsesCompletion(obj: unknown): Generator<ProviderEvent> {
  const root = obj as Record<string, unknown>;
  const body = (
    root.response && typeof root.response === 'object' ? root.response : root
  ) as ResponsesPayload;

  const err = body.error ?? (root.error as ResponsesPayload['error']);
  if (err) {
    yield {
      type: 'error',
      recoverable: true,
      code: String(err.code ?? err.type ?? 'provider_error'),
      message: String(err.message ?? 'responses error'),
    };
    yield* finishResponsesTurn('end_turn', { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0 });
    return;
  }

  let stopReason: StopReason = 'end_turn';
  const calls = new Map<string, { id: string; name: string; args: string }>();
  const keySeq = { n: 0 };
  const { inputTokens, outputTokens, cacheReadTokens } = readResponsesUsage(body.usage);

  const splitter = new ThinkingSplitter();
  yield* yieldResponsesOutputItems(body.output ?? [], { emitText: true, splitter }, calls, keySeq);
  yield* yieldSplitSpans(splitter);
  yield* yieldResponsesToolCalls(calls, keySeq);

  if (calls.size > 0 && stopReason === 'end_turn') stopReason = 'tool_use';
  if (body.status === 'failed') stopReason = 'end_turn';

  yield* finishResponsesTurn(stopReason, { inputTokens, outputTokens, cacheReadTokens });
}

/** Parse Responses API SSE lines into ProviderEvents. */
export async function* parseResponsesSSE(lines: AsyncIterable<string>): AsyncIterable<ProviderEvent> {
  let inputTokens = 0;
  let outputTokens = 0;
  let cacheReadTokens = 0;
  let stopReason: StopReason = 'end_turn';
  const calls = new Map<string, { id: string; name: string; args: string }>();
  const keySeq = { n: 0 };
  let streamedOutputText = false;
  const splitter = new ThinkingSplitter();

  for await (const rawLine of lines) {
    const line = rawLine.trim();
    if (!line.startsWith('data:')) continue;
    const payload = line.slice(5).trim();
    if (!payload || payload === '[DONE]') continue;
    let obj: ResponsesSSE;
    try {
      obj = JSON.parse(payload) as ResponsesSSE;
    } catch {
      continue;
    }

    if (obj.error) {
      yield {
        type: 'error',
        recoverable: true,
        code: String(obj.error.code ?? obj.error.type ?? 'provider_stream_error'),
        message: String(obj.error.message ?? 'responses stream error'),
      };
      continue;
    }

    if (obj.type === 'response.output_text.delta' && obj.delta) {
      streamedOutputText = true;
      yield* yieldTextThroughSplitter(obj.delta, splitter);
    }

    if (obj.type === 'response.function_call_arguments.delta') {
      const key = `k${keySeq.n}`;
      if (!calls.has(key)) calls.set(key, { id: `call_${keySeq.n}`, name: '', args: '' });
      const cur = calls.get(key)!;
      if (typeof obj.delta === 'string') cur.args += obj.delta;
    }

    if (obj.type === 'response.completed' && obj.response) {
      const u = readResponsesUsage(obj.response.usage);
      inputTokens = u.inputTokens;
      outputTokens = u.outputTokens;
      cacheReadTokens = u.cacheReadTokens;
      yield* yieldResponsesOutputItems(
        obj.response.output ?? [],
        { emitText: !streamedOutputText, splitter },
        calls,
        keySeq,
      );
      if (obj.response.status === 'failed') stopReason = 'end_turn';
    }
  }

  yield* yieldSplitSpans(splitter);
  yield* yieldResponsesToolCalls(calls, keySeq);

  if (calls.size > 0 && stopReason === 'end_turn') stopReason = 'tool_use';
  yield* finishResponsesTurn(stopReason, { inputTokens, outputTokens, cacheReadTokens });
}

export class ResponsesProvider implements Provider {
  /** Provider family for logging/budget (same config slot as chat-completions). */
  readonly name = 'openai';
  /** Wire discriminator — `/v1/responses` vs `/v1/chat/completions`. */
  readonly wire = 'responses' as const;
  private readonly apiKey: string | undefined;
  private readonly baseUrl: string;
  private readonly model: string;

  constructor(opts: { apiKey?: string; baseUrl?: string; model: string }) {
    this.apiKey = opts.apiKey;
    this.baseUrl = (opts.baseUrl ?? DEFAULT_BASE_URL).replace(/\/+$/, '');
    this.model = opts.model;
  }

  estimateTokens(messages: import('./provider.js').Message[]): number {
    return estimateTokensFromMessages(messages);
  }

  async *send(req: CompletionRequest): AsyncIterable<ProviderEvent> {
    const model = req.model || this.model;
    const headers: Record<string, string> = { 'content-type': 'application/json' };
    if (this.apiKey) headers.Authorization = `Bearer ${this.apiKey}`;
    yield* streamWithRetry({
      url: `${this.baseUrl}/responses`,
      headers,
      body: buildResponsesBody(req, model, true),
      parse: parseResponsesSSE,
      signal: req.signal,
      nonStreamBody: buildResponsesBody(req, model, false),
      parseNonStream: eventsFromResponsesCompletion,
    });
  }
}

/** Select wire API from env: `responses` uses the Responses endpoint; default chat. */
export function useResponsesWire(): boolean {
  return process.env.SHADOW_WIRE_API === 'responses';
}