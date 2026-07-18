import { EventBus } from '../agent/events.js';
import { startWebServer } from './server.js';
import { openBrowser } from './browser.js';

export interface RunWebOptions {
  write: (s: string) => void;
  /** Fixed port; 0/undefined picks a free one. */
  port?: number;
  /** Suppress the browser launch (`--no-open`). */
  open?: boolean;
  /** Existing bus to mirror; phase 5 passes the live agent's. */
  bus?: EventBus;
}

/**
 * `shadow web` — start the loopback UI and block until interrupted.
 *
 * Phase 1 scope: the server, its security gate, and the live event stream. Provider and
 * credential management (phase 2) and driving a conversation from the browser (phase 5)
 * mount onto this same server and port.
 */
export async function runWeb(opts: RunWebOptions): Promise<void> {
  const bus = opts.bus ?? new EventBus();
  const server = await startWebServer({ bus, port: opts.port });

  opts.write(`\nShadow web UI — http://127.0.0.1:${server.port}\n`);
  opts.write(`  ${server.url}\n`);
  opts.write('Loopback only. The token in that URL is required; requests from any other\n');
  opts.write('host or origin are refused. Nothing leaves this machine.\n\n');
  opts.write('Ctrl-C to stop.\n');

  if (opts.open !== false) openBrowser(server.url);

  await new Promise<void>((resolve) => {
    const stop = (): void => {
      opts.write('\nStopping web UI…\n');
      void server.close().then(resolve);
    };
    process.once('SIGINT', stop);
    process.once('SIGTERM', stop);
  });
}

/** Parse `shadow web [--port N] [--no-open]`. */
export function parseWebArgs(argv: string[]): { port?: number; open: boolean } {
  let port: number | undefined;
  let open = true;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--no-open') open = false;
    else if (a === '--port') {
      const n = Number(argv[++i]);
      if (Number.isInteger(n) && n > 0 && n < 65536) port = n;
    } else if (a.startsWith('--port=')) {
      const n = Number(a.slice(7));
      if (Number.isInteger(n) && n > 0 && n < 65536) port = n;
    }
  }
  return { port, open };
}
