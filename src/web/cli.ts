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
    'Loopback only. The token in that URL is required; requests from any other\n' +
    'host or origin are refused. Nothing leaves this machine.\n\n'
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
  const server = await startWebServer({ bus, port: opts.port });

  opts.write(formatWebBoot(server));
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
