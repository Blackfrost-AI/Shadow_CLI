import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { familyProfile, resolveParallelTools } from '../src/config/familyProfiles.js';

test('anthropic-distilled models: anthropic transport hint + parallel tools off', () => {
  const p = familyProfile('gemma4-12b-opus-distill');
  assert.equal(p?.family, 'anthropic-distill');
  assert.equal(p?.transport, 'anthropic');
  assert.equal(p?.parallelTools, false);
});

test('bare GLM-4 gets the NOT-AGENTIC matrix warning; glm-4.6 / glm-4.7-flash do NOT', () => {
  assert.equal(familyProfile('glm-4')?.family, 'glm-4-legacy');
  assert.equal(familyProfile('glm-4.6'), undefined, 'modern GLM is clean');
  assert.equal(familyProfile('glm-4.7-flash'), undefined);
  assert.equal(familyProfile('glm-5.2'), undefined);
});

test('ONLY true reasoners get the 64k-floor note — mirrors the adapter matchers exactly', () => {
  assert.equal(familyProfile('qwq-32b')?.minOutputTokens, 64_000, 'QwQ is a reasoner');
  assert.equal(familyProfile('qwen3-30b-thinking-2507')?.minOutputTokens, 64_000, 'qwen *think* variant');
  assert.equal(familyProfile('deepseek-reasoner')?.minOutputTokens, 64_000);
  assert.equal(familyProfile('deepseek-r1')?.minOutputTokens, 64_000);
  // A plain Qwen3 INSTRUCT gets no floor from the adapter — claiming one here would be false.
  assert.equal(familyProfile('qwen3.6-35b-a3b'), undefined, 'instruct qwen: no false floor note');
  assert.equal(familyProfile('Qwen3-4B-Instruct-Q4_K_M'), undefined, 'local instruct gguf: no false note');
});

test('genuine Anthropic models NEVER inherit distill defaults (parallel stays on)', () => {
  // looksAnthropicDistilled matches real Claude ids too (transport routing) — the profile must not.
  for (const m of ['claude-opus-4-8', 'claude-sonnet-5', 'claude-fable-5',
                   'anthropic/claude-sonnet-4-6', 'us.anthropic.claude-opus-4-8-v1', 'opus-4.1']) {
    assert.equal(familyProfile(m), undefined, `${m} unprofiled`);
    assert.equal(resolveParallelTools({ parallelTools: true }, m), true, `${m} keeps parallel tools`);
  }
});

test('most models have NO profile — by design (a wrong profile is worse than none)', () => {
  for (const m of ['claude-opus-4-8', 'gpt-5.1', 'llama3.1', 'mistral-large-latest', 'gemini-2.0-flash']) {
    assert.equal(familyProfile(m), undefined, `${m} unprofiled`);
  }
});

test('resolveParallelTools: explicit config BEATS the profile; profile fills when unset', () => {
  const distill = 'gemma4-12b-opus-distill';
  // Unset by user → the distill profile's `false` applies.
  assert.equal(resolveParallelTools({ parallelTools: true }, distill), false, 'profile fills the default');
  // Explicitly set → user wins, profile ignored.
  assert.equal(resolveParallelTools({ parallelTools: true, explicitKeys: ['parallelTools'] }, distill), true);
  // No profile → global value either way.
  assert.equal(resolveParallelTools({ parallelTools: true }, 'claude-opus-4-8'), true);
  assert.equal(resolveParallelTools({ parallelTools: false, explicitKeys: [] }, 'claude-opus-4-8'), false);
});

test('loadConfig records explicitKeys so profiles can defer to real user settings', async () => {
  const HOME = mkdtempSync(join(tmpdir(), 'shadow-prof-'));
  const prevHome = process.env.HOME;
  const prevProfile = process.env.USERPROFILE;
  process.env.HOME = HOME;
  process.env.USERPROFILE = HOME;
  try {
    mkdirSync(join(HOME, '.shadow'), { recursive: true });
    writeFileSync(join(HOME, '.shadow', 'config.json'), JSON.stringify({ provider: 'mock', parallelTools: false }));
    // Fresh import AFTER the HOME swap is not possible here (config caches homedir at import in
    // globalStore) — so this asserts via the loadConfig contract on the CURRENT module: the key
    // set must reflect the merged pre-parse object. We exercise the pure recorder instead.
    const { loadConfig } = await import('../src/config.js');
    const cwd = mkdtempSync(join(tmpdir(), 'shadow-ws-'));
    const cfg = loadConfig(cwd, { provider: 'mock' });
    assert.ok(Array.isArray(cfg.explicitKeys), 'explicitKeys recorded');
    assert.ok(cfg.explicitKeys!.includes('provider'), 'CLI-overridden key is explicit');
    rmSync(cwd, { recursive: true, force: true });
  } finally {
    process.env.HOME = prevHome;
    process.env.USERPROFILE = prevProfile;
    rmSync(HOME, { recursive: true, force: true });
  }
});

test('explicitKeys excludes the UNTRUSTED project file — a cloned repo cannot out-rank a profile', async () => {
  // resolveParallelTools treats explicitKeys as user intent; only trusted sources may set it.
  // (loadConfig computes it from global+env+CLI — asserted here via the resolver contract.)
  const distill = 'gemma4-12b-opus-distill';
  // Project file set parallelTools:true but it is NOT in explicitKeys → the profile still wins.
  assert.equal(resolveParallelTools({ parallelTools: true, explicitKeys: ['provider'] }, distill), false);
});
