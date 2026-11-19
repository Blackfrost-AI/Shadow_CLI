import test from 'node:test';
import assert from 'node:assert/strict';
import { isolateHome, assertStoreIsolated } from './helpers/isolateHome.js';

const { home } = isolateHome('ops-redact');
const globalStore = await import('../src/state/globalStore.js');
assertStoreIsolated(globalStore.GLOBAL_DIR, home);
const { assertNoSecrets, gatePayload, scrubEnv, payloadBytes } = await import('../src/security/ops/redact.js');
const { SecretInPayloadError, MAX_PAYLOAD_BYTES } = await import('../src/security/ops/types.js');

// All fixture secrets are obviously-fake strings (§11).
const FAKE_AWS = 'AKIA' + 'F'.repeat(16);
const FAKE_SK = 'sk-' + 'z'.repeat(24);
const FAKE_PEM_BLOCK = '-----BEGIN RSA PRIVATE KEY-----\nZmFrZWtleWJvZHlub3RyZWFs\n-----END RSA PRIVATE KEY-----';

test('planted fake AWS key rejected', () => {
  assert.throws(() => assertNoSecrets({ note: `found key ${FAKE_AWS} in config` }), SecretInPayloadError);
});

test('planted fake PEM private-key block rejected', () => {
  assert.throws(() => assertNoSecrets({ detail: FAKE_PEM_BLOCK }), SecretInPayloadError);
});

test('planted fake sk- token rejected', () => {
  assert.throws(() => assertNoSecrets({ detail: `endpoint key ${FAKE_SK}` }), SecretInPayloadError);
  assert.throws(() => assertNoSecrets([FAKE_SK]), SecretInPayloadError);
});

test('secret-named keys rejected even when masked or short', () => {
  assert.throws(() => assertNoSecrets({ token: 'x' }), SecretInPayloadError);
  assert.throws(() => assertNoSecrets({ API_KEY: '[REDACTED]' }), SecretInPayloadError);
  assert.throws(() => assertNoSecrets({ nested: { password: 'hunter2' } }), SecretInPayloadError);
  // Empty values pass; non-credential key names carrying masked text pass.
  assertNoSecrets({ token: '' });
  assertNoSecrets({ note: 'credential was [REDACTED] before storage' });
});

test('clean payloads pass', () => {
  assertNoSecrets({ path: '/srv/app/login.ts', severity: 'high', summary: 'missing rate limit on /login' });
  assertNoSecrets({ targets: ['/srv/app'], anchors: [1, 2], verified: true });
  assertNoSecrets('plain text about a vulnerability');
});

test('8 KiB payload cap enforced', () => {
  const big = { blob: 'x'.repeat(MAX_PAYLOAD_BYTES) };
  assert.ok(payloadBytes(big) > MAX_PAYLOAD_BYTES);
  assert.throws(() => gatePayload(big), /cap/);
  gatePayload({ blob: 'x'.repeat(100) });
});

test('scrubEnv allowlist exact: PATH HOME LANG TMPDIR only', () => {
  const env = scrubEnv({
    PATH: '/usr/bin',
    HOME: '/h',
    LANG: 'C',
    TMPDIR: '/t',
    TZ: 'UTC',
    OPENAI_API_KEY: FAKE_SK,
    AWS_SECRET_ACCESS_KEY: 'fake',
    LC_ALL: 'C',
    CUSTOM: 'no',
  });
  assert.deepEqual(Object.keys(env).sort(), ['HOME', 'LANG', 'PATH', 'TMPDIR']);
});