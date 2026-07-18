import test from 'node:test';
import assert from 'node:assert/strict';
import { rmSync, readFileSync, existsSync, writeFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { isolateHome, assertStoreIsolated } from './helpers/isolateHome.js';

// isolateHome() BEFORE any import that derives paths from homedir(), and prove it took.
// This file CREATES A VAULT and REWRITES config.json — under a runner that ignores
// process.env.HOME it would do that to the user's real ~/.shadow. Run with `npm test`.
const { home: HOME, shadowDir: SHADOW } = isolateHome('credref-migrate');
process.env.PATH = ''; // no keychain backend
delete process.env.SHADOW_VAULT_PASSWORD;

const store = await import('../src/state/globalStore.js');
assertStoreIsolated(store.GLOBAL_DIR, HOME);
const vault = await import('../src/auth/vault.js');
const { migratePresetKeysIntoVault, slugSlotId, countPlaintextPresetKeys } = await import(
  '../src/auth/credRefMigrate.js'
);

/** The session key for the vault under test; set once the vault is created. */
let sessionKey: Buffer | undefined;
/** Migrate using the key this process holds (production reads it from the unlock flow). */
const migrate = (): ReturnType<typeof migratePresetKeysIntoVault> =>
  migratePresetKeysIntoVault(() => {}, { key: sessionKey });
const { resolveEntryCredential } = await import('../src/config.js');

const CONFIG = join(SHADOW, 'config.json');
const PW = 'correct horse battery';

// Distinctive sentinels so we can grep the raw file bytes for any survivor.
const S_ZAI = 'sk-test-ZAI-SENTINEL-aaa';
const S_ANT = 'sk-test-ANTHROPIC-SENTINEL-bbb';
const S_GEM = 'sk-test-GEMINI-SENTINEL-ccc';

function seedConfig(models: unknown[]): void {
  writeFileSync(CONFIG, JSON.stringify({ provider: 'openai', model: 'a', models }, null, 2), { mode: 0o600 });
}

const PRESETS = [
  { label: 'GLM 5.2 API (z.ai)', provider: 'openai', model: 'glm-5.2', baseUrl: 'https://api.z.ai/v1', apiKey: S_ZAI },
  { label: 'Anthropic Opus', provider: 'anthropic', model: 'claude-opus-4-8', apiKey: S_ANT },
  { label: 'Gemini Flash', provider: 'openai', model: 'gemini-2.0-flash', apiKey: S_GEM },
  { label: 'No key preset', provider: 'openai', model: 'local', baseUrl: 'http://127.0.0.1:8000/v1' },
];

test.after(() => rmSync(HOME, { recursive: true, force: true }));

test('locked vault does NOT scrub: config bytes are untouched', () => {
  seedConfig(PRESETS);
  const before = readFileSync(CONFIG, 'utf8');
  store.setUnlockedVault(null); // locked

  const r = migrate();
  assert.equal(r.migrated, 0);
  assert.equal(r.skipped, 'locked');
  assert.equal(readFileSync(CONFIG, 'utf8'), before, 'never destroy what cannot be sealed');

  // And the inline keys still serve requests, so a locked vault does not break the user.
  const cred = resolveEntryCredential(PRESETS[0]);
  assert.equal(cred.ok && cred.apiKey, S_ZAI);
});

test('ACCEPTANCE: after migration config.json holds no key material', () => {
  seedConfig(PRESETS);
  assert.equal(countPlaintextPresetKeys(), 3);

  const key = vault.createVault(PW, { openai: { apiKey: 'adapter-key' } } as never);
  store.setUnlockedVault(vault.unlockWithKey(key) as never);
  sessionKey = key;
  

  const r = migrate();
  assert.equal(r.migrated, 3);

  // Force a full merge-rewrite of config.json — the path that used to re-serialize keys.
  store.saveGlobalConfig({ lastStyle: 'explanatory' });

  const raw = readFileSync(CONFIG, 'utf8');
  assert.equal(/"apiKey"/.test(raw), false, 'no apiKey field survives');
  assert.equal(/"authToken"/.test(raw), false, 'no authToken field survives');
  for (const s of [S_ZAI, S_ANT, S_GEM]) {
    assert.equal(raw.includes(s), false, `sentinel ${s} must be gone from config.json`);
  }

  // The keys are in the vault, and the vault is ciphertext (sentinels not readable on disk).
  const vaultRaw = readFileSync(join(SHADOW, 'vault.enc'), 'utf8');
  for (const s of [S_ZAI, S_ANT, S_GEM]) {
    assert.equal(vaultRaw.includes(s), false, 'vault must be encrypted, not plaintext');
  }

  // Pointers replaced them, and the keyless preset was left alone.
  const models = JSON.parse(raw).models as Array<{ credRef?: string; label: string }>;
  assert.deepEqual(
    models.map((m) => m.credRef ?? null),
    ['model.glm-5-2-api-z-ai', 'model.anthropic-opus', 'model.gemini-flash', null],
  );
  assert.equal(countPlaintextPresetKeys(), 0);
});

test('the migrated keys still resolve after a fresh unlock from disk', () => {
  // Re-derive from the password, exactly as a new process would.
  store.setUnlockedVault(null);
  const { data, key } = vault.unlockWithPassword(PW);
  store.setUnlockedVault(data as never);
  sessionKey = key;
  

  const models = JSON.parse(readFileSync(CONFIG, 'utf8')).models as Array<Record<string, unknown>>;
  assert.equal(resolveEntryCredential(models[0]).ok && resolveEntryCredential(models[0]).apiKey, S_ZAI);
  assert.equal(resolveEntryCredential(models[1]).ok && resolveEntryCredential(models[1]).apiKey, S_ANT);
  assert.equal(resolveEntryCredential(models[2]).ok && resolveEntryCredential(models[2]).apiKey, S_GEM);
});

test('a pre-migration backup of config.json is left behind', () => {
  const bak = join(SHADOW, 'config.json.pre-credref.bak');
  assert.ok(existsSync(bak), 'backup exists — the scrub is irreversible without it');
  assert.ok(readFileSync(bak, 'utf8').includes(S_ZAI), 'backup holds the pre-scrub content');
  assert.equal(statSync(bak).mode & 0o777, 0o600, 'backup is owner-only');
});

test('migration is idempotent — a second run moves nothing and keeps slot ids stable', () => {
  const before = readFileSync(CONFIG, 'utf8');
  const r = migrate();
  assert.equal(r.migrated, 0);
  assert.equal(r.skipped, 'nothing-to-do');
  assert.equal(readFileSync(CONFIG, 'utf8'), before);
  assert.equal(/-2"/.test(before), false, 'no collision suffixes appeared on re-run');
});

test('two presets sharing one key share one slot', () => {
  const shared = 'sk-test-SHARED-ddd';
  seedConfig([
    { label: 'Anth One', provider: 'anthropic', model: 'm1', apiKey: shared },
    { label: 'Anth Two', provider: 'anthropic', model: 'm2', apiKey: shared },
  ]);
  const r = migrate();
  assert.equal(r.migrated, 2);
  const models = JSON.parse(readFileSync(CONFIG, 'utf8')).models as Array<{ credRef: string }>;
  assert.equal(models[0].credRef, models[1].credRef, 'identical secrets dedupe to one slot');
});

test('slug collisions get distinct slots', () => {
  seedConfig([
    { label: 'GLM 4.6', provider: 'openai', model: 'a', apiKey: 'k1' },
    { label: 'glm-4-6', provider: 'openai', model: 'b', apiKey: 'k2' },
  ]);
  migrate();
  const models = JSON.parse(readFileSync(CONFIG, 'utf8')).models as Array<{ credRef: string }>;
  assert.equal(models[0].credRef, 'model.glm-4-6');
  assert.equal(models[1].credRef, 'model.glm-4-6-2');
  assert.notEqual(models[0].credRef, models[1].credRef);
});

test('slugSlotId never derives from the secret', () => {
  assert.equal(slugSlotId('GLM 5.2 API (z.ai)'), 'model.glm-5-2-api-z-ai');
  assert.equal(slugSlotId('!!!'), 'model.preset');
});
