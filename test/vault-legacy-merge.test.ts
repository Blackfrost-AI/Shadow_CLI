import { test } from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync, existsSync, rmSync } from 'node:fs';
import { isolateHome, assertStoreIsolated } from './helpers/isolateHome.js';

// Isolate ~/.shadow and disable the keychain (same drill as vault-merge.test.ts) so onboarding
// exercises the password branch and never touches the real login keychain. Run with `npm test`.
const { home: HOME } = isolateHome('merge-legacy');
process.env.PATH = '';
delete process.env.SHADOW_VAULT_PASSWORD;

const { persistOnboardSecret } = await import('../src/onboard/webOnboard.js');
const { unlockWithPassword } = await import('../src/auth/vault.js');
const { GLOBAL_DIR, credentialsPath } = await import('../src/state/globalStore.js');
assertStoreIsolated(GLOBAL_DIR, HOME);

const PW = 'correct horse battery';
const credsFile = (): string => credentialsPath();
const writeLegacy = (creds: Record<string, unknown>): void => {
  writeFileSync(credsFile(), JSON.stringify(creds), { mode: 0o600 });
};
const stored = (data: Record<string, unknown>, provider: string): { apiKey?: string } | undefined =>
  data[provider] as { apiKey?: string } | undefined;

test('fresh vault over a legacy credentials.json: legacy keys ride along, then the plaintext is shredded', () => {
  writeLegacy({ openai: { apiKey: 'sk-LEGACY-OPENAI' } });
  const r = persistOnboardSecret({ provider: 'anthropic', apiKey: 'sk-ANTHROPIC', password: PW });
  assert.equal(r.merged, false, 'no vault existed — a fresh one is created');
  const data = unlockWithPassword(PW).data;
  assert.equal(stored(data, 'anthropic')?.apiKey, 'sk-ANTHROPIC', 'the new key is sealed');
  assert.equal(stored(data, 'openai')?.apiKey, 'sk-LEGACY-OPENAI', 'the legacy key is MERGED, not shredded with the file');
  assert.equal(existsSync(credsFile()), false, 'the plaintext is shredded only after the sealed vault verified');
});

test('merge path: a legacy file that appeared after the vault is folded in (vault wins on conflict)', () => {
  writeLegacy({ openai: { apiKey: 'sk-OLD' }, anthropic: { apiKey: 'sk-IGNORED' } });
  const r = persistOnboardSecret({ provider: 'openai', apiKey: 'sk-NEW', password: PW });
  assert.equal(r.merged, true, 'added to the existing vault');
  const data = unlockWithPassword(PW).data;
  assert.equal(stored(data, 'openai')?.apiKey, 'sk-NEW', 'the vault wins on conflict — it is the deliberate store');
  assert.equal(stored(data, 'anthropic')?.apiKey, 'sk-ANTHROPIC', 'existing vault keys survive');
  assert.equal(existsSync(credsFile()), false);
});

test.after(() => rmSync(HOME, { recursive: true, force: true }));
