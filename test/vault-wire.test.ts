import { test } from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync, existsSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { isolateHome, assertStoreIsolated } from './helpers/isolateHome.js';

// Redirect ~/.shadow to a throwaway HOME BEFORE importing the store (GLOBAL_DIR is derived
// from homedir() at module load), and PROVE the redirect took — these tests shred credential
// files, so a runner that ignores process.env.HOME would destroy a real ~/.shadow.
// See test/helpers/isolateHome.ts. Run with `npm test`, never `bun test`.
const { home: HOME, shadowDir: SHADOW } = isolateHome('wire');
const CREDS = join(SHADOW, 'credentials.json');

const store = await import('../src/state/globalStore.js');
assertStoreIsolated(store.GLOBAL_DIR, HOME);

test('getCredential prefers the unlocked vault over the plaintext credentials.json', () => {
  writeFileSync(CREDS, JSON.stringify({ anthropic: { apiKey: 'plaintext-key' } }));
  // Before unlock: reads the legacy plaintext file.
  assert.equal(store.getCredential('anthropic')?.apiKey, 'plaintext-key');

  // After unlock: the vault is the source of truth.
  store.setUnlockedVault({ anthropic: { apiKey: 'vault-key' }, openai: { apiKey: 'oai-vault' } } as never);
  assert.equal(store.getCredential('anthropic')?.apiKey, 'vault-key', 'vault wins over the file');
  assert.equal(store.getCredential('openai')?.apiKey, 'oai-vault');

  // Clearing the vault falls back to the plaintext file again.
  store.setUnlockedVault(null);
  assert.equal(store.getCredential('anthropic')?.apiKey, 'plaintext-key');
});

test('loadLegacyCredentials bypasses the vault cache (used only for one-time migration)', () => {
  writeFileSync(CREDS, JSON.stringify({ anthropic: { apiKey: 'on-disk' } }));
  store.setUnlockedVault({ anthropic: { apiKey: 'in-vault' } } as never);
  // getCredential sees the vault; loadLegacyCredentials must still read the raw file to migrate it.
  assert.equal(store.getCredential('anthropic')?.apiKey, 'in-vault');
  assert.equal(store.loadLegacyCredentials().anthropic?.apiKey, 'on-disk');
  store.setUnlockedVault(null);
});

test('saveCredential mutates the vault in memory (not the plaintext) while a vault is unlocked', () => {
  writeFileSync(CREDS, JSON.stringify({ anthropic: { apiKey: 'disk' } }));
  const before = readFileSync(CREDS, 'utf8');
  store.setUnlockedVault({ anthropic: { apiKey: 'vault' } } as never);
  store.saveCredential('anthropic', { apiKey: 'rotated' });
  assert.equal(store.getCredential('anthropic')?.apiKey, 'rotated', 'rotation is visible in-session');
  assert.equal(readFileSync(CREDS, 'utf8'), before, 'the plaintext file is NOT written to when a vault is active');
  store.setUnlockedVault(null);
});

test('shredLegacyCredentials overwrites then removes the plaintext file', () => {
  writeFileSync(CREDS, JSON.stringify({ anthropic: { apiKey: 'sk-secret-should-be-gone' } }));
  assert.ok(store.legacyCredentialsExist());
  store.shredLegacyCredentials();
  assert.equal(existsSync(CREDS), false, 'file removed');
  assert.equal(store.legacyCredentialsExist(), false);
});

test.after(() => rmSync(HOME, { recursive: true, force: true }));
