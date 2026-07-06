/**
 * Heuristic: does this model id look like it was distilled on / trained for the
 * Anthropic (Claude) wire format? Such models emit `<thinking>`, Anthropic-style
 * tool calls, and `<channel|>` control tokens — which the OpenAI adapter can't
 * parse, but the Anthropic adapter handles natively (e.g. via Ollama's
 * `/v1/messages`). Used to auto-suggest the right transport at onboarding.
 *
 * Deliberately a NAME heuristic only — it cannot be foolproof (distillation isn't
 * always in the name), so callers should SUGGEST, never force, and an onboarding
 * disclaimer covers the gap.
 */
export type ModelFamily =
  | 'anthropic'
  | 'openai'
  | 'grok'
  | 'google'
  | 'deepseek'
  | 'qwen'
  | 'meta'
  | 'mistral'
  | 'other';

/** Classify a model id by its maker — for transport/format routing and onboarding hints. */
export function modelFamily(model: string): ModelFamily {
  const m = model.toLowerCase();
  if (/claude|opus|sonnet|haiku|fable|anthropic/.test(m)) return 'anthropic';
  if (/grok/.test(m)) return 'grok';
  if (/gpt|codex|davinci|(^|[-/])o[1345]\b|text-embedding/.test(m)) return 'openai';
  if (/gemini|gemma|palm/.test(m)) return 'google';
  if (/deepseek/.test(m)) return 'deepseek';
  if (/qwen/.test(m)) return 'qwen';
  if (/llama|codellama/.test(m)) return 'meta';
  if (/mistral|mixtral|codestral/.test(m)) return 'mistral';
  return 'other';
}

export function looksAnthropicDistilled(model: string): boolean {
  return modelFamily(model) === 'anthropic';
}

/** Drop a trailing `/v1` so a base URL fits the Anthropic adapter (which appends `/v1/messages`). */
export function toAnthropicBaseUrl(baseUrl: string): string {
  return baseUrl.replace(/\/v1\/?$/, '');
}
