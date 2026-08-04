import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// Isolate ~/.shadow before importing the store (GLOBAL_DIR is derived from homedir() at load).
const HOME = mkdtempSync(join(tmpdir(), 'shadow-home-'));
process.env.HOME = HOME;
process.env.USERPROFILE = HOME;
mkdirSync(join(HOME, '.shadow'), { recursive: true });

const store = await import('../src/state/globalStore.js');
const { persistTerminalOnboardTarget } = await import('../src/onboard/onboard.js');
const { persistWebOnboardTarget } = await import('../src/onboard/webOnboard.js');

test('onboarding a new provider clears lastModel so the fresh pick becomes active (regression)', () => {
  // A user with presets and a last `/model` pick at a (now-stale) preset.
  store.saveGlobalConfig({
    provider: 'openai',
    model: 'glm-5.2',
    baseUrl: 'http://10.0.0.9:8010/v1',
    models: [
      { label: 'LAN Hy3', provider: 'openai', model: 'hy3', baseUrl: 'http://10.0.0.10:8010/v1' },
      { label: 'GLM (z.ai)', provider: 'openai', model: 'glm-4.6', baseUrl: 'https://api.z.ai/api/coding/paas/v4' },
    ],
    lastModel: 'LAN Hy3',
  });
  assert.equal(store.loadGlobalConfig().lastModel, 'LAN Hy3', 'precondition: lastModel is set');

  // Onboarding writes the new provider AND clears lastModel (what web/terminal onboard now do).
  store.saveGlobalConfig({
    provider: 'anthropic',
    model: 'claude-opus-4-8',
    lastModel: undefined,
  });

  const after = store.loadGlobalConfig();
  assert.equal(after.lastModel, undefined, 'lastModel is cleared — no stale preset overrides the onboard');
  assert.equal(after.provider, 'anthropic', 'the freshly-onboarded provider is now top-level');
  assert.equal(after.model, 'claude-opus-4-8');
  assert.ok(Array.isArray(after.models) && (after.models as unknown[]).length === 2, 'existing presets are preserved');
});

test('terminal custom OpenAI onboarding persists self-hosted yes and clears a stale marker on no', () => {
  const baseUrl = 'https://gpu.example.test/v1';
  persistTerminalOnboardTarget({
    adapter: 'openai',
    model: 'qwen3.8-custom',
    baseUrl,
    customEndpoint: true,
    selfHosted: true,
  });
  let after = store.loadGlobalConfig();
  assert.equal(after.selfHosted, true, 'a public remote self-host survives URL-based locality checks');
  assert.equal(after.baseUrl, baseUrl);

  persistTerminalOnboardTarget({
    adapter: 'openai',
    model: 'hosted-model',
    baseUrl: 'https://hosted.example.test/v1',
    customEndpoint: true,
    selfHosted: false,
  });
  after = store.loadGlobalConfig();
  assert.equal(after.selfHosted, undefined, 'an explicit no removes the previous endpoint trust marker');
});

test('browser onboarding persists the custom control and never marks native Anthropic self-hosted', () => {
  persistWebOnboardTarget({
    provider: 'openai',
    model: 'remote-qwen',
    baseUrl: 'https://browser-gpu.example.test/v1',
    customEndpoint: true,
    selfHosted: true,
  });
  assert.equal(store.loadGlobalConfig().selfHosted, true, 'browser yes is persisted');

  persistWebOnboardTarget({
    provider: 'openai',
    model: 'cloud-model',
    baseUrl: 'https://api.example.test/v1',
    customEndpoint: true,
    selfHosted: false,
  });
  assert.equal(store.loadGlobalConfig().selfHosted, undefined, 'browser no clears a stale marker');

  store.saveGlobalConfig({ selfHosted: true });
  persistWebOnboardTarget({
    provider: 'anthropic',
    model: 'claude-opus-4-8',
    baseUrl: 'https://api.anthropic.com',
    customEndpoint: true,
    selfHosted: true,
  });
  assert.equal(store.loadGlobalConfig().selfHosted, undefined, 'native Anthropic is always unmarked');
});

test('onboarding a provider-default endpoint removes a stale custom base URL', () => {
  store.saveGlobalConfig({ baseUrl: 'https://old-untrusted-target.example.test/v1', selfHosted: true });
  persistWebOnboardTarget({
    provider: 'openai',
    model: 'gpt-5.1',
    baseUrl: undefined,
    customEndpoint: false,
    selfHosted: false,
  });
  const after = store.loadGlobalConfig();
  assert.equal(after.baseUrl, undefined);
  assert.equal(after.selfHosted, undefined);
});

test.after(() => rmSync(HOME, { recursive: true, force: true }));
