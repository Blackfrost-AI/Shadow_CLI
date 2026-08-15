/**
 * F06-10 — a small FIFO counting semaphore for session-level caps (sub-agent concurrency).
 *
 * Why not just count: the cap must HOLD under concurrent tool calls. A model with parallel tool
 * use can fire six `agent` invocations in one turn; without a real gate all six loops stream at
 * once — six provider connections, six context windows, and on a local rig six models fighting
 * for one GPU. Permits are handed out strictly in arrival order (a tryAcquire never cuts the
 * queue), and an aborted waiter is dequeued cleanly so a cancelled turn cannot leak a permit.
 */
export class Semaphore {
  private slots: number;
  private readonly queue: Array<() => void> = [];

  constructor(permits: number) {
    this.slots = Math.max(1, Math.floor(permits));
  }

  /** Callers currently waiting for a permit. */
  get waiting(): number {
    return this.queue.length;
  }

  /** Take a permit WITHOUT waiting. Returns the releaser, or null when none is free (or someone
   *  is already queued — FIFO fairness: a newcomer never cuts the line). */
  tryAcquire(): (() => void) | null {
    if (this.slots <= 0 || this.queue.length > 0) return null;
    return this.grant();
  }

  /** Take a permit, queueing behind earlier callers when none is free. Resolves with a
   *  once-only releaser; rejects if `signal` aborts while still queued (an already-granted
   *  permit cannot be revoked — the caller proceeds and releases normally). */
  acquire(signal?: AbortSignal): Promise<() => void> {
    const immediate = this.tryAcquire();
    if (immediate) return Promise.resolve(immediate);
    return new Promise<() => void>((resolve, reject) => {
      if (signal?.aborted) return reject(new Error('aborted while queued'));
      let settled = false;
      const wake = (): void => {
        if (settled) return;
        settled = true;
        if (signal) signal.removeEventListener('abort', onAbort);
        resolve(this.grant());
      };
      const onAbort = (): void => {
        if (settled) return;
        settled = true;
        const i = this.queue.indexOf(wake);
        if (i !== -1) this.queue.splice(i, 1);
        reject(new Error('aborted while queued'));
      };
      signal?.addEventListener('abort', onAbort, { once: true });
      this.queue.push(wake);
    });
  }

  private grant(): () => void {
    this.slots -= 1;
    let released = false;
    return () => {
      if (released) return; // double-release is a no-op, not a permit inflation
      released = true;
      this.slots += 1;
      this.pump();
    };
  }

  private pump(): void {
    // Hand freed permits to waiters in arrival order. wake() calls grant() synchronously,
    // so `slots` is decremented before the loop re-checks it.
    while (this.queue.length > 0 && this.slots > 0) {
      const next = this.queue.shift()!;
      next();
    }
  }
}
