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
import { isQwenReasoner, isDeepSeekReasoner } from '../provider/openai.js';

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
    // Same rule: the adapter's matcher IS the truth (deepseek-reasoner / R1 / R1 distills).
    match: (m) => isDeepSeekReasoner(m),
    profile: {
      family: 'deepseek-reasoner',
      minOutputTokens: 64_000,
      note: 'reasoning family: the provider enforces a 64k output floor (thinking + answer share it).',
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
