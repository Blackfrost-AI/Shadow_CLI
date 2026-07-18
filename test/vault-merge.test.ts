import { test } from 'node:test';
import assert from 'node:assert/strict';
import { rmSync } from 'node:fs';
import { isolateHome, assertStoreIsolated } from './helpers/isolateHome.js';

// Isolate ~/.shadow AND disable the keychain (empty PATH → the backend probe ENOENTs) so the merge
// path exercises the master-password branch and never touches the real login keychain. GLOBAL_DIR is
// frozen at import from this HOME, so tests run in order: no-vault cases FIRST, then create, then merge.
// isolateHome() PROVES the redirect took effect — this file writes a real vault, and a runner that
// ignores process.env.HOME would write it over the user's own. Run with `npm test`, never `bun test`.
const { home: HOME } = isolateHome('merge');
process.env.PATH = '';
delete process.env.SHADOW_VAULT_PASSWORD;

const { persistOnboardSecret } = await import('../src/onboard/webOnboard.js');
const { unlockWithPassword, vaultExists } = await import('../src/auth/vault.js');
const { GLOBAL_DIR } = await import('../src/state/globalStore.js');
assertStoreIsolated(GLOBAL_DIR, HOME);

const PW = 'correct horse battery';

test('creating a fresh vault rejects a weak master password (no vault yet)', () => {
  assert.equal(vaultExists(), false, 'precondition: no vault');
  assert.throws(() => persistOnboardSecret({ provider: 'openai', apiKey: 'x', password: 'short' }), /weak-password/);
  assert.equal(vaultExists(), false, 'nothing was written');
});

test('first onboard creates the vault (merged=false)', () => {
  const r = persistOnboardSecret({ provider: 'anthropic', apiKey: 'sk-ANTHROPIC', password: PW });
  assert.equal(r.merged, false, 'a fresh vault is created, not merged');
  assert.ok(vaultExists());
  assert.equal(unlockWithPassword(PW).data.anthropic?.apiKey, 'sk-ANTHROPIC');
});

test('second onboard MERGES into the existing vault, keeping the first key', () => {
  const r = persistOnboardSecret({ provider: 'openai', apiKey: 'sk-OPENAI', password: PW });
  assert.equal(r.merged, true, 'adds to the existing vault');
  const data = unlockWithPassword(PW).data;
  assert.equal(data.anthropic?.apiKey, 'sk-ANTHROPIC', 'the pre-existing key survives (no overwrite)');
  assert.equal(data.openai?.apiKey, 'sk-OPENAI', 'the new key is present');
});

test('merge with the WRONG master password is rejected (bad-password), vault untouched', () => {
  assert.throws(
    () => persistOnboardSecret({ provider: 'openai', apiKey: 'sk-EVIL', password: 'wrong password' }),
    /bad-password/,
  );
  assert.equal(unlockWithPassword(PW).data.openai?.apiKey, 'sk-OPENAI', 'the real key is unchanged');
});

test('merge with NO password (and no keychain) asks for one (need-password)', () => {
  assert.throws(() => persistOnboardSecret({ provider: 'openai', apiKey: 'x' }), /need-password/);
});

test.after(() => rmSync(HOME, { recursive: true, force: true }));
