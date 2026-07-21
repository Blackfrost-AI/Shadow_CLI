/**
 * The process-wide run lock: ONE agent turn executes at a time across the TUI and every web
 * session (decision 1 — two agents in one repo corrupt each other). This is turn-level mutual
 * exclusion for LIVENESS/ORDERING, NOT filesystem isolation: background sub-agents and
 * `run_shell` children outlive the turn and escape it. Worktree isolation is the containment
 * story; do not read this lock as one.
 *
 * There is no timeout — an auto-released lock is two agents writing one repo. The human at the
 * terminal must never be starved behind browser sessions, so the TUI acquires with
 * `{ priority: true }` (jumps the queue) and an ESC-cancellable signal.
 */

/** One-shot release token. Double-release is a no-op, so a `finally` is always safe to call. */
export type Release = () => void;

export interface LockState {
  holder: string | null;
  heldSince: number | null;
  waiting: string[];
}

export interface RunLock {
  /** Non-blocking. Null when held. Used by the browser chat route → 409. */
  tryAcquire(holder: string): Release | null;
  /**
   * FIFO wait. `priority: true` jumps the queue. Rejects (and de-queues) if `signal` fires. If
   * the grant was already handed out when the abort lands, the grant is RELEASED and passed to
   * the next waiter — never dropped, or the lock wedges forever.
   */
  acquire(holder: string, opts?: { signal?: AbortSignal; priority?: boolean }): Promise<Release>;
  /** Teardown only. Drops a holder's grant and de-queues its waiters. Idempotent. */
  releaseFor(holder: string): void;
  state(): LockState;
}

export const CLI_HOLDER = 'cli';

interface Waiter {
  holder: string;
  priority: boolean;
  signal?: AbortSignal;
  resolve: (r: Release) => void;
  reject: (e: Error) => void;
  settled: boolean;
  onAbort?: () => void;
}

function abortError(): Error {
  const e = new Error('run-lock acquire aborted');
  e.name = 'AbortError';
  return e;
}

function createRunLock(): RunLock & { __reset(): void } {
  let holder: string | null = null;
  let heldSince: number | null = null;
  // Identity of the current grant. A release only acts if it still owns this token, so a stale or
  // double release can never hand the lock to two waiters.
  let activeGrant: object | null = null;
  const waiters: Waiter[] = [];

  const now = (): number => Date.now();

  const makeRelease = (grant: object): Release => {
    return () => {
      if (activeGrant !== grant) return; // stale / double release → no-op
      activeGrant = null;
      holder = null;
      heldSince = null;
      pump();
    };
  };

  const grantTo = (h: string): Release => {
    const grant = {};
    activeGrant = grant;
    holder = h;
    heldSince = now();
    return makeRelease(grant);
  };

  const detachAbort = (w: Waiter): void => {
    if (w.onAbort && w.signal) w.signal.removeEventListener('abort', w.onAbort);
  };

  const pump = (): void => {
    if (activeGrant) return; // still held
    const w = waiters.shift();
    if (!w) return;
    const release = grantTo(w.holder);
    w.settled = true;
    detachAbort(w);
    // Abort landed while this waiter sat at the front: release the just-made grant and pass it on,
    // never drop it (that wedges the lock forever).
    if (w.signal?.aborted) {
      release();
      w.reject(abortError());
      return;
    }
    w.resolve(release);
  };

  const enqueue = (w: Waiter): void => {
    if (w.priority) {
      // After the last existing priority waiter: FIFO among priority, ahead of every normal one.
      let i = 0;
      while (i < waiters.length && waiters[i]!.priority) i++;
      waiters.splice(i, 0, w);
    } else {
      waiters.push(w);
    }
  };

  const onWaiterAbort = (w: Waiter): void => {
    if (w.settled) return; // already granted; pump() handled the same-tick case
    const idx = waiters.indexOf(w);
    if (idx !== -1) waiters.splice(idx, 1);
    w.settled = true;
    detachAbort(w);
    w.reject(abortError());
  };

  return {
    tryAcquire(h: string): Release | null {
      if (activeGrant) return null;
      return grantTo(h);
    },

    acquire(h: string, opts: { signal?: AbortSignal; priority?: boolean } = {}): Promise<Release> {
      return new Promise<Release>((resolve, reject) => {
        if (opts.signal?.aborted) {
          reject(abortError());
          return;
        }
        const w: Waiter = {
          holder: h,
          priority: Boolean(opts.priority),
          signal: opts.signal,
          resolve,
          reject,
          settled: false,
        };
        if (opts.signal) {
          w.onAbort = () => onWaiterAbort(w);
          opts.signal.addEventListener('abort', w.onAbort, { once: true });
        }
        enqueue(w);
        pump();
      });
    },

    releaseFor(h: string): void {
      if (holder === h && activeGrant) {
        activeGrant = null;
        holder = null;
        heldSince = null;
      }
      for (let i = waiters.length - 1; i >= 0; i--) {
        if (waiters[i]!.holder === h) {
          const [w] = waiters.splice(i, 1);
          if (w) {
            w.settled = true;
            detachAbort(w);
            w.reject(new Error('run-lock released for holder'));
          }
        }
      }
      pump();
    },

    state(): LockState {
      return { holder, heldSince, waiting: waiters.map((w) => w.holder) };
    },

    __reset(): void {
      for (const w of waiters) {
        detachAbort(w);
        w.settled = true;
      }
      waiters.length = 0;
      activeGrant = null;
      holder = null;
      heldSince = null;
    },
  };
}

const _lock = createRunLock();

/**
 * Process singleton — the ONE place module-level state is correct in the web tree. The TUI
 * (tui.tsx) and the registry must contend on the same object.
 */
export const runLock: RunLock = _lock;

/** Test-only reset. Throws unless NODE_ENV === 'test'. */
export function __resetRunLock(): void {
  if (process.env.NODE_ENV !== 'test') {
    throw new Error('__resetRunLock is test-only (set NODE_ENV=test)');
  }
  _lock.__reset();
}
