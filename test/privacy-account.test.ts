import test from 'node:test';
import assert from 'node:assert/strict';
import { rmSync } from 'node:fs';
import { isolateHome, assertStoreIsolated } from './helpers/isolateHome.js';
import type { PrivacyConfigView, PrivacyEnv } from '../src/doctor/privacy.js';

const { home } = isolateHome('privacy-account');
const store = await import('../src/state/globalStore.js');
assertStoreIsolated(store.GLOBAL_DIR, home);
const { effectiveSessionEndpoint, buildPrivacyReport, formatPrivacyReport } = await import('../src/doctor/privacy.js');
const keys = ['OPENAI_BASE_URL', 'ANTHROPIC_BASE_URL', 'OPENAI_API_KEY', 'ANTHROPIC_API_KEY'];
const previous = Object.fromEntries(keys.map((key) => [key, process.env[key]]));
test.beforeEach(() => {
  process.env.OPENAI_BASE_URL = 'https://api-override.example.test/v1';
  process.env.ANTHROPIC_BASE_URL = 'https://anthropic-override.example.test';
  process.env.OPENAI_API_KEY = 'fixture-openai-key';
  process.env.ANTHROPIC_API_KEY = 'fixture-anthropic-key';
});
test.after(() => {
  for (const key of keys) {
    if (previous[key] === undefined) delete process.env[key];
    else process.env[key] = previous[key];
  }
  rmSync(home, { recursive: true, force: true });
});
const env: PrivacyEnv = { offline: false, credStore: 'vault', keychainAvailable: false };
const account: PrivacyConfigView = { provider: 'openai', model: 'fixture-reasoner', connection: { kind: 'chatgpt', profileId: 'fixture-account' }, lsp: { enabled: false } };

test('ChatGPT endpoint reports the account service despite API endpoint overrides and never reads tokens', (t) => {
  const fetch = t.mock.method(globalThis, 'fetch', async () => { throw new Error('privacy inspection cannot contact an account'); });
  const target = effectiveSessionEndpoint({ ...account, baseUrl: 'https://configured-api.example.test/v1' });
  assert.equal(target.baseUrl, 'https://api.openai.com/v1');
  assert.deepEqual(target.connection, account.connection);
  const report = buildPrivacyReport({ ...account, ...target }, env);
  assert.equal(report.effectiveBaseUrl, 'https://api.openai.com/v1');
  assert.equal(report.credentials.store, 'account');
  assert.match(report.credentials.detail, /0600/);
  assert.match(report.credentials.detail, /not encrypted/);
  const auth = report.egress.find((path) => path.name === 'ChatGPT authentication')!;
  assert.equal(auth.target, 'auth.openai.com');
  assert.equal(auth.active, true);
  assert.equal(report.egress.find((path) => path.name === 'Model provider')!.target, 'api.openai.com');
  assert.doesNotMatch(formatPrivacyReport(report, false), /fixture-openai-key|fixture-anthropic-key|api-override\.example/);
  assert.equal(fetch.mock.callCount(), 0);
});

test('remembered account presets replace stale provider, endpoint and credential identity in privacy reports', () => {
  const presets = [{ label: 'My subscription', provider: account.provider, model: account.model, connection: account.connection }];
  const cfg: PrivacyConfigView = { provider: 'anthropic', model: 'old-api', baseUrl: 'https://old-api.example.test', lastModel: 'My subscription', lsp: { enabled: false },
    models: presets, trustedGlobalModelPresets: presets };
  const target = effectiveSessionEndpoint(cfg);
  assert.equal(target.provider, 'openai');
  assert.deepEqual(target.connection, account.connection);
  const report = buildPrivacyReport({ ...cfg, ...target }, env);
  assert.equal(report.credentials.store, 'account');
  assert.equal(report.model, account.model);
  assert.doesNotMatch(report.effectiveBaseUrl, /old-api/);
});

test('an explicit API preset does not inherit the previous subscription identity in privacy output', () => {
  const presets = [{ label: 'API selection', provider: 'openai', model: 'fixture-api' }];
  const cfg: PrivacyConfigView = { ...account, lastModel: 'API selection', models: presets, trustedGlobalModelPresets: presets };
  const target = effectiveSessionEndpoint(cfg);
  assert.equal(target.connection, undefined);
  assert.equal(target.baseUrl, process.env.OPENAI_BASE_URL);
  const report = buildPrivacyReport({ ...cfg, ...target, connection: target.connection }, env);
  assert.equal(report.credentials.store, 'vault');
  assert.equal(report.egress.some((path) => path.name === 'ChatGPT authentication'), false);
});

test('Claude subscription discloses official CLI traffic, external storage and limits of Shadow receipts', () => {
  const cfg: PrivacyConfigView = { provider: 'anthropic', model: 'sonnet', connection: { kind: 'claude-code' }, lsp: { enabled: false } };
  const target = effectiveSessionEndpoint(cfg);
  assert.equal(target.baseUrl, undefined);
  assert.deepEqual(target.connection, cfg.connection);
  const report = buildPrivacyReport({ ...cfg, ...target }, env);
  assert.equal(report.credentials.store, 'external');
  assert.match(report.credentials.detail, /does not read, copy or store Claude login tokens/);
  assert.match(report.effectiveBaseUrl, /Claude Code/);
  assert.doesNotMatch(report.effectiveBaseUrl, /anthropic-override|api\.anthropic/);
  const engine = report.egress.find((path) => path.name === 'Official Claude Code engine')!;
  assert.match(engine.note!, /outside Shadow.s fetch receipt/);
  assert.match(engine.note!, /Nonessential traffic is disabled/);
  assert.equal(engine.active, true);
  assert.ok(report.warnings.some((warning) => /administrator-managed policy hooks/.test(warning)));
});

test('offline account reports disable both authentication and inference traffic without claiming local eligibility', () => {
  for (const cfg of [account, { ...account, provider: 'anthropic', model: 'sonnet', connection: { kind: 'claude-code' as const } }]) {
    const report = buildPrivacyReport(cfg, { ...env, offline: true });
    assert.equal(report.providerIsLocal, false);
    assert.equal(report.offlineEligible.eligible, false);
    assert.ok(report.egress.every((path) => !path.active));
  }
});

test('a sole hand-written account preset is reported exactly like the connection startup selects', () => {
  for (const entry of [
    { label: 'Manual ChatGPT', provider: 'openai', model: 'fixture-model', connection: { kind: 'chatgpt' as const, profileId: 'manual-account' } },
    { label: 'Manual Claude', provider: 'anthropic', model: 'sonnet', connection: { kind: 'claude-code' as const } },
  ]) {
    const cfg: PrivacyConfigView = { provider: entry.provider, model: entry.model, models: [entry], lsp: { enabled: false } };
    const target = effectiveSessionEndpoint(cfg);
    assert.deepEqual(target.connection, entry.connection);
    assert.equal(target.baseUrl, entry.provider === 'openai' ? 'https://api.openai.com/v1' : undefined);
    const report = buildPrivacyReport({ ...cfg, ...target }, env);
    assert.equal(report.credentials.store, entry.provider === 'openai' ? 'account' : 'external');
    assert.doesNotMatch(report.effectiveBaseUrl, /override\.example/);
  }
});

test('privacy endpoint selection preserves the chosen account among same-model API and account presets', () => {
  const connection = { kind: 'chatgpt' as const, profileId: 'chosen-account' };
  const cfg: PrivacyConfigView = { provider: 'openai', model: 'same-model', connection, lsp: { enabled: false }, models: [
    { label: 'API', provider: 'openai', model: 'same-model' },
    { label: 'Other account', provider: 'openai', model: 'same-model', connection: { kind: 'chatgpt', profileId: 'other-account' } },
    { label: 'Chosen account', provider: 'openai', model: 'same-model', connection },
  ] };
  assert.deepEqual(effectiveSessionEndpoint(cfg).connection, connection);
  assert.equal(effectiveSessionEndpoint(cfg).baseUrl, 'https://api.openai.com/v1');
});
