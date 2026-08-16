/**
 * `shadow acp` — the ACP (Agent Client Protocol) entry point. An ACP editor (Zed et al.) spawns
 * this process and speaks JSON-RPC 2.0 over its stdin/stdout, one message per line.
 *
 * STDOUT PURITY: the RPC peer is the ONLY writer to stdout — every diagnostic, banner, warning,
 * and vault prompt goes to stderr, or a stray byte on stdout would corrupt the wire.
 *
 * The vault is unlocked at startup (keychain → env). Under an editor stdin is a pipe, never a
 * TTY, so the interactive password path can NEVER fire here — a locked vault degrades exactly
 * like it does for `shadow web` (server keeps serving; session builds that need a key fail with
 * a clear error). Stdin can therefore stay exclusively the RPC wire.
 */
import { loadConfig } from '../config.js';
import { INSTALL_DIR } from '../installDir.js';
import { readVersion } from '../version.js';
import { ensureVaultReady } from '../auth/unlock.js';
import { makeAgentBuilder } from '../web/sessionAgent.js';
import { createSessionRegistry } from '../web/registry.js';
import { makeTurnRunner } from '../web/runTurn.js';
import { addProject } from '../web/projects.js';
import { RpcPeer } from './jsonrpc.js';
import { createAcpServer, type AcpServer } from './server.js';
import {
  ACP_PROTOCOL_VERSION,
  AGENT_NAME,
  M_SESSION_REQUEST_PERMISSION,
  type RequestPermissionResult,
} from './protocol.js';

const ACP_HELP = [
  'Usage: shadow acp [--add-project <path>]...',
  '',
  'Speaks ACP (Agent Client Protocol) over stdin/stdout for ACP-capable editors (Zed).',
  'JSON-RPC 2.0, one message per line; all diagnostics go to stderr.',
  '',
  'Options:',
  '  --add-project <path>  add a directory to the project allowlist (repeatable, idempotent).',
  '                        Sessions may only be created inside allowlisted directories.',
  '  -h, --help            show this help',
  '',
  'Point your editor\'s ACP agent command at `shadow acp`. Add your project directory first',
  '(or pass --add-project in the editor\'s agent configuration).',
].join('\n');

export interface AcpArgs {
  addProjects: string[];
  help: boolean;
}

/** Parse `shadow acp [--add-project <path>]...`. Unknown flags throw (typos must be loud). */
export function parseAcpArgs(argv: string[]): AcpArgs {
  const addProjects: string[] = [];
  let help = false;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (a === '-h' || a === '--help') {
      help = true;
    } else if (a === '--add-project') {
      const v = argv[++i];
      if (!v) throw new Error('--add-project needs a <path>');
      addProjects.push(v);
    } else if (a.startsWith('--add-project=')) {
      addProjects.push(a.slice('--add-project='.length));
    } else {
      throw new Error(`unknown argument: ${a}`);
    }
  }
  return { addProjects, help };
}

export async function runAcp(argv: string[]): Promise<void> {
  let args: AcpArgs;
  try {
    args = parseAcpArgs(argv);
  } catch (err) {
    process.stderr.write(`${err instanceof Error ? err.message : String(err)}\n\n${ACP_HELP}\n`);
    process.exitCode = 1;
    return;
  }
  if (args.help) {
    // A human asked (editors never pass --help) — stdout is free here, no RPC session exists.
    process.stdout.write(`${ACP_HELP}\n`);
    return;
  }

  for (const raw of args.addProjects) {
    try {
      const entry = addProject(raw);
      process.stderr.write(`allowlisted project: ${entry.path}\n`);
    } catch (err) {
      // A refusal is not fatal: the editor session may target an already-allowlisted directory.
      process.stderr.write(`warning: could not add project "${raw}": ${err instanceof Error ? err.message : String(err)}\n`);
    }
  }

  const vaultReady = await ensureVaultReady((s) => process.stderr.write(s));
  if (!vaultReady) {
    process.stderr.write(
      'Vault is locked — set SHADOW_VAULT_PASSWORD (or unlock once from a terminal so the keychain caches the key);\n' +
        'session builds that need credentials will fail until then.\n',
    );
  }

  const bootConfig = loadConfig(process.cwd(), {});
  const version = readVersion();

  // Peer ↔ server reference each other; both are fully constructed before stdin is wired, so
  // nothing can arrive before the closures below resolve. `server` starts null only to break
  // the construction cycle — it is bound before any input can arrive.
  let server: AcpServer | null = null;
  const peer = new RpcPeer(
    (line) => process.stdout.write(line),
    {
      request: (method, params) => server!.handleRequest(method, params),
      notification: (method, params) => server!.handleNotification(method, params),
    },
  );
  const registry = createSessionRegistry({
    builder: makeAgentBuilder({ bootConfig, installDir: INSTALL_DIR }),
    // The turn's approval gate bridges to the EDITOR (session/request_permission) instead of
    // denying everything — see AcpPermissionGate. Same fail-closed floor.
    runTurn: makeTurnRunner(undefined, (s) => server!.gateFor(s)),
  });
  server = createAcpServer({
    registry,
    version,
    notify: (method, params) => peer.notify(method, params),
    askPermission: async (params, signal) => {
      try {
        const result = await peer.request(M_SESSION_REQUEST_PERMISSION, params, signal ? { signal } : undefined);
        return result as RequestPermissionResult;
      } catch {
        return undefined; // abort, editor error, or shutdown — the gate fail-closes on undefined
      }
    },
  });

  process.stderr.write(`${AGENT_NAME} ${version} — ACP agent ready (protocol v${ACP_PROTOCOL_VERSION}); diagnostics on stderr\n`);

  process.stdin.setEncoding('utf8');
  process.stdin.on('data', (chunk) => peer.feed(String(chunk)));

  let shuttingDown = false;
  await new Promise<void>((resolveShutdown) => {
    const shutdown = (why: string): void => {
      if (shuttingDown) return;
      shuttingDown = true;
      process.stderr.write(`shutting down (${why})\n`);
      void (async () => {
        try {
          await server!.close();
        } catch {
          /* teardown is best-effort */
        }
        peer.cancelPending('acp server shutting down');
        // On the signal paths the editor will never close stdin for us, and its open pipe with
        // a 'data' listener keeps the event loop referenced — the process would outlive its own
        // teardown. Destroy the handle so the loop drains when runAcp returns. (On the EOF path
        // stdin is already ended; destroy is idempotent there.)
        try {
          process.stdin.destroy();
        } catch {
          /* already gone */
        }
        resolveShutdown();
      })();
    };
    // Editor exits → stdin EOF → clean teardown. Signals cover Ctrl-C / editor kill.
    process.stdin.on('end', () => shutdown('stdin closed'));
    process.stdin.on('error', () => shutdown('stdin error'));
    process.on('SIGINT', () => shutdown('SIGINT'));
    process.on('SIGTERM', () => shutdown('SIGTERM'));
  });
}
