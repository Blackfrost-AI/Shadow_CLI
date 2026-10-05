import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, rmSync } from 'node:fs';
import { isolateHome, assertStoreIsolated } from './helpers/isolateHome.js';
import type { OnboardUI, Screen, Choice, TextOptions } from '../src/onboard/ui.js';
import { BACK, OnboardCancelled } from '../src/onboard/ui.js';
import type { EndpointProbeResult } from '../src/onboard/probe.js';
const { home } = isolateHome('onboard-flow');
const store = await import('../src/state/globalStore.js');
assertStoreIsolated(store.GLOBAL_DIR, home);
const { runOnboard, validateOnboardUrl } = await import('../src/onboard/onboard.js');
const { resolveEntryCredential, loadConfig } = await import('../src/config.js');
test.after(() => rmSync(home, { recursive: true, force: true }));

class ScriptUI implements OnboardUI {
  seen: Screen[] = [];
  closed = false;
  constructor(public script: Array<[string, string | string[] | typeof BACK | Error]>) {}
  private answer(screen: Screen): string | string[] | typeof BACK {
    this.seen.push(screen);
    const next = this.script.shift();
    // Throw cancellation on a test mismatch so the recovery loop cannot spin.
    if (!next || next[0] !== screen.title)
      throw new OnboardCancelled(`Unexpected ${screen.title}; expected ${next?.[0]}`);
    if (next[1] instanceof Error) throw next[1];
    return next[1];
  }
  async choose(screen: Screen, items: Choice[]): Promise<string[] | typeof BACK> {
    const value = this.answer(screen);
    if (value === BACK) return BACK;
    const selected = Array.isArray(value) ? value : [value];
    assert.ok(
      selected.every((id) => items.some((item) => item.id === id)),
      `choice exists: ${selected}`,
    );
    return selected;
  }
  async text(screen: Screen, options: TextOptions = {}): Promise<string | typeof BACK> {
    const value = this.answer(screen);
    if (value === BACK) return BACK;
    assert.equal(typeof value, 'string');
    assert.equal(options.validate?.(value as string), undefined);
    return value as string;
  }
  async busy<T>(screen: Screen, work: (signal: AbortSignal) => Promise<T>) {
    this.seen.push(screen);
    return work(new AbortController().signal);
  }
  close() {
    this.closed = true;
  }
}
const catalog: EndpointProbeResult = {
  ok: true,
  models: ['model-one', 'model-two'],
  source: 'live',
  compatibility: 'openai',
  hosting: 'self-hosted',
  baseUrl: 'http://127.0.0.1:8011/v1',
};

test('custom endpoint completes after key entry; retry preserves draft and saves multiple models', async () => {
  store.saveCredential('openai', {
    apiKey: 'previous-provider-key',
    baseUrl: 'https://old.example.test/v1',
  });
  const ui = new ScriptUI([
    ['How do you want to run Shadow?', 'server'],
    ['Choose a model server', 'custom'],
    ['Endpoint URL', 'http://127.0.0.1:8011/v1'],
    ['API key', BACK],
    ['Endpoint URL', 'http://127.0.0.1:8011/v1'],
    ['API key', 'new-endpoint-key'],
    ['Choose models', ['model-one', 'model-two']],
    ['Default model', 'model-two'],
    ['Connection needs attention', 'retry'],
    ['Review and save', 'save'],
  ]);
  let attempts = 0;
  const ok = await runOnboard({
    ui,
    probe: async () => catalog,
    test: async (options) => {
      assert.equal(options.apiKey, 'new-endpoint-key');
      assert.equal(options.model, 'model-two');
      assert.equal(store.loadGlobalConfig().model, undefined, 'no premature config save');
      return ++attempts === 1 ? { ok: false, error: 'temporary connection failure' } : { ok: true };
    },
  });
  assert.equal(ok, true);
  assert.equal(ui.script.length, 0);
  assert.equal(ui.closed, true);
  const config = loadConfig(home);
  assert.equal(config.model, 'model-two');
  assert.equal(config.models.length, 2);
  for (const entry of config.models)
    assert.equal(
      resolveEntryCredential(entry).ok &&
        (resolveEntryCredential(entry) as { apiKey?: string }).apiKey,
      'new-endpoint-key',
    );
  assert.equal(store.getCredential('openai')?.apiKey, 'previous-provider-key');
});

test('discovery failure offers manual entry; an unverified setup requires explicit save', async () => {
  const ui = new ScriptUI([
    ['How do you want to run Shadow?', 'cloud'],
    ['Choose a cloud provider', '@browse'],
    ['All providers', 'cerebras'],
    ['Endpoint URL', 'https://api.cerebras.ai/v1'],
    ['API key', 'cerebras-test-key'],
    ['Model discovery unavailable', 'continue'],
    ['Model ID', 'exact-model-id'],
    ['Connection needs attention', 'save'],
    ['Review and save', 'save'],
  ]);
  assert.equal(
    await runOnboard({
      ui,
      probe: async () => ({
        ...catalog,
        ok: false,
        models: [],
        source: 'none',
        hosting: 'hosted',
        baseUrl: 'https://api.cerebras.ai/v1',
        error: 'model listing unsupported',
      }),
      test: async () => ({ ok: false, error: 'timed out' }),
    }),
    true,
  );
  assert.equal(ui.script.length, 0);
  const review = ui.seen.find((screen) => screen.title === 'Review and save');
  assert.match(review!.description!, /unverified/);
  const config = loadConfig(home);
  assert.equal(config.model, 'exact-model-id');
  assert.equal(config.models.length, 3, 'prior endpoint models are kept');
  const previous = config.models.find((entry) => entry.model === 'model-one')!;
  const credential = resolveEntryCredential(previous);
  assert.ok(
    credential.ok && credential.apiKey === 'new-endpoint-key',
    'previous endpoint key still works',
  );
});

test('cancelling before save leaves the existing config and credentials unchanged', async () => {
  const before = JSON.stringify([store.loadGlobalConfig(), store.loadCredentials()]);
  const ui = new ScriptUI([
    ['How do you want to run Shadow?', 'server'],
    ['Choose a model server', 'custom'],
    ['Endpoint URL', 'http://127.0.0.1:8011/v1'],
    ['API key', new OnboardCancelled()],
  ]);
  assert.equal(await runOnboard({ ui }), false);
  assert.equal(JSON.stringify([store.loadGlobalConfig(), store.loadCredentials()]), before);
});

test('endpoint typos stay in the field instead of falling back to a local default', () => {
  for (const value of ['', 'invalid', 'ftp://host', 'https://host/v1/chat/completions'])
    assert.ok(validateOnboardUrl(value));
  for (const value of ['http://localhost:8000/v1', 'https://api.z.ai/api/coding/paas/v4'])
    assert.equal(validateOnboardUrl(value), undefined);
});

test('a keyless endpoint never inherits the previously saved cloud key', async () => {
  const baseUrl = 'http://127.0.0.1:8022/v1';
  const ui = new ScriptUI([
    ['How do you want to run Shadow?', 'server'], ['Choose a model server', 'custom'],
    ['Endpoint URL', baseUrl], ['API key', ''], ['Choose models', 'model-one'],
    ['Review and save', 'save'],
  ]);
  assert.equal(await runOnboard({ ui, probe: async () => ({ ...catalog, baseUrl }), test: async (options) => {
    assert.equal(options.apiKey, undefined);
    return { ok: true };
  } }), true);
  const config = loadConfig(home);
  const entry = config.models.find((model) => model.label === config.lastModel)!;
  assert.deepEqual(resolveEntryCredential(entry), { ok: true, source: 'credRef' });
  assert.equal(store.getCredential('openai')?.apiKey, 'previous-provider-key');
});

test('an existing vault receives the new endpoint key durably without writing plaintext', async () => {
  const originalPath = process.env.PATH;
  process.env.PATH = ''; // No access to the real OS keychain from this test.
  process.env.SHADOW_VAULT_PASSWORD = 'onboard-test-vault-password';
  const { createVault, unlockWithPassword } = await import('../src/auth/vault.js');
  const { lockVault } = await import('../src/auth/unlock.js');
  const previous = Object.fromEntries(
    Object.entries(store.loadCredentials()).map(([id, value]) => [
      id,
      { ...value, kind: 'apiKey' as const },
    ]),
  );
  createVault(process.env.SHADOW_VAULT_PASSWORD, previous);
  const plaintext = readFileSync(store.credentialsPath(), 'utf8');
  const ui = new ScriptUI([
    ['How do you want to run Shadow?', 'cloud'],
    ['Choose a cloud provider', 'openai'],
    ['Endpoint URL', 'https://api.openai.com/v1'],
    ['API key', 'new-vault-endpoint-key'],
    ['Choose models', 'model-one'],
    ['Review and save', 'save'],
  ]);
  try {
    assert.equal(
      await runOnboard({
        ui,
        probe: async () => ({
          ...catalog,
          baseUrl: 'https://api.openai.com/v1',
          hosting: 'hosted',
        }),
        test: async () => ({ ok: true }),
      }),
      true,
    );
    const config = loadConfig(home);
    const current = config.models.find((entry) => entry.label === config.lastModel)!;
    const saved = unlockWithPassword(process.env.SHADOW_VAULT_PASSWORD).data;
    assert.equal((saved[current.credRef!] as { apiKey?: string })?.apiKey, 'new-vault-endpoint-key');
    assert.equal(readFileSync(store.credentialsPath(), 'utf8'), plaintext);
    for (const id of Object.keys(previous)) assert.ok(saved[id], `kept ${id}`);
  } finally {
    lockVault();
    process.env.PATH = originalPath;
    delete process.env.SHADOW_VAULT_PASSWORD;
  }
});
