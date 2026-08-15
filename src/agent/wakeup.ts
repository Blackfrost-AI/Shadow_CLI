/** In-session schedule_wakeup queue (Claude ScheduleWakeup parity baseline). */
export interface WakeupJob {
  id: string;
  delaySec: number;
  reason: string;
  task: string;
  at: number;
}

export type WakeupHandler = (task: string, reason: string) => void;

/**
 * F04-09 guardrails:
 * - MIN delay floor — a 1-second wakeup is a token furnace with no legitimate use; the floor
 *   raises any shorter request to 30s (the caller sees the effective value on the job).
 * - Per-session RATE CEILING checked AT FIRE TIME — a stuck scheduling loop (a model that
 *   re-schedules itself every 30s forever) is capped at MAX_WAKEUPS_PER_WINDOW fires per
 *   rolling window; excess fires are dropped and reported via onRateLimited, never executed.
 */
export const MIN_WAKEUP_DELAY_SEC = 30;
export const WAKEUP_RATE_WINDOW_MS = 60 * 60 * 1000; // one rolling hour
export const MAX_WAKEUPS_PER_WINDOW = 30;

export interface WakeupSchedulerOpts {
  /** Injectable clock (tests). */
  now?: () => number;
  /** Invoked instead of onFire when a due wakeup is dropped by the rate ceiling. */
  onRateLimited?: (job: WakeupJob) => void;
}

export class WakeupScheduler {
  private jobs = new Map<string, ReturnType<typeof setTimeout>>();
  private firedAt: number[] = [];
  private idSeq = 0;
  private readonly now: () => number;
  /** Wired after construction (the bus exists outside bootstrap — see index.ts). */
  onRateLimited?: (job: WakeupJob) => void;

  constructor(opts: WakeupSchedulerOpts = {}) {
    this.now = opts.now ?? Date.now;
    this.onRateLimited = opts.onRateLimited;
  }

  /**
   * The delay that will actually be used after applying the minimum floor (F04-09).
   * Non-finite input (NaN/±Infinity from a malformed model call) is treated as 0 → the floor.
   */
  effectiveDelay(delaySec: number): number {
    const d = Number.isFinite(delaySec) ? delaySec : 0;
    return Math.max(MIN_WAKEUP_DELAY_SEC, d);
  }

  schedule(delaySec: number, reason: string, task: string, onFire: WakeupHandler): WakeupJob {
    const effective = this.effectiveDelay(delaySec);
    const id = `wakeup-${++this.idSeq}`;
    const job: WakeupJob = { id, delaySec: effective, reason, task, at: this.now() + effective * 1000 };
    const timer = setTimeout(() => {
      this.jobs.delete(id);
      this.tryFire(job, onFire);
    }, effective * 1000);
    // A pending wakeup must never hold a dying process alive — a one-shot `--task` that
    // schedules a wakeup must still exit when its turn ends. An unref'd timer still fires
    // while the session is alive for other reasons (REPL prompt, TUI, web mirror); session
    // teardown calls clear() to cancel outright, so a fired wakeup can never outlive its
    // session and run tools against a torn-down gate.
    timer.unref?.();
    this.jobs.set(id, timer);
    return job;
  }

  /**
   * Fire decision for one due job: enforce the per-session rate ceiling AT FIRE TIME (a job
   * scheduled before the ceiling became reachable is still dropped once it is). Exported as a
   * method — the timer callback delegates here, and tests drive it directly instead of waiting
   * on real timers. Returns true when the job fired.
   */
  tryFire(job: WakeupJob, onFire: WakeupHandler): boolean {
    const t = this.now();
    this.firedAt = this.firedAt.filter((ts) => t - ts < WAKEUP_RATE_WINDOW_MS);
    if (this.firedAt.length >= MAX_WAKEUPS_PER_WINDOW) {
      this.onRateLimited?.(job);
      return false;
    }
    this.firedAt.push(t);
    onFire(job.task, job.reason);
    return true;
  }

  cancel(id: string): boolean {
    const t = this.jobs.get(id);
    if (!t) return false;
    clearTimeout(t);
    this.jobs.delete(id);
    return true;
  }

  clear(): void {
    for (const t of this.jobs.values()) clearTimeout(t);
    this.jobs.clear();
  }
}
