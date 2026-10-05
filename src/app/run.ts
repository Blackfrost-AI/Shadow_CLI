// One lifecycle owner for normal return, signals, exceptions and terminal restoration.
import { ShadowApp } from './app.js';
import type { TuiOpts } from '../tui.js';
import { backgroundSequence, themeBackground } from '../tui/theme.js';

export async function runPiTui(opts: TuiOpts): Promise<void> {
  const isTTY = !!process.stdout.isTTY;
  const app = new ShadowApp(opts);
  let restored = false;
  const restore = (): void => {
    if (restored) return;
    restored = true;
    app.stop();
    if (isTTY) process.stdout.write(backgroundSequence(null, true) + '\x1b[0m\x1b[23;2t\x1b[?2004l\x1b[?25h');
  };
  const signals = new Map<NodeJS.Signals, () => void>();
  const removeHandlers = (): void => {
    for (const [signal, handler] of signals) process.removeListener(signal, handler);
    process.removeListener('exit', restore);
    process.removeListener('uncaughtExceptionMonitor', restore);
  };
  if (isTTY) {
    for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP'] as const) {
      const handler = (): void => {
        restore();
        removeHandlers();
        process.kill(process.pid, signal);
      };
      signals.set(signal, handler);
      process.on(signal, handler);
    }
    process.on('exit', restore);
    // Observe without swallowing the exception or replacing Node's fatal-exit behavior.
    process.on('uncaughtExceptionMonitor', restore);
    process.stdout.write('\x1b[22;2t\x1b]2;Shadow\x07' + backgroundSequence(themeBackground(opts.cfg.lastTheme), true));
  }
  try {
    await app.run();
  } finally {
    restore();
    removeHandlers();
  }
}
