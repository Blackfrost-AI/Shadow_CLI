import { EventBus } from '../agent/events.js';
import { startWebServer, type WebServerHandle } from './server.js';
import { openBrowser, openCommand } from './browser.js';
import { ensureVaultReady } from '../auth/unlock.js';

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
 * The boot block `shadow web` prints once the server is up. The third line is a one-line
 * copy-paste join command; the token rides in the URL FRAGMENT (`#t=`), which browsers never
 * send to the server — the fragment handoff model in security.ts stays untouched.
 */
export function formatWebBoot(server: Pick<WebServerHandle, 'port' | 'url'>): string {
  return (
    `\nShadow web UI — http://127.0.0.1:${server.port}\n` +
    `  ${server.url}\n` +
    `  ${openCommand()} "${server.url}"\n` +
    'The console is accessible on this machine only. Keep its access link private.\n' +
    'Model requests go to your configured endpoint; web tools and integrations may use the network.\n\n'
  );
}

/**
 * `shadow web` — start the loopback UI and block until interrupted.
 *
 * The web UI is the credential "single writer" (see WEBUI_RESEARCH/00-PLAN.md phase 2), so the
 * vault is unlocked at startup exactly as a normal agent run does — via `ensureVaultReady`
 * (keychain → env → prompt → migrate). Without this, saving a model with a key from the
 * browser would have nowhere to seal it. A locked vault that can't be opened does not abort
 * the server: read-only management still works, and writes that need the vault return a clear
 * error (see api/models.ts).
 */
export async function runWeb(opts: RunWebOptions): Promise<void> {
  const vaultReady = await ensureVaultReady((s) => opts.write(s));
  if (!vaultReady) {
    opts.write(
      'Vault is locked — credential writes from the UI will be refused until you set\n' +
        'SHADOW_VAULT_PASSWORD or re-run from a terminal where you can type the master password.\n\n',
    );
  }

  const bus = opts.bus ?? new EventBus();
  let server: WebServerHandle;
  try {
    server = await startWebServer({ bus, port: opts.port });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'EADDRINUSE') {
      throw new Error(`Port ${opts.port} is already in use. Choose another with --port, or omit --port for an available one.`);
    }
    throw error;
  }

  opts.write(formatWebBoot(server));
  opts.write('Ctrl-C to stop.\n');

  if (opts.open !== false) openBrowser(server.url);

  await new Promise<void>((resolve) => {
    let stopping = false;
    const stop = (): void => {
      if (stopping) return;
      stopping = true;
      opts.write('\nStopping web UI…\n');
      void server.close().then(() => {
        process.removeListener('SIGINT', stop);
        process.removeListener('SIGTERM', stop);
        resolve();
      });
    };
    process.once('SIGINT', stop);
    process.once('SIGTERM', stop);
  });
}

/** Parse `shadow web [--port N] [--no-open]`. */
export const WEB_USAGE = 'Usage: shadow web [--port 1-65535] [--no-open]\n\nOpens the local browser console. --no-open prints the link without opening a browser.\nThe listener binds to 127.0.0.1; remote access requires an SSH tunnel.';

export function parseWebArgs(argv: string[]): { port?: number; open: boolean } {
  let port: number | undefined;
  let open = true;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--no-open') open = false;
    else if (a === '--port') {
      port = parsePort(argv[++i]);
    } else if (a.startsWith('--port=')) {
      port = parsePort(a.slice(7));
    } else throw new Error(`Unknown web option: ${a}\n${WEB_USAGE}`);
  }
  return { port, open };
}

function parsePort(value: string | undefined): number {
  if (!value || !/^\d+$/.test(value) || Number(value) < 1 || Number(value) > 65535) {
    throw new Error('Invalid --port. Use a number from 1 to 65535, or omit --port for an available one.');
  }
  return Number(value);
}
