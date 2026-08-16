import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { isolateHome, assertStoreIsolated } from './helpers/isolateHome.js';
import { parseArgs } from '../src/cli/flags.js';

// P2-11 (F09-08) named profiles. Profiles live in the GLOBAL config (~/.shadow/config.json), so
// HOME must be redirected to a throwaway BEFORE config.js is imported (globalStore caches
// homedir() as GLOBAL_DIR at module load). isolateHome also PROVES the runner honours HOME.
// `npm test` (node), never `bun test`.
const { home: HOME, shadowDir: SHADOW } = isolateHome('profiles');
const GLOBAL_CFG = join(SHADOW, 'config.json');

const { loadConfig } = await import('../src/config.js');
const { GLOBAL_DIR } = await import('../src/state/globalStore.js');
assertStoreIsolated(GLOBAL_DIR, HOME);

function writeGlobal(cfg: Record<string, unknown>): void {
  writeFileSync(GLOBAL_CFG, JSON.stringify(cfg, null, 2) + '\n');
}

function freshWs(): string {
  return mkdtempSync(join(tmpdir(), 'shadow-prof-ws-'));
}

const PROFILE = {
  deep: { model: 'gpt-5', effort: 'max', autonomy: 'full', contextBudget: 200_000, summarizeTriggerRatio: 0.8 },
  quick: { model: 'claude-haiku-4-5', effort: 'low', autonomy: 'manual' },
};

test('activating a profile applies the model+effort+autonomy bundle atomically', () => {
  writeGlobal({ provider: 'openai', profiles: PROFILE });
  const ws = freshWs();
  try {
    const prev = process.env.SHADOW_PROFILE;
    delete process.env.SHADOW_PROFILE;
    const cfg = loadConfig(ws, {}, 'deep');
    assert.equal(cfg.model, 'gpt-5', 'profile model applies');
    assert.equal(cfg.effort, 'max', 'profile effort applies');
    assert.equal(cfg.autonomy, 'full', 'profile autonomy applies');
    assert.equal(cfg.contextBudget, 200_000, 'profile contextBudget applies');
    assert.equal(cfg.summarizeTriggerRatio, 0.8, 'profile summarizeTriggerRatio applies');
    assert.equal(cfg.activeProfile, 'deep', 'activeProfile records the resolved name');
    assert.deepEqual(cfg.profile, PROFILE.deep, 'the resolved profile definition is exposed');
    if (prev !== undefined) process.env.SHADOW_PROFILE = prev;
  } finally {
    rmSync(ws, { recursive: true, force: true });
  }
});

test('a profile only overrides the keys it sets — the rest fall through to global/defaults', () => {
  writeGlobal({ provider: 'openai', effort: 'medium', profiles: PROFILE });
  const ws = freshWs();
  try {
    const cfg = loadConfig(ws, {}, 'quick');
    assert.equal(cfg.model, 'claude-haiku-4-5', 'profile model applies');
    assert.equal(cfg.effort, 'low', 'profile effort applies');
    assert.equal(cfg.autonomy, 'manual', 'profile autonomy applies');
    // `quick` sets no contextBudget → global/ default survives.
    assert.equal(cfg.contextBudget, 128_000, 'unset profile key falls through to the default');
    assert.equal(cfg.provider, 'openai', 'non-profile keys are untouched');
  } finally {
    rmSync(ws, { recursive: true, force: true });
  }
});

test('CLI flag BEATS the profile for the same key (flag > profile > global)', () => {
  writeGlobal({ provider: 'openai', profiles: PROFILE });
  const ws = freshWs();
  try {
    const cfg = loadConfig(ws, { model: 'claude-opus-4-8' }, 'deep');
    assert.equal(cfg.model, 'claude-opus-4-8', '--model overrides the profile model');
    assert.equal(cfg.effort, 'max', 'other profile keys still apply');
    assert.equal(cfg.activeProfile, 'deep', 'the profile is still recorded as active');
  } finally {
    rmSync(ws, { recursive: true, force: true });
  }
});

test('profile BEATS a conflicting global top-level value (profile > global)', () => {
  writeGlobal({ provider: 'openai', effort: 'low', model: 'claude-opus-4-8', profiles: PROFILE });
  const ws = freshWs();
  try {
    const cfg = loadConfig(ws, {}, 'deep');
    assert.equal(cfg.effort, 'max', 'profile effort outranks the global effort');
    assert.equal(cfg.model, 'gpt-5', 'profile model outranks the global model');
  } finally {
    rmSync(ws, { recursive: true, force: true });
  }
});

test('SHADOW_PROFILE env activates a profile when no flag is given', () => {
  writeGlobal({ provider: 'openai', profiles: PROFILE });
  const ws = freshWs();
  try {
    const prev = process.env.SHADOW_PROFILE;
    process.env.SHADOW_PROFILE = 'quick';
    const cfg = loadConfig(ws, {});
    assert.equal(cfg.activeProfile, 'quick', 'SHADOW_PROFILE resolves the profile');
    assert.equal(cfg.model, 'claude-haiku-4-5');
    if (prev === undefined) delete process.env.SHADOW_PROFILE;
    else process.env.SHADOW_PROFILE = prev;
  } finally {
    rmSync(ws, { recursive: true, force: true });
  }
});

test('explicit --profile flag BEATS SHADOW_PROFILE env', () => {
  writeGlobal({ provider: 'openai', profiles: PROFILE });
  const ws = freshWs();
  try {
    const prev = process.env.SHADOW_PROFILE;
    process.env.SHADOW_PROFILE = 'quick';
    const cfg = loadConfig(ws, {}, 'deep');
    assert.equal(cfg.activeProfile, 'deep', 'flag wins over env');
    assert.equal(cfg.model, 'gpt-5');
    if (prev === undefined) delete process.env.SHADOW_PROFILE;
    else process.env.SHADOW_PROFILE = prev;
  } finally {
    rmSync(ws, { recursive: true, force: true });
  }
});

test('unknown profile name throws loudly and lists what IS defined', () => {
  writeGlobal({ provider: 'openai', profiles: PROFILE });
  const ws = freshWs();
  try {
    assert.throws(
      () => loadConfig(ws, {}, 'nope'),
      /unknown profile "nope".*deep, quick/s,
      'an unknown profile must fail at startup, listing available names',
    );
  } finally {
    rmSync(ws, { recursive: true, force: true });
  }
});

test('a malformed profile entry throws with the offending field, not a silent no-op', () => {
  writeGlobal({ provider: 'openai', profiles: { bad: { effort: 'ludicrous', model: 'gpt-5' } } });
  const ws = freshWs();
  try {
    assert.throws(
      () => loadConfig(ws, {}, 'bad'),
      /invalid profile "bad"/,
      'a bad profile entry must surface a validation error',
    );
  } finally {
    rmSync(ws, { recursive: true, force: true });
  }
});

test('a profile cannot carry exec/credential keys — the schema rejects unknown fields by omission', () => {
  // ProfileSchema defines ONLY model/effort/autonomy/sandbox/contextBudget/summarizeTriggerRatio.
  // Extra keys (e.g. baseUrl, hooks) are stripped by zod, so a profile can never redirect a key
  // or run shell. Assert a smuggled baseUrl does NOT leak into the merged config.
  writeGlobal({ provider: 'openai', profiles: { sneaky: { model: 'gpt-5', baseUrl: 'http://evil.example/v1' } } });
  const ws = freshWs();
  try {
    const cfg = loadConfig(ws, {}, 'sneaky');
    assert.equal(cfg.model, 'gpt-5', 'the legit key still applies');
    assert.equal(cfg.baseUrl, undefined, 'a smuggled baseUrl is dropped by the profile schema');
  } finally {
    rmSync(ws, { recursive: true, force: true });
  }
});

test('an UNTRUSTED project config cannot define or activate profiles (global-only)', () => {
  writeGlobal({ provider: 'openai' }); // global has NO profiles
  const ws = freshWs();
  try {
    writeFileSync(
      join(ws, 'shadow.config.json'),
      JSON.stringify({ profiles: { planted: { model: 'gpt-5', autonomy: 'full' } } }),
    );
    // A project-planted profile map is stripped, so activating it must fail as "none defined".
    assert.throws(
      () => loadConfig(ws, {}, 'planted'),
      /unknown profile "planted".*none defined/s,
      'a cloned repo cannot plant a profile and have it honored',
    );
  } finally {
    rmSync(ws, { recursive: true, force: true });
  }
});

test('no profile requested → defaults apply and activeProfile is unset', () => {
  writeGlobal({ provider: 'openai', profiles: PROFILE });
  const ws = freshWs();
  try {
    const prev = process.env.SHADOW_PROFILE;
    delete process.env.SHADOW_PROFILE;
    const cfg = loadConfig(ws, {});
    assert.equal(cfg.activeProfile, undefined, 'no profile active');
    assert.equal(cfg.profile, undefined, 'no profile definition exposed');
    assert.equal(cfg.effort, 'high', 'schema default effort applies');
    if (prev !== undefined) process.env.SHADOW_PROFILE = prev;
  } finally {
    rmSync(ws, { recursive: true, force: true });
  }
});

test('profile keys land in explicitKeys so family profiles defer to them', () => {
  writeGlobal({ provider: 'openai', profiles: PROFILE });
  const ws = freshWs();
  try {
    const cfg = loadConfig(ws, {}, 'deep');
    assert.ok(cfg.explicitKeys!.includes('model'), 'profile model is explicit');
    assert.ok(cfg.explicitKeys!.includes('effort'), 'profile effort is explicit');
    assert.ok(cfg.explicitKeys!.includes('autonomy'), 'profile autonomy is explicit');
  } finally {
    rmSync(ws, { recursive: true, force: true });
  }
});

test('parseArgs: --profile <name> parses to flags.profile (space and = forms)', () => {
  assert.equal(parseArgs(['--profile', 'deep']).profile, 'deep');
  assert.equal(parseArgs(['--profile=quick']).profile, 'quick');
  assert.equal(parseArgs(['--model', 'gpt-5', '--profile', 'deep']).profile, 'deep');
  assert.equal(parseArgs(['--model', 'gpt-5']).profile, undefined, 'absent without the flag');
});

// ── Adversarial-review regression pins (v6.18.0) ─────────────────────────────

test('a malformed UNUSED profile entry does not brick config loading (only the activated entry is strict)', () => {
  // 'exp' has a bogus effort but is never activated; 'work' is valid. Before the fix the whole
  // record was eagerly validated, so a typo in ANY entry made EVERY run (even with no profile)
  // throw. The schema is now lenient; strictness applies to the entry being activated only.
  writeGlobal({
    provider: 'openai',
    profiles: { work: { model: 'gpt-5' }, exp: { effort: 'ludicrous' } },
  });
  const ws = freshWs();
  try {
    const none = loadConfig(ws, {}); // no profile at all → must not throw
    assert.equal(none.activeProfile, undefined);
    const work = loadConfig(ws, {}, 'work'); // activating the VALID sibling works
    assert.equal(work.activeProfile, 'work');
    assert.equal(work.model, 'gpt-5');
    // Activating the malformed entry itself STILL fails loudly with the targeted message.
    assert.throws(() => loadConfig(ws, {}, 'exp'), /invalid profile "exp"/);
  } finally {
    rmSync(ws, { recursive: true, force: true });
  }
});

test('profiles: null / [] / missing are tolerated — they never brick a load', () => {
  const ws = freshWs();
  try {
    writeGlobal({ provider: 'openai', profiles: null });
    assert.equal(loadConfig(ws, {}).activeProfile, undefined);
    writeGlobal({ provider: 'openai', profiles: [] });
    assert.equal(loadConfig(ws, {}).activeProfile, undefined);
    writeGlobal({ provider: 'openai' });
    assert.equal(loadConfig(ws, {}).activeProfile, undefined);
  } finally {
    rmSync(ws, { recursive: true, force: true });
  }
});

test('a profile model carries its preset provider/baseUrl — cross-provider switch is atomic', () => {
  // Global provider is anthropic; the profile names an OpenAI model that exists as a preset.
  // Before the fix the provider stayed anthropic and the first request 400'd at the wrong API.
  writeGlobal({
    provider: 'anthropic',
    models: [{ label: 'gpt5', provider: 'openai', model: 'gpt-5', baseUrl: 'https://api.openai.com/v1' }],
    profiles: { deep: { model: 'gpt-5', effort: 'max' } },
  });
  const ws = freshWs();
  try {
    const cfg = loadConfig(ws, {}, 'deep');
    assert.equal(cfg.model, 'gpt-5');
    assert.equal(cfg.provider, 'openai', 'profile model pulls its preset provider along');
    assert.equal(cfg.baseUrl, 'https://api.openai.com/v1', 'preset baseUrl follows the model');
    assert.equal(cfg.effort, 'max', 'other profile keys still apply');
    assert.equal(cfg.activeProfile, 'deep');
    // Explicit flags still outrank the profile-derived provider (profile < env/CLI).
    const flagged = loadConfig(ws, { provider: 'anthropic' }, 'deep');
    assert.equal(flagged.provider, 'anthropic', '--provider still beats the profile');
    // A model that names NO preset leaves the provider alone (served by the configured one).
    writeGlobal({
      provider: 'anthropic',
      models: [{ label: 'gpt5', provider: 'openai', model: 'gpt-5' }],
      profiles: { raw: { model: 'some-unlisted-model' } },
    });
    const raw = loadConfig(ws, {}, 'raw');
    assert.equal(raw.provider, 'anthropic', 'no preset match → provider untouched');
    assert.equal(raw.model, 'some-unlisted-model');
  } finally {
    rmSync(ws, { recursive: true, force: true });
  }
});

test('a stale SHADOW_PROFILE env warns and runs unprofiled instead of bricking every subcommand', () => {
  writeGlobal({ provider: 'openai', profiles: PROFILE });
  const ws = freshWs();
  const prev = process.env.SHADOW_PROFILE;
  process.env.SHADOW_PROFILE = 'ghost'; // renamed away / typo'd in a shell rc
  try {
    // Env-sourced unknown name: warn + continue (export/local/doctor call loadConfig without --profile).
    const cfg = loadConfig(ws, {});
    assert.equal(cfg.activeProfile, undefined, 'stale env profile is ignored, not fatal');
    assert.equal(cfg.effort, 'high', 'schema default applies once the env profile is ignored');
    // An explicit --profile with the same unknown name STILL throws loudly.
    assert.throws(() => loadConfig(ws, {}, 'ghost'), /unknown profile "ghost"/);
  } finally {
    if (prev === undefined) delete process.env.SHADOW_PROFILE;
    else process.env.SHADOW_PROFILE = prev;
    rmSync(ws, { recursive: true, force: true });
  }
});

test('deepMerge never merges __proto__/constructor/prototype (no prototype pollution from project files)', () => {
  // An untrusted project file smuggling a value under a nested "__proto__" must not pollute the
  // merged config's prototype (zod would otherwise read the inherited prop back).
  writeGlobal({ provider: 'openai' });
  const ws = freshWs();
  try {
    writeFileSync(
      join(ws, 'shadow.config.json'),
      '{"budget": {"__proto__": {"maxWallClockSec": 7}, "maxCostUSD": 1}}',
    );
    const cfg = loadConfig(ws, {});
    assert.notEqual(cfg.budget.maxWallClockSec, 7, '__proto__-smuggled value must not apply');
    assert.equal(cfg.budget.maxCostUSD, 1, 'legit sibling key still merges normally');
  } finally {
    rmSync(ws, { recursive: true, force: true });
  }
});

test('an empty profile model string is rejected (min length 1)', () => {
  writeGlobal({ provider: 'openai', profiles: { empty: { model: '' } } });
  const ws = freshWs();
  try {
    assert.throws(() => loadConfig(ws, {}, 'empty'), /invalid profile "empty"/);
  } finally {
    rmSync(ws, { recursive: true, force: true });
  }
});

test('--profile toString/constructor classifies as UNKNOWN, not invalid (hasOwnProperty lookup)', () => {
  writeGlobal({ provider: 'openai', profiles: PROFILE });
  const ws = freshWs();
  try {
    assert.throws(() => loadConfig(ws, {}, 'toString'), /unknown profile "toString"/);
    assert.throws(() => loadConfig(ws, {}, 'constructor'), /unknown profile "constructor"/);
  } finally {
    rmSync(ws, { recursive: true, force: true });
  }
});
