import { stdin, stdout } from 'node:process';
import { createHash } from 'node:crypto';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { stripVTControlCharacters } from 'node:util';
import {
  featuredProviders,
  findPreset,
  providersForMode,
  type ProviderPreset,
  type OnboardMode,
} from './catalog.js';
import type { ProviderName } from '../provider/index.js';
import {
  saveCredential,
  saveGlobalConfig,
  loadGlobalConfig,
  vaultUnlocked,
} from '../state/globalStore.js';
import { vaultExists } from '../auth/vault.js';
import { unlockExistingVault } from '../auth/unlock.js';
import { addLocalModel } from '../local/garage.js';
import { defaultModelPatch } from '../config/modelPresets.js';
import { normalizeBaseUrl, type ModelEntry } from '../config.js';
import { looksAnthropicDistilled, toAnthropicBaseUrl } from '../util/transport.js';
import { registerSecret, redactString } from '../util/redact.js';
import { persistOnboardTarget, type OnboardTargetInput } from './persistTarget.js';
import { probeModelEndpoint, type EndpointProbeResult } from './probe.js';
import { testConnection, type ConnectionResult } from './connection.js';
import { runAccountOnboard, type AccountOnboardOptions } from './accounts.js';
import {
  BACK,
  OnboardCancelled,
  TerminalOnboardUI,
  PlainOnboardUI,
  type OnboardUI,
  type Screen,
  type Choice,
} from './ui.js';

type Step =
  | 'mode'
  | 'provider'
  | 'browse'
  | 'file'
  | 'fileReview'
  | 'endpoint'
  | 'key'
  | 'discover'
  | 'discoveryFailure'
  | 'compatibility'
  | 'hosting'
  | 'models'
  | 'manual'
  | 'default'
  | 'transport'
  | 'test'
  | 'testFailure'
  | 'review';
interface Draft {
  preset: ProviderPreset;
  adapter: ProviderName;
  baseUrl?: string;
  key?: string;
  bearer?: boolean;
  selfHosted?: boolean;
  probe?: EndpointProbeResult;
  selected: string[];
  model?: string;
  test?: ConnectionResult;
}

export function persistTerminalOnboardTarget(input: {
  adapter: ProviderName;
  model: string;
  baseUrl?: string;
  customEndpoint: boolean;
  selfHosted?: boolean;
  entryExtras?: OnboardTargetInput['entryExtras'];
  selectedModels?: string[];
  entryGroup?: string;
  credentialRef?: string;
}): void {
  const { adapter, ...target } = input;
  persistOnboardTarget({ ...target, provider: adapter });
}

/** Validate the entered address instead of silently replacing a typo with localhost. */
export function validateOnboardUrl(value: string): string | undefined {
  const normalized = normalizeBaseUrl(value);
  if (!normalized) return 'Enter an http:// or https:// API base URL.';
  const url = new URL(normalized);
  if (url.username || url.password || url.search || url.hash)
    return 'Use the API base URL only; enter the key in the next step.';
  if (/\/(?:chat\/completions|messages|models)\/?$/i.test(url.pathname))
    return 'Use the base URL before /chat/completions, /messages, or /models.';
  return undefined;
}

function modelError(value: string): string | undefined {
  return !value || /[\s\u0000-\u001f\u007f]/.test(value) || value.length > 256
    ? 'Enter one exact model ID, without spaces.'
    : undefined;
}
const safeError = (error: unknown) =>
  stripVTControlCharacters(
    redactString(error instanceof Error ? error.message : String(error)),
  ).slice(0, 400);
const choices = (items: [string, string, string?][]): Choice[] =>
  items.map(([id, label, detail]) => ({ id, label, detail }));
const providerChoices = (items: ProviderPreset[]) =>
  items.map((item) => ({ id: item.id, label: item.label, detail: item.baseUrl }));
const credentials = (draft: Draft) =>
  draft.bearer ? { authToken: draft.key } : { apiKey: draft.key };

/** Test seams replace only network/UI boundaries; production uses the same state machine. */
export interface OnboardOptions {
  accounts?: AccountOnboardOptions;
  ui?: OnboardUI;
  probe?: typeof probeModelEndpoint;
  test?: typeof testConnection;
}

export async function runOnboard(options: OnboardOptions = {}): Promise<boolean> {
  const theme = loadGlobalConfig().lastTheme;
  const ui =
    options.ui ??
    (stdin.isTTY && stdout.isTTY && process.env.TERM !== 'dumb'
      ? new TerminalOnboardUI(undefined, typeof theme === 'string' ? theme : undefined)
      : new PlainOnboardUI());
  const probeEndpoint = options.probe ?? probeModelEndpoint;
  const checkConnection = options.test ?? testConnection;
  let step: Step = 'mode';
  let mode: OnboardMode = 'server';
  let draft: Draft | undefined;
  let filePath = '';
  let local: { entry: ModelEntry; models: ModelEntry[] } | undefined;
  let finale = 'Setup cancelled — your existing configuration is unchanged.';
  const pick = async (screen: Screen, items: Choice[], initial?: string, search = false) => {
    const answer = await ui.choose(screen, items, { initial, search });
    return answer === BACK ? BACK : answer[0]!;
  };
  const details = () => (draft ? [draft.preset.label, draft.baseUrl ?? ''] : []);
  const afterDiscovery = (): Step => {
    if (draft?.preset.kind === 'custom' && !draft.probe?.ok) return 'compatibility';
    if (
      draft?.preset.kind === 'custom' &&
      draft.adapter === 'openai' &&
      draft.probe?.hosting === 'unknown'
    )
      return 'hosting';
    return 'models';
  };

  try {
    while (true) {
      try {
        switch (step) {
          case 'mode': {
            const answer = await pick(
              {
                stage: 0,
                title: 'How do you want to run Shadow?',
                description: 'Connect a model that supports tools. No Shadow account needed.',
              },
              choices([
                ['file', 'Local file', 'A GGUF file or MLX model, served on this machine'],
                ['server', 'Model server', 'Ollama, LM Studio, vLLM, or your own endpoint'],
                ['cloud', 'Cloud provider', 'Connect with a provider API key'],
                ['account', 'Subscription account', 'Continue with ChatGPT or use your Claude Code sign-in'],
              ]),
              mode,
            );
            if (answer === BACK) continue;
            if (answer === 'account') {
              const result = await runAccountOnboard(ui, options.accounts);
              if (result === BACK) break;
              finale = result;
              return true;
            }
            mode = answer as OnboardMode;
            step = mode === 'file' ? 'file' : 'provider';
            break;
          }
          case 'provider':
          case 'browse': {
            const browsing: boolean = step === 'browse';
            const available = providersForMode(mode).filter(
              (preset) => !preset.comingSoon && preset.kind !== 'custom',
            );
            const items = browsing
              ? providerChoices(available)
              : [
                  ...providerChoices(featuredProviders(mode)),
                  {
                    id: '@browse',
                    label: 'Browse all providers',
                    detail: `${available.length} providers · type / to search`,
                  },
                  {
                    id: 'custom',
                    label: 'Custom endpoint',
                    detail: 'Any OpenAI- or Anthropic-compatible API',
                  },
                ];
            const answer = await pick(
              {
                stage: 0,
                title: browsing
                  ? 'All providers'
                  : mode === 'cloud'
                    ? 'Choose a cloud provider'
                    : 'Choose a model server',
                description: 'Your key goes only to the endpoint you choose.',
              },
              items,
              draft?.preset.id,
              browsing,
            );
            if (answer === BACK) {
              step = browsing ? 'provider' : 'mode';
              break;
            }
            if (answer === '@browse') {
              step = 'browse';
              break;
            }
            const preset = findPreset(answer)!;
            if (draft?.preset.id !== preset.id)
              draft = {
                preset,
                adapter: preset.adapter,
                baseUrl: preset.baseUrl,
                bearer: preset.bearer,
                selected: [],
              };
            step = 'endpoint';
            break;
          }
          case 'file': {
            const answer = await ui.text(
              {
                stage: 1,
                title: 'Choose a local model',
                description: 'GGUF file, MLX folder, or mlx-community/model ID',
              },
              {
                initial: filePath,
                validate: (value) =>
                  value ? undefined : 'Enter a model path or MLX repository ID.',
              },
            );
            if (answer === BACK) {
              step = 'mode';
              break;
            }
            filePath = answer;
            const models = (loadGlobalConfig().models as ModelEntry[] | undefined) ?? [];
            const expanded = answer.startsWith('~/') ? join(homedir(), answer.slice(2)) : answer;
            const absolute = resolve(expanded);
            const existing = models.find(
              (model) => model.gguf === absolute || model.mlx === answer || model.mlx === absolute,
            );
            if (existing) local = { entry: existing, models };
            else {
              const result = addLocalModel(models, { path: answer });
              if (!result.ok) throw new Error(result.message);
              local = result.value;
            }
            step = 'fileReview';
            break;
          }
          case 'fileReview': {
            const answer = await pick(
              {
                stage: 4,
                title: 'Save local model',
                description:
                  'The server will start on first use. The model has not been tested yet.',
                details: [local!.entry.label, filePath],
              },
              choices([
                ['save', 'Save and make default'],
                ['edit', 'Choose a different model'],
              ]),
            );
            if (answer === BACK || answer === 'edit') {
              step = 'file';
              break;
            }
            const models = (loadGlobalConfig().models as ModelEntry[] | undefined) ?? [];
            const entry = local!.entry;
            saveGlobalConfig({
              models: [...models.filter((model) => model.label !== entry.label), entry],
              ...defaultModelPatch(entry),
            });
            finale = `Saved ${entry.label}. Run shadow to start. Test it with: shadow local test ${JSON.stringify(entry.label)}`;
            return true;
          }
          case 'endpoint': {
            const d = draft!;
            const answer = await ui.text(
              {
                stage: 1,
                title: 'Endpoint URL',
                description: 'Confirm or edit the API base URL.',
                details: [d.preset.label],
              },
              {
                initial: d.baseUrl ?? '',
                placeholder: 'http://localhost:8000/v1',
                validate: validateOnboardUrl,
              },
            );
            if (answer === BACK) {
              step = 'provider';
              break;
            }
            const baseUrl = normalizeBaseUrl(answer)!;
            if (baseUrl !== d.baseUrl) {
              if (!d.baseUrl || new URL(baseUrl).origin !== new URL(d.baseUrl).origin)
                d.key = undefined;
              d.probe = undefined;
              d.selected = [];
              d.model = undefined;
              d.test = undefined;
              d.adapter = d.preset.adapter;
              d.bearer = d.preset.bearer;
            }
            d.baseUrl = baseUrl;
            step = 'key';
            break;
          }
          case 'key': {
            const d = draft!;
            const required = d.preset.kind === 'cloud';
            const answer = await ui.text(
              {
                stage: 1,
                title: 'API key',
                description: required
                  ? 'Paste your provider key. Input stays hidden.'
                  : 'Paste a key, or leave blank if your server needs none.',
                details: [
                  ...details(),
                  ...(d.preset.keyUrl ? [`Get a key: ${d.preset.keyUrl}`] : []),
                ],
              },
              {
                initial: d.key,
                secret: true,
                placeholder: required ? 'Paste your API key' : 'Enter to skip',
                validate: (value) =>
                  required && !value
                    ? 'This provider requires an API key.'
                    : /\s/.test(value)
                      ? 'The key contains whitespace. Paste the key without extra text.'
                      : undefined,
              },
            );
            if (answer === BACK) {
              step = 'endpoint';
              break;
            }
            d.key = answer || (d.preset.bearer ? 'ollama' : undefined);
            registerSecret(d.key);
            d.test = undefined;
            step = 'discover';
            break;
          }
          case 'discover': {
            const d = draft!;
            const probe = await ui.busy(
              {
                stage: 2,
                title: 'Discover models',
                description: 'Checking the catalog · up to 6 seconds',
                details: details(),
              },
              (signal) =>
                probeEndpoint({
                  adapter:
                    d.preset.kind === 'custom'
                      ? 'auto'
                      : d.adapter === 'anthropic'
                        ? 'anthropic'
                        : 'openai',
                  baseUrl: d.baseUrl,
                  ...credentials(d),
                  signal,
                  fallbackModels:
                    d.preset.recommendedModels ??
                    (d.preset.defaultModel ? [d.preset.defaultModel] : []),
                  hostingHint:
                    d.preset.kind === 'cloud'
                      ? 'hosted'
                      : d.preset.kind === 'local'
                        ? 'self-hosted'
                        : undefined,
                }),
            );
            if (probe === BACK) {
              step = 'key';
              break;
            }
            d.probe = probe;
            if (probe.baseUrl) d.baseUrl = probe.baseUrl;
            if (probe.ok && d.preset.kind === 'custom') d.adapter = probe.compatibility;
            d.selfHosted = probe.hosting === 'self-hosted';
            step = probe.ok ? afterDiscovery() : 'discoveryFailure';
            break;
          }
          case 'discoveryFailure': {
            const d = draft!;
            const answer = await pick(
              {
                stage: 2,
                title: 'Model discovery unavailable',
                description: 'Your entries are kept. You can retry or continue with a model ID.',
                details: details(),
                error: d.probe?.error,
              },
              choices([
                [
                  'continue',
                  d.probe?.models.length
                    ? 'Use suggested models / enter an ID'
                    : 'Enter a model ID',
                ],
                ['retry', 'Retry discovery'],
                ['endpoint', 'Edit endpoint'],
                ['key', 'Edit API key'],
              ]),
            );
            step =
              answer === BACK
                ? 'key'
                : answer === 'retry'
                  ? 'discover'
                  : answer === 'endpoint'
                    ? 'endpoint'
                    : answer === 'key'
                      ? 'key'
                      : afterDiscovery();
            break;
          }
          case 'compatibility': {
            const answer = await pick(
              {
                stage: 1,
                title: 'API format',
                description:
                  'Discovery could not detect the format. Choose what your server supports.',
              },
              choices([
                ['openai', 'OpenAI-compatible', 'Chat Completions API'],
                ['anthropic', 'Anthropic-compatible', 'Messages API'],
              ]),
              draft!.adapter,
            );
            if (answer === BACK) {
              step = 'key';
              break;
            }
            draft!.adapter = answer as ProviderName;
            draft!.bearer = answer === 'anthropic';
            step =
              answer === 'openai' && draft!.probe?.hosting === 'unknown' ? 'hosting' : 'models';
            break;
          }
          case 'hosting': {
            const answer = await pick(
              {
                stage: 1,
                title: 'Who runs this endpoint?',
                description: 'This sets the connection timeout and local model options.',
              },
              choices([
                ['hosted', 'A hosted provider'],
                [
                  'self',
                  'I run this server',
                  'Your own machine, rented GPU, or private model server',
                ],
              ]),
              draft!.selfHosted ? 'self' : 'hosted',
            );
            if (answer === BACK) {
              step = 'key';
              break;
            }
            draft!.selfHosted = answer === 'self';
            step = 'models';
            break;
          }
          case 'models': {
            const d = draft!;
            const available = d.probe?.models ?? [];
            if (!available.length) {
              step = 'manual';
              break;
            }
            const preferred = d.preset.recommendedModels ?? [d.preset.defaultModel];
            const ordered = [
              ...available.filter((id) => preferred.includes(id)),
              ...available.filter((id) => !preferred.includes(id)),
            ];
            const answer = await ui.choose(
              {
                stage: 2,
                title: 'Choose models',
                description: 'Enter picks one · Space selects several · / searches all models',
                details: [
                  `${d.preset.label} · ${available.length} ${d.probe?.source === 'live' ? 'available' : 'suggested'} models`,
                ],
              },
              [
                ...ordered.map((id) => ({
                  id,
                  label: id,
                  detail: preferred.includes(id)
                    ? 'Recommended · choose a model with tool support'
                    : undefined,
                })),
                {
                  id: '@manual',
                  label: 'Enter a model ID…',
                  detail: 'Use an exact ID that is not in the catalog',
                },
              ],
              {
                search: true,
                multiple: true,
                selected: d.selected.filter((id) => available.includes(id)),
                initial: d.model,
              },
            );
            if (answer === BACK) {
              step = 'key';
              break;
            }
            if (answer.includes('@manual')) {
              if (answer[1]) d.model = answer[1];
              step = 'manual';
              break;
            }
            d.selected = answer;
            step = answer.length > 1 ? 'default' : 'transport';
            if (answer.length === 1) d.model = answer[0];
            break;
          }
          case 'manual': {
            const answer = await ui.text(
              {
                stage: 2,
                title: 'Model ID',
                description: 'Use the exact ID served by your endpoint.',
                details: details(),
              },
              { initial: draft!.model ?? '', validate: modelError },
            );
            if (answer === BACK) {
              step = draft!.probe?.models.length ? 'models' : 'key';
              break;
            }
            draft!.model = answer;
            draft!.selected = [answer];
            step = 'transport';
            break;
          }
          case 'default': {
            const answer = await pick(
              {
                stage: 2,
                title: 'Default model',
                description: 'The other selected models will be available in /model.',
              },
              draft!.selected.map((id) => ({ id, label: id })),
              draft!.model,
            );
            if (answer === BACK) {
              step = 'models';
              break;
            }
            draft!.model = answer;
            step = 'transport';
            break;
          }
          case 'transport': {
            const d = draft!;
            if (
              d.adapter === 'openai' &&
              d.preset.kind !== 'cloud' &&
              looksAnthropicDistilled(d.model!)
            ) {
              const answer = await pick(
                {
                  stage: 3,
                  title: 'Model compatibility',
                  description:
                    'This model may work better with an Anthropic-compatible server route.',
                },
                choices([
                  ['keep', 'Keep OpenAI format'],
                  [
                    'anthropic',
                    'Use Anthropic format',
                    'Only if your endpoint supports the Messages API',
                  ],
                ]),
              );
              if (answer === BACK) {
                step = 'models';
                break;
              }
              if (answer === 'anthropic') {
                d.adapter = 'anthropic';
                d.baseUrl = toAnthropicBaseUrl(d.baseUrl!);
                d.bearer = true;
                d.selfHosted = false;
                d.key ||= 'ollama';
              }
            }
            d.test = undefined;
            step = 'test';
            break;
          }
          case 'test': {
            const d = draft!;
            const result = await ui.busy(
              {
                stage: 3,
                title: 'Test connection',
                description: 'Verifying a completed tool response · up to 30 seconds',
                details: [...details(), d.model!],
              },
              (signal) =>
                checkConnection(
                  {
                    provider: d.adapter,
                    model: d.model!,
                    baseUrl: d.baseUrl,
                    ...credentials(d),
                    selfHosted: d.selfHosted,
                    capabilities:
                      d.model === d.preset.defaultModel ? d.preset.entry?.capabilities : undefined,
                  },
                  signal,
                ),
            );
            if (result === BACK) {
              step = 'models';
              break;
            }
            d.test = result;
            step = result.ok ? 'review' : 'testFailure';
            break;
          }
          case 'testFailure': {
            const answer = await pick(
              {
                stage: 3,
                title: 'Connection needs attention',
                description: 'Nothing has been saved. Your setup entries are still here.',
                error: draft!.test?.error,
                details: details(),
              },
              choices([
                ['retry', 'Retry connection'],
                ['endpoint', 'Edit endpoint'],
                ['key', 'Edit API key'],
                ['models', 'Choose another model'],
                ['save', 'Continue without a successful test'],
              ]),
            );
            step =
              answer === BACK
                ? 'models'
                : answer === 'retry'
                  ? 'test'
                  : answer === 'save'
                    ? 'review'
                    : (answer as Step);
            break;
          }
          case 'review': {
            const d = draft!;
            const answer = await pick(
              {
                stage: 4,
                title: 'Review and save',
                description: d.test?.ok
                  ? 'Connection verified. Save these models and make the default active.'
                  : 'Connection unverified. Save only if you want to fix it later.',
                details: [
                  d.preset.label,
                  d.baseUrl!,
                  `Default: ${d.model}`,
                  `${d.selected.length} model${d.selected.length === 1 ? '' : 's'} · key ${d.key ? 'provided (hidden)' : 'not provided'}`,
                ],
              },
              choices([
                ['save', d.test?.ok ? 'Save and finish' : 'Save unverified setup'],
                ['endpoint', 'Edit endpoint'],
                ['key', 'Edit API key'],
                ['models', 'Change models'],
              ]),
            );
            if (answer === BACK) {
              step = 'models';
              break;
            }
            if (answer !== 'save') {
              step = answer as Step;
              break;
            }
            if (vaultExists() && !vaultUnlocked()) {
              let message = '';
              let back = false;
              const unlocked = await unlockExistingVault(
                (text) => {
                  message = text;
                },
                async () => {
                  const password = await ui.text(
                    {
                      stage: 4,
                      title: 'Unlock saved credentials',
                      description: 'Enter your vault password to save the new key.',
                      error: message || undefined,
                    },
                    { secret: true },
                  );
                  if (password === BACK) {
                    back = true;
                    return '';
                  }
                  return password;
                },
              );
              if (back) break;
              if (unlocked !== 'ok')
                throw new Error('Vault remains locked. Unlock it to save your new endpoint key.');
            }
            const credentialRef = `onboard-${d.adapter}-${createHash('sha256').update(d.baseUrl!).digest('hex').slice(0, 20)}`;
            saveCredential(credentialRef, {
              apiKey: undefined,
              authToken: undefined,
              ...credentials(d),
              baseUrl: d.baseUrl,
              noAuth: d.key ? undefined : true,
            });
            persistTerminalOnboardTarget({
              adapter: d.adapter,
              model: d.model!,
              baseUrl: d.baseUrl,
              customEndpoint: d.preset.kind === 'custom',
              selfHosted: d.selfHosted,
              selectedModels: d.selected,
              entryGroup: d.preset.label,
              credentialRef,
              entryExtras: d.preset.entry
                ? { label: d.preset.label, ...d.preset.entry }
                : undefined,
            });
            finale = `Saved ${d.preset.label} · ${d.model}${d.test?.ok ? ' · connection verified' : ' · connection unverified'}.\nRun shadow to start. Use /model to switch between your selected models.`;
            return true;
          }
        }
      } catch (error) {
        if (error instanceof OnboardCancelled) throw error;
        const answer = await pick(
          {
            stage: step === 'review' || step === 'fileReview' ? 4 : 1,
            title: 'Setup needs attention',
            description: 'Your entries are kept. Fix the issue and retry.',
            error: safeError(error),
          },
          choices([
            ['retry', 'Retry this step'],
            ['endpoint', 'Return to connection setup'],
          ]),
        );
        if (answer === BACK || answer === 'endpoint')
          step = draft && mode !== 'file' ? 'endpoint' : 'mode';
      }
    }
  } catch (error) {
    if (!(error instanceof OnboardCancelled))
      finale = `Setup could not complete: ${safeError(error)}. Run shadow onboard to retry.`;
    return false;
  } finally {
    ui.close();
    stdout.write('\n' + finale + '\n');
  }
}
