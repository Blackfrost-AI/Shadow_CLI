import { test } from 'node:test';
import assert from 'node:assert/strict';

import { isolateHome } from './helpers/isolateHome.js';

// Redirect ~/.shadow BEFORE any config module import (GLOBAL_DIR is a module-level const derived
// from os.homedir() at import time inside globalStore.js).
const { home: HOME } = isolateHome('p1a06-preset');

const { findPreset } = await import('../src/onboard/catalog.js');
const { persistOnboardTarget, presetEntryUpsert } = await import('../src/onboard/persistTarget.js');
const { loadConfig } = await import('../src/config.js');
const { entryStreamContract } = await import('../src/provider/index.js');
const { buildOpenAIBody, shouldPreserveQwenReasoning } = await import('../src/provider/openai.js');
import type { ModelEntry } from '../src/config.js';
import type { CompletionRequest } from '../src/provider/provider.js';

// ── P1A-06 step 4: the self-hosted Qwen 3.8 Max launch preset ships the FULL declared contract ──

test('the qwen-selfhosted catalog preset carries the pinned contract block (P1A-06 step 4)', () => {
  const preset = findPreset('qwen-selfhosted');
  assert.ok(preset, 'preset must exist in the catalog');
  assert.equal(preset.adapter, 'openai');
  assert.equal(preset.kind, 'local', 'shows under the server door of onboarding');
  assert.equal(preset.defaultModel, 'qwen3.8-max');
  assert.ok(preset.entry, 'preset must ship entry extras');
  assert.equal(preset.entry.selfHosted, true);
  assert.equal(preset.entry.idleTimeoutMs, 600_000, 'vLLM/SGLang prefill silence needs a 600s frame');
  // The block mirrors MAX_CAPS in test/qwen38-compat.test.ts — the test-pinned known-good contract.
  assert.deepEqual(preset.entry.capabilities, {
    preserveThinking: true,
    reasoning: 'interleaved',
    effortScale: ['low', 'medium', 'xhigh'],
    maxOutputTokens: 262_144,
  });
});

test('onboarding with the preset persists a ModelEntry the runtime actually resolves', () => {
  const preset = findPreset('qwen-selfhosted')!;
  persistOnboardTarget({
    provider: preset.adapter,
    model: preset.defaultModel,
    baseUrl: 'http://10.0.0.5:8000/v1',
    customEndpoint: false,
    entryExtras: { label: preset.label, ...preset.entry },
  });
  const cfg = loadConfig(HOME);
  // Top-level target points at the serve…
  assert.equal(cfg.provider, 'openai');
  assert.equal(cfg.model, 'qwen3.8-max');
  // …and the ModelEntry carrier exists with the contract fields. Bootstrap resolves the active
  // entry by provider+model match, so this entry IS what the session runs with.
  const entry = cfg.models.find((m: ModelEntry) => m.provider === cfg.provider && m.model === cfg.model);
  assert.ok(entry, 'a matching ModelEntry must be persisted');
  assert.equal(entry.selfHosted, true);
  assert.equal(entry.idleTimeoutMs, 600_000);
  assert.equal(entry.capabilities?.preserveThinking, true);
  assert.equal(entry.capabilities?.maxOutputTokens, 262_144);

  // End-to-end: the persisted entry produces the full Aug-12 wire contract out of the box —
  // 600s idle frame through entryStreamContract, and the Max body through the capability block.
  const contract = entryStreamContract(entry);
  assert.equal(contract.idleTimeoutMs, 600_000);
  const req: CompletionRequest = {
    model: 'my-vllm-alias', // even via --served-model-name aliasing
    system: 's',
    messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }],
    tools: [],
    maxOutputTokens: 8192,
    effort: 'high',
  };
  const body = buildOpenAIBody(req, 'fallback', true, {
    selfHosted: true,
    capabilities: contract.capabilities,
  });
  assert.equal(body.max_tokens, 262_144);
  assert.equal(body.preserve_thinking, true);
  assert.equal(body.reasoning_effort, 'xhigh');
  assert.equal(shouldPreserveQwenReasoning('my-vllm-alias', { selfHosted: true, capabilities: contract.capabilities }), true);
});

test('re-onboarding refreshes contract fields but preserves user additions on the entry', () => {
  const preset = findPreset('qwen-selfhosted')!;
  const existing: ModelEntry[] = [
    {
      label: preset.label,
      provider: 'openai',
      model: 'qwen3.8-max',
      baseUrl: 'http://old:8000/v1',
      credRef: 'vault-slot-7',
      idleTimeoutMs: 120_000,
    } as ModelEntry,
  ];
  const next = presetEntryUpsert(existing, {
    provider: 'openai',
    model: 'qwen3.8-max',
    baseUrl: 'http://new:8000/v1',
    entryExtras: { label: preset.label, ...preset.entry },
  });
  assert.equal(next.length, 1, 'upsert, not duplicate');
  const merged = next[0]!;
  assert.equal(merged.baseUrl, 'http://new:8000/v1', 'endpoint refreshed');
  assert.equal(merged.idleTimeoutMs, 600_000, 'contract knob refreshed');
  assert.equal((merged as ModelEntry & { credRef?: string }).credRef, 'vault-slot-7', 'user credential pointer survives');
});

test('presets without entry extras persist exactly as before (no models[] side effects)', () => {
  const before = loadConfig(HOME).models.length;
  persistOnboardTarget({
    provider: 'openai',
    model: 'gpt-5.1',
    baseUrl: 'https://api.openai.com/v1',
    customEndpoint: false,
  });
  const cfg = loadConfig(HOME);
  assert.equal(cfg.models.length, before, 'no entry is invented for plain presets');
  assert.equal(cfg.model, 'gpt-5.1');
});
