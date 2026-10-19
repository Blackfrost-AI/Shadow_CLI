/**
 * Quality scoring — turns a normalized trajectory into a labelled training example.
 *
 * The failure mode this module exists to prevent: dumping every session into a corpus and
 * calling it training data. Most transcripts are noise — abandoned attempts, thrash loops, runs
 * that hit the iteration ceiling. Training on that teaches a model to thrash.
 *
 * Shadow already emits every signal needed to do better than a heuristic. The important
 * distinction is that **negative examples are valuable too** — a thrash loop is a good "don't do
 * this" example and a bad "do this" example. So we LABEL rather than filter. Blending gold and
 * negative into one unlabelled pile is the actual mistake; discarding negatives throws away half
 * the signal.
 *
 * Signals used, in rough order of trustworthiness:
 *
 *  - `stopReason === 'max_iterations'` — the model ran out of rope. Strongly negative.
 *  - test/command outcomes in observations — objective, where present.
 *  - `userCorrections` — the user had to steer. Strong negative on the turn it corrects.
 *  - `failedActions` / turn ratio — thrash.
 *  - clean `stop` + no corrections — the only path to "gold".
 */
import type { Trajectory } from './trajectory.js';

export type QualityLabel = 'gold' | 'negative' | 'neutral';

export interface QualityScore {
  label: QualityLabel;
  /** 0..1. Not a probability — a ranking score for filtering/curriculum. */
  score: number;
  /** Human-readable reasons, so a label is always explainable. */
  reasons: string[];
  /** True when the example contains a failure followed by recovery (high training value). */
  containsRecovery: boolean;
}

/** Stop reasons that indicate the run did not finish its work. */
const NEGATIVE_STOPS = new Set([
  'max_iterations',
  'budget',
  'interrupted',
  'fatal_tool_error',
  'provider_error',
]);

/** A tool outcome that clearly signals the action failed. */
function looksFailed(summary: string, ok: boolean): boolean {
  if (!ok) return true;
  const s = summary.toLowerCase();
  return (
    /^(error|failed|command failed|no such file|permission denied)/.test(s) ||
    /\bexit(ed)? (code )?[1-9]\d*\b/.test(s)
  );
}

/**
 * Score one trajectory. Pure function of the trajectory — no I/O, so it is trivially testable
 * and cannot accidentally read session files.
 */
export function scoreTrajectory(t: Trajectory): QualityScore {
  const reasons: string[] = [];
  let score = 0.5;

  const { turns, outcome } = t;

  // --- Not an example at all -------------------------------------------------
  if (turns.length === 0) {
    return {
      label: 'negative',
      score: 0,
      reasons: ['empty trajectory — no turns to learn from'],
      containsRecovery: false,
    };
  }

  // --- Terminal state --------------------------------------------------------
  const stop = outcome.stopReason;
  if (stop && NEGATIVE_STOPS.has(stop)) {
    score -= 0.35;
    reasons.push(`unfinished run (stop: ${stop})`);
  } else if (stop === 'completed' || stop === 'end_turn' || stop === 'stop') {
    score += 0.2;
    reasons.push(`clean finish (stop: ${stop})`);
  } else if (!stop) {
    reasons.push('no terminal stop record');
  }

  // --- Truncation ------------------------------------------------------------
  if (outcome.truncated) {
    score -= 0.15;
    reasons.push('truncated trace (action started, no observation)');
  }

  // --- Thrash ----------------------------------------------------------------
  const thrashRatio = outcome.failedActions / Math.max(1, turns.length);
  if (thrashRatio > 0.5) {
    score -= 0.3;
    reasons.push(`high failure ratio (${outcome.failedActions}/${turns.length} actions failed)`);
  } else if (thrashRatio > 0.25) {
    score -= 0.15;
    reasons.push(`elevated failure ratio (${outcome.failedActions}/${turns.length})`);
  } else if (outcome.failedActions === 0) {
    score += 0.1;
    reasons.push('no failed actions');
  }

  // --- Repeated identical tool calls (loop detection) ------------------------
  let repeats = 0;
  for (let i = 1; i < turns.length; i++) {
    const a = turns[i - 1]?.action;
    const b = turns[i]?.action;
    if (!a || !b) continue;
    if (a.tool === b.tool && JSON.stringify(a.input) === JSON.stringify(b.input)) repeats++;
  }
  if (repeats >= 3) {
    score -= 0.15;
    reasons.push(`repetitive tool loop (${repeats} identical consecutive calls)`);
  }

  // --- Recovery: a failure followed later by success -------------------------
  let containsRecovery = false;
  for (let i = 0; i < turns.length; i++) {
    const o = turns[i]?.observation;
    if (o && looksFailed(o.summary, o.ok)) {
      for (let j = i + 1; j < turns.length; j++) {
        const n = turns[j]?.observation;
        if (n && n.ok && !looksFailed(n.summary, true)) {
          containsRecovery = true;
          break;
        }
      }
    }
    if (containsRecovery) break;
  }
  if (containsRecovery) {
    score += 0.1;
    reasons.push('contains failure → recovery (high training value)');
  }

  // --- User corrections ------------------------------------------------------
  if (outcome.userCorrections === 0) {
    score += 0.15;
    reasons.push('no user corrections');
  } else if (outcome.userCorrections === 1) {
    score -= 0.1;
    reasons.push('1 user correction');
  } else {
    score -= 0.2;
    reasons.push(`${outcome.userCorrections} user corrections — model needed repeated steering`);
  }

  // --- Reasoning presence ----------------------------------------------------
  const withThought = turns.filter((x) => x.thought && x.thought.length > 0).length;
  if (withThought === 0) {
    score -= 0.1;
    reasons.push('no reasoning traces captured');
  } else if (withThought / turns.length > 0.5) {
    score += 0.05;
    reasons.push('reasoning present on most turns');
  }

  // --- Unattributable --------------------------------------------------------
  if (t.modelsSeen.length === 0 && !t.provenance?.model) {
    score -= 0.05;
    reasons.push('no model attribution (pre-provenance session)');
  }

  score = Math.max(0, Math.min(1, score));

  // Label thresholds. Deliberately conservative: "gold" must mean something.
  let label: QualityLabel;
  if (score >= 0.72) label = 'gold';
  else if (score <= 0.42) label = 'negative';
  else label = 'neutral';

  return { label, score, reasons, containsRecovery };
}

/** Convenience: does this trajectory belong in a training set at all? */
export function isUsable(t: Trajectory, s: QualityScore): boolean {
  if (t.turns.length === 0) return false;
  if (s.label === 'neutral') return false;
  return true;
}