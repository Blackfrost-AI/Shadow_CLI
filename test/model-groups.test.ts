import { test } from 'node:test';
import assert from 'node:assert/strict';
import { modelGroup, groupedModelRows, firstSelectableRow, stepSelectableRow } from '../src/util/modelGroups.js';
import type { ModelEntry } from '../src/config.js';

const m = (model: string, extra: Partial<ModelEntry> = {}): ModelEntry => ({
  label: model,
  provider: extra.provider ?? 'openai',
  model,
  ...extra,
});

test('local endpoint groups under "Local" regardless of maker', () => {
  assert.equal(modelGroup(m('gemma4:12b', { baseUrl: 'http://localhost:11434/v1' })), 'Local');
  assert.equal(modelGroup(m('qwen3-coder', { baseUrl: 'http://127.0.0.1:1234/v1' })), 'Local');
  // LAN / WireGuard-served models are local too — locality beats the maker. A quad-served
  // GLM is "Local", not "Zhipu"; a quad Ornith is "Local", not "Other".
  assert.equal(modelGroup(m('glm-local', { baseUrl: 'http://127.0.0.1:8002/v1' })), 'Local');
  assert.equal(modelGroup(m('local-reasoner', { baseUrl: 'http://127.0.0.1:8001/v1' })), 'Local');
  assert.equal(modelGroup(m('gemini-x', { baseUrl: 'http://192.168.1.50:8000/v1' })), 'Local');
});

test('cloud models group by company', () => {
  assert.equal(modelGroup(m('claude-opus-4-8', { provider: 'anthropic' })), 'Anthropic');
  assert.equal(modelGroup(m('gpt-5.2-codex')), 'OpenAI');
  assert.equal(modelGroup(m('o4-mini')), 'OpenAI');
  assert.equal(modelGroup(m('grok-4')), 'xAI');
  assert.equal(modelGroup(m('gemini-flash-latest')), 'Google');
  assert.equal(modelGroup(m('deepseek-chat')), 'DeepSeek');
});

test('explicit group overrides derivation', () => {
  assert.equal(modelGroup(m('gpt-4o', { group: 'Work' })), 'Work');
});

test('groupedModelRows: header per category then its models', () => {
  const rows = groupedModelRows([
    m('claude-opus-4-8', { provider: 'anthropic' }),
    m('gemma4:12b', { baseUrl: 'http://localhost:11434/v1' }),
    m('grok-4'),
    m('huihui-gemma4-12b', { baseUrl: 'http://localhost:11434/v1' }),
  ]);
  // Anthropic(h+1), Local(h+2 — both local models under one header), xAI(h+1)
  assert.deepEqual(
    rows.map((r) => (r.kind === 'header' ? `#${r.label}` : r.entry.model)),
    ['#Anthropic', 'claude-opus-4-8', '#Local', 'gemma4:12b', 'huihui-gemma4-12b', '#xAI', 'grok-4'],
  );
});

test('navigation skips headers and clamps at the ends', () => {
  const rows = groupedModelRows([
    m('claude-opus-4-8', { provider: 'anthropic' }),
    m('gemma4:12b', { baseUrl: 'http://localhost:11434/v1' }),
  ]);
  // rows: [#Anthropic(0), claude(1), #Local(2), gemma(3)]
  assert.equal(firstSelectableRow(rows), 1);
  assert.equal(stepSelectableRow(rows, 1, 1), 3); // down from claude skips the #Local header → gemma
  assert.equal(stepSelectableRow(rows, 3, 1), 3); // already at last model → stays
  assert.equal(stepSelectableRow(rows, 3, -1), 1); // up skips header → claude
  assert.equal(stepSelectableRow(rows, 1, -1), 1); // already at first model → stays
});
