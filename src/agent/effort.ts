/**
 * Reasoning-effort model for the Shadow harness.
 *
 * Effort has TWO channels, and both are used together:
 *
 *   1. NATIVE param — the loop passes `effort` on every CompletionRequest; the
 *      Anthropic adapter maps it to `output_config.effort` and the OpenAI adapter
 *      to `reasoning_effort` (where the model speaks them).
 *
 *   2. PROMPT DIRECTIVE — {@link effortDirective} is appended to the system prompt
 *      every turn. This is the model-agnostic channel: it is the ONLY signal a
 *      model that does not speak a native effort param receives (e.g. an
 *      OpenAI-compatible local model, GLM, or a plain chat model behind the
 *      hosted API). It describes the *operating style* expected at each depth, so
 *      any capable model can act on it regardless of wire format.
 *
 * The directive is intentionally complementary to the baseline profile's
 * "Calibrate to your capability" section: that section is the MODEL's
 * self-assessment; this directive is the HARNESS/user's requested depth for the
 * current session.
 *
 * Pure + dependency-free so it is unit-testable in isolation.
 */
import type { Effort } from '../provider/provider.js';

export const EFFORT_LEVELS: readonly Effort[] = ['low', 'medium', 'high', 'xhigh', 'max'];

export const DEFAULT_EFFORT: Effort = 'high';

/** Unicode depth glyph (matches the reference client's EffortIndicator vocabulary). */
const SYMBOLS: Record<Effort, string> = {
  low: '◯',
  medium: '◐',
  high: '◑',
  xhigh: '◕',
  max: '⬤',
};

export function effortSymbol(level: Effort): string {
  return SYMBOLS[level] ?? SYMBOLS.high;
}

/** Cycle to the next depth, wrapping low → medium → … → max → low. */
export function cycleEffort(level: Effort): Effort {
  const i = EFFORT_LEVELS.indexOf(level);
  const next = i < 0 ? EFFORT_LEVELS.indexOf(DEFAULT_EFFORT) : i;
  return EFFORT_LEVELS[(next + 1) % EFFORT_LEVELS.length]!;
}

/** Parse + validate a user string ('low'|'medium'|'high'|'xhigh'|'max'); null if invalid. */
export function normalizeEffort(s: string | undefined | null): Effort | null {
  if (!s) return null;
  const l = s.toLowerCase().trim();
  return (EFFORT_LEVELS as readonly string[]).includes(l) ? (l as Effort) : null;
}

/** Coerce to a valid Effort, defaulting when null/invalid. */
export function effortOrDefault(s: string | undefined | null): Effort {
  return normalizeEffort(s) ?? DEFAULT_EFFORT;
}

const DESCRIPTIONS: Record<Effort, string> = {
  low: 'minimal — direct answers, one-shot edits, no planning ceremony',
  medium: 'normal — read before edit, verify after, light planning',
  high: 'thorough — plan multi-step, verify each step, consider edge cases, parallelize reads',
  xhigh: 'exhaustive — deep planning, adversarial self-review before done, full edge-case coverage',
  max: 'maximum — high-stakes; reason exhaustively, verify relentlessly by execution, leave nothing unexamined',
};

export function effortDescription(level: Effort): string {
  return DESCRIPTIONS[level] ?? DESCRIPTIONS.high;
}

/**
 * A concise, model-agnostic directive appended to the system prompt every turn.
 * Any model — including one with no native effort param — can act on this. Kept
 * short (it re-sends every turn) and framed as operating style, not fluff.
 */
export function effortDirective(level: Effort): string {
  return [
    `## Operating effort: ${level}`,
    '',
    `Work at **${level}** effort this session: ${effortDescription(level)}.`,
    'The harness also requests this depth natively where the model supports it; for ' +
      'models that do not (local/OpenAI-compatible/chat models), this directive IS the signal — ' +
      'honour it in how deeply you reason, plan, and verify before answering.',
    'Scale to the task: do not burn max effort on a typo, and do not one-line a ' +
      'security-sensitive or multi-file change. Report outcomes faithfully regardless of level.',
  ].join('\n');
}
