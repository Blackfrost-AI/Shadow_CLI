import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  addModelPreset,
  defaultModelPatch,
  parseModelAddArgs,
  removeModelPreset,
  resolveActiveModelPreset,
  setModelPresetEnabled,
  splitPresetArgs,
} from '../src/config/modelPresets.js';
import type { ModelEntry } from '../src/config.js';

test('splitPresetArgs supports quoted labels and rejects malformed input', () => {
  const parsed = splitPresetArgs('add "Gemini Flash" openai gemini-2.5-flash https://example.test/v1 --group Google');
  assert.equal(parsed.ok, true);
  if (parsed.ok) {
    assert.deepEqual(parsed.value, [
      'add',
      'Gemini Flash',
      'openai',
      'gemini-2.5-flash',
      'https://example.test/v1',
      '--group',
      'Google',
    ]);
  }
  assert.equal(splitPresetArgs('add "unterminated').ok, false);
});

test('parseModelAddArgs validates provider and baseUrl', () => {
  const parsed = parseModelAddArgs([
    'add',
    'local-red',
    'openai',
    'local-reasoner',
    'http://127.0.0.1:8001/v1',
    '--group',
    'Local',
    '--self-hosted',
  ]);
  assert.equal(parsed.ok, true);
  if (parsed.ok) {
    assert.deepEqual(parsed.value, {
      label: 'local-red',
      provider: 'openai',
      model: 'local-reasoner',
      baseUrl: 'http://127.0.0.1:8001/v1',
      group: 'Local',
      selfHosted: true,
    });
  }
  assert.equal(parseModelAddArgs(['add', 'bad', 'bogus', 'm']).ok, false);
  assert.equal(parseModelAddArgs(['add', 'bad-url', 'openai', 'm', 'ftp://example.test']).ok, false);
  assert.equal(parseModelAddArgs(['add', 'bad-marker', 'anthropic', 'm', '--self-hosted']).ok, false);
});

test('model preset helpers add, remove, enable, disable, and produce default patch', () => {
  const models: ModelEntry[] = [{ label: 'alpha', provider: 'mock', model: 'm1' }];
  const added = addModelPreset(models, {
    label: 'beta',
    provider: 'openai',
    model: 'm2',
    baseUrl: 'https://example.test/v1',
    selfHosted: true,
  });
  assert.equal(added.ok, true);
  assert.equal(addModelPreset(models, { label: 'ALPHA', provider: 'mock', model: 'm3' }).ok, false);
  assert.equal(removeModelPreset(models, 'missing').ok, false);
  if (!added.ok) throw new Error('expected add to succeed');
  const disabled = setModelPresetEnabled(added.value, 'beta', false);
  assert.equal(disabled.ok, true);
  if (!disabled.ok) throw new Error('expected disable to succeed');
  assert.equal(disabled.value.find((m) => m.label === 'beta')?.disabled, true);
  const enabled = setModelPresetEnabled(disabled.value, 'beta', true);
  assert.equal(enabled.ok, true);
  if (!enabled.ok) throw new Error('expected enable to succeed');
  assert.equal(enabled.value.find((m) => m.label === 'beta')?.disabled, undefined);
  assert.deepEqual(defaultModelPatch(enabled.value[1]!), {
    connection: undefined,
    provider: 'openai',
    model: 'm2',
    baseUrl: 'https://example.test/v1',
    selfHosted: true,
    lastModel: 'beta',
  });
});

test('active API preset resolution binds capabilities and credentials to the exact endpoint', () => {
  const endpointA: ModelEntry = {
    label: 'Shared model at A',
    provider: 'openai',
    model: 'shared-model',
    baseUrl: 'https://a.example.test/v1',
    credRef: 'endpoint-a-key',
    capabilities: { chatTemplateEnableThinking: false },
  };
  const endpointB: ModelEntry = {
    label: 'Shared model at B',
    provider: 'openai',
    model: 'shared-model',
    baseUrl: 'https://b.example.test/v1/',
    credRef: 'endpoint-b-key',
  };
  const cfg = {
    models: [endpointA, endpointB],
    provider: 'openai' as const,
    model: 'shared-model',
    baseUrl: 'https://b.example.test/v1',
  };

  const selected = resolveActiveModelPreset(cfg);
  assert.equal(selected?.label, endpointB.label);
  assert.equal(selected?.credRef, 'endpoint-b-key');
  assert.equal(selected?.capabilities?.chatTemplateEnableThinking, undefined);

  assert.equal(
    resolveActiveModelPreset({ ...cfg, models: [endpointA] }),
    undefined,
    'endpoint A metadata must not attach to a direct endpoint B target',
  );

  const reverse = resolveActiveModelPreset({ ...cfg, baseUrl: endpointA.baseUrl });
  assert.equal(reverse?.label, endpointA.label, 'matching is bidirectional and independent of preset order');
  assert.equal(reverse?.credRef, 'endpoint-a-key');
});

test('labeled API selections stay stable only while their endpoint remains active', () => {
  const endpointA: ModelEntry = {
    label: 'Endpoint A',
    provider: 'openai',
    model: 'duplicate-model',
    baseUrl: 'https://a.example.test/v1',
  };
  const endpointB: ModelEntry = {
    label: 'Endpoint B',
    provider: 'openai',
    model: 'duplicate-model',
    baseUrl: 'https://b.example.test/v1',
  };
  const cfg = {
    models: [endpointB, endpointA],
    provider: 'openai' as const,
    model: 'duplicate-model',
    baseUrl: endpointA.baseUrl,
    profile: { model: endpointA.label },
  };

  assert.equal(resolveActiveModelPreset(cfg)?.label, endpointA.label, 'profile label disambiguates duplicate model IDs');
  assert.equal(resolveActiveModelPreset(cfg, { lastPicked: endpointA })?.label, endpointA.label);
  assert.equal(
    resolveActiveModelPreset({ ...cfg, baseUrl: endpointB.baseUrl }, { lastPicked: endpointA })?.label,
    endpointB.label,
    'an endpoint override prevents a stale labeled API preset from leaking into the new target',
  );
  assert.equal(
    resolveActiveModelPreset(
      { ...cfg, baseUrl: endpointB.baseUrl, lastModel: endpointA.label, profile: undefined },
      { recallLast: true, targetPinned: true },
    )?.label,
    endpointB.label,
    'an explicitly pinned target prevents lastModel recall from bypassing endpoint matching',
  );
});

test('remembered labels are applied atomically before endpoint-bound metadata is resolved', () => {
  const remembered: ModelEntry = {
    label: 'Remembered LAN',
    provider: 'openai',
    model: 'lan-model',
    baseUrl: 'http://10.0.0.8:8000/v1',
    credRef: 'lan-key',
    capabilities: { chatTemplateEnableThinking: false },
  };
  const stale = {
    models: [remembered],
    trustedGlobalModelPresets: [remembered],
    provider: 'anthropic' as const,
    model: 'stale-cloud-model',
    baseUrl: 'https://api.anthropic.com',
    lastModel: remembered.label,
  };

  assert.equal(
    resolveActiveModelPreset(stale, { recallLast: true })?.label,
    remembered.label,
    'the selected label carries provider/model/endpoint as one trusted tuple',
  );
  assert.equal(
    resolveActiveModelPreset(stale, { recallLast: true, targetPinned: true }),
    undefined,
    'a one-run target pin leaves the stale direct target detached from remembered credentials',
  );
});

test('automatic recall fails closed when trusted preset provenance is absent', () => {
  const projectOnly: ModelEntry = {
    label: 'Project only',
    provider: 'openai',
    model: 'project-model',
    baseUrl: 'https://project.example.test/v1',
  };
  assert.equal(resolveActiveModelPreset({
    models: [projectOnly],
    provider: 'anthropic',
    model: 'saved-global-model',
    lastModel: projectOnly.label,
  }, { recallLast: true }), undefined);
});

test('effective endpoint matching includes provider environment URLs', () => {
  const previous = process.env.OPENAI_BASE_URL;
  const endpointA: ModelEntry = {
    label: 'Environment A', provider: 'openai', model: 'environment-model',
    baseUrl: 'https://env-a.example.test/v1', credRef: 'env-a-key',
  };
  const endpointB: ModelEntry = {
    label: 'Environment B', provider: 'openai', model: 'environment-model',
    baseUrl: 'https://env-b.example.test/v1', credRef: 'env-b-key',
  };
  const cfg = {
    models: [endpointA, endpointB],
    provider: 'openai' as const,
    model: 'environment-model',
  };
  try {
    process.env.OPENAI_BASE_URL = endpointB.baseUrl;
    assert.equal(resolveActiveModelPreset(cfg)?.label, endpointB.label);
    process.env.OPENAI_BASE_URL = endpointA.baseUrl;
    assert.equal(resolveActiveModelPreset(cfg)?.label, endpointA.label);
  } finally {
    if (previous === undefined) delete process.env.OPENAI_BASE_URL;
    else process.env.OPENAI_BASE_URL = previous;
  }
});

test('omitted and explicit official provider endpoints are canonically equivalent', () => {
  const previous = process.env.OPENAI_BASE_URL;
  const implicit: ModelEntry = {
    label: 'Implicit OpenAI', provider: 'openai', model: 'official-model', credRef: 'official-key',
  };
  const explicit: ModelEntry = {
    label: 'Explicit OpenAI', provider: 'openai', model: 'other-official-model',
    baseUrl: 'https://api.openai.com/v1/',
  };
  try {
    process.env.OPENAI_BASE_URL = 'https://api.openai.com/v1';
    assert.equal(resolveActiveModelPreset({
      models: [implicit], provider: 'openai', model: implicit.model, baseUrl: 'https://api.openai.com/v1/',
    })?.label, implicit.label);
    assert.equal(resolveActiveModelPreset({
      models: [explicit], provider: 'openai', model: explicit.model,
    })?.label, explicit.label);
  } finally {
    if (previous === undefined) delete process.env.OPENAI_BASE_URL;
    else process.env.OPENAI_BASE_URL = previous;
  }
});

test('a custom direct endpoint does not silently fall back to a same-model account preset', () => {
  const account: ModelEntry = {
    label: 'Subscription model',
    provider: 'openai',
    model: 'shared-model',
    connection: { kind: 'chatgpt', profileId: 'fixture-account' },
  };

  assert.equal(
    resolveActiveModelPreset({
      models: [account],
      provider: 'openai',
      model: account.model,
      baseUrl: 'http://127.0.0.1:8908/v1',
    }),
    undefined,
    'the explicit API endpoint remains a direct target instead of reattaching the account',
  );
  assert.equal(
    resolveActiveModelPreset({
      models: [account],
      provider: 'openai',
      model: account.model,
      baseUrl: 'https://api.openai.com/v1',
    })?.label,
    account.label,
    'the canonical account endpoint remains compatible',
  );
});
