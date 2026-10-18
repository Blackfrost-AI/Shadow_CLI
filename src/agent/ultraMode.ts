/**
 * Ultra mode: run every model at the strongest setting it can CERTIFIABLY accept.
 *
 * The problem this solves is not "add a bigger effort level". It is that Shadow serves a dozen
 * endpoints with wildly different capabilities — a frontier API with adaptive thinking and a 1M
 * window, a local vLLM serve that speaks `reasoning_effort` but nothing else, a proxy reusing a
 * Qwen alias with only plain Chat Completions. Until now each ADAPTER decided what to send by
 * inspecting the model id with a regex. That has two failure modes that pull in opposite
 * directions, and both are real:
 *
 *   - UNDER-DELIVERY. `anthropic.ts` sends `output_config.effort` on every adaptive model but
 *     never consults `capabilities.effortScale`, so a declared scale is dead metadata and the
 *     /effort dial can hand an endpoint a value its author never claimed it accepts.
 *   - OVER-CLAIMING. The status line says "max" because the user asked for max, whether or not
 *     the endpoint got anything of the sort.
 *
 * Ultra mode replaces the guess with a contract. An endpoint DECLARES its capabilities (see
 * `ModelCapabilities` in config.ts, filled in per model in the catalog); this module folds that
 * declaration and the user's request into a single plan that is (a) the strongest honest setting
 * the endpoint can take, and (b) explicit about every channel it could not enable.
 *
 * THE RULE IS FAIL-CLOSED, IN THE STRICT DIRECTION. A capability that is not declared is never
 * sent, and is reported as unavailable rather than quietly assumed. The consequence worth stating
 * plainly: an UNDECLARED endpoint gets exactly today's behaviour (so no working setup regresses)
 * but is reported as `unverified`, not as `ultra`. That distinction is the whole point — the
 * feature must never let Shadow claim depth it did not deliver.
 *
 * Known limit, deliberately not papered over: the catalog's Anthropic preset declares NO
 * `capabilities` block at all — not an `effortScale`. So a Claude endpoint is currently
 * UNDECLARED, which puts it in the `unverified` branch below rather than clamping it. Whether a
 * given Claude model accepts `high`/`max` is an API fact that cannot be established from this
 * checkout, so this module does not invent it. Declaring `effortScale` on that one catalog entry
 * would move Claude onto the declared path and deliver the full ladder with no code change; until
 * then the effort value is passed through and reported as unverified, never as `ultra`.
 */
import type { Effort } from '../provider/provider.js';

/** Ascending depth ladder. Mirrors EFFORT_LEVELS; kept local so this module stays dependency-free. */
export const ULTRA_LADDER: readonly Effort[] = ['low', 'medium', 'high', 'xhigh', 'max'];

/**
 * The strongest value on a declared scale at or below `requested`.
 *
 * Never returns something ABOVE `requested`: ultra mode must not silently out-spend the setting
 * the user chose. When the scale cannot serve the request at all — every declared value is
 * shallower — this returns the deepest declared value, because the honest answer to "give me max"
 * on a three-tier endpoint is its top tier, not a refusal.
 */
export function clampToScale(requested: Effort, scale: readonly Effort[]): Effort {
  const want = ULTRA_LADDER.indexOf(requested);
  if (want < 0) return requested; // not on the ladder: caller's own value, untouched
  let best: Effort | null = null;
  let bestRank = -1;
  for (const v of scale) {
    const rank = ULTRA_LADDER.indexOf(v);
    if (rank < 0 || rank > want) continue; // undeclared depth is never sent
    if (rank > bestRank) {
      bestRank = rank;
      best = v;
    }
  }
  if (best) return best;
  // Every declared value is deeper than requested (a scale of ['xhigh'] and a request for 'low'):
  // the shallowest declared value is the closest honest answer.
  let shallowest: Effort | null = null;
  let shallowestRank = Number.POSITIVE_INFINITY;
  for (const v of scale) {
    const rank = ULTRA_LADDER.indexOf(v);
    if (rank >= 0 && rank < shallowestRank) {
      shallowestRank = rank;
      shallowest = v;
    }
  }
  return shallowest ?? requested;
}

/**
 * Capability channels ultra mode can light up. Each one is a distinct wire feature with a distinct
 * cost/latency profile, so they are tracked separately rather than collapsed into one boolean —
 * "ultra" on a model with adaptive thinking and no fast path is a different thing from ultra on a
 * model with both, and the user deserves to see which they got.
 */
export type UltraChannel =
  | 'adaptive-thinking'
  | 'effort'
  | 'fast-mode'
  | 'prompt-cache'
  | 'extended-cache';

/**
 * What an endpoint declares it can do. This is the `capabilities` block from config.ts, narrowed to
 * the fields ultra mode consumes — deliberately NOT a parallel type, so a channel cannot drift
 * between the schema and the planner.
 */
export interface UltraCapabilities {
  /** Depths this exact endpoint accepts, ascending. Absent = no effort param is sent. */
  effortScale?: readonly Effort[];
  /** Server picks its own thinking depth (`thinking: adaptive`) instead of a fixed budget. */
  adaptiveThinking?: boolean;
  /** A premium low-latency speed path exists. */
  fastMode?: boolean;
  /** Prompt caching via `cache_control` breakpoints. */
  promptCache?: boolean;
  /** An extended (1h) prompt-cache TTL is available. Opt-in. */
  extendedCache?: boolean;
}

/** The user's ultra request. Every flag is OPT-IN: ultra never bills a premium path uninvited. */
export interface UltraRequest {
  /** Depth the user dialled. */
  effort: Effort;
  /** Ask for the premium low-latency path where available. */
  fastMode?: boolean;
  /** Ask for the extended cache TTL where available. */
  extendedCache?: boolean;
}

export interface UltraPlan {
  /** The depth to actually send. Always on the endpoint's declared scale when one exists. */
  effort: Effort;
  /** Channels that will genuinely be active. */
  enabled: UltraChannel[];
  /** Channels the user asked for that this endpoint does not declare. */
  unavailable: UltraChannel[];
  /**
   * True when the plan is weaker than the request — a downgraded depth or a refused channel.
   * The status line must show this rather than the dialled value.
   */
  degraded: boolean;
  /**
   * True when no capability block was declared at all. The plan then carries today's behaviour
   * unchanged, and callers must not describe it as ultra: nothing was certified.
   */
  unverified: boolean;
  /** One-line, human-readable summary for the status bar. Never overstates. */
  summary: string;
}

/**
 * Fold a declaration and a request into a plan.
 *
 * Ordering note: `effortScale` is consulted first because every other channel is a modifier on a
 * turn that effort has already shaped. An endpoint with no declared scale gets its effort passed
 * through untouched (preserving prior behaviour) and is marked `unverified`.
 */
export function planUltra(req: UltraRequest, caps: UltraCapabilities | undefined): UltraPlan {
  const declared = !!caps && Object.keys(caps).length > 0;
  const enabled: UltraChannel[] = [];
  const unavailable: UltraChannel[] = [];

  // ── depth ──────────────────────────────────────────────────────────────────────────────────
  let effort: Effort = req.effort;
  let depthDowngraded = false;
  if (declared && caps?.effortScale && caps.effortScale.length > 0) {
    effort = clampToScale(req.effort, caps.effortScale);
    depthDowngraded = effort !== req.effort;
    enabled.push('effort');
  } else if (declared) {
    // A declared block that omits effortScale is asserting this endpoint takes no effort param.
    // Fail closed: do not send one.
    unavailable.push('effort');
  }

  // ── structural channels ────────────────────────────────────────────────────────────────────
  if (declared && caps?.adaptiveThinking) enabled.push('adaptive-thinking');
  if (declared && caps?.promptCache) enabled.push('prompt-cache');

  // ── opt-in premium channels ────────────────────────────────────────────────────────────────
  // Only these can be "unavailable" in the user's sense: they were ASKED for and refused. A
  // channel the user never requested is not a shortfall and is not reported as one.
  if (req.fastMode) {
    if (declared && caps?.fastMode) enabled.push('fast-mode');
    else unavailable.push('fast-mode');
  }
  if (req.extendedCache) {
    if (declared && caps?.extendedCache) enabled.push('extended-cache');
    else unavailable.push('extended-cache');
  }

  const degraded = depthDowngraded || unavailable.length > 0;
  return {
    effort,
    enabled,
    unavailable,
    degraded,
    unverified: !declared,
    summary: summarize({ effort, requested: req.effort, enabled, unavailable, unverified: !declared }),
  };
}

/**
 * Build the status string.
 *
 * The wording is load-bearing. An unverified endpoint says `effort unverified`, never `ultra` —
 * because the user's complaint was precisely that Shadow could not tell them what it was actually
 * doing, and a label that rounds "unknown" up to "maximum" would recreate that complaint in the
 * one place it is most damaging.
 */
function summarize(p: {
  effort: Effort;
  requested: Effort;
  enabled: UltraChannel[];
  unavailable: UltraChannel[];
  unverified: boolean;
}): string {
  if (p.unverified) return `effort ${p.effort} · unverified (endpoint declares no capabilities)`;
  const parts = [`effort ${p.effort}`];
  if (p.effort !== p.requested) parts.push(`(asked ${p.requested})`);
  const on = p.enabled.filter((c) => c !== 'effort');
  if (on.length > 0) parts.push(on.join(' + '));
  if (p.unavailable.length > 0) parts.push(`no ${p.unavailable.join(', ')}`);
  return parts.join(' · ');
}

/**
 * Decide whether a plan deserves a user-visible notice.
 *
 * Split out of the adapter so the "does this reach the transcript?" question is testable without a
 * live request. The first iteration of ultra mode computed `degraded`/`unverified` and then
 * dropped them, which made the whole declaration layer invisible: the feature existed to tell the
 * user what Shadow was really doing, and it ended up telling them nothing.
 *
 * Only the degraded and unverified cases speak. A fully-delivered plan is the normal case, and a
 * notice every session is noise that trains the user to ignore the one that matters.
 */
export function planNotice(plan: UltraPlan): { title: string; body: string; severity: 'info' | 'warn' } | null {
  if (plan.unverified) {
    return {
      title: 'effort: unverified endpoint',
      body: `${plan.summary} — this endpoint declares no capabilities, so Shadow cannot confirm the requested depth was delivered.`,
      severity: 'info',
    };
  }
  if (plan.degraded) {
    return {
      title: 'ultra mode: depth downgraded',
      body: `${plan.summary} — the endpoint does not declare the requested depth.`,
      severity: 'warn',
    };
  }
  return null;
}
