/**
 * OpenAI Chat Completions adapter (`/chat/completions`, streaming). One class
 * covers OpenAI and any OpenAI-compatible endpoint (OpenRouter, Groq, xAI,
 * DeepSeek, Together, local vLLM / LM Studio) — they differ only by baseUrl and
 * key. Differences from Anthropic the mapping handles: the system prompt is a
 * first message, tool calls are `tool_calls` on an assistant message, and each
 * tool RESULT is its own `{role:'tool'}` message (the API cannot batch them).
 *
 * The SSE→ProviderEvent transform is the exported async generator `parseOpenAISSE`
 * (unit-testable, no network); the class wires fetch → line-splitter → parser.
 */
import {
  estimateTokensFromMessages,
  type CompletionRequest,
  type Effort,
  type Message,
  type Provider,
  type ProviderEvent,
  type StopReason,
} from './provider.js';
import { streamWithRetry } from './stream.js';
import { eventsFromOpenAICompletion } from './nonStream.js';
import { parseToolArgs } from './toolJson.js';
import { ThinkingSplitter } from '../util/thinkingTags.js';

const DEFAULT_BASE_URL = 'https://api.openai.com/v1';

export class OpenAIProvider implements Provider {
  readonly name = 'openai';
  private readonly apiKey: string | undefined;
  private readonly baseUrl: string;
  private readonly model: string;

  constructor(opts: { apiKey?: string; baseUrl?: string; model: string }) {
    this.apiKey = opts.apiKey;
    this.baseUrl = (opts.baseUrl ?? DEFAULT_BASE_URL).replace(/\/+$/, '');
    this.model = opts.model;
  }

  estimateTokens(messages: Message[]): number {
    return estimateTokensFromMessages(messages);
  }

  async *send(req: CompletionRequest): AsyncIterable<ProviderEvent> {
    const model = req.model || this.model;
    const headers: Record<string, string> = { 'content-type': 'application/json' };
    if (this.apiKey) headers.Authorization = `Bearer ${this.apiKey}`;
    yield* streamWithRetry({
      url: `${this.baseUrl}/chat/completions`,
      headers,
      body: buildOpenAIBody(req, model, true),
      parse: parseOpenAISSE,
      signal: req.signal,
      nonStreamBody: buildOpenAIBody(req, model, false),
      parseNonStream: eventsFromOpenAICompletion,
    });
  }
}

// ── request shaping ──────────────────────────────────────────────────────────

type OAIContentPart = { type: 'text'; text: string } | { type: 'image_url'; image_url: { url: string } };
type OAIMessage =
  | { role: 'system'; content: string }
  | { role: 'user'; content: string | OAIContentPart[] }
  | {
      role: 'assistant';
      content: string | null;
      tool_calls?: {
        id: string;
        type: 'function';
        function: { name: string; arguments: string };
        extra_content?: { google: { thought_signature: string } };
      }[];
    }
  | { role: 'tool'; tool_call_id: string; content: string };

/** Map the provider-neutral Message[] into OpenAI chat messages. */
export function toOpenAIMessages(req: CompletionRequest): OAIMessage[] {
  const out: OAIMessage[] = [{ role: 'system', content: req.system }];

  for (const m of req.messages) {
    if (m.role === 'system') continue; // system is prepended above; ignore embedded
    if (m.role === 'assistant') {
      let text = '';
      const toolCalls: {
        id: string;
        type: 'function';
        function: { name: string; arguments: string };
        extra_content?: { google: { thought_signature: string } };
      }[] = [];
      for (const b of m.content) {
        if (b.type === 'text') text += b.text;
        else if (b.type === 'tool_use') {
          toolCalls.push({
            id: b.id,
            type: 'function',
            function: { name: b.name, arguments: JSON.stringify(b.input ?? {}) },
            // Echo Gemini's thought_signature back, or multi-turn tool use 400s.
            ...(b.signature ? { extra_content: { google: { thought_signature: b.signature } } } : {}),
          });
        }
      }
      if (toolCalls.length > 0) out.push({ role: 'assistant', content: text || null, tool_calls: toolCalls });
      else out.push({ role: 'assistant', content: text });
    } else {
      // role 'user' or 'tool'. Each tool_result becomes its own tool message;
      // text + images become a single user message. (OpenAI cannot batch tool results.)
      let text = '';
      const images: OAIContentPart[] = [];
      for (const b of m.content) {
        if (b.type === 'tool_result') out.push({ role: 'tool', tool_call_id: b.toolCallId, content: b.content });
        else if (b.type === 'text') text += b.text;
        else if (b.type === 'image') images.push({ type: 'image_url', image_url: { url: `data:${b.mediaType};base64,${b.data}` } });
      }
      if (images.length > 0) {
        // Multimodal: OpenAI/Gemini take an array of content parts (text first, then images).
        const parts: OAIContentPart[] = [];
        if (text) parts.push({ type: 'text', text });
        parts.push(...images);
        out.push({ role: 'user', content: parts });
      } else if (text) {
        out.push({ role: 'user', content: text });
      }
    }
  }
  return out;
}

/** Reasoning models split their output budget between hidden thinking AND the answer, so a small
 *  cap returns an empty turn (all budget spent thinking). Give them generous output headroom; a
 *  larger explicit --max-output-tokens still wins via Math.max. NOTE: 64k is the OUTPUT limit on the
 *  big cloud reasoners (gpt-5/o, Gemini, Grok) but equals the TOTAL context window on some small
 *  local/OpenRouter reasoners (e.g. deepseek-r1 @ 64k) — there this floor overflows the window. The
 *  stream layer catches that 400 and shrinks max_tokens on retry (see looksLikeTokenOverflow), so the
 *  floor stays generous without making small-window models fail on their first turn. */
const REASONING_MAX_TOKENS = 64_000;

/**
 * OpenAI reasoning models (GPT-5 family, o-series) reject `max_tokens` and `temperature`
 * and accept `reasoning_effort`. `gpt-5-chat` is the non-reasoning chat variant — excluded.
 */
export function isOpenAIReasoningModel(model: string): boolean {
  return /(^|[-/])(gpt-5|o[1345])(\b|[-.])/i.test(model) && !/gpt-5-chat/i.test(model);
}

/** Shadow's 5-level effort → OpenAI's 3-level reasoning_effort (xhigh/max collapse to high). */
export function toReasoningEffort(effort: Effort | undefined): 'low' | 'medium' | 'high' {
  return effort === 'low' ? 'low' : effort === 'medium' ? 'medium' : 'high';
}

/**
 * Grok reasoning variants that ACCEPT `reasoning_effort` (grok-3-mini, grok-4-fast-reasoning, …).
 * Deliberately narrow: plain grok-4 auto-reasons and 400s if the param is sent, so it's excluded.
 */
export function isGrokReasoningModel(model: string): boolean {
  // `fast` matches grok-4-fast-non-reasoning too — exclude the explicit non-reasoning variant.
  return /grok/i.test(model) && /(mini|reasoning|fast)/i.test(model) && !/non[-_]?reasoning/i.test(model);
}

/**
 * Gemini reasons invisibly over the OpenAI-compat endpoint but takes `max_tokens` (NOT
 * max_completion_tokens), so without a floor its hidden thinking burns the whole budget and the
 * turn returns empty on a heavy task. `gemma` (a different family) is NOT matched.
 */
export function isGeminiModel(model: string): boolean {
  return /gemini/i.test(model);
}

/** DeepSeek's reasoner (R1 / deepseek-reasoner / R1 distills). Shadow already routes its
 *  reasoning_content to the thinking channel — it just needs the budget floor too. */
export function isDeepSeekReasoner(model: string): boolean {
  // deepseek-reasoner, deepseek-r1, DeepSeek-R1-Distill-* (first), and bare R1 distills (second).
  return /deepseek[-_ ]?r(?:1|easoner)/i.test(model) || /(^|[-_/])r1[-_]?(distill|0528)/i.test(model);
}

/** Qwen's reasoners: QwQ and Qwen3 "thinking" variants. */
export function isQwenReasoner(model: string): boolean {
  return /\bqwq\b/i.test(model) || /qwen[\w.-]*think/i.test(model);
}

/**
 * One place, every family: any model that does HIDDEN reasoning and therefore needs the output
 * budget floored so thinking can't consume it all. Replaces the scattered per-provider checks.
 */
export function isReasoningModel(model: string): boolean {
  return (
    isOpenAIReasoningModel(model) ||
    isGrokReasoningModel(model) ||
    isGeminiModel(model) ||
    isDeepSeekReasoner(model) ||
    isQwenReasoner(model)
  );
}

export function buildOpenAIBody(
  req: CompletionRequest,
  fallbackModel: string,
  stream = true,
): Record<string, unknown> {
  const model = req.model || fallbackModel;
  const body: Record<string, unknown> = {
    model,
    messages: toOpenAIMessages(req),
    stream,
  };
  if (stream) body.stream_options = { include_usage: true };
  if (isOpenAIReasoningModel(model)) {
    // GPT-5/o-series reject `max_tokens` (use max_completion_tokens); the cap is reasoning+answer.
    body.max_completion_tokens = Math.max(req.maxOutputTokens, REASONING_MAX_TOKENS);
    body.reasoning_effort = toReasoningEffort(req.effort);
  } else {
    // Every other reasoning family (Gemini, Grok, DeepSeek-R1, Qwen-QwQ) takes `max_tokens` and
    // gets the SAME floor — one check, so a new reasoner can't silently run out. Non-reasoning
    // models keep their exact cap.
    body.max_tokens = isReasoningModel(model) ? Math.max(req.maxOutputTokens, REASONING_MAX_TOKENS) : req.maxOutputTokens;
    // Grok's reasoning variants accept reasoning_effort (narrow gate — a 400 on non-reasoning grok).
    if (isGrokReasoningModel(model)) body.reasoning_effort = toReasoningEffort(req.effort);
  }
  if (req.tools.length > 0) {
    body.tools = req.tools.map((t) => ({
      type: 'function',
      function: { name: t.name, description: t.description, parameters: t.parameters },
    }));
    body.tool_choice = 'auto';
  }
  return body;
}

// ── SSE → ProviderEvent (exported for unit tests; no network) ────────────────

interface OAISSE {
  // OpenAI-compat backends can return an error as a `data:` frame on an HTTP-200 stream
  // (rate limit, content filter, server error mid-generation). Without this the frame has
  // no `choices`, falls through, and the turn ends as a silent empty `end_turn`.
  error?: { message?: string; code?: string | number; type?: string };
  choices?: {
    delta?: {
      content?: string;
      // Reasoning models (DeepSeek, some OpenAI-compat) stream the chain of thought
      // in a separate field rather than inline tags. Both spellings seen in the wild.
      reasoning_content?: string;
      reasoning?: string;
      tool_calls?: {
        index?: number;
        id?: string;
        function?: { name?: string; arguments?: string };
        // Gemini (OpenAI-compat) attaches a thought_signature here that MUST be echoed
        // back on the next request or multi-turn tool use 400s.
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

interface OAICallState {
  id: string;
  name: string;
  args: string;
  signature: string;
}

function findKeyById(calls: Map<string, OAICallState>, id: string): string | undefined {
  for (const [k, v] of calls) if (v.id === id) return k;
  return undefined;
}

export async function* parseOpenAISSE(lines: AsyncIterable<string>): AsyncIterable<ProviderEvent> {
  let inputTokens = 0;
  let outputTokens = 0;
  let cacheReadTokens = 0;
  let stopReason: StopReason = 'end_turn';
  // Tool calls accumulate keyed by a synthetic key (insertion-ordered for flush). Backends
  // vary wildly: some omit `index`, some reuse index 0 for every call. We key by `id` when a
  // chunk introduces one, correlate args-only continuation chunks by `index`, else attach to
  // the most-recent call — so distinct calls never merge and continuations never split.
  const calls = new Map<string, OAICallState>();
  const indexToKey = new Map<number, string>();
  let lastKey: string | null = null;
  let keySeq = 0;
  const splitter = new ThinkingSplitter(); // routes inline <think>/<thinking> spans to the reasoning channel

  for await (const rawLine of lines) {
    const line = rawLine.trim();
    if (!line.startsWith('data:')) continue;
    const payload = line.slice(5).trim();
    if (!payload || payload === '[DONE]') continue;

    let obj: OAISSE;
    try {
      obj = JSON.parse(payload) as OAISSE;
    } catch {
      continue;
    }

    // An error frame on a 200 stream: surface it (recoverable) instead of dropping it,
    // so the loop reports a real failure rather than a clean empty turn.
    if (obj.error) {
      const message = obj.error.message ?? 'provider returned an error frame';
      const code = obj.error.code ?? obj.error.type ?? 'provider_stream_error';
      yield { type: 'error', recoverable: true, code: String(code), message: String(message) };
      stopReason = 'end_turn';
      continue;
    }

    // The final usage chunk has empty `choices`; capture tokens whenever present.
    if (obj.usage) {
      const cached = obj.usage.prompt_tokens_details?.cached_tokens ?? 0;
      cacheReadTokens = cached;
      // OpenAI's prompt_tokens INCLUDES cached tokens; the rest of Shadow assumes disjoint
      // (Anthropic) semantics, so subtract to avoid double-counting cost + context.
      if (typeof obj.usage.prompt_tokens === 'number') inputTokens = Math.max(0, obj.usage.prompt_tokens - cached);
      if (typeof obj.usage.completion_tokens === 'number') outputTokens = obj.usage.completion_tokens;
    }

    const choice = obj.choices?.[0];
    if (!choice) continue;
    const delta = choice.delta;
    // Separate reasoning field (DeepSeek `reasoning_content`, some `reasoning`) → reasoning channel.
    const reasoning = delta?.reasoning_content ?? delta?.reasoning;
    if (typeof reasoning === 'string' && reasoning) yield { type: 'thinking', delta: reasoning };
    // Inline <think>/<thinking> spans in the content are split out to the same channel.
    if (delta?.content) {
      for (const span of splitter.push(delta.content)) {
        yield span.kind === 'thinking' ? { type: 'thinking', delta: span.text } : { type: 'text', delta: span.text };
      }
    }

    for (const tc of delta?.tool_calls ?? []) {
      let key: string;
      const existingById = tc.id ? findKeyById(calls, tc.id) : undefined;
      const idxKey = typeof tc.index === 'number' ? indexToKey.get(tc.index) : undefined;
      if (existingById) {
        key = existingById; // a later chunk re-stating a known id
      } else if (idxKey !== undefined && !(tc.id && calls.get(idxKey)!.id && calls.get(idxKey)!.id !== tc.id)) {
        // Continuation by index — INCLUDING a chunk that introduces the id late (name-first,
        // id-later), but NOT when the index already holds a DIFFERENT id (reused index).
        key = idxKey;
      } else if (tc.id) {
        key = `k${keySeq++}`; // a NEW id → a new call (even if index is absent or reused)
        calls.set(key, { id: tc.id, name: '', args: '', signature: '' });
        if (typeof tc.index === 'number') indexToKey.set(tc.index, key);
      } else if (typeof tc.index === 'number') {
        key = `k${keySeq++}`; // first chunk carried only an index
        calls.set(key, { id: '', name: '', args: '', signature: '' });
        indexToKey.set(tc.index, key);
      } else {
        key = lastKey ?? `k${keySeq++}`; // no id, no index → continue the most recent call
        if (!calls.has(key)) calls.set(key, { id: '', name: '', args: '', signature: '' });
      }
      lastKey = key;
      const cur = calls.get(key)!;
      if (tc.id) cur.id = tc.id;
      if (tc.function?.name) cur.name = tc.function.name;
      const sig = tc.extra_content?.google?.thought_signature;
      if (typeof sig === 'string' && sig) cur.signature = sig;
      if (typeof tc.function?.arguments === 'string') {
        cur.args += tc.function.arguments;
        yield { type: 'tool_call_partial', id: cur.id, name: cur.name, jsonDelta: tc.function.arguments };
      }
    }

    if (choice.finish_reason) stopReason = mapOpenAIFinish(choice.finish_reason);
  }

  // Surface any held-back tail (e.g. an unclosed reasoning tag) at stream end.
  for (const span of splitter.flush()) {
    yield span.kind === 'thinking' ? { type: 'thinking', delta: span.text } : { type: 'text', delta: span.text };
  }

  // Flush accumulated tool calls at stream end (insertion order = stream order).
  let flushN = 0;
  const usedIds = new Set<string>();
  for (const c of calls.values()) {
    const idx = flushN++;
    if (!c.name && !c.args) continue; // a slot that never received a name or args is not a real call
    // De-dupe ids: a backend that omits or reuses ids would otherwise yield duplicate
    // tool_use ids → a hard 400 (duplicate_tool_use_id) once bridged to Anthropic.
    let id = c.id || `call_${idx}`;
    while (usedIds.has(id)) id = `call_${idx}_${usedIds.size}`;
    usedIds.add(id);
    const parsed = parseToolArgs(c.args); // repair ladder before giving up
    if (parsed.ok) {
      yield {
        type: 'tool_call',
        call: { id, name: c.name, input: parsed.value, ...(c.signature ? { signature: c.signature } : {}) },
      };
    } else {
      yield {
        type: 'error',
        recoverable: true,
        code: 'bad_tool_json',
        message: `tool "${c.name}" ${parsed.error}`,
      };
    }
  }

  // Some servers omit finish_reason:'tool_calls'; infer it from emitted calls.
  if (calls.size > 0 && stopReason === 'end_turn') stopReason = 'tool_use';

  yield { type: 'usage', inputTokens, outputTokens, cacheReadTokens };
  yield { type: 'done', stopReason };
}

function mapOpenAIFinish(reason: string): StopReason {
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
