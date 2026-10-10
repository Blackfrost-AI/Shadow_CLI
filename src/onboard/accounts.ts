import type { AccountConnection, ModelEntry } from '../config.js';
import { defaultModelPatch } from '../config/modelPresets.js';
import { loadGlobalConfig, saveGlobalConfig } from '../state/globalStore.js';
import { listChatGPTAccounts, listChatGPTModels, signInChatGPT } from '../auth/chatgpt.js';
import { claudeCodeLogin, claudeCodeStatus } from '../auth/claudeCode.js';
import { openBrowser } from '../web/browser.js';
import { publicSignInUrl } from '../auth/signInUrl.js';
import { redactString } from '../util/redact.js';
import { testConnection } from './connection.js';
import { BACK, OnboardCancelled, type OnboardUI } from './ui.js';

export interface AccountOnboardOptions {
  accounts?: typeof listChatGPTAccounts;
  signIn?: typeof signInChatGPT;
  models?: typeof listChatGPTModels;
  claudeStatus?: typeof claudeCodeStatus;
  claudeLogin?: typeof claudeCodeLogin;
  openBrowser?: (url: string) => void;
  test?: typeof testConnection;
}

export { publicSignInUrl } from '../auth/signInUrl.js';

export function persistAccountModel(
  connection: AccountConnection,
  model: string,
  title: string,
): ModelEntry {
  const config = loadGlobalConfig();
  const models = (config.models as ModelEntry[] | undefined) ?? [];
  const same = (entry: ModelEntry) =>
    entry.connection?.kind === connection.kind &&
    (connection.kind !== 'chatgpt' ||
      (entry.connection.kind === 'chatgpt' && entry.connection.profileId === connection.profileId));
  const previous = models.find((entry) => same(entry) && entry.model === model);
  const stem = `${title} · ${model}`;
  let label = previous?.label ?? stem;
  for (let suffix = 2; !previous && models.some((entry) => entry.label === label); suffix++)
    label = `${stem} (${suffix})`;
  const entry: ModelEntry = {
    label,
    provider: connection.kind === 'chatgpt' ? 'openai' : 'anthropic',
    model,
    connection,
    group: connection.kind === 'chatgpt' ? 'ChatGPT subscription' : 'Claude subscription',
    onboarded: true,
  };
  const next = previous
    ? models.map((item) => (item === previous ? entry : item))
    : [...models, entry];
  saveGlobalConfig({ ...defaultModelPatch(entry), models: next });
  return entry;
}

export async function runAccountOnboard(
  ui: OnboardUI,
  options: AccountOnboardOptions = {},
): Promise<string | typeof BACK> {
  const pick = async (
    title: string,
    choices: { id: string; label: string; detail?: string }[],
    stage = 0,
    details?: string[],
  ) => {
    const answer = await ui.choose({ title, stage, details }, choices, { search: stage >= 1 });
    return answer === BACK ? BACK : answer[0]!;
  };
  let connection: AccountConnection | undefined;
  let title = '';
  let model = '';
  let catalog: { id: string; label: string }[] = [];
  let stage: 'provider' | 'connect' | 'models' | 'test' | 'save' = 'provider';
  let selected = 'chatgpt';
  let selectedProfileId: string | undefined;
  let reconnect = false;
  for (;;) {
    try {
      if (stage === 'provider') {
        const answer = await pick('Choose a subscription', [
          {
            id: 'chatgpt',
            label: 'Continue with ChatGPT',
            detail: 'Use an eligible ChatGPT plan · sign in with your browser',
          },
          {
            id: 'claude',
            label: 'Claude Code subscription',
            detail: 'Use your sign-in through installed, official Claude Code',
          },
        ]);
        if (answer === BACK) return BACK;
        selected = answer;
        connection = undefined;
        selectedProfileId = undefined;
        reconnect = false;
        stage = 'connect';
      }
      if (stage === 'connect') {
        if (selected === 'chatgpt') {
          const saved = await (options.accounts ?? listChatGPTAccounts)();
          const answer =
            reconnect && selectedProfileId
              ? selectedProfileId
              : await pick(
                  'ChatGPT accounts',
                  [
                    ...saved.map((account) => ({
                      id: account.profileId,
                      label: account.label,
                      detail: account.verificationPending
                        ? 'Verification pending; retry'
                        : account.signedIn && account.planUsageEnabled
                          ? 'Connected · use this account'
                          : 'Sign in again to enable plan usage',
                    })),
                    {
                      id: '@new',
                      label: 'Continue with ChatGPT',
                      detail: 'Add another account or workspace',
                    },
                  ],
                  1,
                );
          if (answer === BACK) {
            stage = 'provider';
            continue;
          }
          selectedProfileId = answer === '@new' ? undefined : answer;
          let account = saved.find((item) => item.profileId === answer);
          if (
            reconnect ||
            !account ||
            (!account.verificationPending && (!account.signedIn || !account.planUsageEnabled))
          ) {
            const result = await ui.busy(
              {
                stage: 1,
                title: 'Continue with ChatGPT',
                description: 'Complete sign-in in your browser. Esc cancels and returns here.',
              },
              (signal) =>
                (options.signIn ?? signInChatGPT)({
                  profileId: selectedProfileId,
                  signal,
                  enablePlanUsage: true,
                  onUrl: (raw) => {
                    const url = publicSignInUrl(raw);
                    (options.openBrowser ?? openBrowser)(url);
                    ui.updateBusy?.({
                      details: ['Browser sign-in opened. If needed, open this link:', url],
                    });
                  },
                }),
            );
            if (result === BACK) {
              reconnect = false;
              continue;
            }
            account = result;
            reconnect = false;
          }
          selectedProfileId = account.profileId;
          if (!account.planUsageEnabled && !account.verificationPending)
            throw new Error(
              'ChatGPT sign-in succeeded, but plan usage was not enabled. Authorize plan usage to continue.',
            );
          connection = { kind: 'chatgpt', profileId: account.profileId };
          title = `ChatGPT (${account.label})`;
          const result = await ui.busy(
            {
              stage: 2,
              title: 'Your ChatGPT models',
              description: 'Loading models available to this account.',
            },
            (signal) => (options.models ?? listChatGPTModels)(account!.profileId, signal),
          );
          if (result === BACK) continue;
          catalog = result.map((item) => ({ id: item.slug, label: item.displayName }));
          if (!catalog.length)
            throw new Error(
              'This account returned no available models. Check plan usage in ChatGPT Settings → Usage.',
            );
        } else {
          let status = await ui.busy(
            {
              stage: 1,
              title: 'Claude Code sign-in',
              description: 'Checking the installed official CLI.',
            },
            (signal) => (options.claudeStatus ?? claudeCodeStatus)({ signal }),
          );
          if (status === BACK) {
            stage = 'provider';
            continue;
          }
          if (!status.installed || !status.supported)
            throw new Error(
              status.message ??
                'Install or update official Claude Code from https://code.claude.com/docs/en/setup, then retry.',
            );
          if (!status.loggedIn || status.authMethod !== 'claude.ai') {
            const answer = await pick(
              'Sign in to Claude Code',
              [
                {
                  id: 'login',
                  label: 'Open official Claude Code sign-in',
                  detail: 'Use your Claude subscription; Shadow never receives your login tokens.',
                },
              ],
              1,
            );
            if (answer === BACK) {
              stage = 'provider';
              continue;
            }
            if (!ui.external)
              throw new Error(
                'Run shadow login claude in an interactive terminal, then return here.',
              );
            await ui.external((signal) => (options.claudeLogin ?? claudeCodeLogin)({ signal }));
            status = await (options.claudeStatus ?? claudeCodeStatus)();
          }
          if (!status.loggedIn || status.authMethod !== 'claude.ai')
            throw new Error(
              'Claude subscription sign-in is not active. Run shadow login claude and choose your Claude account.',
            );
          connection = { kind: 'claude-code' };
          title = 'Claude Code';
          catalog = [
            { id: 'sonnet', label: 'Claude Sonnet' },
            { id: 'opus', label: 'Claude Opus' },
            { id: 'haiku', label: 'Claude Haiku' },
          ];
        }
        stage = 'models';
      }
      if (stage === 'models') {
        const answer = await pick('Choose a subscription model', catalog, 2, [title]);
        if (answer === BACK) {
          stage = 'connect';
          continue;
        }
        model = answer;
        stage = 'test';
      }
      if (stage === 'test') {
        const result = await ui.busy(
          {
            stage: 3,
            title: 'Verify subscription connection',
            description:
              'Checking a completed tool response. Uses a small amount of your plan allowance.',
            details: [title, model],
          },
          (signal) =>
            (options.test ?? testConnection)(
              {
                provider: connection!.kind === 'chatgpt' ? 'openai' : 'anthropic',
                model,
                connection,
              },
              signal,
              60_000,
            ),
        );
        if (result === BACK) {
          stage = 'models';
          continue;
        }
        if (!result.ok)
          throw new Error(result.error ?? 'Subscription connection could not be verified.');
        stage = 'save';
      }
      if (stage === 'save') {
        const answer = await pick(
          'Save subscription connection',
          [
            { id: 'save', label: 'Save and finish', detail: 'Make this model active in Shadow.' },
            { id: 'models', label: 'Choose another model' },
          ],
          4,
          [
            title,
            model,
            'Tool response verified · subscription limits apply · no automatic API billing fallback',
          ],
        );
        if (answer === BACK || answer === 'models') {
          stage = 'models';
          continue;
        }
        persistAccountModel(connection!, model, title);
        return `Saved ${title} · ${model} · subscription connection verified.\nRun shadow to start. Use /model to switch connections.`;
      }
    } catch (error) {
      if (error instanceof OnboardCancelled) throw error;
      const answer = await ui.choose(
        {
          stage: stage === 'test' ? 3 : 1,
          title: 'Connection needs attention',
          description: 'Your active setup is unchanged. You can retry or go back.',
          error: redactString(error instanceof Error ? error.message : String(error)).slice(0, 500),
        },
        [
          { id: 'retry', label: 'Retry this step' },
          ...(selected === 'chatgpt' && selectedProfileId
            ? [
                {
                  id: 'reconnect',
                  label: 'Reconnect selected account',
                  detail: 'Sign in again using this saved registration, then verify before saving.',
                },
              ]
            : []),
          ...(stage === 'test' ? [{ id: 'models', label: 'Choose another model' }] : []),
          { id: 'connect', label: 'Choose an account again' },
          { id: 'back', label: 'Back to subscription choices' },
        ],
      );
      if (answer === BACK || answer[0] === 'back') stage = 'provider';
      else if (answer[0] === 'reconnect') {
        reconnect = true;
        stage = 'connect';
      } else if (answer[0] === 'connect') {
        reconnect = false;
        stage = 'connect';
      } else if (answer[0] === 'models') stage = 'models';
    }
  }
}
