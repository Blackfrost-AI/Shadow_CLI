// src/app/run.ts — entry point for the pi-tui shell.
//
// Owns the terminal lifecycle: the modes Shadow sets (bracketed paste, window title, theme
// background) are claimed here and released on exit and on the fatal signals. The re-raise in the
// signal handler matters — a `process.once(sig, …)` listener overrides Node's default
// disposition, so without re-raising the process would survive SIGINT/SIGHUP and orphan on
// terminal close.

import { ShadowApp } from './app.js';
import type { TuiOpts } from '../tui.js';

let restoring = false;

/**
 * Restore whatever the session changed. Idempotent, and safe to call from an exit hook, a signal
 * handler and the normal return path.
 */
function restoreTerminal(): void {
  if (restoring) return;
  restoring = true;
  // The pi-tui engine restores its own modes (raw mode, Kitty protocol, cursor, alt screen) in
  // terminal.stop(), which ShadowApp.exit() calls. What remains is what Shadow itself set.
  if (process.stdout.isTTY) {
    process.stdout.write('\x1b[23;2t'); // pop the title stack pushed at launch
    process.stdout.write('\x1b[?2004l'); // bracketed paste off
  }
}

function installSignalHandlers(): void {
  const onSignal = (sig: NodeJS.Signals): void => {
    restoreTerminal();
    process.removeListener(sig, onSignal);
    process.kill(process.pid, sig); // re-raise: the default disposition must still apply
  };
  for (const sig of ['SIGINT', 'SIGTERM', 'SIGHUP'] as const) {
    process.on(sig, onSignal);
  }
  process.on('exit', restoreTerminal);
}

export async function runPiTui(opts: TuiOpts): Promise<void> {
  const isTTY = !!process.stdout.isTTY;
  if (isTTY) {
    installSignalHandlers();
    // Push the previous title and set ours, so a screenshot doesn't leak the working directory.
    process.stdout.write('\x1b[22;2t\x1b]2;Shadow\x07');
    // Bracketed paste: the editor relies on the terminal bracketing a paste so a multi-line
    // clipboard change is one atomic insert rather than a burst of keystrokes.
    process.stdout.write('\x1b[?2004h');
  }
  const app = new ShadowApp(opts);
  try {
    await app.run();
  } finally {
    restoreTerminal();
  }
}
