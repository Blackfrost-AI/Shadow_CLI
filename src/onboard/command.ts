import { runOnboard } from './onboard.js';
import { runWebOnboard } from './webOnboard.js';

export const ONBOARD_HELP = `Usage: shadow onboard [--terminal | --web] [--no-open]

  (default)   Open secure setup in your local browser.
  --terminal  Use the terminal wizard (also: --cli).
  --web       Alias for the default browser wizard.
  --no-open   Print the local setup URL without launching a browser.

For SSH, forward the printed loopback port or use --terminal.
`;

export function parseOnboardArgs(args: string[]): {
  terminal: boolean;
  open: boolean;
  help: boolean;
} {
  const allowed = new Set(['--terminal', '--cli', '--web', '--no-open', '--help', '-h']);
  const unknown = args.find((arg) => !allowed.has(arg));
  if (unknown) throw new Error(`Unknown onboarding option: ${unknown}`);
  const terminal = args.includes('--terminal') || args.includes('--cli');
  if (terminal && (args.includes('--web') || args.includes('--no-open')))
    throw new Error('Choose --terminal or browser setup, not both.');
  return {
    terminal,
    open: !args.includes('--no-open'),
    help: args.includes('--help') || args.includes('-h'),
  };
}

/** Explicit and first-run setup share the same browser-first dispatch. */
export async function runOnboarding(
  args: string[],
  write: (message: string) => void,
  runners: { terminal?: typeof runOnboard; web?: typeof runWebOnboard } = {},
): Promise<boolean> {
  const flags = parseOnboardArgs(args);
  if (flags.help) {
    write(ONBOARD_HELP);
    return true;
  }
  const terminal = runners.terminal ?? runOnboard;
  if (flags.terminal) return terminal();
  const result = await (runners.web ?? runWebOnboard)(write, { launchBrowser: flags.open });
  if (result.terminal) {
    write('\nContinuing setup in this terminal. You do not need to restart Shadow.\n');
    return terminal();
  }
  if (result.ok) {
    write(
      `✓ Setup saved${result.cached ? ' and unlocked via your keychain' : ''}. Run \`shadow\` to start.\n`,
    );
  } else {
    write(
      `Setup not completed${result.reason ? ` — ${result.reason}` : ''}. Use \`shadow onboard --terminal\` for terminal-only setup.\n`,
    );
  }
  return result.ok;
}
