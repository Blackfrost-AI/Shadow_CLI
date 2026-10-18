import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  DEFAULT_SANDBOX_MODE,
  SANDBOX_MODES,
  UNTRUSTED_SANDBOX_MODE,
  describeSandboxPolicy,
  isSandboxMode,
  nextSandboxMode,
  resolveSandboxPolicy,
  sandboxLevel,
  untrustedSandboxPolicy,
  writableRoots,
} from '../src/safety/sandboxPolicy.js';
import {
  applyEscalation,
  createEscalationState,
  looksLikeSandboxDenial,
  recordDecline,
  sandboxDenial,
  validateEscalation,
} from '../src/safety/escalation.js';

test('the ladder is strictly widening and complete', () => {
  assert.deepEqual([...SANDBOX_MODES], ['read-only', 'workspace-write', 'danger-full-access']);
  for (let i = 0; i < SANDBOX_MODES.length; i++) {
    assert.equal(sandboxLevel(SANDBOX_MODES[i]), i, `${SANDBOX_MODES[i]} must rank at ${i}`);
  }
});

test('nextSandboxMode walks one rung and stops at the top', () => {
  assert.equal(nextSandboxMode('read-only'), 'workspace-write');
  assert.equal(nextSandboxMode('workspace-write'), 'danger-full-access');
  assert.equal(nextSandboxMode('danger-full-access'), null);
});

test('an unknown mode never ranks as most privileged', () => {
  // A typo in config must not grant full access. Level 0 = read-only.
  assert.equal(sandboxLevel('typo' as never), 0);
  assert.equal(sandboxLevel(undefined as never), 0);
  assert.equal(isSandboxMode('typo'), false);
  assert.equal(isSandboxMode('read-only'), true);
});

test('resolveSandboxPolicy falls back to the safe default on garbage input', () => {
  const p = resolveSandboxPolicy({ mode: 'not-a-mode', workspaceRoot: '/tmp/ws' });
  assert.equal(p.mode, DEFAULT_SANDBOX_MODE);
  assert.equal(p.workspaceRoot, '/tmp/ws');
});

test('read-only grants no real write capability, but keeps /dev/null working', () => {
  const roots = writableRoots(resolveSandboxPolicy({ mode: 'read-only', workspaceRoot: '/tmp/ws' }));
  assert.ok(roots.includes('/dev/null'), 'ordinary 2>/dev/null redirection must not break');
  assert.ok(!roots.includes('/tmp/ws'), 'read-only must NOT make the workspace writable');
  assert.ok(!roots.includes('/'), 'read-only must not grant the whole filesystem');
});

test('workspace-write makes exactly the workspace writable', () => {
  const roots = writableRoots(resolveSandboxPolicy({ mode: 'workspace-write', workspaceRoot: '/tmp/ws' }));
  assert.ok(roots.includes('/tmp/ws'));
  assert.ok(!roots.includes('/'), 'workspace-write is not full access');
});

test('untrustedSandboxPolicy is read-only and fences reads', () => {
  const p = untrustedSandboxPolicy({ workspaceRoot: '/tmp/ws' });
  assert.equal(p.mode, UNTRUSTED_SANDBOX_MODE);
  assert.equal(p.readConfined, true, 'untrusted detonation must fence the read side too');
});

test('read confinement is refused under danger-full-access (it would contradict the mode)', () => {
  const p = resolveSandboxPolicy({ mode: 'danger-full-access', readConfined: true, workspaceRoot: '/tmp/ws' });
  assert.equal(p.readConfined, false);
});

test('describeSandboxPolicy never claims confinement that is not there', () => {
  assert.match(describeSandboxPolicy(resolveSandboxPolicy({ mode: 'danger-full-access' })), /NO filesystem confinement/);
  assert.match(describeSandboxPolicy(resolveSandboxPolicy({ mode: 'read-only', workspaceRoot: '/tmp/ws' })), /NOT writable/);
});

test('escalation must move exactly one rung', () => {
  const s = createEscalationState('read-only');
  assert.deepEqual(validateEscalation(s, { from: 'read-only', to: 'workspace-write', reason: 'need to write' }), {
    ok: true,
  });
  const skipped = validateEscalation(s, { from: 'read-only', to: 'danger-full-access', reason: 'just let me' });
  assert.equal(skipped.ok, false);
  assert.match(skipped.ok === false ? skipped.reason : '', /exactly one rung/);
});

test('escalation rejects a stale "from"', () => {
  const s = createEscalationState('workspace-write');
  const r = validateEscalation(s, { from: 'read-only', to: 'workspace-write', reason: 'x' });
  assert.equal(r.ok, false);
});

test('a declined rung is not re-prompted', () => {
  let s = createEscalationState('read-only');
  s = recordDecline(s, 'workspace-write');
  const r = validateEscalation(s, { from: 'read-only', to: 'workspace-write', reason: 'again' });
  assert.equal(r.ok, false);
  assert.match(r.ok === false ? r.reason : '', /already declined/);
});

test('applyEscalation moves the mode without clearing declined history', () => {
  let s = createEscalationState('read-only');
  s = recordDecline(s, 'workspace-write');
  const s2 = applyEscalation(s, { from: 'read-only', to: 'workspace-write', reason: 'ok' });
  assert.equal(s2.mode, 'workspace-write');
  assert.ok(s2.declined.has('workspace-write'), 'declined history must survive an escalation');
});

test('nothing escalates past the top of the ladder', () => {
  const s = createEscalationState('danger-full-access');
  const r = validateEscalation(s, { from: 'danger-full-access', to: 'danger-full-access', reason: 'x' });
  assert.equal(r.ok, false);
  assert.match(r.ok === false ? r.reason : '', /widest mode/);
});

test('a denial tells the model the mode, the policy, and the next rung', () => {
  const res = sandboxDenial(resolveSandboxPolicy({ mode: 'read-only', workspaceRoot: '/tmp/ws' }), 'write failed');
  assert.equal(res.ok, false);
  assert.equal(res.error?.code, 'sandbox_denied');
  assert.match(res.summary, /read-only/, 'must name the mode it ran under');
  assert.match(res.summary, /workspace-write/, 'must name the next rung');
  assert.match(res.summary, /confinement working as intended/, 'must not read as a bug');
  assert.equal(res.error?.recoverable, true);
});

test('a denial at the top rung is not recoverable', () => {
  const res = sandboxDenial(resolveSandboxPolicy({ mode: 'danger-full-access', workspaceRoot: '/tmp/ws' }), 'x');
  assert.equal(res.error?.recoverable, false);
});

test('a denial after a decline says so instead of inviting another prompt', () => {
  const res = sandboxDenial(resolveSandboxPolicy({ mode: 'read-only', workspaceRoot: '/tmp/ws' }), 'x', {
    declined: new Set(['workspace-write' as const]),
  });
  assert.match(res.summary, /already declined/);
  assert.equal(res.error?.recoverable, false);
});

test('denial detection recognises real confinement errors but not ordinary failures', () => {
  assert.ok(looksLikeSandboxDenial('bash: /tmp/x: Operation not permitted'));
  assert.ok(looksLikeSandboxDenial('touch: /ws/f: Read-only file system'));
  assert.ok(!looksLikeSandboxDenial('bash: command not found: nope'));
  assert.ok(!looksLikeSandboxDenial(''));
});