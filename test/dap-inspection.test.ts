/**
 * m10 — DAP inspection API: secret redaction and redaction-aware inspection helpers.
 *
 * The security property: anything surfaced to the operator through the
 * inspection helpers is scrubbed of secret-shaped values BEFORE it reaches the
 * transcript, and frames keep only path basename + line/column (no absolute
 * paths, no home directories).
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  isSecretLikeValue,
  redactSecretValue,
  redactIfSecretNamed,
  redactSourcePath,
  stackTrace,
  DapInspectionError,
  inspectionRefusal,
  DAP_STEP_TIMEOUT_MS,
  type DapStackFrame,
} from '../src/agent/dap/inspection.js';
import { MAX_STACK_FRAMES, type DapSession } from '../src/agent/dap/session.js';

// ── secret redaction primitives ─────────────────────────────────────────────

test('secret-shaped values are detected by shape, not by name', () => {
  for (const secret of [
    'sk-proj-abcdefghijklmnopqrstuvwxyz123456',
    'AKIAIOSFODNN7EXAMPLE',
    'ghp_abcdefghijklmnopqrstuvwxyz',
    'xoxb-123456789-abcdefghijklmnop',
  ]) {
    assert.ok(isSecretLikeValue(secret), `detect ${secret.slice(0, 8)}…`);
  }
  for (const benign of ['', 'hello', '1234', '0', 'true', 'a', 'rgba(0,0,0,1)']) {
    assert.equal(isSecretLikeValue(benign), false, `benign ${JSON.stringify(benign)}`);
  }
});

test('redactSecretValue masks the whole value, keeping only shape hints', () => {
  const out = redactSecretValue('sk-proj-abcdefghijklmnopqrstuvwxyz123456');
  assert.equal(out.redacted, true);
  assert.equal(out.value, '[REDACTED: secret-like value]');
  // A non-secret passes through unmasked:
  const benign = redactSecretValue('hello');
  assert.equal(benign.redacted, false);
  assert.equal(benign.value, 'hello');
});

test('redactIfSecretNamed redacts by NAME regardless of shape', () => {
  // Shape-secret under any name:
  assert.equal(redactIfSecretNamed('anything', 'AKIAIOSFODNN7EXAMPLE').redacted, true);
  // Non-secret shape under a secret-suggestive name:
  const out = redactIfSecretNamed('api_key', 'hello');
  assert.equal(out.redacted, true);
  assert.equal(out.value, '[REDACTED: secret-named]');
  // Benign name + benign value passes through:
  const benign = redactIfSecretNamed('count', '42');
  assert.equal(benign.redacted, false);
  assert.equal(benign.value, '42');
});

test('redactSourcePath strips every directory — only the basename survives', () => {
  // Absolute POSIX path:
  assert.equal(redactSourcePath('/home/u/project/src/main.ts'), 'main.ts');
  // Windows separators must be stripped too:
  assert.equal(redactSourcePath('C:\\Users\\u\\project\\main.ts'), 'main.ts');
  // Mixed separators:
  assert.equal(redactSourcePath('a/b\\c/d.ts'), 'd.ts');
  // A bare filename stays itself:
  assert.equal(redactSourcePath('main.ts'), 'main.ts');
  // Path traversal never survives as a directory:
  assert.equal(redactSourcePath('../../etc/passwd'), 'passwd');
  // Trailing separators are stripped BEFORE basename extraction, so a path
  // ending in a separator still yields its real basename — no directory
  // structure leaks — and the function never falls back to the raw input:
  assert.equal(redactSourcePath('/Users/craigmac/secret-client/'), 'secret-client');
  assert.equal(redactSourcePath('C:\\\\Users\\\\u\\\\'), 'u');
  // A separator-only path has no basename at all: placeholder, never raw input:
  assert.equal(redactSourcePath('///'), '(redacted)');
});

test('frames surface only basename + line/column — never absolute paths', async () => {
  // GENUINE end-to-end check of the redaction boundary: the REAL stackTrace()
  // production path runs against a stub transport that answers like an adapter.
  // The stub is transport only — parsing, bounds and redaction are the real code.
  const hostileFrames = [
    {
      id: 1,
      name: 'main',
      source: { path: '/home/u/project/src/main.ts' },
      line: 10,
      column: 2,
    },
    {
      id: 2,
      name: 'load',
      source: { path: 'C:\\Users\\u\\secrets\\loader.js' },
      line: 3,
      column: 0,
    },
  ];
  const stub = {
    request: async (command: string) => {
      assert.equal(command, 'stackTrace');
      return { stackFrames: hostileFrames };
    },
  } as unknown as DapSession;
  const { frames, truncated } = await stackTrace(stub, 1);
  assert.equal(truncated, false);
  assert.equal(frames.length, 2);
  // Basename ONLY — no absolute path, no home directory may ever surface:
  assert.equal(frames[0].sourceBasename, 'main.ts');
  assert.equal(frames[1].sourceBasename, 'loader.js');
  const wire = JSON.stringify(frames);
  assert.ok(!wire.includes('/home/u'), 'frames must never carry POSIX directories');
  assert.ok(!wire.includes('C:\\'), 'frames must never carry Windows directories');
  assert.ok(!wire.includes('secrets'), 'frames must never carry directory names');
  // Line/column/frameId still flow through for diagnosis:
  assert.equal(frames[0].line, 10);
  assert.equal(frames[0].column, 2);
  assert.equal(frames[0].frameId, 1);
  assert.equal(frames[1].frameId, 2);
  // The interface itself carries no path-shaped field anymore:
  const frame: DapStackFrame = frames[0];
  assert.ok(!('sourcePath' in frame), 'sourcePath must not exist on frames');
});

test('stackTrace truncates at MAX_STACK_FRAMES and reports it', async () => {
  const many = Array.from({ length: MAX_STACK_FRAMES + 9 }, (_, i) => ({
    id: i,
    name: 'f' + i,
    source: { path: '/x/y/f' + i + '.ts' },
    line: i,
    column: 0,
  }));
  const stub = {
    request: async () => ({ stackFrames: many }),
  } as unknown as DapSession;
  const { frames, truncated } = await stackTrace(stub, 1);
  assert.equal(frames.length, MAX_STACK_FRAMES);
  assert.equal(truncated, true);
});

// ── refusal and bounds ───────────────────────────────────────────────────────

test('inspectionRefusal names the exact capability refused', () => {
  for (const kind of ['stack', 'scopes', 'variables', 'breakpoints', 'threads'] as const) {
    const refusal = inspectionRefusal(kind);
    assert.ok(refusal.includes(kind), refusal);
  }
});

test('step helpers are bounded by DAP_STEP_TIMEOUT_MS', () => {
  assert.equal(DAP_STEP_TIMEOUT_MS, 10_000);
});

test('DapInspectionError is a named error type', () => {
  const e = new DapInspectionError('no');
  assert.equal(e.name, 'DapInspectionError');
  assert.ok(e instanceof Error);
});
