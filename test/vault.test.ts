import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { deriveKey, seal, open } from '../src/auth/vault.js';

test('vault: seal → open round-trips the secrets', () => {
  const salt = randomBytes(16);
  const key = deriveKey('correct horse battery staple', salt);
  const secrets = { anthropic: { apiKey: 'sk-ant-xxx' }, local: { baseUrl: 'http://127.0.0.1:8000/v1' } };
  const file = seal(secrets, key, salt);
  assert.deepEqual(open(file, key), secrets, 'decrypts to the same object');
  // The plaintext must NOT appear in the on-disk envelope.
  assert.ok(!JSON.stringify(file).includes('sk-ant-xxx'), 'ciphertext does not leak the key');
});

test('vault: deriveKey is deterministic for the same password+salt, different for a different salt', () => {
  const salt = randomBytes(16);
  assert.ok(deriveKey('pw', salt).equals(deriveKey('pw', salt)), 'same inputs → same key');
  assert.ok(!deriveKey('pw', salt).equals(deriveKey('pw', randomBytes(16))), 'different salt → different key');
});

test('vault: a WRONG password cannot open the vault (GCM auth failure, not garbage)', () => {
  const salt = randomBytes(16);
  const good = deriveKey('the-real-password', salt);
  const file = seal({ apiKey: 'secret' }, good, salt);
  const bad = deriveKey('a-guess', salt);
  assert.throws(() => open(file, bad), 'wrong key throws rather than returning corrupt data');
});

test('vault: a TAMPERED ciphertext is rejected (integrity)', () => {
  const salt = randomBytes(16);
  const key = deriveKey('pw', salt);
  const file = seal({ apiKey: 'secret' }, key, salt);
  // Flip a byte in the ciphertext.
  const raw = Buffer.from(file.ct, 'base64');
  raw[0] ^= 0xff;
  const tampered = { ...file, ct: raw.toString('base64') };
  assert.throws(() => open(tampered, key), 'tampered ciphertext fails the GCM auth tag');
});
