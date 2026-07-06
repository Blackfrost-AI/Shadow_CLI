import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createPkce, randomState, base64url } from '../src/auth/pkce.js';

test('PKCE verifier is RFC-7636 length (43–128) and base64url', () => {
  for (let i = 0; i < 50; i++) {
    const { verifier } = createPkce();
    assert.ok(verifier.length >= 43 && verifier.length <= 128, `len ${verifier.length}`);
    assert.match(verifier, /^[A-Za-z0-9_-]+$/); // no +, /, or = padding
  }
});

test('PKCE challenge = base64url(sha256(verifier)), method S256', () => {
  const { verifier, challenge, method } = createPkce();
  assert.equal(method, 'S256');
  assert.equal(challenge, base64url(createHash('sha256').update(verifier).digest()));
});

test('createPkce and randomState produce fresh values each call', () => {
  const a = createPkce();
  const b = createPkce();
  assert.notEqual(a.verifier, b.verifier);
  assert.notEqual(randomState(), randomState());
});
