import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  addModelPreset,
  defaultModelPatch,
  parseModelAddArgs,
  removeModelPreset,
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
  ]);
  assert.equal(parsed.ok, true);
  if (parsed.ok) {
    assert.deepEqual(parsed.value, {
      label: 'local-red',
      provider: 'openai',
      model: 'local-reasoner',
      baseUrl: 'http://127.0.0.1:8001/v1',
      group: 'Local',
    });
  }
  assert.equal(parseModelAddArgs(['add', 'bad', 'bogus', 'm']).ok, false);
  assert.equal(parseModelAddArgs(['add', 'bad-url', 'openai', 'm', 'ftp://example.test']).ok, false);
});

test('model preset helpers add, remove, enable, disable, and produce default patch', () => {
  const models: ModelEntry[] = [{ label: 'alpha', provider: 'mock', model: 'm1' }];
  const added = addModelPreset(models, { label: 'beta', provider: 'openai', model: 'm2', baseUrl: 'https://example.test/v1' });
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
    provider: 'openai',
    model: 'm2',
    baseUrl: 'https://example.test/v1',
    lastModel: 'beta',
  });
});
