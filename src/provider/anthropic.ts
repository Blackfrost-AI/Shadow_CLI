/**
 * Native Anthropic Messages API adapter (`/v1/messages`, streaming). Chosen over
 * the OpenAI-compat shim for Claude fidelity: the system prompt is a top-level
 * field, tool calls arrive as `tool_use` content blocks, tool RESULTS must ride
 * inside a user turn as `tool_result` blocks (consecutive ones coalesced), and
 * prompt caching is opted in via `cache_control` markers.
 *
 * The SSE→ProviderEvent transform is factored into the exported async generator
 * `parseAnthropicSSE` so it can be unit-tested with no network; the class only
 * wires fetch → line-splitter → parser through the shared retry/idle substrate.
 */
import {
  estimateTokensFromMessages,
  type CompletionRequest,
  type Message,
  type Provider,
  type ProviderEvent,
  type StopReason,
} from './provider.js';
import { streamWithRetry } from './stream.js';
import { eventsFromAnthropicMessage } from './nonStream.js';
import { parseToolArgs } from './toolJson.js';

const DEFAULT_ANTHROPIC_BASE = 'https://api.anthropic.com';
// Claude Code 2.1.187 sends this exact version header — it is the only GA Messages
// API version, NOT stale; do not bump to an invented date (verified against corpus).
const ANTHROPIC_VERSION = '2023-06-01';

export class AnthropicProvider implements Provider {
  readonly name = 'anthropic';
  private readonly apiKey: string | undefined;
  private readonly authToken: string | undefined;
  private readonly url: string;
  private readonly model: string;

  /**
   * `baseUrl` lets Shadow target an Anthropic-Messages-compatible endpoint
   * (e.g. an Ollama server or a proxy). Auth: a bearer `authToken` (à la
   * ANTHROPIC_AUTH_TOKEN) takes precedence; otherwise `x-api-key` is used.
   */
  constructor(opts: { apiKey?: string; authToken?: string; baseUrl?: string; model: string }) {
    this.apiKey = opts.apiKey;
    this.authToken = opts.authToken;
    this.url = `${(opts.baseUrl ?? DEFAULT_ANTHROPIC_BASE).replace(/\/v1\/?$/, '').replace(/\/+$/, '')}/v1/messages`;
    this.model = opts.model;
  }

  estimateTokens(messages: Message[]): number {
    return estimateTokensFromMessages(messages);
  }

  async countTokens(args: {
    model: string;
    system?: string;
    messages: Message[];
    tools?: any[];
  }): Promise<number> {
    // Build a minimal count_tokens request body.
    const body: any = {
      model: args.model || this.model,
      messages: (args.messages ?? []).map((m) => ({
        role: m.role,
        content: m.content.map((b) => {
          if (b.type === 'text') return { type: 'text', text: b.text };
          if (b.type === 'tool_use') return { type: 'tool_use', id: b.id, name: b.name, input: b.input };
          if (b.type === 'tool_result') return { type: 'tool_result', tool_use_id: b.toolCallId, content: wrapAnthropicToolResult(b.content, b.ok) };
          if (b.type === 'thinking') return { type: 'thinking', thinking: b.thinking };
          if (b.type === 'redacted_thinking') return { type: 'redacted_thinking', data: b.data };
          if (b.type === 'image') return { type: 'image', source: { type: 'base64', media_type: b.mediaType, data: b.data } };
          return b;
        }),
      })),
    };
    if (args.system) body.system = args.system;
    if (args.tools && args.tools.length) body.tools = args.tools;

    const countUrl = this.url.replace(/\/messages$/, '/messages/count_tokens');
    const headers: Record<string, string> = {
      'anthropic-version': ANTHROPIC_VERSION,
      'content-type': 'application/json',
    };
    if (this.authToken) headers['authorization'] = `Bearer ${this.authToken}`;
    else if (this.apiKey) headers['x-api-key'] = this.apiKey;

    const res = await fetch(countUrl, {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
    });
    if (!res.ok) {
      // Fall back to local heuristic on error (don't break compaction).
      return estimateTokensFromMessages(args.messages ?? []);
    }
    const json = (await res.json()) as { input_tokens?: number };
    return json.input_tokens ?? estimateTokensFromMessages(args.messages ?? []);
  }

  async *send(req: CompletionRequest): AsyncIterable<ProviderEvent> {
    const model = req.model || this.model;
    const headers: Record<string, string> = {
      'anthropic-version': ANTHROPIC_VERSION,
      'content-type': 'application/json',
    };
    const betas = anthropicBetaHeaders({
      model,
      cacheTtl: req.cacheTtl,
      fastMode: req.fastMode,
    });
    if (betas.length) headers['anthropic-beta'] = betas.join(',');
    if (this.authToken) headers['authorization'] = `Bearer ${this.authToken}`;
    else headers['x-api-key'] = this.apiKey ?? '';

    yield* streamWithRetry({
      url: this.url,
      headers,
      body: buildAnthropicBody(req, model, true),
      parse: parseAnthropicSSE,
      signal: req.signal,
      nonStreamBody: buildAnthropicBody(req, model, false),
      parseNonStream: eventsFromAnthropicMessage,
    });
  }
}

// ── request shaping ──────────────────────────────────────────────────────────

type AntBlock =
  | { type: 'text'; text: string }
  | { type: 'thinking'; thinking: string; signature: string }
  | { type: 'redacted_thinking'; data: string }
  | { type: 'image'; source: { type: 'base64'; media_type: string; data: string } }
  | { type: 'tool_use'; id: string; name: string; input: unknown }
  | { type: 'tool_result'; tool_use_id: string; content: string; is_error: boolean };

interface AntMessage {
  role: 'user' | 'assistant';
  content: AntBlock[];
}

/**
 * Claude Code wraps a FAILED tool_result's content in `<tool_use_error>…</tool_use_error>`
 * tags (alongside `is_error: true`) — a stronger in-band error signal the model is trained
 * to recognize than the structured flag alone (verified in corpus: `<tool_use_error>Error:
 * No such tool available: …</tool_use_error>`). Applied only at Anthropic-serialization time,
 * so the neutral history and other providers keep clean, untagged content; re-applied
 * deterministically each turn from the stored `ok` flag, so it never double-wraps.
 */
export function wrapAnthropicToolResult(content: string, ok: boolean): string {
  return ok ? content : `<tool_use_error>${content}</tool_use_error>`;
}

/**
 * Map the provider-neutral Message[] into Anthropic's user/assistant turns. The
 * system prompt is hoisted to a top-level param (see buildAnthropicBody), so any
 * role:'system' message is dropped here. tool_result blocks always ride in a user
 * turn; consecutive same-role turns coalesce (the API requires alternation and
 * tool_result must be in a user turn). `model` is the current request's model:
 * signed thinking blocks are replayed only when they were produced by that same
 * model (a different model's signature is rejected after a /model switch).
 */
export function toAnthropicMessages(messages: Message[], model?: string): AntMessage[] {
  const out: AntMessage[] = [];
  const push = (role: 'user' | 'assistant', blocks: AntBlock[]): void => {
    if (blocks.length === 0) return;
    const last = out[out.length - 1];
    if (last && last.role === role) last.content.push(...blocks);
    else out.push({ role, content: [...blocks] });
  };

  for (const m of messages) {
    if (m.role === 'system') continue;
    if (m.role === 'assistant') {
      // Thinking blocks must LEAD the assistant turn and carry a signature, or the
      // API 400s the follow-up. Dropped when unsigned (e.g. non-Anthropic history)
      // or produced by a different model (its signature is invalid here).
      const thinking: AntBlock[] = [];
      const blocks: AntBlock[] = [];
      for (const b of m.content) {
        if (b.type === 'thinking') {
          if (b.signature && b.model === model) thinking.push({ type: 'thinking', thinking: b.thinking, signature: b.signature });
        } else if (b.type === 'redacted_thinking') {
          // Echo the encrypted blob back verbatim (only for the model that issued it),
          // else the API can 400 the follow-up turn that carried tool_use.
          if (b.data && b.model === model) thinking.push({ type: 'redacted_thinking', data: b.data });
        } else if (b.type === 'text') blocks.push({ type: 'text', text: b.text });
        else if (b.type === 'tool_use') blocks.push({ type: 'tool_use', id: b.id, name: b.name, input: b.input });
      }
      push('assistant', [...thinking, ...blocks]);
    } else {
      // role 'user' or 'tool' → a user turn. tool_result blocks coalesce.
      const blocks: AntBlock[] = [];
      for (const b of m.content) {
        if (b.type === 'text') blocks.push({ type: 'text', text: b.text });
        else if (b.type === 'image') {
          blocks.push({ type: 'image', source: { type: 'base64', media_type: b.mediaType, data: b.data } });
        } else if (b.type === 'tool_result') {
          blocks.push({ type: 'tool_result', tool_use_id: b.toolCallId, content: wrapAnthropicToolResult(b.content, b.ok), is_error: !b.ok });
        }
      }
      push('user', blocks);
    }
  }
  return out;
}

/**
 * Adaptive thinking + `output_config.effort` is GA on Claude 4.6 and up (incl.
 * Fable 5). On these models `thinking: {type:"enabled", budget_tokens}` and
 * `{type:"disabled"}` both 400 — depth is controlled solely via effort. Older
 * models (≤4.5), local, and OpenAI-compat endpoints get no thinking config.
 */
/**
 * `anthropic-beta` flags to send for a given model. The 1M context window is beta-
 * gated behind `context-1m-2025-08-07` and only offered on `[1m]` model variants;
 * adaptive thinking + effort are GA on 4.6+ so they need no header.
 */
export function anthropicBetaHeaders(opts: { model: string; cacheTtl?: '5m' | '1h'; fastMode?: boolean }): string[] {
  const betas: string[] = [];
  if (/\[1m\]/i.test(opts.model)) betas.push('context-1m-2025-08-07');
  if (opts.cacheTtl === '1h') betas.push('extended-cache-ttl-2025-04-11');
  if (opts.fastMode) betas.push('fast-mode-2026-02-01');
  return betas;
}

export function supportsAdaptiveThinking(model: string): boolean {
  const m = model.toLowerCase();
  if (m.startsWith('claude-fable-')) return true;
  // claude-{opus,sonnet,haiku}-4-N where N ≥ 6 is a MINOR version (1–2 digits: 4.6, 4.8, …).
  // Require the minor to be followed by end-or-non-digit so an 8-digit DATE snapshot id
  // (e.g. claude-opus-4-20250514 = Opus 4.0 GA, which does NOT support adaptive thinking) is
  // NOT misread as "generation 20250514" and sent an adaptive body the API 400s.
  const gen = /^claude-(?:opus|sonnet|haiku)-4-(\d{1,2})(?:$|[^\d])/.exec(m);
  return gen ? Number(gen[1]) >= 6 : false;
}

/**
 * With adaptive thinking on, `max_tokens` caps thinking + answer combined, so the
 * default 8k can truncate mid-reasoning at higher effort. Floor it so thinking has
 * room; the caller still pays only for tokens actually produced.
 */
const MIN_THINKING_MAX_TOKENS = 32_000;

export function buildAnthropicBody(
  req: CompletionRequest,
  fallbackModel: string,
  stream = true,
): Record<string, unknown> {
  const model = req.model || fallbackModel;
  // Fast mode is a low-latency path; it's mutually exclusive with extended thinking,
  // so fast mode disables adaptive thinking rather than risk a 400.
  const adaptive = supportsAdaptiveThinking(model) && !req.fastMode;
  const cacheControl = req.cacheTtl === '1h' ? { type: 'ephemeral', ttl: '1h' } : { type: 'ephemeral' };
  // Rolling prompt-cache breakpoint on the conversation: tag the last block of the
  // last message so the whole prefix is cached and the NEXT turn reads it back.
  // Anthropic allows up to 4 cache_control breakpoints — we use system + last tool
  // + this one. Previously only system+tools were cached, so the (growing) history
  // was re-billed in full every turn; this is the big multi-turn latency/cost win.
  const messages = toAnthropicMessages(req.messages, model);
  const lastMsg = messages[messages.length - 1];
  if (lastMsg && lastMsg.content.length > 0) {
    (lastMsg.content[lastMsg.content.length - 1] as Record<string, unknown>).cache_control = cacheControl;
  }
  const body: Record<string, unknown> = {
    model,
    max_tokens: adaptive ? Math.max(req.maxOutputTokens, MIN_THINKING_MAX_TOKENS) : req.maxOutputTokens,
    // NOTE: no `temperature`/`top_p`/`top_k` — all return HTTP 400 on adaptive models.
    messages,
    stream,
  };

  // Extended reasoning: adaptive thinking lets Claude decide when/how deep to think;
  // `output_config.effort` is the primary intelligence/latency/cost dial (GA on 4.6+,
  // no beta header). `display:"summarized"` opts into a readable reasoning summary —
  // the default ("omitted") returns an empty thinking string. Interleaved thinking is
  // automatic under adaptive mode.
  if (adaptive) {
    body.thinking = { type: 'adaptive', display: 'summarized' };
    body.output_config = { effort: req.effort ?? 'high' };
  }
  // Fast mode (premium low-latency): a top-level speed param + the beta header (see send()).
  if (req.fastMode) body.speed = 'fast';

  // System as a cacheable text block (prompt caching is GA; no beta header).
  if (req.system && req.system.trim()) {
    body.system = [{ type: 'text', text: req.system, cache_control: cacheControl }];
  }

  if (req.tools.length > 0) {
    body.tools = req.tools.map((t, i) => {
      const tool: Record<string, unknown> = {
        name: t.name,
        description: t.description,
        input_schema: t.parameters,
      };
      // cache_control on the LAST tool only — caches the whole tool block prefix.
      if (i === req.tools.length - 1) tool.cache_control = cacheControl;
      return tool;
    });
  }

  // tool_choice / stop_sequences: caller-supplied, omitted by default (matches Claude
  // Code, which sends each only when provided — the API defaults to `auto` for tools).
  if (req.toolChoice) {
    const tc: Record<string, unknown> = { type: req.toolChoice.type };
    if (req.toolChoice.type === 'tool') tc.name = req.toolChoice.name;
    if (req.toolChoice.disableParallelToolUse) tc.disable_parallel_tool_use = true;
    body.tool_choice = tc;
  }
  if (req.stopSequences && req.stopSequences.length) body.stop_sequences = req.stopSequences;

  return body;
}

// ── SSE → ProviderEvent (exported for unit tests; no network) ────────────────

interface AntUsage {
  input_tokens?: number;
  output_tokens?: number;
  cache_read_input_tokens?: number;
  cache_creation_input_tokens?: number;
}

interface AntSSE {
  type?: string;
  index?: number;
  message?: { usage?: AntUsage };
  content_block?: { type?: string; id?: string; name?: string; data?: string };
  delta?: {
    type?: string;
    text?: string;
    partial_json?: string;
    thinking?: string;
    signature?: string;
    stop_reason?: string;
  };
  usage?: AntUsage;
  error?: { type?: string; message?: string };
}

interface AntBlockState {
  type: string;
  id: string;
  name: string;
  json: string;
  thinking: string;
  signature: string;
  data: string; // redacted_thinking payload (arrives whole at content_block_start, no deltas)
  done?: boolean; // emitted at content_block_stop — guards against a double-emit on the end flush
}

export async function* parseAnthropicSSE(lines: AsyncIterable<string>): AsyncIterable<ProviderEvent> {
  let inputTokens = 0;
  let outputTokens = 0;
  let cacheReadTokens = 0;
  let cacheWriteTokens = 0;
  let stopReason: StopReason = 'end_turn';
  const blocks = new Map<number, AntBlockState>();
  let sawMessageStop = false;

  // Emit any tool_use block that accumulated args but never got a content_block_stop
  // (truncated / non-conforming Anthropic-compat stream). The per-block `done` flag is set
  // when content_block_stop already emitted it, so this can never double-emit a call.
  function* flushPendingToolUse(): Generator<ProviderEvent> {
    for (const b of blocks.values()) {
      // Guard on `name` (set by content_block_start), NOT `json` — a zero-arg call has empty
      // json and must still flush as {} args, matching the content_block_stop path.
      if (b.type !== 'tool_use' || b.done || !b.name) continue;
      b.done = true;
      const parsed = parseToolArgs(b.json);
      if (parsed.ok) yield { type: 'tool_call', call: { id: b.id, name: b.name, input: parsed.value } };
      else yield { type: 'error', recoverable: true, code: 'bad_tool_json', message: `tool "${b.name}" ${parsed.error}` };
    }
  }

  for await (const rawLine of lines) {
    const line = rawLine.trim();
    if (!line.startsWith('data:')) continue;
    const payload = line.slice(5).trim();
    if (!payload) continue;

    let evt: AntSSE;
    try {
      evt = JSON.parse(payload) as AntSSE;
    } catch {
      continue; // ignore keepalive / malformed frames
    }

    switch (evt.type) {
      case 'message_start': {
        const u = evt.message?.usage;
        if (u) {
          if (typeof u.input_tokens === 'number') inputTokens = u.input_tokens;
          if (typeof u.cache_read_input_tokens === 'number') cacheReadTokens = u.cache_read_input_tokens;
          if (typeof u.cache_creation_input_tokens === 'number') cacheWriteTokens = u.cache_creation_input_tokens;
        }
        break;
      }
      case 'content_block_start': {
        if (typeof evt.index === 'number') {
          blocks.set(evt.index, {
            type: evt.content_block?.type ?? '',
            id: evt.content_block?.id ?? '',
            name: evt.content_block?.name ?? '',
            json: '',
            thinking: '',
            signature: '',
            // redacted_thinking carries its whole (encrypted) payload here — no deltas follow.
            data: typeof evt.content_block?.data === 'string' ? evt.content_block.data : '',
          });
        }
        break;
      }
      case 'content_block_delta': {
        const d = evt.delta;
        if (!d || typeof evt.index !== 'number') break;
        // some Anthropic-compat streams omit content_block_start — lazy-create.
        let b = blocks.get(evt.index);
        if (!b) {
          const inferredType =
            d.type === 'input_json_delta'
              ? 'tool_use'
              : d.type === 'thinking_delta' || d.type === 'signature_delta'
                ? 'thinking'
                : 'text';
          b = { type: inferredType, id: '', name: '', json: '', thinking: '', signature: '', data: '' };
          blocks.set(evt.index, b);
        }
        if (d.type === 'text_delta' && typeof d.text === 'string') {
          yield { type: 'text', delta: d.text };
        } else if (d.type === 'input_json_delta' && typeof d.partial_json === 'string') {
          b.json += d.partial_json;
          yield { type: 'tool_call_partial', id: b.id, name: b.name, jsonDelta: d.partial_json };
        } else if (d.type === 'thinking_delta' && typeof d.thinking === 'string') {
          b.thinking += d.thinking;
          yield { type: 'thinking', delta: d.thinking };
        } else if (d.type === 'signature_delta' && typeof d.signature === 'string') {
          // The signature arrives (possibly in parts) on the thinking block; it must
          // be captured and echoed back verbatim on the next request.
          b.signature += d.signature;
        }
        break;
      }
      case 'content_block_stop': {
        if (typeof evt.index !== 'number') break;
        const b = blocks.get(evt.index);
        if (b && b.type === 'thinking') {
          b.done = true;
          // Emit the completed, signed thinking block for the loop to stash in
          // history so it can be echoed back on the next turn.
          yield { type: 'thinking_block', thinking: b.thinking, signature: b.signature };
        } else if (b && b.type === 'redacted_thinking') {
          b.done = true;
          // Encrypted reasoning — preserve the blob for verbatim echo-back next turn.
          yield { type: 'redacted_thinking_block', data: b.data };
        } else if (b && b.type === 'tool_use') {
          b.done = true;
          const parsed = parseToolArgs(b.json); // repair ladder before giving up
          if (parsed.ok) {
            yield { type: 'tool_call', call: { id: b.id, name: b.name, input: parsed.value } };
          } else {
            yield {
              type: 'error',
              recoverable: true,
              code: 'bad_tool_json',
              message: `tool "${b.name}" ${parsed.error}`,
            };
          }
        }
        break;
      }
      case 'message_delta': {
        if (evt.delta?.stop_reason) stopReason = mapAnthropicStop(evt.delta.stop_reason);
        if (typeof evt.usage?.output_tokens === 'number') outputTokens = evt.usage.output_tokens;
        break;
      }
      case 'message_stop': {
        yield* flushPendingToolUse(); // any in-flight tool_use must land BEFORE done
        sawMessageStop = true;
        yield { type: 'usage', inputTokens, outputTokens, cacheReadTokens, cacheWriteTokens };
        yield { type: 'done', stopReason };
        break;
      }
      case 'error': {
        const code = evt.error?.type ?? 'api_error';
        // overloaded / transient api errors are retryable; the rest are terminal.
        const recoverable = code === 'overloaded_error' || code === 'api_error';
        yield { type: 'error', recoverable, code, message: evt.error?.message ?? 'stream error' };
        break;
      }
      default:
        break;
    }
  }

  // Stream ended WITHOUT a message_stop (truncated / non-conforming endpoint): salvage any
  // in-flight tool call and synthesize the terminal events so the loop completes the turn
  // instead of silently committing an empty one.
  if (!sawMessageStop) {
    yield* flushPendingToolUse();
    yield { type: 'usage', inputTokens, outputTokens, cacheReadTokens, cacheWriteTokens };
    yield { type: 'done', stopReason };
  }
}

function mapAnthropicStop(reason: string): StopReason {
  switch (reason) {
    case 'tool_use':
      return 'tool_use';
    case 'max_tokens':
      return 'max_tokens';
    case 'pause_turn':
      // A long turn the server paused mid-flight; resend to let it continue.
      return 'pause_turn';
    case 'end_turn':
    case 'stop_sequence':
    case 'refusal':
    default:
      return 'end_turn';
  }
}
