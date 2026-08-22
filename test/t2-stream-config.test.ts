import { test } from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync, mkdtempSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

// T2 emergency — top-level `stream` config knobs + self-hosted-aware idle default +
// onboarding resilience stamping.
//
// Background: self-hosted inference servers keep SSE silent through long prefill on big
// contexts; the old 120s public-API budget killed exactly those requests, and a blank
// config.json (the founder's Windows box) had NO knob to change it — per-model knobs only
// cover preset/model-entry setups. T2 adds:
//   1. a session-wide `stream.{idleTimeoutMs,firstByteTimeoutMs,retries}` block accepted in
//      BOTH ~/.shadow/config.json (global) and the project shadow.config.json — merged into
//      ShadowConfig.stream by loadConfig's deepMerge, flowing into entryStreamContract;
//   2. a self-hosted-aware idle default (300s) inside the watchdog resolver;
//   3. onboarding stamping the resilience knobs onto self-hosted/local carrier entries.
//
// The env escape hatch (SHADOW_IDLE_MS) must still beat everything.

// Redirect ~/.shadow to a throwaway HOME BEFORE any config module is imported. GLOBAL_DIR is
// resolved from os.homedir() at import time inside globalStore.js — one isolated home per
// test process (each parallel node --test file gets its own). Every import that transitively
// touches globalStore (config.js, provider/index.js, persistTarget.js, globalStore.js) MUST be
// a dynamic import AFTER this call: static imports are hoisted above it and would capture the
// REAL home at module load — leaking test writes into the founder's live config.
// (stream.js is side-effect-free and globalStore-independent, so it may stay static.)
import { isolateHome } from './helpers/isolateHome.js';
isolateHome('t2');

import { resolveIdleBudget, SELF_HOSTED_DEFAULT_IDLE_MS } from '../src/provider/stream.js';

const { entryStreamContract } = await import('../src/provider/index.js');
const { loadConfig } = await import('../src/config.js');
const { persistOnboardTarget } = await import('../src/onboard/persistTarget.js');
const { loadGlobalConfig } = await import('../src/state/globalStore.js');
// Module handle shared by the two global-config tests below (one instance per test file).
const globalStore = await import('../src/state/globalStore.js');

const PUBLIC_URL = 'https://api.openai.com/v1/chat/completions';
const LOCAL_URL = 'http://127.0.0.1:8000/v1/chat/completions';
const REMOTE_SELF_HOSTED = 'https://llm.example.internal:9443/v1/chat/completions';

/** loadConfig reads `<cwd>/shadow.config.json` — materialize one in a temp dir. */
function withProjectConfig(contents: unknown): { cwd: string; cfg: ReturnType<typeof loadConfig> } {
  const cwd = mkdtempSync(join(tmpdir(), 'shadow-t2proj-'));
  writeFileSync(join(cwd, 'shadow.config.json'), JSON.stringify(contents), 'utf8');
  return { cwd, cfg: loadConfig(cwd) };
}

test('resolveIdleBudget: explicit knob wins everywhere', () => {
  assert.equal(resolveIdleBudget(99_000, PUBLIC_URL), 99_000);
  assert.equal(resolveIdleBudget(99_000, LOCAL_URL), 99_000);
  assert.equal(resolveIdleBudget(99_000, REMOTE_SELF_HOSTED, true), 99_000);
});

test('resolveIdleBudget: public endpoint without a knob keeps the tight 120s budget', () => {
  assert.equal(resolveIdleBudget(undefined, PUBLIC_URL), 120_000);
});

test('resolveIdleBudget: self-hosted without a knob gets the loose 300s default', () => {
  assert.equal(SELF_HOSTED_DEFAULT_IDLE_MS, 300_000);
  assert.equal(resolveIdleBudget(undefined, LOCAL_URL), 300_000);
  assert.equal(resolveIdleBudget(undefined, LOCAL_URL, true), 300_000);
  assert.equal(resolveIdleBudget(undefined, REMOTE_SELF_HOSTED, true), 300_000);
});

test('entryStreamContract: stream defaults apply when the model entry has none', () => {
  const c = entryStreamContract(undefined, {
    idleTimeoutMs: 240_000,
    firstByteTimeoutMs: 30_000,
    retries: 4,
  });
  assert.equal(c.idleTimeoutMs, 240_000);
  assert.equal(c.firstByteTimeoutMs, 30_000);
  assert.equal(c.streamRetries, 4);
  assert.equal(c.capabilities, undefined);
});

test('entryStreamContract: per-model entry beats the stream defaults', () => {
  const c = entryStreamContract(
    { idleTimeoutMs: 150_000, firstByteTimeoutMs: 10_000, streamRetries: 2 },
    { idleTimeoutMs: 240_000, firstByteTimeoutMs: 30_000, retries: 4 },
  );
  assert.equal(c.idleTimeoutMs, 150_000);
  assert.equal(c.firstByteTimeoutMs, 10_000);
  assert.equal(c.streamRetries, 2);
});

test('entryStreamContract: partial entry falls through per-knob to the defaults', () => {
  const c = entryStreamContract(
    { idleTimeoutMs: 150_000 },
    { idleTimeoutMs: 240_000, firstByteTimeoutMs: 30_000, retries: 4 },
  );
  assert.equal(c.idleTimeoutMs, 150_000, 'entry knob wins where set');
  assert.equal(c.firstByteTimeoutMs, 30_000, 'stream defaults fill the gap');
  assert.equal(c.streamRetries, 4, 'stream defaults fill the gap');
});

test('entryStreamContract: SHADOW_IDLE_MS env beats entry AND defaults; invalid env ignored', () => {
  const saved = process.env.SHADOW_IDLE_MS;
  try {
    process.env.SHADOW_IDLE_MS = '77000';
    const c = entryStreamContract({ idleTimeoutMs: 150_000 }, { idleTimeoutMs: 240_000 });
    assert.equal(c.idleTimeoutMs, 77_000);

    process.env.SHADOW_IDLE_MS = 'not-a-number';
    const c2 = entryStreamContract({ idleTimeoutMs: 150_000 }, { idleTimeoutMs: 240_000 });
    assert.equal(c2.idleTimeoutMs, 150_000, 'invalid env is ignored fail-closed');

    process.env.SHADOW_IDLE_MS = '0';
    const c3 = entryStreamContract(undefined, { idleTimeoutMs: 240_000 });
    assert.equal(c3.idleTimeoutMs, 240_000, 'zero env is rejected (positive-int)');
  } finally {
    if (saved === undefined) delete process.env.SHADOW_IDLE_MS;
    else process.env.SHADOW_IDLE_MS = saved;
  }
});

test('loadConfig accepts the session-wide stream block in the project file', () => {
  const { cfg } = withProjectConfig({
    stream: { idleTimeoutMs: 300_000, firstByteTimeoutMs: 600_000, retries: 8 },
  });
  assert.deepEqual(cfg.stream, { idleTimeoutMs: 300_000, firstByteTimeoutMs: 600_000, retries: 8 });
});

test('loadConfig rejects nonsense stream values fail-loudly (never smuggle into the watchdog)', () => {
  assert.throws(() => withProjectConfig({ stream: { idleTimeoutMs: 'x' } }));
  assert.throws(() => withProjectConfig({ stream: { retries: -1 } }));
  assert.throws(() => withProjectConfig({ stream: { idleTimeoutMs: 0 } }));
  assert.throws(() => withProjectConfig({ stream: { idleTimeoutMs: 1.5 } }));
});

test('loadConfig: configs without the stream block still parse (legacy)', () => {
  const cwd = mkdtempSync(join(tmpdir(), 'shadow-t2legacy-'));
  const cfg = loadConfig(cwd);
  assert.equal(cfg.stream, undefined);
});

test('stream block set ONLY in ~/.shadow/config.json reaches ShadowConfig.stream (the founder case)', () => {
  // The global config is merged into the ShadowConfig by loadConfig — a blank PROJECT file must
  // still inherit the global stream block, because a blank global + global-only edit is the
  // exact setup that was timing out on Windows.
  const { saveGlobalConfig: save } = globalStore;
  save({ stream: { idleTimeoutMs: 280_000, retries: 6 } });
  const cwd = mkdtempSync(join(tmpdir(), 'shadow-t2global-'));
  const cfg = loadConfig(cwd);
  assert.deepEqual(cfg.stream, { idleTimeoutMs: 280_000, retries: 6 });
});

test('project stream block deep-merges over the global one without dropping global siblings', () => {
  const { saveGlobalConfig: save } = globalStore;
  save({ stream: { idleTimeoutMs: 280_000, firstByteTimeoutMs: 600_000 } });
  const { cfg } = withProjectConfig({ stream: { retries: 3 } });
  assert.equal(cfg.stream?.idleTimeoutMs, 280_000, 'global idle survives project override of a sibling');
  assert.equal(cfg.stream?.firstByteTimeoutMs, 600_000);
  assert.equal(cfg.stream?.retries, 3, 'project wins the knob it sets');
});

test('onboarding stamps resilience knobs onto a self-hosted custom endpoint carrier entry', () => {
  persistOnboardTarget({
    provider: 'openai',
    model: 'qwen3.5-plus',
    baseUrl: 'http://10.0.0.5:8000/v1/chat/completions',
    customEndpoint: true,
    selfHosted: true,
  });
  const carrier = loadModels().find((m) => m.label === 'qwen3.5-plus');
  assert.ok(carrier, 'self-hosted onboarding must persist a carrier entry (no entry = no home for the knobs)');
  assert.equal(carrier.idleTimeoutMs, 300_000, 'loose idle budget stamped');
  assert.equal(carrier.firstByteTimeoutMs, 600_000, 'generous first-byte budget stamped');
  assert.equal(carrier.streamRetries, 8, 'high retry ceiling stamped');
  assert.equal(carrier.selfHosted, true);
});

test('onboarding a self-hosted target with NO catalog extras still gets a stamped carrier', () => {
  persistOnboardTarget({
    provider: 'openai',
    model: 'vllm-direct',
    baseUrl: LOCAL_URL,
    customEndpoint: true,
  });
  const carrier = loadModels().find((m) => m.label === 'vllm-direct');
  assert.ok(carrier, 'a custom self-hosted endpoint must carry its own entry');
  assert.equal(carrier.idleTimeoutMs, 300_000);
  assert.equal(carrier.firstByteTimeoutMs, 600_000);
  assert.equal(carrier.streamRetries, 8);
});

test('onboarding a PUBLIC endpoint leaves the tight budget untouched (no carrier, no knobs)', () => {
  persistOnboardTarget({
    provider: 'openai',
    model: 'gpt-4.1',
    baseUrl: PUBLIC_URL,
    customEndpoint: true,
  });
  const carrier = loadModels().find((m) => m.label === 'gpt-4.1');
  assert.equal(carrier, undefined, 'public targets must not gain a carrier entry');
});

test('a catalog preset declares its OWN idle budget verbatim (onboarding never overrides it)', () => {
  persistOnboardTarget({
    provider: 'openai',
    model: 'local-custom',
    baseUrl: LOCAL_URL,
    customEndpoint: true,
    entryExtras: { label: 'slow-preset', selfHosted: true, idleTimeoutMs: 900_000 },
  });
  const carrier = loadModels().find((m) => m.label === 'slow-preset');
  assert.ok(carrier);
  assert.equal(carrier.idleTimeoutMs, 900_000, 'preset-declared budget wins verbatim');
  assert.equal(carrier.firstByteTimeoutMs, 600_000, 'other knobs still stamped where the preset is silent');
});

function loadModels(): Array<Record<string, unknown>> {
  return (loadGlobalConfig().models as Array<Record<string, unknown>> | undefined) ?? [];
}
