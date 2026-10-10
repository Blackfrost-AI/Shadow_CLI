import { listChatGPTAccounts, signInChatGPT, logoutChatGPT } from './chatgpt.js';
import { claudeCodeLogin, claudeCodeStatus } from './claudeCode.js';
import { publicSignInUrl } from './signInUrl.js';
import { openBrowser } from '../web/browser.js';
import { redactString } from '../util/redact.js';

export const ACCOUNT_LOGIN_USAGE =
  'usage: shadow login [status|chatgpt [profile-id] [--no-open]|claude|logout <profile-id>]';
export interface AccountLoginOptions {
  write?: (text: string) => void;
  accounts?: typeof listChatGPTAccounts;
  signIn?: typeof signInChatGPT;
  logout?: typeof logoutChatGPT;
  claudeStatus?: typeof claudeCodeStatus;
  claudeLogin?: typeof claudeCodeLogin;
  openBrowser?: typeof openBrowser;
}

/** Authentication only: onboarding verifies a model before changing the active connection. */
export async function runAccountLogin(
  args: string[],
  options: AccountLoginOptions = {},
): Promise<number> {
  const write = options.write ?? ((text: string) => process.stdout.write(text));
  const command = args[0] ?? 'status';
  const controller = new AbortController();
  const cancel = () => controller.abort();
  process.once('SIGINT', cancel);
  process.once('SIGTERM', cancel);
  process.once('SIGHUP', cancel);
  try {
    if ((command === 'status' || command === 'show') && args.length <= 1) {
      const accounts = await (options.accounts ?? listChatGPTAccounts)();
      write('ChatGPT accounts (local Shadow registrations):\n');
      if (!accounts.length) write('  None — run shadow onboard → Subscription account.\n');
      for (const account of accounts) {
        write(
          `  ${account.label} — ${account.verificationPending ? 'verification pending; retry in shadow onboard' : account.signedIn ? (account.planUsageEnabled ? 'plan usage enabled' : 'plan usage not enabled') : 'signed out'}\n    ${account.profileId}\n`,
        );
      }
      const claude = await (options.claudeStatus ?? claudeCodeStatus)({
        signal: controller.signal,
      });
      write(
        `Claude Code: ${!claude.installed ? 'not installed' : !claude.supported ? 'update required' : claude.loggedIn && claude.authMethod === 'claude.ai' ? 'subscription sign-in active' : 'subscription sign-in required'}${claude.version ? ` (${claude.version})` : ''}\n`,
      );
      write(
        '\nRun shadow onboard to select and verify a subscription, API key, or self-hosted endpoint.\n',
      );
      return 0;
    }
    if (command === 'chatgpt' || command === 'codex') {
      const positional = args.slice(1).filter((arg) => arg !== '--no-open');
      if (positional.length > 1 || positional.some((arg) => arg.startsWith('-'))) {
        write(`${ACCOUNT_LOGIN_USAGE}\n`);
        return 1;
      }
      const account = await (options.signIn ?? signInChatGPT)({
        profileId: positional[0],
        signal: controller.signal,
        enablePlanUsage: true,
        onUrl: (raw) => {
          const url = publicSignInUrl(raw);
          write(
            `Continue with ChatGPT in your browser:\n${url}\n\nWaiting for sign-in. Ctrl+C cancels.\n`,
          );
          if (!args.includes('--no-open')) {
            try {
              (options.openBrowser ?? openBrowser)(url);
            } catch {
              write('The browser could not open automatically. Open the link above.\n');
            }
          }
        },
      });
      write(`\nConnected ${account.label}.\nAccount: ${account.profileId}\n`);
      if (!account.planUsageEnabled) {
        write(
          'Plan usage was not enabled. Run shadow login chatgpt with this account ID to authorize it.\n',
        );
        return 1;
      }
      write('Run shadow onboard → Subscription account to choose and verify a model.\n');
      return 0;
    }
    if (command === 'claude' && args.length === 1) {
      await (options.claudeLogin ?? claudeCodeLogin)({ signal: controller.signal });
      const status = await (options.claudeStatus ?? claudeCodeStatus)({
        signal: controller.signal,
      });
      if (!status.loggedIn || status.authMethod !== 'claude.ai') {
        write(
          'Claude subscription sign-in is not active. Run shadow login claude and choose your Claude account.\n',
        );
        return 1;
      }
      write(
        'Claude Code subscription connected. Run shadow onboard → Subscription account to verify a model.\n',
      );
      return 0;
    }
    if (command === 'logout' && args.length === 2 && !args[1]!.startsWith('-')) {
      const result = await (options.logout ?? logoutChatGPT)(args[1]!, controller.signal);
      write(`ChatGPT credentials removed locally for ${result.profileId}.\n`);
      if (result.revocation === 'unconfirmed')
        write(
          'Server revocation could not be confirmed. Manage this connection in ChatGPT Settings → Usage.\n',
        );
      else if (result.revocation === 'confirmed') write('OpenAI confirmed token revocation.\n');
      write(
        'The account registration is retained for sign-in again. Shadow will not switch to API billing.\n',
      );
      return 0;
    }
    write(
      `${ACCOUNT_LOGIN_USAGE}\nClaude sign-out is managed by the official command: claude auth logout\n`,
    );
    return 1;
  } catch (error) {
    write(
      controller.signal.aborted
        ? 'Sign-in cancelled. Your active connection is unchanged.\n'
        : `${redactString(error instanceof Error ? error.message : String(error)).slice(0, 500)}\n`,
    );
    return controller.signal.aborted ? 130 : 1;
  } finally {
    process.removeListener('SIGINT', cancel);
    process.removeListener('SIGTERM', cancel);
    process.removeListener('SIGHUP', cancel);
  }
}
