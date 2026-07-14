import * as readline from 'node:readline/promises';
import { stdin, stdout } from 'node:process';
import { execSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { providersForMode, type ProviderPreset, type OnboardMode } from './catalog.js';
import { createProvider, type ProviderName } from '../provider/index.js';
import { saveCredential, saveGlobalConfig, loadGlobalConfig, GLOBAL_DIR } from '../state/globalStore.js';
import { addLocalModel, testLocalModel } from '../local/garage.js';
import { defaultModelPatch } from '../config/modelPresets.js';
import type { ModelEntry } from '../config.js';
import { looksAnthropicDistilled, toAnthropicBaseUrl } from '../util/transport.js';
import { normalizeBaseUrl } from '../config.js';
import type { Message } from '../provider/provider.js';

const ESC = '\x1b[';
const c = {
  bold: (s: string) => `${ESC}1m${s}${ESC}0m`,
  cyan: (s: string) => `${ESC}36m${s}${ESC}0m`,
  green: (s: string) => `${ESC}32m${s}${ESC}0m`,
  red: (s: string) => `${ESC}31m${s}${ESC}0m`,
  yellow: (s: string) => `${ESC}33m${s}${ESC}0m`,
  gray: (s: string) => `${ESC}90m${s}${ESC}0m`,
};

// ── Centered banner / box layout ─────────────────────────────────────────────
const SHADOW_ART = [
  '███████╗██╗  ██╗ █████╗ ██████╗  ██████╗ ██╗    ██╗',
  '██╔════╝██║  ██║██╔══██╗██╔══██╗██╔═══██╗██║    ██║',
  '███████╗███████║███████║██║  ██║██║   ██║██║ █╗ ██║',
  '╚════██║██╔══██║██╔══██║██║  ██║██║   ██║██║███╗██║',
  '███████║██║  ██║██║  ██║██████╔╝╚██████╔╝╚███╔███╔╝',
  '╚══════╝╚═╝  ╚═╝╚═╝  ╚═╝╚═════╝  ╚═════╝  ╚══╝╚══╝ ',
];

// Compatibility disclaimer.
const DISCLAIMER = [
  'For AGENTIC (tool-calling) models only — OpenAI- or',
  'Anthropic-compatible. A chat-only model will reply but will',
  'NOT call tools and is not intended to work in this CLI.',
  'Capability + format also vary by model; each performs best on',
  'the wire format it was trained for. You own the models you connect.',
];

const stripAnsi = (s: string): string => s.replace(/\x1b\[[0-9;]*m/g, '');
const visLen = (s: string): number => stripAnsi(s).length;
const cols = (): number => Math.max(40, Math.min(stdout.columns || 80, 100));

/** Left-pad a block of lines so it sits centered as a unit (internal alignment preserved). */
function centerBlock(lines: string[], width = cols()): string[] {
  const max = Math.max(...lines.map(visLen));
  const pad = ' '.repeat(Math.max(0, Math.floor((width - max) / 2)));
  return lines.map((l) => pad + l);
}

/** Wrap lines in a rounded border box sized to the widest line. */
function boxed(lines: string[]): string[] {
  const w = Math.max(...lines.map(visLen));
  return [
    '╭' + '─'.repeat(w + 2) + '╮',
    ...lines.map((l) => '│ ' + l + ' '.repeat(w - visLen(l)) + ' │'),
    '╰' + '─'.repeat(w + 2) + '╯',
  ];
}

function writeCentered(lines: string[]): void {
  for (const l of centerBlock(lines)) stdout.write(l + '\n');
}

// ── Context Cooler (optional, opt-in MCP server) ─────────────────────────────
const CC_REPO = 'Blackfrost-AI/context-cooler';
const CC_URL = 'https://github.com/Blackfrost-AI/context-cooler';

function sh(cmd: string, cwd?: string): void {
  execSync(cmd, { cwd, stdio: 'inherit', timeout: 300_000 });
}

/** Clone (or update) + build + register Context Cooler natively for Shadow. Its own
 *  installer writes the MCP entry into ~/.shadow/config.json via `--platform=shadow`. */
function installContextCooler(dir: string): void {
  if (existsSync(join(dir, '.git'))) {
    sh(`git -C "${dir}" pull --ff-only`);
  } else {
    try {
      sh(`gh repo clone ${CC_REPO} "${dir}"`); // gh carries the user's auth for the private repo
    } catch {
      sh(`git clone ${CC_URL}.git "${dir}"`);
    }
  }
  sh('npm install', dir);
  sh('python3 install.py --platform=shadow --non-interactive', dir);
}

const BACK = Symbol('back');
const QUIT = Symbol('quit');
type PromptResult = string | typeof BACK | typeof QUIT;
type SetupStep =
  | 'mode'
  | 'provider'
  | 'ggufPath'
  | 'customCompatibility'
  | 'customBaseUrl'
  | 'customSecret'
  | 'localBaseUrl'
  | 'localSecret'
  | 'cloudSecret'
  | 'model'
  | 'transport'
  | 'test'
  | 'contextCooler';

interface DraftSetup {
  preset?: ProviderPreset;
  adapter?: ProviderName;
  baseUrl?: string;
  apiKey?: string;
  authToken?: string;
  model?: string;
}

function controlAnswer(raw: string): typeof BACK | typeof QUIT | null {
  const value = raw.trim().toLowerCase();
  if (value === 'b' || value === 'back') return BACK;
  if (value === 'q' || value === 'quit' || value === 'exit') return QUIT;
  return null;
}

async function askText(rl: readline.Interface, query: string): Promise<PromptResult> {
  const raw = (await rl.question(query)).trim();
  return controlAnswer(raw) ?? raw;
}

async function askSecretStep(rl: readline.Interface, query: string): Promise<PromptResult> {
  const raw = await askSecret(rl, query);
  return controlAnswer(raw) ?? raw;
}

function backHint(): string {
  return c.gray('(back to previous, quit to exit)');
}

function previousCredentialStep(preset: ProviderPreset | undefined): SetupStep {
  if (!preset) return 'provider';
  if (preset.kind === 'custom') return 'customSecret';
  if (preset.kind === 'local') return 'localSecret';
  return 'cloudSecret';
}

/**
 * Optional onboarding step — offer Context Cooler (our token-saving MCP server) and,
 * on opt-in, install + register it so it loads automatically. Never bundled; the
 * user chooses. Failures are non-fatal — onboarding always completes.
 */
async function offerContextCooler(rl: readline.Interface): Promise<'done' | 'back' | 'quit'> {
  stdout.write('\n');
  writeCentered(
    boxed([
      c.bold('Save 70–90% on token burn — Context Cooler'),
      '',
      'An MCP server that runs sandboxed scripts against your data',
      'and a search index — the agent pulls back compact answers',
      'instead of re-reading raw files. Optional, not bundled.',
      '',
      c.gray(CC_URL),
    ]),
  );
  stdout.write('\n');
  const ans = await askText(rl, `  Install Context Cooler now? ${c.gray('[Y/n/back]')}: `);
  if (ans === BACK) return 'back';
  if (ans === QUIT) return 'quit';
  const choice = ans.toLowerCase();
  if (choice === 'n' || choice === 'no') {
    stdout.write(c.gray('\n  No worries — you know where to stay cool.\n'));
    stdout.write(c.gray(`  ${CC_URL}\n`));
    return 'done';
  }
  const dir = join(homedir(), '.shadow', 'context-cooler');
  stdout.write(c.gray('\n  Installing Context Cooler (clone + build + register, ~1 min)…\n\n'));
  try {
    installContextCooler(dir);
    stdout.write(
      c.green('\n  ✓ Context Cooler installed') +
        c.gray(` — registered as an MCP server in ${GLOBAL_DIR}/config.json.\n`) +
        c.gray('    It loads automatically when you start a session.\n'),
    );
  } catch (err) {
    stdout.write(
      c.red(`\n  ✗ Install failed: ${(err as Error).message.split('\n')[0]}\n`) +
        c.gray(`    No worries — install it later from ${CC_URL}\n`),
    );
  }
  return 'done';
}

/**
 * Guided provider setup. Picks a provider from the catalog, collects the key /
 * base URL / model, runs a live connection test, and persists to ~/.shadow so
 * future runs connect with no flags. Returns true if a provider was saved.
 */
export async function runOnboard(): Promise<boolean> {
  const rl = readline.createInterface({ input: stdin, output: stdout });
  try {
    let step: SetupStep = 'mode';
    let mode: OnboardMode = 'cloud';
    let savedGguf: ModelEntry | undefined; // set when the 'file' mode has already persisted a model
    let ggufTestFailed = false; // the inline test failed — the finale must not claim a working setup
    const draft: DraftSetup = {};

    // Quitting mid-wizard: if the ggufPath step already persisted + activated a model, that work
    // is durable — say so and report success. Only a truly empty run is "cancelled".
    const quitOutcome = (): boolean => {
      if (savedGguf) {
        stdout.write(c.gray(`Setup closed — local model "${savedGguf.label}" is saved and active. Run \`shadow\` to use it.\n`));
        return true;
      }
      stdout.write(c.gray('Setup cancelled — nothing saved.\n'));
      return false;
    };

    const showBanner = () => {
      stdout.write('\n');
      writeCentered(SHADOW_ART.map((l) => c.cyan(l)));
      stdout.write('\n');
      writeCentered(boxed(DISCLAIMER).map((l) => c.gray(l)));
      stdout.write('\n');
    };

    const showProviderMenu = (list: ProviderPreset[]) => {
      stdout.write('\n');
      writeCentered([c.bold('Connect a model provider')]);
      writeCentered([c.gray('No Shadow account — bring your own provider; keys stay local in ~/.shadow.')]);
      stdout.write('\n');
      const menu = list.map((p, i) => {
        const n = c.bold(String(i + 1).padStart(2));
        return p.comingSoon ? `${n}. ${c.gray(p.label)}` : `${n}. ${p.label}`;
      });
      writeCentered(menu);
      stdout.write('\n');
      stdout.write(c.gray('  Tip: type `back` or `b` at any prompt to go to the previous step.\n\n'));
    };

    while (true) {
      switch (step) {
        case 'mode': {
          // The positioning choice comes FIRST: local is a front door, not a submenu buried
          // under nine cloud vendors. Enter defaults to Cloud (the most common fresh-user key).
          showBanner();
          writeCentered([c.bold('How do you want to run Shadow?')]);
          stdout.write('\n');
          writeCentered([
            `${c.bold('1')}. Local file    ${c.gray('— a .gguf or MLX model on this machine (auto-served)')}`,
            `${c.bold('2')}. Local server  ${c.gray('— Ollama / LM Studio / llama.cpp already running')}`,
            `${c.bold('3')}. Cloud         ${c.gray('— Anthropic, OpenAI, Z.ai (GLM), OpenRouter, …')}`,
          ]);
          stdout.write('\n');
          const pick = await askText(rl, `Choose ${c.gray('[3]')} ${backHint()}: `);
          if (pick === QUIT) return quitOutcome();
          if (pick === BACK) {
            stdout.write(c.gray('Already at the first step.\n'));
            continue;
          }
          const choice = pick === '' ? '3' : pick;
          if (choice === '1') mode = 'file';
          else if (choice === '2') mode = 'server';
          else if (choice === '3') mode = 'cloud';
          else {
            stdout.write(c.red('Choose 1, 2, or 3.\n'));
            continue;
          }
          step = mode === 'file' ? 'ggufPath' : 'provider';
          break;
        }

        case 'ggufPath': {
          const ans = await askText(rl, `Model to run: .gguf path, MLX folder, or mlx-community/<model> id ${backHint()}: `);
          if (ans === QUIT) return quitOutcome(); // a previously saved model stays saved
          if (ans === BACK) {
            step = 'mode';
            break;
          }
          if (!ans) {
            stdout.write(c.red('Enter the path to a .gguf file.\n'));
            continue;
          }
          const models = (loadGlobalConfig().models as ModelEntry[] | undefined) ?? [];
          // Re-entry with an already-registered file (e.g. `back` from a later step) must not
          // dead-end on "already exists" — reuse the existing entry and move forward.
          const resolved = ans.startsWith('~/') || ans === '~' ? join(homedir(), ans.slice(1)) : ans;
          const abs = resolve(resolved);
          const existing = models.find(
            (m) =>
              (m.gguf && (m.gguf === abs || m.gguf.endsWith(`/${resolved.split('/').pop() ?? resolved}`))) ||
              (m.mlx && (m.mlx === abs || m.mlx === resolved || m.mlx === ans)),
          );
          let entry: ModelEntry;
          if (existing) {
            saveGlobalConfig(defaultModelPatch(existing));
            entry = existing;
            stdout.write(c.gray(`\n"${existing.label}" is already registered — made it the active model.\n`));
          } else {
            const res = addLocalModel(models, { path: ans });
            if (!res.ok) {
              stdout.write(c.red(`${res.message}\n`));
              continue;
            }
            entry = res.value.entry;
            // Persist the preset AND make it the active model (same patch `shadow local use` writes).
            saveGlobalConfig({ models: res.value.models, ...defaultModelPatch(entry) });
            stdout.write(c.green(`\n✓ Added local model "${entry.label}"`) + c.gray(entry.mlx ? ' (MLX, auto-served on demand)\n' : ` (ctx ${entry.ctx}, auto-served on demand)\n`));
            if (res.note) stdout.write(c.yellow(`  ⚠ ${res.note}\n`));
          }
          savedGguf = entry;
          ggufTestFailed = false;

          const t = await askText(rl, `Test it now? Loads the model — can take a minute. ${c.gray('[Y/n/back]')}: `);
          if (t === QUIT) return quitOutcome(); // model is already saved; quitting here loses nothing
          if (t === BACK) {
            step = 'mode';
            break;
          }
          if (t === '' || t.toLowerCase() === 'y' || t.toLowerCase() === 'yes') {
            stdout.write(c.gray('\nStarting llama-server and running a tiny completion…\n'));
            const result = await testLocalModel(entry, (m) => stdout.write(c.gray(`  ${m}\n`)));
            if (result.ok) {
              stdout.write(c.green(`✓ PASS`) + c.gray(` — ${result.endpoint}${result.tokensPerSec ? ` · ${result.tokensPerSec.toFixed(1)} tok/s` : ''}\n`));
            } else {
              ggufTestFailed = true;
              stdout.write(c.red(`✗ test failed: ${result.error}\n`));
              stdout.write(c.gray(`  The model is saved — fix the issue above, then verify with: shadow local test ${entry.label}\n`));
            }
          }
          step = 'contextCooler';
          break;
        }

        case 'provider': {
          const list = providersForMode(mode);
          showProviderMenu(list);
          const firstReal = Math.max(0, list.findIndex((p) => !p.comingSoon));
          const pick = await askText(rl, `Choose a provider ${c.gray(`[${firstReal + 1}]`)} ${backHint()}: `);
          if (pick === QUIT) return quitOutcome();
          if (pick === BACK) {
            step = 'mode';
            break;
          }
          const idx = pick === '' ? firstReal : parseInt(pick, 10) - 1;
          const preset = list[idx];
          if (!preset) {
            stdout.write(c.red('Invalid choice. Choose a number from the menu.\n'));
            continue;
          }
          if (preset.comingSoon) {
            stdout.write(c.yellow(`\n${preset.label.replace(/\s*\(coming soon\)/i, '')} isn't available yet — coming soon.\n`));
            stdout.write(c.gray('Pick another provider for now.\n'));
            continue;
          }
          draft.preset = preset;
          draft.adapter = preset.adapter;
          draft.baseUrl = preset.baseUrl;
          draft.apiKey = undefined;
          draft.authToken = undefined;
          draft.model = undefined;
          step = preset.kind === 'custom' ? 'customCompatibility' : preset.kind === 'local' ? 'localBaseUrl' : 'cloudSecret';
          break;
        }

        case 'customCompatibility': {
          const comp = await askText(rl, `API compatibility ${c.gray('(openai/anthropic) [openai]')} ${backHint()}: `);
          if (comp === QUIT) return false;
          if (comp === BACK) {
            step = 'provider';
            break;
          }
          const value = comp.toLowerCase();
          if (value && value !== 'openai' && value !== 'anthropic') {
            stdout.write(c.red('Choose openai or anthropic.\n'));
            break;
          }
          draft.adapter = value === 'anthropic' ? 'anthropic' : 'openai';
          step = 'customBaseUrl';
          break;
        }

        case 'customBaseUrl': {
          const baseUrl = await askText(rl, `Base URL ${backHint()}: `);
          if (baseUrl === QUIT) return false;
          if (baseUrl === BACK) {
            step = 'customCompatibility';
            break;
          }
          if (!baseUrl) {
            stdout.write(c.red('Base URL is required.\n'));
            break;
          }
          draft.baseUrl = baseUrl;
          step = 'customSecret';
          break;
        }

        case 'customSecret': {
          const key = await askSecretStep(rl, `API key/token ${c.gray('(Enter to skip)')} ${backHint()}: `);
          if (key === QUIT) return false;
          if (key === BACK) {
            step = 'customBaseUrl';
            break;
          }
          draft.apiKey = undefined;
          draft.authToken = undefined;
          if (key) {
            if (draft.adapter === 'anthropic') draft.authToken = key;
            else draft.apiKey = key;
          }
          step = 'model';
          break;
        }

        case 'localBaseUrl': {
          const preset = draft.preset!;
          const baseUrl = await askText(rl, `Base URL ${c.gray(`(Enter to use ${preset.baseUrl})`)} ${backHint()}: `);
          if (baseUrl === QUIT) return false;
          if (baseUrl === BACK) {
            step = 'provider';
            break;
          }
          // Sanitize: strips a pasted [bracket]/quote hint + validates; empty/garbage → the preset.
          draft.baseUrl = normalizeBaseUrl(baseUrl) ?? preset.baseUrl;
          step = 'localSecret';
          break;
        }

        case 'localSecret': {
          const preset = draft.preset!;
          const key = await askSecretStep(rl, `API key/token ${c.gray('(Enter to skip for local)')} ${backHint()}: `);
          if (key === QUIT) return false;
          if (key === BACK) {
            step = 'localBaseUrl';
            break;
          }
          draft.apiKey = undefined;
          draft.authToken = undefined;
          if (key) {
            if (preset.bearer || draft.adapter === 'anthropic') draft.authToken = key;
            else draft.apiKey = key;
          } else if (preset.bearer) {
            draft.authToken = 'ollama';
          }
          step = 'model';
          break;
        }

        case 'cloudSecret': {
          const preset = draft.preset!;
          if (preset.keyUrl) stdout.write(c.gray(`  Get a key: ${preset.keyUrl}\n`));
          const key = await askSecretStep(rl, `API key ${backHint()}: `);
          if (key === QUIT) return false;
          if (key === BACK) {
            step = 'provider';
            break;
          }
          if (!key) {
            stdout.write(c.red('An API key is required for this provider.\n'));
            break;
          }
          draft.apiKey = key;
          draft.authToken = undefined;
          step = 'model';
          break;
        }

        case 'model': {
          const preset = draft.preset!;
          const def = preset.defaultModel;
          const mAns = await askText(rl, `Model${def ? ` ${c.gray(`[${def}]`)}` : ''} ${backHint()}: `);
          if (mAns === QUIT) return false;
          if (mAns === BACK) {
            step = previousCredentialStep(preset);
            break;
          }
          const model = mAns || def;
          if (!model) {
            stdout.write(c.red('A model id is required.\n'));
            break;
          }
          draft.model = model;
          step = 'transport';
          break;
        }

        case 'transport': {
          if (draft.adapter === 'openai' && draft.model && looksAnthropicDistilled(draft.model)) {
            stdout.write(
              `\n${c.yellow('⚠ "' + draft.model + '" looks distilled on Claude/Anthropic.')}\n` +
                c.gray('  On the OpenAI transport such models often emit unparseable tool calls.\n') +
                c.gray('  The Anthropic transport (e.g. Ollama /v1/messages) usually works far better.\n'),
            );
            const sw = await askText(rl, `Use the Anthropic transport instead? ${c.gray('[Y/n/back]')}: `);
            if (sw === QUIT) return false;
            if (sw === BACK) {
              step = 'model';
              break;
            }
            const choice = sw.toLowerCase();
            if (choice === '' || choice === 'y' || choice === 'yes') {
              draft.adapter = 'anthropic';
              if (draft.baseUrl) draft.baseUrl = toAnthropicBaseUrl(draft.baseUrl);
              if (draft.apiKey) {
                draft.authToken = draft.apiKey;
                draft.apiKey = undefined;
              } else if (!draft.authToken) {
                draft.authToken = 'ollama';
              }
              stdout.write(c.gray(`  → switched to anthropic transport${draft.baseUrl ? ` (${draft.baseUrl})` : ''}\n`));
            }
          }
          step = 'test';
          break;
        }

        case 'test': {
          if (!draft.adapter || !draft.model || !draft.preset) {
            step = 'provider';
            break;
          }
          stdout.write(c.gray('\nTesting connection…\n'));
          const test = await testConnection({
            adapter: draft.adapter,
            model: draft.model,
            apiKey: draft.apiKey,
            authToken: draft.authToken,
            baseUrl: draft.baseUrl,
          });
          if (test.ok) {
            stdout.write(c.green('✓ connected\n'));
            step = 'contextCooler';
            break;
          }
          stdout.write(c.red(`✗ connection test failed: ${test.error}\n`));
          const cont = await askText(rl, `Save anyway? ${c.gray('[y/N/back]')}: `);
          if (cont === QUIT) return false;
          if (cont === BACK) {
            step = 'model';
            break;
          }
          const choice = cont.toLowerCase();
          if (choice === 'y' || choice === 'yes') {
            step = 'contextCooler';
          } else {
            stdout.write(c.gray('Nothing saved yet — returning to model setup.\n'));
            step = 'model';
          }
          break;
        }

        case 'contextCooler': {
          const result = await offerContextCooler(rl);
          // A COMPLETED cloud/server draft always takes precedence over an earlier gguf save:
          // the user who backed out of file mode and finished a cloud setup typed a key and
          // watched it test green — discarding that (the old savedGguf-first order) silently
          // dropped their credentials and misreported what was saved.
          const draftComplete = Boolean(draft.preset && draft.adapter && draft.model);
          if (result === 'quit') return savedGguf !== undefined; // durable gguf work survives a quit
          if (result === 'back') {
            step = draftComplete ? 'model' : savedGguf ? 'ggufPath' : 'model';
            break;
          }
          // Local-file mode (no completed draft): the model + activation were already saved.
          if (savedGguf && !draftComplete) {
            const finale = ggufTestFailed
              ? `\n${c.yellow('⚠ Saved, but the test FAILED')} — ${c.bold(savedGguf.label)} ${c.gray('·')} ${c.bold('local .gguf')}\n` +
                c.gray(`  file: ${savedGguf.gguf}\n  config: ${GLOBAL_DIR}/config.json\n`) +
                `\nFix the issue above, then verify with ${c.bold(`shadow local test ${savedGguf.label}`)} before starting a session.\n`
              : `\n${c.green('✓ Saved')} — ${c.bold(savedGguf.label)} ${c.gray('·')} ${c.bold('local .gguf')}\n` +
                c.gray(`  file: ${savedGguf.gguf}\n  config: ${GLOBAL_DIR}/config.json\n`) +
                `\nRun ${c.bold('shadow')} to start — the server launches automatically. ${c.gray('(manage local models with `shadow local`)')}\n`;
            stdout.write(finale);
            return true;
          }
          const { preset, adapter, model, baseUrl, apiKey, authToken } = draft;
          if (!preset || !adapter || !model) {
            step = 'provider';
            break;
          }
          // Clear lastModel so this fresh pick actually becomes active — otherwise a previously
          // `/model`-selected preset overrides the newly-onboarded provider at launch.
          saveGlobalConfig({ provider: adapter, model, lastModel: undefined, ...(baseUrl ? { baseUrl } : {}) });
          if (apiKey) saveCredential(adapter, { apiKey, ...(baseUrl ? { baseUrl } : {}) });
          if (authToken) saveCredential(adapter, { authToken, ...(baseUrl ? { baseUrl } : {}) });

          stdout.write(
            `\n${c.green('✓ Saved')} — ${c.bold(preset.label)} ${c.gray('·')} ${c.bold(model)}\n` +
              c.gray(
                `  config: ${GLOBAL_DIR}/config.json · credentials: ${GLOBAL_DIR}/credentials.json (chmod 600)\n`,
              ) +
              `\nRun ${c.bold('shadow')} to start. ${c.gray('(re-run `shadow onboard` to change providers)')}\n`,
          );
          return true;
        }
      }
    }
  } finally {
    rl.close();
  }
}

async function testConnection(o: {
  adapter: ProviderName;
  model: string;
  apiKey?: string;
  authToken?: string;
  baseUrl?: string;
}): Promise<{ ok: boolean; error?: string }> {
  let provider;
  try {
    provider = createProvider({
      provider: o.adapter,
      model: o.model,
      apiKey: o.apiKey,
      authToken: o.authToken,
      baseUrl: o.baseUrl,
    });
  } catch (e) {
    return { ok: false, error: (e as Error).message };
  }

  const messages: Message[] = [
    { role: 'user', content: [{ type: 'text', text: 'Reply with: ok' }] },
  ];
  const probe = (async (): Promise<{ ok: boolean; error?: string }> => {
    try {
      for await (const ev of provider.send({
        model: o.model,
        system: '',
        messages,
        tools: [],
        maxOutputTokens: 16,
      })) {
        // ANY error fails the test — recoverable ones (network down, a persistent
        // 429, a typo'd base URL that 5xx's) are exactly the broken-config cases the
        // live test exists to catch, so they must not be saved as "✓ connected".
        if (ev.type === 'error') return { ok: false, error: `${ev.code}: ${ev.message}` };
        if (
          ev.type === 'usage' ||
          ev.type === 'text' ||
          ev.type === 'done' ||
          ev.type === 'tool_call'
        ) {
          return { ok: true };
        }
      }
      return { ok: false, error: 'no response from provider' };
    } catch (e) {
      return { ok: false, error: (e as Error).message };
    }
  })();
  const timeout = new Promise<{ ok: boolean; error?: string }>((res) =>
    setTimeout(() => res({ ok: false, error: 'timed out after 30s' }), 30_000),
  );
  return Promise.race([probe, timeout]);
}

/** Prompt that masks typed input with `*` (falls back to plain echo if unsupported). */
async function askSecret(rl: readline.Interface, query: string): Promise<string> {
  const iface = rl as unknown as { _writeToOutput?: (s: string) => void };
  const orig = iface._writeToOutput?.bind(rl);
  if (orig) {
    iface._writeToOutput = (s: string) => {
      if (s.includes(query)) orig(s);
      else orig(s.replace(/[^\r\n]/g, '*'));
    };
  }
  try {
    return (await rl.question(query)).trim();
  } finally {
    if (orig) iface._writeToOutput = orig;
    stdout.write('\n');
  }
}
