/**
 * Single owner for every TERMINAL-level mode Shadow turns on.
 *
 * Why this exists: modes like DECSET 2004 (bracketed paste), 1000/1006 (mouse reporting), the
 * xterm title stack, and the OSC 11 background are properties of the USER'S TERMINAL, not of this
 * process. They outlive us. Shadow reset them from React effect destructors and from
 * `waitUntilExit().finally(cleanup)` — a promise continuation — so on SIGTERM/SIGINT/SIGHUP, or on
 * an uncaught exception, NONE of them ran. A `kill`, a closed SSH session, or a crash left the
 * terminal with bracketed paste on, the title stuck on "Shadow", and (with the `shadow` theme) the
 * background forced to black with no way back but `reset`.
 *
 * That is exactly the 3.6.0 mouse-reporting incident, which was fixed for mode 1000 alone. Every
 * mode now registers here instead, and restore is bound to `exit` AND to the fatal signals — the
 * same way ink's own `restore-cursor` gets `\x1b[?25h` out on a signal.
 *
 * Two rules for callers:
 *  - Only ever reset what we actually SET (a user whose terminal is already black keeps it).
 *  - Restore must be idempotent: it can run from a signal, then again from `exit`.
 */

type Signal = 'SIGINT' | 'SIGTERM' | 'SIGHUP';
const SIGNALS: readonly Signal[] = ['SIGINT', 'SIGTERM', 'SIGHUP'];

/** Reset sequences by mode key, in claim order. A Map so a mode can update its reset in place. */
const resets = new Map<string, string>();
let out: NodeJS.WriteStream = process.stdout;
let installed = false;
let restoring = false;

function write(seq: string): void {
  if (!seq) return;
  try {
    out.write(seq);
  } catch {
    /* stream already torn down — nothing useful to do on the way out */
  }
}

/** Point the owner at a stream other than process.stdout (tests). Resets any prior claims. */
export function setTerminalOutput(stream: NodeJS.WriteStream): void {
  out = stream;
  resets.clear();
}

/**
 * Turn a mode on and register how to turn it off. Re-claiming the same key replaces its reset
 * without re-writing the enable, which is what a mid-session `/theme` switch needs.
 */
export function claimMode(key: string, enable: string, reset: string): void {
  if (!resets.has(key)) write(enable);
  resets.set(key, reset);
}

/** Change (or drop) the reset for an already-claimed mode — e.g. `/theme` swapping the background. */
export function updateReset(key: string, reset: string | null): void {
  if (reset === null) resets.delete(key);
  else resets.set(key, reset);
}

/** Release a mode now (its reset runs immediately and is de-registered). */
export function releaseMode(key: string): void {
  const reset = resets.get(key);
  if (reset === undefined) return;
  resets.delete(key);
  write(reset);
}

/** True if the mode is currently claimed — for tests and assertions. */
export function isClaimed(key: string): boolean {
  return resets.has(key);
}

/**
 * Undo every claimed mode, most recent first. Idempotent: safe to call from a signal handler and
 * again from `exit`, and safe to call when nothing was ever claimed.
 */
export function restoreTerminal(): void {
  if (restoring) return;
  restoring = true;
  const pending = [...resets.entries()].reverse();
  resets.clear();
  for (const [, reset] of pending) write(reset);
  restoring = false;
}

/**
 * Bind restore to process exit and to the fatal signals.
 *
 * The signal handlers RE-RAISE after restoring. This matters: a plain `process.once(sig, fn)`
 * OVERRIDES Node's default disposition, and ink's signal-exit declines to re-raise once a foreign
 * listener is present — so the 3.6.0 mouse fix accidentally made a mouse-enabled session survive
 * SIGINT and SIGHUP outright, orphaning the process (with its provider connection and MCP children)
 * when the terminal window closed. Removing our own listener before re-raising restores the default
 * behaviour, so cleaning up costs nothing in killability.
 */
export function installRestoreHandlers(): void {
  if (installed) return;
  installed = true;
  process.once('exit', restoreTerminal);
  for (const sig of SIGNALS) {
    const onSignal = (): void => {
      restoreTerminal();
      process.removeListener(sig, onSignal);
      // Re-deliver so the default disposition (or another handler, e.g. index.ts's SIGTERM →
      // exit(143)) actually terminates us. Without this the process just keeps running.
      process.kill(process.pid, sig);
    };
    process.on(sig, onSignal);
  }
}

/** Test seam: forget that handlers were installed (does not remove already-registered ones). */
export function resetInstalledForTest(): void {
  installed = false;
  resets.clear();
}
