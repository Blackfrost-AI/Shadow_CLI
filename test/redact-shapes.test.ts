import { test } from 'node:test';
import assert from 'node:assert/strict';
import { redact, redactConfig, redactString } from '../src/util/redact.js';

// The scrubber the session log and exported transcripts rely on: a leaked secret in a tool result
// must not land on disk.

test('redactString masks private-key blocks and AWS secret access keys', () => {
  const pem = [
    '-----BEGIN OPENSSH PRIVATE KEY-----',
    'b3BlbnNzaC1rZXktdjEAAAAABG5vbmUAAAAEbm9uZQAAAAAAAAABAAAAMwAAAAtzc2gtZW',
    'QyNTUxOQAAACDxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx',
    '-----END OPENSSH PRIVATE KEY-----',
  ].join('\n');
  const out = redactString(`key file follows:\n${pem}\ntrailing text`);
  assert.ok(!out.includes('b3BlbnNzaC1rZXktdjEAAAAA'), 'the key body must not survive');
  assert.ok(out.includes('trailing text'), 'surrounding text is preserved');
  assert.ok(!out.includes('BEGIN OPENSSH PRIVATE KEY-----\nb3Bl'), 'the body is gone');

  for (const line of [
    'AWS_SECRET_ACCESS_KEY=wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY',
    'aws_secret_access_key = "wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY"',
    'SecretAccessKey: wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY',
  ]) {
    const masked = redactString(line);
    assert.ok(!masked.includes('wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY'), `unmasked: ${line}`);
    assert.ok(masked.includes('[REDACTED]'), `no marker: ${line}`);
  }
});

test('a shared object reference is redacted EVERYWHERE, not just on first visit', () => {
  // The cycle guard used to work as a whole-traversal "already visited" set, so the second and later
  // occurrences of the same object were returned RAW — anything aliased twice reached the session
  // log unredacted. Shared references (a DAG) must reuse the redacted copy.
  const shared = { apiKey: 'sk-live-abcdefghijklmnop1234', nested: { token: 'ghp_abcdefghijklmnopqrstuvwxyz0123456789' } };
  const input = { first: shared, second: shared, list: [shared, shared] };
  const out = redact(input) as typeof input;

  const json = JSON.stringify(out);
  assert.ok(!json.includes('sk-live-abcdefghijklmnop1234'), `raw key survived: ${json}`);
  assert.ok(!json.includes('ghp_abcdefghijklmnopqrstuvwxyz0123456789'), `raw token survived: ${json}`);
  assert.equal(out.first.apiKey, out.second.apiKey, 'the alias is preserved as redacted');
  assert.equal(out.list[0]!.apiKey, out.first.apiKey);
});

test('a genuine cycle still terminates and stays redacted', () => {
  type Node = { label: string; secret?: string; self?: Node };
  const a: Node = { label: 'a', secret: 'sk-live-abcdefghijklmnop1234' };
  a.self = a; // true cycle
  const out = redact(a) as Node;
  assert.equal(out.self, out, 'the cycle is preserved on the redacted copy');
  assert.ok(!JSON.stringify({ label: out.label, secret: out.secret }).includes('sk-live-abcdefghijklmnop1234'));
  assert.ok(!JSON.stringify(out.self.secret).includes('sk-live-abcdefghijklmnop1234'));
});

test('redactConfig: aliased config objects are masked on every path', () => {
  const creds = { apiKey: 'a-bare-local-key-no-shape', password: 'hunter2' };
  const cfg = { provider: creds, fallback: creds };
  const out = redactConfig(cfg) as typeof cfg;
  const json = JSON.stringify(out);
  assert.ok(!json.includes('a-bare-local-key-no-shape'), `apiKey survived: ${json}`);
  assert.ok(!json.includes('hunter2'), `password survived: ${json}`);
  assert.ok(json.includes('[REDACTED]') || json.includes('…[REDACTED]'), 'a mask marker is present');
});
