import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { isolateHome, assertStoreIsolated } from './helpers/isolateHome.js';
import type { ModelEntry } from '../src/config.js';
import type { SwitchHost } from '../src/app/modelSwitch.js';
import type { SlashCtx } from '../src/tui/slash.js';
import type { CompletionRequest, ProviderEvent } from '../src/provider/provider.js';

const { home } = isolateHome('account-connections');
const store = await import('../src/state/globalStore.js');
assertStoreIsolated(store.GLOBAL_DIR, home);
const { AccountConnectionSchema, ModelEntrySchema, loadConfig, resolveEntryCredential, resolveBaseUrl } = await import('../src/config.js');
const { createProvider, entryStreamContract } = await import('../src/provider/index.js');
const { ChatGPTProvider } = await import('../src/provider/chatgpt.js');
const { ClaudeCodeProvider } = await import('../src/provider/claudeCode.js');
const { OpenAIProvider } = await import('../src/provider/openai.js');
const { AnthropicProvider } = await import('../src/provider/anthropic.js');
const { defaultModelPatch, resolveActiveModelPreset } = await import('../src/config/modelPresets.js');
const { onboardTargetPatch, persistOnboardTarget } = await import('../src/onboard/persistTarget.js');
const { persistAccountModel } = await import('../src/onboard/accounts.js');
const { ModelSwitcher } = await import('../src/app/modelSwitch.js');
const { ModelProfileResolver } = await import('../src/agent/modelProfiles.js');
const { Context } = await import('../src/agent/context.js');
const { createAgentSession } = await import('../src/agent/bootstrap.js');
const { providerDiagnostic } = await import('../src/doctor/provider.js');
const { INSTALL_DIR } = await import('../src/installDir.js');
const { runSlashCommand } = await import('../src/tui/slash.js');

const envKeys = ['SHADOW_PROVIDER', 'SHADOW_MODEL', 'SHADOW_BASE_URL', 'SHADOW_PROFILE', 'SHADOW_ALLOW_IMPORT', 'SHADOW_WIRE_API', 'OPENAI_API_KEY', 'OPENAI_BASE_URL', 'ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN', 'ANTHROPIC_BASE_URL'];
const savedEnv = Object.fromEntries(envKeys.map((key) => [key, process.env[key]]));
test.beforeEach(() => {
  rmSync(store.configPath(), { force: true });
  rmSync(store.credentialsPath(), { force: true });
  for (const key of envKeys) delete process.env[key];
});
test.after(() => {
  for (const key of envKeys) {
    if (savedEnv[key] === undefined) delete process.env[key];
    else process.env[key] = savedEnv[key];
  }
  rmSync(home, { recursive: true, force: true });
});

const chatEntry = (): ModelEntry => ({ label: 'Personal ChatGPT', provider: 'openai', model: 'gpt-fixture', connection: { kind: 'chatgpt', profileId: 'fixture-personal' } });
const claudeEntry = (): ModelEntry => ({ label: 'Claude subscription', provider: 'anthropic', model: 'sonnet', connection: { kind: 'claude-code' } });

function fixtureHost(): SwitchHost {
  const cfg = loadConfig(home, { provider: 'mock', model: 'lead' });
  const context = new Context({ contextBudget: cfg.contextBudget, triggerRatio: cfg.summarizeTriggerRatio, keepLastTurns: cfg.keepLastTurns });
  return { cfg, context, baseContextPolicy: context.policy(), provider: createProvider({ provider: 'mock', model: 'lead' }),
    current: { provider: 'mock', model: 'lead' }, loop: null, isRunning: () => false, pushLine: () => {} };
}

function slashFixture(cfg: SwitchHost['cfg'], baseUrl?: string) {
  const output: string[] = [];
  let flushed!: () => void;
  const done = new Promise<void>((resolve) => { flushed = resolve; });
  const ctx: Partial<SlashCtx> = {
    opts: { cfg } as SlashCtx['opts'], setLine: () => {}, setMenuIndex: () => {},
    currentRef: { current: { provider: cfg.provider, model: cfg.model } },
    providerRef: { current: createProvider({ provider: 'mock', model: 'fixture-lead' }) },
    activeTargetRef: { current: { baseUrl, selfHosted: false } }, asyncCommandRef: { current: false },
    flushQueueRef: { current: () => flushed() },
    pushLine: (line) => output.push([line.text, ...(line.lines ?? []).map((row) => row.text)].join('\n')),
  };
  return { output, done, ctx, run: (line: string) => runSlashCommand(ctx as SlashCtx, { name: line.split(' ')[0]!, desc: 'fixture' }, line) };
}

test('account connections have explicit serializable profile identities and reject unknown kinds', () => {
  for (const entry of [chatEntry(), claudeEntry()]) assert.deepEqual(ModelEntrySchema.parse(entry).connection, entry.connection);
  for (const value of [{ kind: 'chatgpt' }, { kind: 'chatgpt', profileId: '' }, { kind: 'api-key' }, { kind: 'codex-token-import' }]) {
    assert.equal(AccountConnectionSchema.safeParse(value).success, false);
  }
  store.saveGlobalConfig(defaultModelPatch(chatEntry()));
  assert.deepEqual(loadConfig(home).connection, chatEntry().connection);
});

test('explicit accounts exclude inline, vault, provider and environment credentials and endpoints', () => {
  process.env.OPENAI_API_KEY = 'fixture-environment-key';
  process.env.ANTHROPIC_API_KEY = 'fixture-environment-anthropic';
  process.env.ANTHROPIC_AUTH_TOKEN = 'fixture-environment-token';
  process.env.OPENAI_BASE_URL = 'https://environment.example.test/v1';
  process.env.ANTHROPIC_BASE_URL = 'https://environment.example.test';
  store.saveCredential('openai', { apiKey: 'fixture-store-key', baseUrl: 'https://stored.example.test/v1' });
  for (const entry of [chatEntry(), claudeEntry()]) {
    assert.deepEqual(resolveEntryCredential({ ...entry, apiKey: 'fixture-inline', authToken: 'fixture-inline-token', credRef: 'missing-slot' }, { vaultIsLocked: true }), { ok: true, source: 'connection' });
  }
  assert.equal(resolveBaseUrl('openai', 'https://configured.example.test/v1', chatEntry().connection), 'https://api.openai.com/v1');
  assert.equal(resolveBaseUrl('anthropic', 'https://configured.example.test', claudeEntry().connection), undefined);
  const apiCredential = resolveEntryCredential({ provider: 'openai' });
  assert.equal(apiCredential.ok, true);
  assert.equal(apiCredential.source, 'provider', 'ordinary API resolution remains available');
});

test('factory selects subscription transports before API wire or API credentials and disallows endpoint mismatches', () => {
  process.env.SHADOW_WIRE_API = 'chat';
  const chat = createProvider({ ...chatEntry(), apiKey: 'fixture-key', authToken: 'fixture-token', wire: 'chat' });
  const claude = createProvider({ ...claudeEntry(), apiKey: 'fixture-key', authToken: 'fixture-token' });
  assert.ok(chat instanceof ChatGPTProvider);
  assert.ok(claude instanceof ClaudeCodeProvider);
  assert.equal(chat.allowAutomaticFallback, false);
  assert.equal(claude.allowAutomaticFallback, false);
  assert.throws(() => createProvider({ ...chatEntry(), baseUrl: 'https://proxy.example.test/v1' }), /official OpenAI endpoint/);
  assert.throws(() => createProvider({ ...claudeEntry(), baseUrl: 'https://proxy.example.test' }), /does not match/);
  assert.throws(() => createProvider({ ...chatEntry(), provider: 'anthropic' }), /does not match/);
  assert.ok(createProvider({ provider: 'openai', model: 'api-fixture', apiKey: 'fixture-key' }) instanceof OpenAIProvider);
  assert.ok(createProvider({ provider: 'anthropic', model: 'api-fixture', apiKey: 'fixture-key' }) instanceof AnthropicProvider);
});

test('model switches and role resolution preserve subscription identity without credential import or network work', async (t) => {
  process.env.SHADOW_ALLOW_IMPORT = '1';
  process.env.OPENAI_BASE_URL = 'https://environment.example.test/v1';
  process.env.ANTHROPIC_BASE_URL = 'https://environment.example.test';
  process.env.OPENAI_API_KEY = 'fixture-environment-key';
  const fetch = t.mock.method(globalThis, 'fetch', async () => { throw new Error('unexpected network request while selecting an account'); });
  const host = fixtureHost();
  const entries = [chatEntry(), claudeEntry()];
  host.cfg.models = entries;
  const switcher = new ModelSwitcher(host);
  for (const entry of entries) {
    assert.deepEqual(entryStreamContract(entry).connection, entry.connection);
    assert.equal(await switcher.selectModel(entry), true);
    assert.deepEqual(host.cfg.connection, entry.connection);
    assert.equal(host.provider.allowAutomaticFallback, false);
    assert.equal(host.provider instanceof ChatGPTProvider, entry.connection!.kind === 'chatgpt');
    assert.equal(host.provider instanceof ClaudeCodeProvider, entry.connection!.kind === 'claude-code');
    assert.equal(host.cfg.lastModel, entry.label);
    const before = JSON.stringify(host.cfg);
    const profiles = new ModelProfileResolver({ cfg: host.cfg, current: () => ({ provider: host.provider, model: host.current.model }) });
    const role = await profiles.resolve(entry.label);
    assert.equal(role.client instanceof ChatGPTProvider, entry.connection!.kind === 'chatgpt');
    assert.equal(role.client instanceof ClaudeCodeProvider, entry.connection!.kind === 'claude-code');
    assert.equal(role.client.allowAutomaticFallback, false);
    assert.equal(JSON.stringify(host.cfg), before, 'role resolution leaves the lead configuration unchanged');
  }
  assert.equal(await switcher.selectModel({ label: 'Explicit API selection', provider: 'openai', model: 'fixture-api', apiKey: 'fixture-api-key' }), true);
  assert.equal(host.cfg.connection, undefined, 'an explicit API selection clears the previous subscription connection');
  assert.ok(host.provider instanceof OpenAIProvider);
  assert.equal(fetch.mock.callCount(), 0);
});

test('named runtime profiles carry saved account connections and clear them for API presets', () => {
  const account = chatEntry();
  const api: ModelEntry = { label: 'API preset', provider: 'anthropic', model: 'claude-api-fixture' };
  store.saveGlobalConfig({ ...defaultModelPatch(account), models: [account, claudeEntry(), api], profiles: {
    personal: { model: account.label }, claude: { model: claudeEntry().label }, api: { model: api.label },
  } });
  assert.deepEqual(loadConfig(home, {}, 'personal').connection, account.connection);
  assert.deepEqual(loadConfig(home, {}, 'claude').connection, claudeEntry().connection);
  const cfg = loadConfig(home, {}, 'api');
  assert.equal(cfg.connection, undefined);
  assert.equal(cfg.provider, 'anthropic');
  assert.equal(cfg.model, api.model);
});

test('startup keeps the exact account when an API preset and another account expose the same model', async (t) => {
  const api: ModelEntry = { label: 'Paid API', provider: 'openai', model: 'gpt-fixture', apiKey: 'fixture-paid-key' };
  const personal = chatEntry();
  const work: ModelEntry = { ...personal, label: 'Work ChatGPT', connection: { kind: 'chatgpt', profileId: 'fixture-work' } };
  store.saveGlobalConfig({ ...defaultModelPatch(api), models: [api, personal, work], profiles: { work: { model: work.label } } });
  const cfg = loadConfig(home, {}, 'work');
  const fetch = t.mock.method(globalThis, 'fetch', async () => { throw new Error('startup must not send an account request'); });
  assert.match(providerDiagnostic(cfg).detail, /ChatGPT account/);
  assert.equal(resolveActiveModelPreset(cfg)?.label, work.label);
  const session = await createAgentSession({ cfg, flags: {}, cwd: home, workspaceRoot: home, additionalRoots: [], installDir: INSTALL_DIR,
    activeStyle: cfg.style, unrestricted: false, write: () => {}, fail: (message) => { throw new Error(message); }, launchLocalServer: async () => null });
  try {
    assert.ok(session.provider instanceof ChatGPTProvider);
    assert.equal(session.provider.allowAutomaticFallback, false);
    assert.deepEqual(session.activeModelEntry?.connection, work.connection);
    assert.equal(session.startBaseUrl, 'https://api.openai.com/v1');
    await assert.rejects(session.activateModel({ ...work, autoModel: true, baseUrl: 'https://fixture.example.test' }), /automatic endpoint discovery/);
    assert.equal(fetch.mock.callCount(), 0);
  } finally { session.bg.killAll(); session.wakeup.clear(); session.sessionLog.close(); }
});

test('interactive switches and role builders reject mixed account/local presets before any probe or state change', async (t) => {
  const host = fixtureHost();
  const provider = host.provider;
  const before = JSON.stringify(host.cfg);
  const fetch = t.mock.method(globalThis, 'fetch', async () => { throw new Error('mixed account preset must not probe an endpoint'); });
  const switcher = new ModelSwitcher(host);
  for (const extras of [{ autoModel: true, baseUrl: 'https://fixture.example.test/v1' }, { gguf: '/fixture/model.gguf' }, { mlx: 'fixture/model' }, { vllm: 'fixture/model' }]) {
    const entry = { ...chatEntry(), ...extras };
    const built = await switcher.buildProvider(entry);
    assert.equal(built.ok, false);
    assert.match(built.error, /local model launchers or automatic endpoint discovery/);
    assert.equal(await switcher.selectModel(entry), false);
    assert.equal(host.provider, provider);
    assert.equal(JSON.stringify(host.cfg), before);
  }
  const invalid = { ...chatEntry(), provider: 'anthropic' as const };
  const built = await switcher.buildProvider(invalid);
  assert.equal(built.ok, false);
  assert.match(built.error, /does not match this provider/);
  host.cfg.models = [{ ...chatEntry(), autoModel: true }];
  const profiles = new ModelProfileResolver({ cfg: host.cfg, current: () => ({ provider: host.provider, model: host.current.model }) });
  await assert.rejects(profiles.resolve(chatEntry().label), /automatic endpoint discovery/);
  assert.equal(fetch.mock.callCount(), 0);
});

test('active selectors distinguish API and account defaults, remembered labels and changed-model overrides', () => {
  const personal = chatEntry();
  const work: ModelEntry = { ...personal, label: 'Work', connection: { kind: 'chatgpt', profileId: 'fixture-work' } };
  const api: ModelEntry = { label: 'Paid API', provider: 'openai', model: personal.model };
  const cfg = loadConfig(home, { ...defaultModelPatch(personal), models: [work, personal, api] });
  assert.equal(resolveActiveModelPreset(cfg)?.label, personal.label);
  assert.equal(resolveActiveModelPreset({ ...cfg, connection: undefined })?.label, api.label);
  assert.equal(resolveActiveModelPreset({
    ...cfg,
    lastModel: work.label,
    trustedGlobalModelPresets: [work, personal, api],
  }, { recallLast: true })?.label, work.label);
  assert.deepEqual(resolveActiveModelPreset({ ...cfg, model: 'new-account-model' })?.connection, personal.connection);
  assert.equal(resolveActiveModelPreset({ ...cfg, model: 'new-account-model' })?.model, 'new-account-model');
  assert.throws(() => resolveActiveModelPreset({ ...cfg, connection: undefined, models: [personal, work] }), /multiple accounts/);
  assert.throws(() => resolveActiveModelPreset({ ...cfg, provider: 'anthropic' }), /does not match this provider/);
  assert.throws(() => resolveActiveModelPreset(cfg, { lastPicked: { ...personal, autoModel: true, baseUrl: 'https://fixture.example.test' } }), /automatic endpoint discovery/);
  assert.equal(providerDiagnostic({ ...cfg, provider: 'anthropic', lastModel: undefined }).ok, false);
});

test('explicit provider and endpoint overrides cannot turn subscription startup into API billing', async () => {
  const cfg = loadConfig(home, { ...defaultModelPatch(chatEntry()), models: [chatEntry()] });
  const base = { cfg, cwd: home, workspaceRoot: home, additionalRoots: [], installDir: INSTALL_DIR,
    activeStyle: cfg.style, unrestricted: false, write: () => {}, fail: (message: string): never => { throw new Error(message); }, launchLocalServer: async () => null };
  await assert.rejects(createAgentSession({ ...base, cfg: { ...cfg, provider: 'anthropic' }, flags: { provider: 'anthropic' } }), /does not match this provider/);
  await assert.rejects(createAgentSession({ ...base, flags: { baseUrl: 'https://override.example.test/v1' } }), /cannot use --base-url/);
});

test('untrusted project files cannot select account connections at either config depth', () => {
  const project = join(home, 'untrusted-project');
  mkdirSync(project, { recursive: true });
  const trusted = chatEntry();
  store.saveGlobalConfig({ ...defaultModelPatch(trusted), models: [trusted] });
  writeFileSync(join(project, 'shadow.config.json'), JSON.stringify({ connection: { kind: 'claude-code' }, models: [
    { ...chatEntry(), label: 'Project suggestion', connection: { kind: 'chatgpt', profileId: 'untrusted-account' } },
    claudeEntry(),
  ] }));
  const cfg = loadConfig(project);
  assert.deepEqual(cfg.connection, trusted.connection, 'trusted user selection survives stripped project override');
  assert.equal(cfg.models.length, 2);
  assert.ok(cfg.models.every((entry) => entry.connection === undefined));
  assert.equal(cfg.models[0]!.label, 'Project suggestion', 'benign model suggestions still load');
});

test('API default selection and API onboarding clear active account identity while preserving saved accounts', () => {
  const account = persistAccountModel(chatEntry().connection!, 'gpt-fixture', 'Personal');
  const api: ModelEntry = { label: 'API fixture', provider: 'openai', model: 'gpt-fixture' };
  assert.ok(Object.hasOwn(defaultModelPatch(api), 'connection'));
  store.saveGlobalConfig(defaultModelPatch(api));
  assert.equal(loadConfig(home).connection, undefined);
  store.saveGlobalConfig(defaultModelPatch(account));
  const input = { provider: 'openai' as const, model: 'gpt-fixture', selectedModels: ['gpt-fixture'], customEndpoint: false, credentialRef: 'fixture-api-slot' };
  assert.ok(Object.hasOwn(onboardTargetPatch(input), 'connection'));
  persistOnboardTarget(input);
  const cfg = loadConfig(home);
  assert.equal(cfg.connection, undefined);
  assert.deepEqual(cfg.models.find((entry) => entry.label === account.label), account);
  const active = cfg.models.find((entry) => entry.label === cfg.lastModel)!;
  assert.equal(active.connection, undefined);
  assert.equal(active.credRef, 'fixture-api-slot');
});

test('account persistence distinguishes identical models on different accounts and keeps API presets intact', () => {
  const model = 'same-model';
  const api: ModelEntry = { label: `Shared · ${model}`, provider: 'openai', model, credRef: 'fixture-api', onboarded: true };
  store.saveGlobalConfig({ models: [api], baseUrl: 'https://previous.example.test/v1', selfHosted: true });
  const one = persistAccountModel({ kind: 'chatgpt', profileId: 'account-one' }, model, 'Shared');
  const two = persistAccountModel({ kind: 'chatgpt', profileId: 'account-two' }, model, 'Shared');
  const repeated = persistAccountModel({ kind: 'chatgpt', profileId: 'account-one' }, model, 'Renamed display');
  const cfg = loadConfig(home);
  assert.equal(cfg.models.length, 3);
  assert.equal(new Set(cfg.models.map((entry) => entry.label)).size, 3);
  assert.deepEqual(cfg.models.find((entry) => entry.label === api.label), api);
  assert.deepEqual(cfg.models.find((entry) => entry.label === two.label), two);
  assert.equal(repeated.label, one.label, 'reauthorizing one account retains its selectable identity');
  assert.deepEqual(cfg.connection, { kind: 'chatgpt', profileId: 'account-one' });
  assert.equal(cfg.baseUrl, undefined);
  assert.equal(cfg.selfHosted, undefined);
  assert.ok(cfg.models.filter((entry) => entry.connection).every((entry) => !entry.apiKey && !entry.authToken && !entry.credRef));
});

test('slash model tests use native account providers despite endpoint env overrides without changing the active session', async (t) => {
  process.env.OPENAI_BASE_URL = 'https://api-override.example.test/v1';
  process.env.ANTHROPIC_BASE_URL = 'https://anthropic-override.example.test';
  process.env.OPENAI_API_KEY = 'fixture-environment-key';
  const requested: string[] = [];
  const response = async function* (req: CompletionRequest): AsyncIterable<ProviderEvent> {
    requested.push(req.model);
    yield { type: 'text', delta: 'fixture response' };
    yield { type: 'done', stopReason: 'end_turn' };
  };
  t.mock.method(ChatGPTProvider.prototype, 'send', response);
  t.mock.method(ClaudeCodeProvider.prototype, 'send', response);
  const fetch = t.mock.method(globalThis, 'fetch', async () => { throw new Error('fixture probes must not contact a live account'); });
  for (const entry of [chatEntry(), claudeEntry()]) {
    const cfg = loadConfig(home, { provider: 'mock', model: 'lead', models: [entry] });
    const before = JSON.stringify(cfg);
    const fixture = slashFixture(cfg);
    fixture.run(`/model test "${entry.label}"`);
    await fixture.done;
    assert.match(fixture.output.join('\n'), /Verdict:/);
    assert.doesNotMatch(fixture.output.join('\n'), /Model test failed|does not match|Remove the custom base URL/);
    assert.equal(fixture.ctx.asyncCommandRef!.current, false);
    assert.equal(JSON.stringify(cfg), before, 'testing a preset does not switch or persist the active connection');
    assert.ok(requested.includes(entry.model));
  }
  assert.equal(fetch.mock.callCount(), 0);
});

test('slash model tests contain invalid account errors before launching or probing and release command state', async (t) => {
  const fetch = t.mock.method(globalThis, 'fetch', async () => { throw new Error('invalid account preset must not probe'); });
  const entry = { ...chatEntry(), autoModel: true, gguf: '/fixture/never-launch.gguf', baseUrl: 'https://fixture.example.test/v1' };
  const cfg = loadConfig(home, { provider: 'mock', model: 'lead', models: [entry] });
  const fixture = slashFixture(cfg);
  fixture.run(`/model test "${entry.label}"`);
  await fixture.done;
  assert.match(fixture.output.join('\n'), /Model test failed: Subscription presets cannot use local model launchers/);
  assert.doesNotMatch(fixture.output.join('\n'), /running capability probes|Local model failed/);
  assert.equal(fixture.ctx.asyncCommandRef!.current, false);
  assert.equal(fetch.mock.callCount(), 0);
});

test('slash provider status distinguishes matching API presets from the selected subscription account', () => {
  process.env.OPENAI_API_KEY = 'fixture-environment-key';
  for (const account of [chatEntry(), claudeEntry()]) {
    const api: ModelEntry = { label: 'API duplicate', provider: account.provider, model: account.model, baseUrl: account.provider === 'openai' ? 'https://api.openai.com/v1' : undefined, apiKey: 'fixture-inline-key' };
    const cfg = loadConfig(home, { ...defaultModelPatch(account), lastModel: undefined, models: [api, account] });
    const fixture = slashFixture(cfg, api.baseUrl);
    fixture.run('/provider');
    const output = fixture.output.join('\n');
    assert.match(output, /auth: subscription connection configured \(sign-in not checked\)/);
    assert.match(output, account.provider === 'openai' ? /configured credential source: ChatGPT account: fixture-personal/ : /configured credential source: official Claude Code subscription/);
    assert.doesNotMatch(output, /model-specific key|OPENAI_API_KEY|api key missing|fixture-inline-key|fixture-environment-key/);
    if (account.provider === 'anthropic') assert.match(output, /endpoint: official Claude Code account service/);

    const recalled = slashFixture({ ...cfg, connection: undefined, lastModel: account.label }, api.baseUrl);
    recalled.run('/provider');
    assert.match(recalled.output.join('\n'), /auth: subscription connection configured/);

    const apiFixture = slashFixture({ ...cfg, connection: undefined, lastModel: api.label }, api.baseUrl);
    apiFixture.run('/provider');
    assert.match(apiFixture.output.join('\n'), /configured credential source: model-specific key/);
    assert.doesNotMatch(apiFixture.output.join('\n'), /subscription connection configured/);
  }
});
