/** Responses API wire adapter; ChatGPT plan usage is an explicit, separate request contract. */
import {
  estimateTokensFromMessages,
  type CompletionRequest,
  type Provider,
  type ProviderEvent,
  type ResponsesReasoningItem,
  type StopReason,
} from './provider.js';
import { streamWithRetry, streamLines, resolveIdleBudget } from './stream.js';
import { sseEvents, parseSseData, nonEmptyParts } from './sse.js';
import { buildOpenAIBody, escapeMultimodalControlTokens } from './openai.js';
import { parseToolArgs } from './toolJson.js';
import { isLocalBaseUrl } from '../safety/offline.js';
import { shadowFetch } from '../safety/egress.js';
import { redactString, registerSecret } from '../util/redact.js';

const DEFAULT_BASE_URL = 'https://api.openai.com/v1';
const TOOL_NAMESPACE = 'shadow';

interface ResponsesOptions {
  selfHosted?: boolean;
  stripParams?: ReadonlySet<string>;
  reasoningRoundtrip?: 'last' | 'none';
  chatgptPlan?: boolean;
}

/** Preserve message/block order; Responses tool history is not Chat Completions history. */
function responseInput(req: CompletionRequest, model: string, opts: ResponsesOptions): unknown[] {
  const input: unknown[] = [];
  const clean = escapeMultimodalControlTokens;
  for (const message of req.messages) {
    if (message.role === 'assistant' && message.responsesReasoning?.model === model &&
        opts.reasoningRoundtrip !== 'none' && !message.interrupted) {
      for (const item of message.responsesReasoning.items) {
        if (item.type === 'reasoning' && item.status !== 'incomplete' && item.status !== 'in_progress') {
          input.push(structuredClone(item));
        }
      }
    }
    const role = message.role === 'system' ? 'developer' : message.role === 'tool' ? 'user' : message.role;
    let content: Array<Record<string, unknown>> = [];
    const flush = () => {
      if (!content.length) return;
      // EasyInputMessage accepts plain assistant text without inventing output item IDs.
      input.push({ role, content: role === 'assistant' ? content.map((part) => part.text ?? '').join('') : content });
      content = [];
    };
    for (const block of message.content) {
      if (block.type === 'text') content.push({ type: 'input_text', text: clean(block.text) });
      else if (block.type === 'image' && role === 'user') {
        content.push({ type: 'input_image', image_url: 'data:' + block.mediaType + ';base64,' + block.data, detail: 'auto' });
      } else if (block.type === 'tool_use') {
        flush();
        input.push({
          type: 'function_call', call_id: block.id, name: block.name,
          arguments: clean(JSON.stringify(block.input ?? {})),
          ...(opts.chatgptPlan ? { namespace: TOOL_NAMESPACE } : {}),
        });
      } else if (block.type === 'tool_result') {
        flush();
        input.push({ type: 'function_call_output', call_id: block.toolCallId, output: clean(block.content) });
      }
      // Other providers' signed thinking is never converted into Responses reasoning.
    }
    flush();
  }
  return input;
}

/**
 * SIWC requirements: https://developers.openai.com/siwc/token-sharing-open-source/preview-limitations
 * Namespace schema: https://developers.openai.com/api/docs/guides/function-calling#defining-namespaces
 */
export function buildResponsesBody(
  req: CompletionRequest,
  fallbackModel: string,
  stream = true,
  opts: ResponsesOptions = {},
): Record<string, unknown> {
  const model = req.model || fallbackModel;
  const body: Record<string, unknown> = {
    model,
    input: responseInput(req, model, opts),
    stream: opts.chatgptPlan ? true : stream,
    ...(req.system ? { instructions: escapeMultimodalControlTokens(req.system) } : {}),
  };
  let tools = req.tools;
  const choice = req.toolChoice;
  if (opts.chatgptPlan) {
    body.store = false;
    body.include = ['reasoning.encrypted_content'];
    body.reasoning = { ...(req.effort ? { effort: req.effort } : {}), summary: 'auto' };
    // ToolChoiceFunction does not document a namespace selector. Restricting the namespace to
    // the requested tool and requiring a call gives the same contract without invented syntax.
    if (choice?.type === 'tool') {
      tools = tools.filter((tool) => tool.name === choice.name);
      if (!tools.length) throw new Error('The requested tool is not available: ' + choice.name);
    }
  } else {
    // Preserve the existing endpoint/model output-floor and sampling policy, but never its
    // Chat Completions messages or nested function/tool-choice shapes.
    const chat = buildOpenAIBody(req, fallbackModel, false, opts);
    body.max_output_tokens = chat.max_completion_tokens ?? chat.max_tokens;
    if (chat.reasoning_effort) body.reasoning = { effort: chat.reasoning_effort };
    if (chat.temperature !== undefined) body.temperature = chat.temperature;
  }
  if (tools.length) {
    const functions = tools.map((tool) => ({
      type: 'function', name: tool.name, description: tool.description,
      parameters: tool.parameters, strict: false,
    }));
    body.tools = opts.chatgptPlan
      ? [{ type: 'namespace', name: TOOL_NAMESPACE, description: 'Tools executed by Shadow.', tools: functions }]
      : functions;
  }
  if (!opts.stripParams?.has('tool_choice') && (tools.length || choice)) {
    body.tool_choice = choice?.type === 'tool'
      ? opts.chatgptPlan ? 'required' : { type: 'function', name: choice.name }
      : choice?.type === 'any' ? 'required' : choice?.type ?? 'auto';
  }
  if (choice?.disableParallelToolUse !== undefined) body.parallel_tool_calls = !choice.disableParallelToolUse;
  return body;
}

interface ResponsesError {
  message?: string;
  code?: string | number;
  type?: string;
  param?: string | null;
}
interface ResponsesOutputItem {
  type?: string;
  id?: string;
  name?: string;
  namespace?: string;
  call_id?: string;
  arguments?: string;
  status?: string;
  encrypted_content?: string | null;
  summary?: Array<{ type?: string; text?: string }>;
  content?: Array<{ type?: string; text?: string; refusal?: string }>;
}
interface ResponsesPayload {
  status?: string;
  output?: ResponsesOutputItem[];
  incomplete_details?: { reason?: string };
  usage?: {
    input_tokens?: number;
    output_tokens?: number;
    input_tokens_details?: { cached_tokens?: number };
  };
  error?: ResponsesError;
}
interface ResponsesSSE extends ResponsesError {
  type?: string;
  delta?: string;
  text?: string;
  arguments?: string;
  item_id?: string;
  output_index?: number;
  content_index?: number;
  summary_index?: number;
  item?: ResponsesOutputItem;
  response?: ResponsesPayload;
  error?: ResponsesError;
}

function responsesError(error: ResponsesError | undefined, fallback: string, plan: boolean, detail?: string): ProviderEvent {
  const code = String(error?.code ?? error?.type ?? fallback);
  const guidance: Record<string, string> = {
    subscription_sharing_usage_limit_exceeded: 'ChatGPT plan usage is paused. Check https://chatgpt.com/settings/usage before trying again.',
    subscription_sharing_usage_unavailable: 'ChatGPT usage availability could not be checked. Keep this connection and retry later.',
    subscription_sharing_user_not_eligible: 'The selected ChatGPT account or workspace is not eligible for this use. Check its plan and policy.',
    subscription_sharing_unsupported_capability: 'This request includes a capability unavailable to the selected ChatGPT plan. Review the named parameter.',
    subscription_sharing_route_not_supported: 'ChatGPT plan inference must use POST https://api.openai.com/v1/responses.',
    subscription_sharing_invalid_user: 'The ChatGPT account could not be validated. Check the account connection; sign in again if access was revoked.',
    chatpass_v2_scope_not_authorized: 'The selected account has not authorized this operation. Check the ChatGPT plan grant.',
    chatpass_v2_invalid_authorization_context: 'The ChatGPT permission context is invalid. Check the client and account grant.',
    subscription_sharing_user_unavailable: 'ChatGPT account information is temporarily unavailable. Keep this connection and retry later.',
  };
  return {
    type: 'error', recoverable: !plan, code,
    message: redactString([
      error?.message ?? fallback.replace(/_/g, ' '),
      error?.param ? 'Parameter: ' + error.param + '.' : '',
      detail,
      plan ? guidance[code] ?? 'Check the ChatGPT account connection and retry when the issue is resolved.' : '',
      plan ? 'Shadow has not switched to API-key billing.' : '',
    ].filter(Boolean).join(' ')),
  };
}

function readResponsesUsage(usage: ResponsesPayload['usage']): {
  inputTokens: number; outputTokens: number; cacheReadTokens: number;
} {
  const count = (value: unknown) => typeof value === 'number' && Number.isFinite(value) ? Math.max(0, value) : 0;
  const total = count(usage?.input_tokens);
  const cached = Math.min(total, count(usage?.input_tokens_details?.cached_tokens));
  return { inputTokens: total - cached, outputTokens: count(usage?.output_tokens), cacheReadTokens: cached };
}

function* finishResponsesTurn(stopReason: StopReason, usage?: ResponsesPayload['usage']): Generator<ProviderEvent> {
  yield { type: 'usage', ...readResponsesUsage(usage) };
  yield { type: 'done', stopReason };
}

interface OutputState {
  item: ResponsesOutputItem;
  index?: number;
  order: number;
  text: Map<number, string>;
  reasoning: Map<number, string>;
  complete: boolean;
}

/** Match by item ID, call ID, or output index so interleaved parallel arguments never merge. */
class ResponsesAccumulator {
  private states: OutputState[] = [];
  private byId = new Map<string, OutputState>();
  private byCall = new Map<string, OutputState>();
  private byIndex = new Map<number, OutputState>();
  private unindexedText = false;
  private unindexedReasoning = false;

  constructor(private plan = false) {}

  get(event: ResponsesSSE): OutputState {
    const item = event.item;
    const id = item?.id ?? event.item_id;
    const index = event.output_index;
    const state: OutputState = (id ? this.byId.get(id) : undefined) ??
      (item?.call_id ? this.byCall.get(item.call_id) : undefined) ??
      (index !== undefined ? this.byIndex.get(index) : undefined) ??
      { item: {}, order: this.states.length, text: new Map(), reasoning: new Map(), complete: false };
    if (!this.states.includes(state)) this.states.push(state);
    if (id) this.byId.set(id, state);
    if (item?.call_id) this.byCall.set(item.call_id, state);
    if (index !== undefined) { state.index = index; this.byIndex.set(index, state); }
    return state;
  }

  private localName(item: ResponsesOutputItem): string | undefined {
    if (!item.name) return undefined;
    if (item.namespace && item.namespace !== TOOL_NAMESPACE) return undefined;
    // Namespace is a separate wire field. Do not rewrite a legitimate local name that happens
    // to contain a dot, or turn an unknown qualified function into a different local tool.
    return item.name;
  }

  *delta(event: ResponsesSSE, reasoning = false): Generator<ProviderEvent> {
    if (typeof event.delta !== 'string' || !event.delta) return;
    const hasIdentity = event.item_id !== undefined || event.output_index !== undefined;
    if (!hasIdentity) {
      if (reasoning) this.unindexedReasoning = true;
      else this.unindexedText = true;
    }
    const state = this.get(event);
    const parts = reasoning ? state.reasoning : state.text;
    const part = (reasoning ? event.summary_index : event.content_index) ?? 0;
    parts.set(part, (parts.get(part) ?? '') + event.delta);
    yield { type: reasoning ? 'thinking' : 'text', delta: event.delta };
  }

  *item(event: ResponsesSSE, complete: boolean): Generator<ProviderEvent> {
    if (!event.item) return;
    const state = this.get(event);
    // Do not replace a final encrypted item with an incomplete snapshot. In particular, the
    // output_item.added ciphertext is not valid continuation state.
    const wasComplete = state.complete;
    state.item = { ...state.item, ...event.item };
    if (complete && event.item.status === undefined && state.item.status === 'in_progress') {
      state.item.status = 'completed';
    }
    if (complete && !wasComplete && event.item.encrypted_content === undefined) {
      delete state.item.encrypted_content;
    }
    if (complete) state.complete = true;
    if (!complete) return;
    const item = state.item;
    const reasoning = item.type === 'reasoning';
    if (item.type !== 'message' && !reasoning) return;
    const parts = reasoning ? item.summary?.length ? item.summary : item.content : item.content;
    const emitted = reasoning ? state.reasoning : state.text;
    const unindexed = reasoning ? this.unindexedReasoning : this.unindexedText;
    for (let index = 0; index < (parts?.length ?? 0); index++) {
      const part = parts![index]!;
      const finalText = part.type === 'refusal' && 'refusal' in part ? part.refusal : part.text;
      if (typeof finalText !== 'string' || !finalText) continue;
      const seen = emitted.get(index) ?? '';
      if (!unindexed && finalText.startsWith(seen) && finalText.length > seen.length) {
        yield { type: reasoning ? 'thinking' : 'text', delta: finalText.slice(seen.length) };
      }
      emitted.set(index, finalText);
    }
  }

  *arguments(event: ResponsesSSE, done: boolean): Generator<ProviderEvent> {
    const state = this.get(event);
    if (done) {
      if (typeof event.arguments === 'string') state.item.arguments = event.arguments;
    } else if (typeof event.delta === 'string') {
      state.item.arguments = (state.item.arguments ?? '') + event.delta;
      const name = this.localName(state.item);
      if (state.item.call_id && name) {
        yield { type: 'tool_call_partial', id: state.item.call_id, name, jsonDelta: event.delta };
      }
    }
  }

  *finish(body: ResponsesPayload, status: string): Generator<ProviderEvent> {
    for (const [index, item] of (body.output ?? []).entries()) {
      yield* this.item({ output_index: index, item }, true);
    }
    const ordered = [...this.states].sort((a, b) => (a.index ?? a.order) - (b.index ?? b.order));
    if (!['completed', 'incomplete', 'failed'].includes(status)) {
      yield responsesError({ message: 'Responses returned a nonterminal status: ' + status }, 'responses_invalid_terminal', this.plan);
      yield* finishResponsesTurn('end_turn', body.usage);
      return;
    }
    if (status === 'failed' || body.error) {
      yield responsesError(body.error, 'response_failed', this.plan);
      yield* finishResponsesTurn('end_turn', body.usage);
      return;
    }
    if (status === 'incomplete' && (this.plan || body.incomplete_details?.reason !== 'max_output_tokens')) {
      yield responsesError({ message: 'Response incomplete: ' + (body.incomplete_details?.reason ?? 'unknown reason') }, 'response_incomplete', this.plan);
      yield* finishResponsesTurn('max_tokens', body.usage);
      return;
    }
    // Only completed reasoning items from a successful response are committed to history.
    if (status === 'completed') {
      for (const state of ordered) {
        const item = state.item;
        if (item.type !== 'reasoning' || !state.complete || !item.id ||
            item.status === 'incomplete' || item.status === 'in_progress') continue;
        const summary = (item.summary ?? []).flatMap((part) =>
          part.type === 'summary_text' && typeof part.text === 'string' ? [{ type: 'summary_text' as const, text: part.text }] : []);
        const content = (item.content ?? []).flatMap((part) =>
          part.type === 'reasoning_text' && typeof part.text === 'string' ? [{ type: 'reasoning_text' as const, text: part.text }] : []);
        const saved: ResponsesReasoningItem = {
          type: 'reasoning', id: item.id, summary,
          ...(content.length ? { content } : {}),
          ...(item.encrypted_content !== undefined ? { encrypted_content: item.encrypted_content } : {}),
          ...(item.status === 'completed' ? { status: 'completed' } : {}),
        };
        yield { type: 'response_reasoning_item', item: saved };
      }
    }
    let calls = 0;
    for (const state of ordered) {
      const item = state.item;
      if (item.type !== 'function_call' && item.type !== 'tool_call') continue;
      if (!state.complete || item.status === 'incomplete' || item.status === 'in_progress') continue;
      const name = this.localName(item);
      if (!name || !item.call_id) {
        yield responsesError({ message: 'Responses tool call is missing its call ID/name or names an unknown namespace.' }, 'invalid_tool_call', this.plan);
        continue;
      }
      const parsed = parseToolArgs(item.arguments ?? '');
      if (!parsed.ok) {
        yield { type: 'error', recoverable: true, code: 'bad_tool_json', message: 'tool "' + name + '" ' + parsed.error };
        continue;
      }
      calls++;
      yield { type: 'tool_call', call: { id: item.call_id, name, input: parsed.value } };
    }
    yield* finishResponsesTurn(status === 'incomplete' ? 'max_tokens' : calls ? 'tool_use' : 'end_turn', body.usage);
  }
}

/** Generic non-stream fallback. SIWC never uses this route. */
export function* eventsFromResponsesCompletion(obj: unknown): Generator<ProviderEvent> {
  const root = obj && typeof obj === 'object' ? obj as ResponsesPayload & { response?: ResponsesPayload } : {};
  const body = root.response && typeof root.response === 'object' ? root.response : root;
  yield* new ResponsesAccumulator().finish(body, body.error ? 'failed' : body.status ?? 'completed');
}

/** A tool is dispatched only after a terminal response, never from argument fragments alone. */
export async function* parseResponsesSSE(
  lines: AsyncIterable<string>,
  opts: Pick<ResponsesOptions, 'chatgptPlan'> = {},
): AsyncIterable<ProviderEvent> {
  const accumulator = new ResponsesAccumulator(opts.chatgptPlan);
  for await (const frame of sseEvents(lines)) {
    if (frame.kind === 'other') continue;
    const parts = nonEmptyParts(frame.parts).filter((part) => part.trim() !== '[DONE]');
    if (!parts.length) continue;
    for (const parsed of parseSseData(parts.join('\n'), parts)) {
      if (!parsed || typeof parsed !== 'object') continue;
      const event = parsed as ResponsesSSE;
      if (event.type === 'error' || event.error) {
        yield responsesError(event.error ?? event, 'provider_stream_error', !!opts.chatgptPlan);
        yield* finishResponsesTurn('end_turn');
        return;
      }
      switch (event.type) {
        case 'response.output_text.delta':
        case 'response.refusal.delta':
          yield* accumulator.delta(event);
          break;
        case 'response.reasoning_summary_text.delta':
        case 'response.reasoning_text.delta':
          yield* accumulator.delta(event, true);
          break;
        case 'response.output_item.added':
          yield* accumulator.item(event, false);
          break;
        case 'response.output_item.done':
          yield* accumulator.item(event, true);
          break;
        case 'response.function_call_arguments.delta':
          yield* accumulator.arguments(event, false);
          break;
        case 'response.function_call_arguments.done':
          yield* accumulator.arguments(event, true);
          break;
        case 'response.completed':
        case 'response.failed':
        case 'response.incomplete': {
          const eventStatus = event.type.slice('response.'.length);
          if (!event.response || (event.response.status !== undefined && event.response.status !== eventStatus)) {
            yield responsesError({ message: 'Responses terminal event contains no valid matching response.' }, 'responses_invalid_terminal', !!opts.chatgptPlan);
            yield* finishResponsesTurn('end_turn');
            return;
          }
          const status = event.response.status ?? eventStatus;
          yield* accumulator.finish(event.response ?? {}, status);
          return;
        }
      }
    }
  }
  yield responsesError({ message: 'Responses stream ended without a terminal response. Partial output was retained; no tool calls were executed.' },
    'responses_stream_incomplete', !!opts.chatgptPlan);
  yield* finishResponsesTurn('end_turn');
}

export class ResponsesProvider implements Provider {
  readonly name = 'openai';
  readonly wire = 'responses' as const;
  readonly allowAutomaticFallback: boolean | undefined;
  private readonly apiKey: string | undefined;
  private readonly extraHeaders: Record<string, string> | undefined;
  private readonly baseUrl: string;
  private readonly model: string;
  private readonly selfHosted: boolean;
  private readonly idleTimeoutMs: number | undefined;
  private readonly firstByteTimeoutMs: number | undefined;
  private readonly streamRetries: number | undefined;
  private readonly strippedParams = new Set<string>();
  private readonly reasoningRoundtrip: 'last' | 'none';
  private readonly chatgptPlan: boolean;

  constructor(opts: {
    apiKey?: string;
    baseUrl?: string;
    extraHeaders?: Record<string, string>;
    model: string;
    selfHosted?: boolean;
    idleTimeoutMs?: number;
    firstByteTimeoutMs?: number;
    streamRetries?: number;
    reasoningRoundtrip?: 'last' | 'none';
    chatgptPlan?: boolean;
  }) {
    this.apiKey = opts.apiKey;
    this.extraHeaders = opts.extraHeaders;
    this.baseUrl = (opts.baseUrl ?? DEFAULT_BASE_URL).replace(/\/+$/, '');
    this.model = opts.model;
    this.chatgptPlan = opts.chatgptPlan === true;
    if (this.chatgptPlan && this.baseUrl !== DEFAULT_BASE_URL) {
      throw new Error('ChatGPT plan credentials can only use https://api.openai.com/v1.');
    }
    this.allowAutomaticFallback = this.chatgptPlan ? false : undefined;
    this.selfHosted = !this.chatgptPlan && (opts.selfHosted === true || isLocalBaseUrl(this.baseUrl));
    this.idleTimeoutMs = opts.idleTimeoutMs;
    this.firstByteTimeoutMs = opts.firstByteTimeoutMs;
    this.streamRetries = opts.streamRetries;
    this.reasoningRoundtrip = opts.reasoningRoundtrip ?? 'last';
    registerSecret(this.apiKey);
  }

  estimateTokens(messages: import('./provider.js').Message[]): number {
    return estimateTokensFromMessages(messages);
  }

  async *send(req: CompletionRequest): AsyncIterable<ProviderEvent> {
    const model = req.model || this.model;
    const headers: Record<string, string> = { 'content-type': 'application/json', ...this.extraHeaders };
    if (this.apiKey) headers.Authorization = 'Bearer ' + this.apiKey;
    const opts: ResponsesOptions = {
      selfHosted: this.selfHosted, stripParams: this.strippedParams,
      reasoningRoundtrip: this.reasoningRoundtrip, chatgptPlan: this.chatgptPlan,
    };
    if (this.chatgptPlan) {
      yield* this.sendPlan(req, headers, buildResponsesBody(req, model, true, opts));
      return;
    }
    yield* streamWithRetry({
      url: this.baseUrl + '/responses', headers,
      body: buildResponsesBody(req, model, true, opts), parse: parseResponsesSSE, signal: req.signal,
      nonStreamBody: buildResponsesBody(req, model, false, opts), parseNonStream: eventsFromResponsesCompletion,
      selfHosted: this.selfHosted, idleTimeoutMs: this.idleTimeoutMs,
      firstByteTimeoutMs: this.firstByteTimeoutMs, streamRetries: this.streamRetries,
      onParamStripped: (param) => { this.strippedParams.add(param); },
    });
  }

  /** One plan request, without paid fallback, body-rewriting ladders, or non-stream rescue. */
  private async *sendPlan(req: CompletionRequest, headers: Record<string, string>, body: unknown): AsyncIterable<ProviderEvent> {
    if (req.signal?.aborted) return;
    const controller = new AbortController();
    const signal = req.signal ? AbortSignal.any([req.signal, controller.signal]) : controller.signal;
    const idleMs = resolveIdleBudget(this.idleTimeoutMs, this.baseUrl);
    let timedOut = false;
    const trip = () => { timedOut = true; controller.abort(); };
    let timer = setTimeout(trip, this.firstByteTimeoutMs ?? idleMs);
    const kick = () => { clearTimeout(timer); timer = setTimeout(trip, idleMs); };
    try {
      const response = await shadowFetch(this.baseUrl + '/responses', {
        method: 'POST', headers, body: JSON.stringify(body), signal, redirect: 'error',
      }, { purpose: 'provider', origin: 'user', streaming: true });
      if (!response.ok) {
        let raw = '';
        if (response.body) {
          for await (const line of streamLines(response.body, kick, signal)) {
            raw += (raw ? '\n' : '') + line;
            if (raw.length > 32_768) { raw = raw.slice(0, 32_768) + ' [truncated]'; break; }
          }
        }
        let payload: { error?: ResponsesError; detail?: unknown } = {};
        try { payload = JSON.parse(raw) as typeof payload; } catch { /* retain non-JSON diagnostic */ }
        const requestId = response.headers.get('x-request-id');
        const error = payload.error && typeof payload.error === 'object' ? payload.error : {
          message: typeof payload.detail === 'string' ? payload.detail : raw || response.statusText,
        };
        yield responsesError(error, 'http_' + response.status, true,
          'HTTP ' + response.status + (requestId ? '; request ID ' + requestId : '') + '.');
        return;
      }
      if (!response.body) {
        yield responsesError(undefined, 'empty_body', true);
        return;
      }
      const requestId = response.headers.get('x-request-id');
      for await (const event of parseResponsesSSE(streamLines(response.body, kick, signal), { chatgptPlan: true })) {
        yield event.type === 'error' && requestId
          ? { ...event, message: event.message + ' Request ID: ' + requestId + '.' }
          : event;
      }
    } catch (error) {
      if (req.signal?.aborted) return;
      yield responsesError({
        message: timedOut ? 'The ChatGPT response timed out. Retry when the connection is ready.' :
          error instanceof Error ? error.message : String(error),
      }, timedOut ? 'idle_timeout' : 'stream_error', true);
    } finally {
      clearTimeout(timer);
      controller.abort();
    }
  }
}

/** Select wire API from env: responses uses the Responses endpoint; default chat. */
export function useResponsesWire(): boolean {
  return process.env.SHADOW_WIRE_API === 'responses';
}
