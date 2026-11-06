/**
 * Pure telemetry aggregation + stop-health classification for the harness eval.
 *
 * Extracted from harness-eval.ts so the two decisions the scorecard rests on are
 * unit-testable against synthetic session logs:
 *
 *   1. USAGE ACCOUNTING — provider usage events carry TWO kinds of numbers and they
 *      must be combined differently:
 *        - `inputTokens`/`outputTokens` are TURN-CUMULATIVE `Budget.snapshot()`
 *          values (the HUD contract). Retaining the LATEST value yields the true
 *          lead-loop total; summing them would count each turn's context many
 *          times over.
 *        - `cacheReadTokens`/`cacheWriteTokens`/`iterInputTokens`/`iterOutputTokens`
 *          are PER-REQUEST values. They must be SUMMED across turns so every
 *          provider round-trip is counted exactly once.
 *        - `subagent_usage` events carry ONE-SHOT totals per finished sub-agent;
 *          they must be SUMMED across events.
 *
 *   2. STOP HEALTH — a fixture whose end-state artifact is correct is still a failed
 *      run if the loop never reached a legitimate terminal state: a task that
 *      "passes" while stopping on provider_error / max_iterations / budget /
 *      interrupted / fatal_tool_error / max_tokens / spawn_error (or a wall-clock
 *      kill) proved the plumbing, not the product. Only end_turn, refusal and
 *      pause_turn are clean terminal states.
 */
import type { RunResult } from './types.js';

export type Telemetry = Omit<RunResult, 'exitCode' | 'timedOut' | 'wallMs' | 'stdout' | 'stderr'>;

/** Terminal stop reasons that mean the loop finished its own decision. */
export const CLEAN_STOP_REASONS: ReadonlySet<string> = new Set(['end_turn', 'refusal', 'pause_turn']);

/**
 * A run is cleanly stopped only when the process exited 0, was not killed by the
 * wall-clock cap, and the loop's own final stop reason is a legitimate terminal
 * state. Anything else — including an empty stop reason (no log at all) — is an
 * abnormal stop.
 */
export function isCleanStop(run: Pick<RunResult, 'stopReason' | 'timedOut' | 'exitCode'>): boolean {
  if (run.timedOut) return false;
  if (run.exitCode !== 0) return false;
  return CLEAN_STOP_REASONS.has(run.stopReason);
}

/**
 * Aggregate a redacted session-log event stream into eval telemetry.
 * Pure: no filesystem access — the runner loads the log, this folds it.
 */
export function parseSessionEvents(events: Record<string, unknown>[]): Telemetry {
  const t: Telemetry = {
    toolCalls: [],
    badJson: 0,
    errors: 0,
    iterations: 0,
    stopReason: '',
    inputTokens: 0,
    outputTokens: 0,
    compactions: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    iterInputTokens: 0,
    iterOutputTokens: 0,
    subagentInputTokens: 0,
    subagentOutputTokens: 0,
    subagentCostUSD: 0,
  };
  for (const e of events) {
    switch (e.type) {
      case 'tool_end': {
        const call = e.call as { name?: string; input?: unknown } | undefined;
        const result = e.result as { ok?: boolean } | undefined;
        // Carry the ARGUMENTS through, not just the name: a task that must assert on
        // what a tool was asked to do cannot recover that from {name, ok} alone.
        t.toolCalls.push({ name: call?.name ?? '?', ok: !!result?.ok, input: call?.input });
        break;
      }
      case 'error':
        t.errors++;
        if (String(e.message ?? '').includes('bad_tool_json')) t.badJson++;
        break;
      case 'assistant_done':
        t.iterations++;
        break;
      case 'compaction':
        t.compactions++;
        break;
      case 'usage': {
        // Turn-cumulative snapshots: keep the LATEST (summing double-counts).
        const inputTokens = (e.inputTokens as number) ?? null;
        const outputTokens = (e.outputTokens as number) ?? null;
        if (inputTokens !== null) t.inputTokens = inputTokens;
        if (outputTokens !== null) t.outputTokens = outputTokens;
        // Per-request metrics: SUM across turns (each request counted once).
        t.cacheReadTokens += (e.cacheReadTokens as number) ?? 0;
        t.cacheWriteTokens += (e.cacheWriteTokens as number) ?? 0;
        t.iterInputTokens += (e.iterInputTokens as number) ?? 0;
        t.iterOutputTokens += (e.iterOutputTokens as number) ?? 0;
        break;
      }
      case 'subagent_usage': {
        // One-shot totals per finished sub-agent: SUM the events.
        t.subagentCostUSD += (e.costUSD as number) ?? 0;
        t.subagentInputTokens += (e.inputTokens as number) ?? 0;
        t.subagentOutputTokens += (e.outputTokens as number) ?? 0;
        break;
      }
      case 'stop':
        t.stopReason = (e.reason as string) ?? t.stopReason;
        break;
    }
  }
  return t;
}
