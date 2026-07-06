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
  private readonly startMs: number;

  constructor(
    private readonly limits: BudgetLimits,
    private readonly model: string,
    private readonly prices: PriceTable,
    now: number,
  ) {
    this.startMs = now;
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
    const total = this.inputTokens + this.outputTokens;
    if (this.limits.maxTotalTokens != null && total >= this.limits.maxTotalTokens) return 'budget';
    if (this.limits.maxCostUSD != null && this.costUSD >= this.limits.maxCostUSD) return 'budget';
    if (
      this.limits.maxWallClockSec != null &&
      (now - this.startMs) / 1000 >= this.limits.maxWallClockSec
    ) {
      return 'budget';
    }
    return null;
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
