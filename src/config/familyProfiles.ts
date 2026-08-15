/**
 * Model-family profiles v0 — per-family DEFAULTS applied only where the user hasn't set an
 * explicit value (precedence: explicit config > family profile > global default).
 *
 * Every entry is EVIDENCE-BASED — from the public compatibility matrix (README "Model
 * compatibility") or behavior already enforced in the provider adapters — never a guess. v0
 * carries two kinds of payload:
 *   • behavioral defaults (`parallelTools`) — applied via resolveParallelTools();
 *   • surfaced knowledge (`note`, `transport`, `minOutputTokens`) — shown when the model is
 *     selected, so matrix findings reach the user at the moment they matter instead of living
 *     in a README table nobody reads mid-session.
 *
 * NOT named "modelProfile" — that name is taken by the prompt-profile system
 * (src/system/resolveSystem.ts + prompts/models/*.md).
 */
import { looksAnthropicDistilled } from '../util/transport.js';
import { isQwenReasoner, isQwen38MaxModel, isDeepSeekReasoner, isKimiThinkingModel } from '../provider/openai.js';
import type { Effort } from '../provider/provider.js';

/** A GENUINE Anthropic model id — including vendor-prefixed forms (OpenRouter
 *  `anthropic/claude-*`, Bedrock `us.anthropic.claude-*`) and bare family aliases
 *  (`opus-4.1`). These must never inherit distill defaults: looksAnthropicDistilled
 *  matches them too (correct for transport routing, wrong for profiles). */
function isGenuineAnthropicId(m: string): boolean {
  const t = m.trim().toLowerCase();
  if (t.startsWith('anthropic/') || /(^|\.)anthropic\./.test(t)) return true;
  const tail = t.split('/').pop() ?? t;
  return /^(claude|opus|sonnet|haiku|fable)([-.\d]|$)/.test(tail);
}

export interface FamilyProfile {
  /** Short family key, e.g. "qwen-reasoner". */
  family: string;
  /** Default for CLIENT-SIDE parallel tool execution (loop-level), when the user hasn't set one. */
  parallelTools?: boolean;
  /** Documented output floor the provider adapter enforces (surfaced, not applied here). */
  minOutputTokens?: number;
  /** Documented HARD output cap of the hosted endpoint (tokens). buildOpenAIBody clamps the first
   *  request under it, so a published limit is never re-discovered through the 400-shrink ladder
   *  (which stays as the safety net for undocumented ones). */
  maxOutputCap?: number;
  /** The reasoning_effort vocabulary the endpoint accepts, ascending. An explicit
   *  capabilities.effortScale outranks it; emission is gated on the scale, so a tier the endpoint
   *  never declared is never sent. */
  effortScale?: Effort[];
  /** Wire-format hint: the model emits this transport's tool-call format natively. */
  transport?: 'anthropic';
  /** One-line heads-up surfaced on selection. */
  note?: string;
}

/** Ordered table — FIRST match wins. Keep matchers narrow; a wrong profile is worse than none. */
const TABLE: { match: (m: string) => boolean; profile: FamilyProfile }[] = [
  {
    // Anthropic-distilled community models (e.g. gemma-*-opus/claude distills): they emit
    // Anthropic-FORMAT tool calls (matrix verdict: FORMAT). Parallel batches multiply the
    // recovery surface, so single-call execution is the safe default for them.
    // NOT genuine Anthropic models (any form — bare, OpenRouter-prefixed, Bedrock-dotted):
    // looksAnthropicDistilled deliberately matches those too (fine for transport routing).
    match: (m) => looksAnthropicDistilled(m) && !isGenuineAnthropicId(m),
    profile: {
      family: 'anthropic-distill',
      transport: 'anthropic',
      parallelTools: false,
      note: 'matrix: emits Anthropic-format tool calls — runs best on the anthropic transport; parallel tool calls off by default.',
    },
  },
  {
    // Qwen 3.8 Max is an adaptive hosted reasoner even though its id contains neither QwQ nor
    // "thinking". On a verified DashScope endpoint it also requires structured reasoning history
    // to remain separate from content; the OpenAI-compatible adapter preserves that field there.
    match: (m) => isQwen38MaxModel(m),
    profile: {
      family: 'qwen-3.8-max',
      minOutputTokens: 262_144,
      note: 'Qwen 3.8 adaptive reasoning: preserved thinking is round-tripped separately; DashScope gets a 262k output ceiling for xhigh reasoning.',
    },
  },
  {
    // Bare GLM-4 (NOT glm-4.x): matrix verdict NOT-AGENTIC — 0 tool calls in the eval. A
    // profile can't fix that; it CAN warn the user at selection instead of letting them
    // discover it after ten silent turns.
    match: (m) => /(^|\/)glm-4$/i.test(m.trim()),
    profile: {
      family: 'glm-4-legacy',
      note: 'matrix: GLM-4 scored NOT-AGENTIC (0 tool calls) — prefer glm-4.6+ for agent work.',
    },
  },
  {
    // Qwen REASONERS only — mirror the adapter's own matcher exactly (isQwenReasoner: QwQ and
    // qwen*think* variants). A plain Qwen3-instruct gets NO floor from the adapter, so claiming
    // one here would be false; the note must only fire where the behavior is real.
    match: (m) => isQwenReasoner(m),
    profile: {
      family: 'qwen-reasoner',
      minOutputTokens: 64_000,
      note: 'reasoning family: the provider enforces a 64k output floor (thinking + answer share it).',
    },
  },
  {
    // Hosted DeepSeek chat (V3 line, non-thinking): platform docs cap max_tokens at 8,192
    // (default 4K). Without the cap, Shadow's 65,536 default 400-cascades through three shrink
    // round-trips EVERY turn before landing on 8,192 — with it the first request fits.
    match: (m) => /(^|\/)deepseek-chat(?:$|[._-])/i.test(m.trim()),
    profile: {
      family: 'deepseek-chat',
      maxOutputCap: 8_192,
      note: 'DeepSeek caps deepseek-chat output at 8,192 tokens — requests are clamped to fit on the first try.',
    },
  },
  {
    // Same rule: the adapter's matcher IS the truth (deepseek-reasoner / R1 / R1 distills).
    // Hosted deepseek-reasoner allows a 64K completion (thinking + answer, default 32K): the cap
    // keeps an explicit larger --max-output-tokens from 400-cascading, while the floor preserves
    // the full documented reasoning budget. For local R1 distills the cap only binds above 64K —
    // requests those windows reject anyway — so the shrink ladder remains their real net.
    match: (m) => isDeepSeekReasoner(m),
    profile: {
      family: 'deepseek-reasoner',
      minOutputTokens: 64_000,
      maxOutputCap: 65_536,
      note: 'reasoning family: the provider enforces a 64k output floor (thinking + answer share it).',
    },
  },
  {
    // Kimi K2/K3 "thinking" variants: reasoning_content replay is a MODEL contract — Moonshot's
    // tool-calling docs require echoing it back on later turns, and the open-weight chat template
    // consumes the same field (see shouldPreserveProviderReasoning). Effort vocabulary is the
    // Moonshot 3-tier low/high/max scale (F09-03) — emission is clamped onto it.
    match: (m) => isKimiThinkingModel(m),
    profile: {
      family: 'kimi-thinking',
      effortScale: ['low', 'high', 'max'],
      note: 'Kimi thinking: assistant reasoning_content is replayed in tool loops; /effort maps onto the low/high/max scale.',
    },
  },
];

/** The profile for a model id, or undefined when no family matches (most models — by design). */
export function familyProfile(model: string): FamilyProfile | undefined {
  for (const { match, profile } of TABLE) {
    if (match(model)) return profile;
  }
  return undefined;
}

/**
 * Effective parallel-tools setting: explicit user config wins, else the family default, else
 * the global default (true). `explicit` = the user actually wrote parallelTools somewhere
 * (config file / CLI / /config set) — zod's .default() erases that, so loadConfig records it.
 */
export function resolveParallelTools(
  cfg: { parallelTools: boolean; explicitKeys?: string[] },
  model: string,
): boolean {
  if (cfg.explicitKeys?.includes('parallelTools')) return cfg.parallelTools;
  const prof = familyProfile(model);
  if (prof?.parallelTools !== undefined) return prof.parallelTools;
  return cfg.parallelTools;
}
