/**
 * Provider layer — one interface, multiple backends (anthropic, openai, mock).
 *
 * The internal message model is provider-NEUTRAL and block-based so tool calls
 * round-trip across every backend. Each provider adapter translates this model
 * to/from its own wire format; the agent loop never sees a provider-specific shape.
 */

export type Role = 'system' | 'user' | 'assistant' | 'tool';

export interface TextBlock {
  type: 'text';
  text: string;
}

export interface ToolUseBlock {
  type: 'tool_use';
  id: string;
  name: string;
  input: unknown;
  /** Opaque provider tool-call signature to echo back next turn (Gemini `thought_signature`). */
  signature?: string;
}

export interface ToolResultBlock {
  type: 'tool_result';
  toolCallId: string; // matches the originating ToolUseBlock.id
  ok: boolean;
  content: string; // model-facing serialization of a ToolResult (summary + key data)
}

/**
 * Extended-reasoning block (Claude 4.6+ adaptive thinking). The `signature` is an
 * opaque token the API issues; it MUST be echoed back verbatim on the next request
 * when the same assistant turn carried tool_use, or the API rejects the turn. The
 * `thinking` text is the (summarized) chain of thought — display-only, never a secret.
 */
export interface ThinkingBlock {
  type: 'thinking';
  thinking: string;
  signature: string;
  /**
   * Model that produced this block. A signature is only valid for the model that
   * issued it, so on a `/model` switch the block is dropped rather than replayed
   * (the API rejects another model's signed thinking). Absent on pre-dev.6 history.
   */
  model?: string;
}

/**
 * Encrypted reasoning the API chose to redact (Anthropic `redacted_thinking`). The
 * `data` is an opaque, non-decryptable blob — it carries no readable text, but it MUST
 * be echoed back verbatim (like a signed thinking block) when the same assistant turn
 * carried tool_use, or the follow-up request 400s. Replayed only for the model that
 * produced it (the blob is bound to that model), so a `/model` switch drops it.
 */
export interface RedactedThinkingBlock {
  type: 'redacted_thinking';
  data: string;
  /** Model that produced this block; absent on history from before redacted support. */
  model?: string;
}

/**
 * Multimodal image input (user turns only — models don't emit images). `data` is the
 * raw image bytes base64-encoded (no `data:` URI prefix); `mediaType` is the MIME type
 * (e.g. `image/png`). Each provider adapter renders this to its own wire form: Anthropic
 * `image.source.base64`, OpenAI/Gemini `image_url` with a data URI. Sent only to vision-
 * capable models; others ignore it (the block is dropped from the request).
 */
export interface ImageBlock {
  type: 'image';
  mediaType: string;
  data: string;
}

export type ContentBlock = TextBlock | ToolUseBlock | ToolResultBlock | ThinkingBlock | RedactedThinkingBlock | ImageBlock;

/** Reasoning depth control. Maps to Anthropic `output_config.effort` on capable models. */
export type Effort = 'low' | 'medium' | 'high' | 'xhigh' | 'max';

export interface Message {
  role: Role;
  content: ContentBlock[]; // never a bare string internally
}

export interface ToolCall {
  id: string;
  name: string;
  input: unknown;
  /** Opaque provider tool-call signature to echo back next turn (Gemini `thought_signature`). */
  signature?: string;
}

/** A tool's calling contract, exported from the registry to the provider. */
export interface ToolSchema {
  name: string;
  description: string;
  parameters: Record<string, unknown>; // JSON Schema (object)
}

export type StopReason = 'end_turn' | 'tool_use' | 'max_tokens' | 'pause_turn';

export type ProviderEvent =
  | { type: 'text'; delta: string }
  | { type: 'thinking'; delta: string } // streamed reasoning text (display)
  | { type: 'thinking_block'; thinking: string; signature: string } // complete block (echo-back)
  | { type: 'redacted_thinking_block'; data: string } // encrypted reasoning to echo back verbatim
  | { type: 'tool_call_partial'; id: string; name: string; jsonDelta: string }
  | { type: 'tool_call'; call: ToolCall }
  | {
      type: 'usage';
      inputTokens: number;
      outputTokens: number;
      cacheReadTokens?: number;
      cacheWriteTokens?: number;
    }
  | { type: 'error'; recoverable: boolean; code: string; message: string }
  | { type: 'done'; stopReason: StopReason };

export interface CompletionRequest {
  model: string;
  system: string;
  messages: Message[];
  tools: ToolSchema[];
  maxOutputTokens: number; // per-call OUTPUT cap (distinct from the budget ceiling)
  effort?: Effort; // reasoning depth; providers that lack adaptive thinking ignore it
  cacheTtl?: '5m' | '1h'; // Anthropic prompt-cache TTL for the stable prefix (default 5m)
  fastMode?: boolean; // Anthropic "fast mode" (premium low-latency); ignored elsewhere
  /**
   * Force or suppress tool use (Anthropic `tool_choice`). Omitted ⇒ provider default
   * (`auto` when tools are present). Like the reference client, this is only sent when a caller
   * supplies it — the agentic loop leaves it unset. `none` forbids tools this turn;
   * `tool` forces the named tool; `any` forces some tool.
   */
  toolChoice?: ToolChoice;
  /** Custom stop sequences (Anthropic `stop_sequences`). Omitted by default, as in the reference client. */
  stopSequences?: string[];
  signal?: AbortSignal; // user interrupt (ESC/Ctrl-C) — cancels the in-flight request
}

export type ToolChoice =
  | { type: 'auto' | 'any' | 'none'; disableParallelToolUse?: boolean }
  | { type: 'tool'; name: string; disableParallelToolUse?: boolean };

export interface Provider {
  readonly name: string;
  send(req: CompletionRequest): AsyncIterable<ProviderEvent>;
  /** LOCAL, synchronous token estimate for budget + summarization (never a network call). */
  estimateTokens(messages: Message[]): number;
  /**
   * Optional accurate count (for Anthropic this hits the count_tokens endpoint).
   * Falls back to estimate if not implemented. May be async and may incur a small cost.
   */
  countTokens?(args: {
    model: string;
    system?: string;
    messages: Message[];
    tools?: any[];
  }): Promise<number>;
}

// ---- small helpers shared across adapters and the loop ----

export function textOf(blocks: ContentBlock[]): string {
  return blocks
    .filter((b): b is TextBlock => b.type === 'text')
    .map((b) => b.text)
    .join('');
}

export function toolUsesOf(blocks: ContentBlock[]): ToolUseBlock[] {
  return blocks.filter((b): b is ToolUseBlock => b.type === 'tool_use');
}

/** Rough char/4 heuristic used by the mock and as a fallback estimator.
 *  Real usage numbers from the provider (inputTokens in usage events) are preferred
 *  by Context for summarization decisions. This is only for the very first estimate
 *  or when no usage has been observed yet.
 */
export function estimateTokensFromMessages(messages: Message[]): number {
  let chars = 0;
  for (const m of messages) {
    for (const b of m.content) {
      if (b.type === 'text') chars += b.text.length;
      else if (b.type === 'thinking') chars += b.thinking.length;
      else if (b.type === 'tool_use') chars += b.name.length + JSON.stringify(b.input ?? {}).length;
      else if (b.type === 'tool_result') chars += (b.content ?? '').length;
      else if (b.type === 'image') chars += 4000; // ~1k tokens flat; real cost comes from usage events
    }
  }
  // Char/4 is a ballpark for English+code; add a small overhead floor so
  // tiny histories don't under-trigger compaction on models with smaller windows.
  const rough = Math.ceil(chars / 4);
  return Math.max(rough, Math.ceil(rough * 1.05));
}
