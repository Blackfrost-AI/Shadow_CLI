import { beforeEach, test } from 'node:test';
import assert from 'node:assert/strict';
import { isolateHome } from './helpers/isolateHome.js';

const { home } = isolateHome('doctor-self-hosted');
for (const name of ['SHADOW_MODEL', 'SHADOW_PROVIDER', 'SHADOW_PROFILE', 'OPENAI_API_KEY', 'OPENAI_BASE_URL', 'ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN', 'ANTHROPIC_BASE_URL']) delete process.env[name];
const { loadConfig } = await import('../src/config.js');
const { providerDiagnostic } = await import('../src/doctor/provider.js');
const { runDoctor, runtimeSupported } = await import('../src/doctor.js');
const { saveGlobalConfig } = await import('../src/state/globalStore.js');

beforeEach(() => saveGlobalConfig({ provider: 'openai', model: 'local-coder', baseUrl: undefined, models: [], lastModel: undefined }));

test('doctor recognizes a keyless model endpoint without making a connection claim', () => {
  saveGlobalConfig({ baseUrl: 'http://127.0.0.1:11434/v1' });
  const report = runDoctor(home);
  const provider = report.checks.find((c) => c.id === 'provider')!;
  assert.equal(provider.ok, true);
  assert.match(provider.detail, /127\.0\.0\.1:11434/);
  assert.match(provider.detail, /connection not tested/);
  assert.doesNotMatch(provider.detail, /run `shadow onboard`/);
});

for (const [backend, value] of [['gguf', '/models/coder.gguf'], ['mlx', '/models/coder-mlx'], ['vllm', 'org/coder']]) {
  test(`doctor recognizes a managed ${backend} model without requiring a cloud key`, () => {
    saveGlobalConfig({ models: [{ label: 'mine', provider: 'openai', model: 'local-coder', [backend!]: value }] });
    const result = providerDiagnostic(loadConfig(home));
    assert.equal(result.ok, true);
    assert.match(result.detail, /no API key required/);
    assert.match(result.detail, /not started/);
  });
}

test('doctor follows the last selected preset, including its provider and endpoint', () => {
  saveGlobalConfig({ provider: 'anthropic', model: 'cloud-model', lastModel: 'mine', models: [{ label: 'mine', provider: 'openai', model: 'local-coder', baseUrl: 'http://127.0.0.1:8000/v1' }] });
  const result = providerDiagnostic(loadConfig(home));
  assert.equal(result.ok, true);
  assert.match(result.detail, /openai \/ local-coder/);
  assert.match(result.detail, /127\.0\.0\.1:8000/);
});

test('doctor diagnoses a missing model credential even when an endpoint is configured', () => {
  saveGlobalConfig({ models: [{ label: 'mine', provider: 'openai', model: 'local-coder', baseUrl: 'http://127.0.0.1:8000/v1', credRef: 'missing-slot' }] });
  const result = providerDiagnostic(loadConfig(home));
  assert.equal(result.ok, false);
  assert.match(result.detail, /credential is missing/);
});

test('doctor gives an onboarding step for a fresh unconfigured install', () => {
  assert.equal(providerDiagnostic(loadConfig(home)).ok, false);
  assert.match(providerDiagnostic(loadConfig(home)).detail, /shadow onboard/);
});

test('doctor enforces the runtime floor in the source installation requirements', () => {
  for (const version of ['20.19.0', '22.18.0']) assert.equal(runtimeSupported(version), false);
  for (const version of ['22.19.0', '22.19.1', '24.0.0', '26.5.0']) assert.equal(runtimeSupported(version), true);
});
