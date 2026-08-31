/**
 * Budget guard — cumulative tokens, estimated cost, iteration count, and
 * wall-clock. Hard-stops the loop when any configured ceiling is hit. Cost is
 * computed from provider-reported usage (incl. cache rates), not the local estimate.
 */

export interface ModelPrice {
  /** USD per 1M tokens. */
  input: number;
  output: number;
  /** Multipliers on the input rate (Anthropic: read ~0.1x, write ~1.25x). */
  cacheReadMult?: number;
  cacheWriteMult?: number;
}

export type PriceTable = Record<string, ModelPrice>;

export interface BudgetLimits {
  maxIterations: number;
  maxTotalTokens?: number;
  maxCostUSD?: number;
  maxWallClockSec?: number;
}

export type BudgetStop = 'max_iterations' | 'budget' | null;

export interface BudgetSnapshot {
  iterations: number;
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  costUSD: number;
  elapsedSec: number;
}

export class Budget {
  private iterations = 0;
  private inputTokens = 0;
  private outputTokens = 0;
  private cacheReadTokens = 0;
  private cacheWriteTokens = 0;
  private costUSD = 0;
  // P3-09 (F04-08): the spend of finished sub-agents rolled up into THIS budget. Kept separate from
  // the own-provider accumulators above so `snapshot()` — the source of the per-turn `usage` events
  // that drive the TUI's delta-based session counters — stays own-only: a sub-agent's spend already
  // reaches /cost through its own `subagent_usage` event, and folding it in here would double-count
  // it. `checkSpending()` and `inheritableCeilings()` read BOTH, so the configured ceilings bound
  // the entire delegation tree, not just this loop's own provider calls.
  private subInputTokens = 0;
  private subOutputTokens = 0;
  private subCostUSD = 0;
  private startMs: number;

  constructor(
    private readonly limits: BudgetLimits,
    private model: string,
    private readonly prices: PriceTable,
    now: number,
  ) {
    this.startMs = now;
  }

  /**
   * F06-10: queue wait is not loop time. A sub-agent that sat in the concurrency semaphore
   * restarts its wall-clock (and reported elapsed) at ADMISSION — otherwise a long queue wait
   * was charged against the 30-minute wall-clock budget and a late-admitted agent could be
   * killed by `budget` seconds after it started running.
   */
  restartClock(now: number): void {
    this.startMs = now;
  }

  /**
   * Re-price against the model actually in use (D5).
   *
   * `prices[this.model]` was fixed at construction. That is harmless in the TUI (a fresh Budget
   * per user message) but UNBOUNDED in headless `--task`, where ONE Budget spans the whole run:
   * after a `/model` switch or an automatic fallback, every later token was still costed at the
   * ORIGINAL model's rate — so the reported spend, and any cost ceiling built on it, drifted
   * further from reality the longer the run went.
   */
  setModel(model: string): void {
    if (model) this.model = model;
  }


  /** Record one provider call's usage and accrue cost. */
  recordUsage(
    u: {
      inputTokens: number;
      outputTokens: number;
      cacheReadTokens?: number;
      cacheWriteTokens?: number;
    },
    now: number,
  ): void {
    this.inputTokens += u.inputTokens;
    this.outputTokens += u.outputTokens;
    this.cacheReadTokens += u.cacheReadTokens ?? 0;
    this.cacheWriteTokens += u.cacheWriteTokens ?? 0;

    const p = this.prices[this.model];
    if (p) {
      const M = 1_000_000;
      const cacheRead = (u.cacheReadTokens ?? 0) * p.input * (p.cacheReadMult ?? 0.1);
      const cacheWrite = (u.cacheWriteTokens ?? 0) * p.input * (p.cacheWriteMult ?? 1.25);
      this.costUSD +=
        (u.inputTokens * p.input + u.outputTokens * p.output + cacheRead + cacheWrite) / M;
    }
    void now;
  }

  /** Count one loop iteration (one provider call + its tool executions). */
  tick(): void {
    this.iterations += 1;
  }

  /** Returns a stop code if any ceiling is now exceeded, else null. */
  check(now: number): BudgetStop {
    if (this.limits.maxIterations > 0 && this.iterations >= this.limits.maxIterations) return 'max_iterations';
    return this.checkSpending(now);
  }

  /**
   * Spending ceilings only (tokens / cost / wall clock), without the iteration cap. Used by the
   * in-call checks (F04-10): `maxIterations` bounds PROVIDER TURNS, and the tools of the final
   * turn are still entitled to run — the between-turns `check()` stops the loop before the NEXT
   * turn. Tokens/cost/wall-clock are different: once crossed, no further call should be enlisted
   * anywhere, mid-batch included.
   */
  checkSpending(now: number): BudgetStop {
    // P3-09 (F04-08): OWN + rolled-up sub-agent spend counts against the same ceilings — before
    // this, a fleet of sub-agents could burn tokens/cost that never touched the parent's
    // maxTotalTokens / maxCostUSD at all.
    const total = this.inputTokens + this.outputTokens + this.subInputTokens + this.subOutputTokens;
    if (this.limits.maxTotalTokens != null && total >= this.limits.maxTotalTokens) return 'budget';
    const cost = this.costUSD + this.subCostUSD;
    if (this.limits.maxCostUSD != null && cost >= this.limits.maxCostUSD) return 'budget';
    if (
      this.limits.maxWallClockSec != null &&
      (now - this.startMs) / 1000 >= this.limits.maxWallClockSec
    ) {
      return 'budget';
    }
    return null;
  }

  /**
   * P3-09 (F04-08): roll a finished sub-agent's spend into this budget. The caller passes the
   * sub-agent's TOTAL spend (its own provider calls plus any nested sub-agents it already rolled
   * up — see `totalCostUSD` etc.), so accrual chains up a delegation tree one level at a time
   * without any level being counted twice. Called on EVERY sub-agent exit path: the tokens and
   * cost were spent regardless of whether the run ended done, cancelled, or in error.
   */
  accrueSubagent(u: { inputTokens?: number; outputTokens?: number; costUSD?: number }): void {
    this.subInputTokens += u.inputTokens ?? 0;
    this.subOutputTokens += u.outputTokens ?? 0;
    this.subCostUSD += u.costUSD ?? 0;
  }

  /** Spend rolled up from finished sub-agents (P3-09). */
  get accruedSubagentCostUSD(): number {
    return this.subCostUSD;
  }
  get accruedSubagentInputTokens(): number {
    return this.subInputTokens;
  }
  get accruedSubagentOutputTokens(): number {
    return this.subOutputTokens;
  }

  /** This budget's OWN spend plus everything rolled up into it — the amount a parent must accrue
   *  when this budget belongs to a finishing sub-agent, or the whole subtree's spend escapes the
   *  parent's ceilings (P3-09). */
  get totalCostUSD(): number {
    return this.costUSD + this.subCostUSD;
  }
  get totalInputTokens(): number {
    return this.inputTokens + this.subInputTokens;
  }
  get totalOutputTokens(): number {
    return this.outputTokens + this.subOutputTokens;
  }

  /**
   * P3-09 (F04-08): the REMAINING headroom on each configured spending ceiling, for a sub-agent to
   * inherit as its own ceiling at admission. An axis the parent never configured inherits none
   * (the sub-agent keeps its own iteration cap and wall-clock backstop on that axis). Never
   * negative — an exhausted parent yields a zero ceiling, and the sub-agent's between-turns
   * budget check (which runs BEFORE the first provider call) stops it immediately with zero spend.
   */
  inheritableCeilings(now: number): { maxTotalTokens?: number; maxCostUSD?: number; maxWallClockSec?: number } {
    const out: { maxTotalTokens?: number; maxCostUSD?: number; maxWallClockSec?: number } = {};
    if (this.limits.maxTotalTokens != null) {
      out.maxTotalTokens = Math.max(
        0,
        this.limits.maxTotalTokens - (this.inputTokens + this.outputTokens + this.subInputTokens + this.subOutputTokens),
      );
    }
    if (this.limits.maxCostUSD != null) {
      out.maxCostUSD = Math.max(0, this.limits.maxCostUSD - (this.costUSD + this.subCostUSD));
    }
    if (this.limits.maxWallClockSec != null) {
      out.maxWallClockSec = Math.max(0, this.limits.maxWallClockSec - (now - this.startMs) / 1000);
    }
    return out;
  }

  /**
   * P3-09 (F04-08): AND a set of inherited ceilings into this budget's limits. An axis present on
   * both sides takes the TIGHTER value; an axis only on the inherited side is adopted; an axis
   * absent on the inherited side is left alone. Never widens a ceiling.
   */
  applyInheritedCeilings(l: { maxTotalTokens?: number; maxCostUSD?: number; maxWallClockSec?: number }): void {
    if (l.maxTotalTokens != null) {
      this.limits.maxTotalTokens =
        this.limits.maxTotalTokens != null ? Math.min(this.limits.maxTotalTokens, l.maxTotalTokens) : l.maxTotalTokens;
    }
    if (l.maxCostUSD != null) {
      this.limits.maxCostUSD =
        this.limits.maxCostUSD != null ? Math.min(this.limits.maxCostUSD, l.maxCostUSD) : l.maxCostUSD;
    }
    if (l.maxWallClockSec != null) {
      this.limits.maxWallClockSec =
        this.limits.maxWallClockSec != null ? Math.min(this.limits.maxWallClockSec, l.maxWallClockSec) : l.maxWallClockSec;
    }
  }

  snapshot(now: number): BudgetSnapshot {
    return {
      iterations: this.iterations,
      inputTokens: this.inputTokens,
      outputTokens: this.outputTokens,
      totalTokens: this.inputTokens + this.outputTokens,
      costUSD: this.costUSD,
      elapsedSec: (now - this.startMs) / 1000,
    };
  }

  get currentCostUSD(): number {
    return this.costUSD;
  }
}

// ── Spend guardrail (plan 2.3) ────────────────────────────────────────────────
/**
 * A PURE state machine for the configurable step/cost budget with warn-once +
 * explicit-continue semantics — fully unit-testable, no I/O. Unlike the `Budget`
 * class above (unconditional hard ceilings), the guardrail WARNS once at
 * `warnRatio`, then pauses and asks; an approval grants exactly one more
 * allowance window (same limits again), a denial ends the run gracefully.
 * Absent limits = no guardrail (always 'ok').
 */
export interface BudgetGuardConfig {
  maxSteps?: number;
  maxCostUsd?: number;
  /** Fraction (0,1] of each limit at which the one-time warning fires. Default 0.8. */
  warnRatio?: number;
}

export type BudgetGuardStatus = 'ok' | 'warned' | 'exceeded';

export interface BudgetGuardSnapshot {
  steps: number;
  costUsd: number;
  status: BudgetGuardStatus;
  maxSteps?: number;
  maxCostUsd?: number;
  warnRatio: number;
  /** Warn crossings announced (at most one per window). */
  warnings: number;
  /** Allowance windows granted via explicit continue. */
  continuations: number;
}

export interface BudgetGuardState {
  /** Count one model call (one agent step). */
  recordStep(): void;
  /** Accrue USD spent (an INCREMENT, not the cumulative session cost). */
  recordCost(usd: number): void;
  /** 'exceeded' when EITHER configured limit is hit; 'warned' inside the warn band. */
  status(): BudgetGuardStatus;
  snapshot(): BudgetGuardSnapshot;
  /**
   * Mark the current warn-band crossing as announced. Returns true only on the
   * FIRST call after a crossing — this is what makes the warning fire exactly
   * once per threshold crossing (reset by grantContinuation, so a fresh window
   * can warn again).
   */
  announceWarning(): boolean;
  /** Explicit continue: reset the window counters; one more allowance, same limits. */
  grantContinuation(): void;
  /** True when at least one limit is configured. */
  readonly active: boolean;
}

export const DEFAULT_BUDGET_WARN_RATIO = 0.8;

export function createBudgetState(cfg: BudgetGuardConfig): BudgetGuardState {
  const warnRatio = cfg.warnRatio ?? DEFAULT_BUDGET_WARN_RATIO;
  const maxSteps = cfg.maxSteps;
  const maxCostUsd = cfg.maxCostUsd;
  let steps = 0;
  let costUsd = 0;
  let warnAnnounced = false;
  let warnings = 0;
  let continuations = 0;

  const rawStatus = (): BudgetGuardStatus => {
    const exceeded =
      (maxSteps != null && steps >= maxSteps) ||
      (maxCostUsd != null && costUsd >= maxCostUsd);
    if (exceeded) return 'exceeded';
    const warned =
      (maxSteps != null && steps >= maxSteps * warnRatio) ||
      (maxCostUsd != null && costUsd >= maxCostUsd * warnRatio);
    return warned ? 'warned' : 'ok';
  };

  return {
    recordStep() {
      steps += 1;
    },
    recordCost(usd) {
      if (usd > 0) costUsd += usd;
    },
    status: rawStatus,
    snapshot() {
      return { steps, costUsd, status: rawStatus(), maxSteps, maxCostUsd, warnRatio, warnings, continuations };
    },
    announceWarning() {
      if (warnAnnounced) return false;
      warnAnnounced = true;
      warnings += 1;
      return true;
    },
    grantContinuation() {
      steps = 0;
      costUsd = 0;
      warnAnnounced = false;
      continuations += 1;
    },
    get active() {
      return maxSteps != null || maxCostUsd != null;
    },
  };
}

/** The decision the agent loop consults before dispatching the next model call. */
export type BudgetDecision = 'proceed' | 'warn' | 'ask' | 'stop';

/**
 * Given the guard state, what the loop should do next:
 * - 'proceed' — under budget (or warning already announced);
 * - 'warn'    — crossed the warn threshold; announce once, then continue;
 * - 'ask'     — a limit is hit and a human can be asked (approval gate);
 * - 'stop'    — a limit is hit with no one to ask: end the run gracefully.
 */
export function decideBudgetAction(state: BudgetGuardState, opts: { interactive: boolean }): BudgetDecision {
  const status = state.status();
  if (status === 'exceeded') return opts.interactive ? 'ask' : 'stop';
  if (status === 'warned' && state.announceWarning()) return 'warn';
  return 'proceed';
}

function fmtUsd(n: number): string {
  return `$${n >= 0.01 ? n.toFixed(2) : n.toFixed(4)}`;
}

/** Warn-band summary, only the configured limits: "Budget 80%: 8/10 steps · $0.80/$1.00". */
export function budgetProgressMessage(snap: BudgetGuardSnapshot): string {
  const parts: string[] = [];
  if (snap.maxSteps != null) parts.push(`${snap.steps}/${snap.maxSteps} steps`);
  if (snap.maxCostUsd != null) parts.push(`${fmtUsd(snap.costUsd)}/${fmtUsd(snap.maxCostUsd)}`);
  return `Budget ${Math.round(snap.warnRatio * 100)}%: ${parts.join(' · ')}`;
}

/** Over-limit detail, only the configured limits: "10/10 steps · $1.20/$1.00". */
export function budgetExceededDetail(snap: BudgetGuardSnapshot): string {
  const parts: string[] = [];
  if (snap.maxSteps != null) parts.push(`${snap.steps}/${snap.maxSteps} steps`);
  if (snap.maxCostUsd != null) parts.push(`${fmtUsd(snap.costUsd)}/${fmtUsd(snap.maxCostUsd)}`);
  return parts.join(' · ');
}

/** Option that ends the run. FIRST so every auto-answer path (yolo, idle countdown) stops safely. */
export const BUDGET_STOP_LABEL = 'Stop here (Recommended)';
/** Option that grants exactly one more allowance window (same limits again). */
export const BUDGET_CONTINUE_LABEL = 'Continue — one more allowance window';
