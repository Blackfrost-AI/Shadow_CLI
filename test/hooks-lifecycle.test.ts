import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, chmodSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runHookPhase } from '../src/hooks/runner.js';

function tmp(): string {
  return mkdtempSync(join(tmpdir(), 'shadow-hooks-'));
}

test('runHookPhase runs session_start hooks without denying', () => {
  const root = tmp();
  try {
    const script = join(root, 'hook.sh');
    writeFileSync(script, '#!/bin/sh\necho ok\n', 'utf8');
    chmodSync(script, 0o755);
    const r = runHookPhase('session_start', [script], { workspaceRoot: root, sessionId: 's1' });
    assert.equal(r.ok, true);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// ─── F07-03: relative hook paths are never resolved against the workspace ──────────────────────

// A global config naming a RELATIVE hook path must NEVER be resolved against the workspace and
// executed — a cloned repo shipping that same relative path was a zero-interaction drive-by RCE.
// The runner refuses relative paths outright (fail-closed on deny phases) instead of running bait.
test('F07-03: a relative hook path is NEVER run against the workspace (bait file not executed)', () => {
  const root = tmp();
  try {
    // The bait: a hostile script at the SAME relative path the (global) config names. Under the old
    // resolve(workspace, script) behavior this file would execute and drop its marker.
    const baitDir = join(root, 'scripts');
    mkdirSync(baitDir, { recursive: true });
    const bait = join(baitDir, 'session.sh');
    writeFileSync(bait, `#!/bin/sh\ntouch "${join(root, 'BAIT_RAN')}"\n`, 'utf8');
    chmodSync(bait, 0o755);

    const r = runHookPhase('session_start', ['scripts/session.sh'], { workspaceRoot: root });
    // session_start is a non-deny phase: the hook is skipped, the phase still reports ok.
    assert.equal(r.ok, true);
    // The critical guarantee: the workspace bait file was NEVER executed.
    assert.equal(existsSync(join(root, 'BAIT_RAN')), false, 'workspace bait file must never run');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('F07-03: a relative hook path in a DENY phase fails closed (blocks the action)', () => {
  const root = tmp();
  try {
    const baitDir = join(root, 'scripts');
    mkdirSync(baitDir, { recursive: true });
    const bait = join(baitDir, 'prompt.sh');
    writeFileSync(bait, `#!/bin/sh\ntouch "${join(root, 'BAIT_RAN2')}"\n`, 'utf8');
    chmodSync(bait, 0o755);
    // user_prompt_submit is a deny phase: we must BLOCK rather than silently skip the guard hook.
    const r = runHookPhase('user_prompt_submit', ['scripts/prompt.sh'], {
      workspaceRoot: root,
      prompt: 'x',
    });
    assert.equal(r.ok, false);
    assert.match(r.message ?? '', /relative hook path/);
    assert.equal(existsSync(join(root, 'BAIT_RAN2')), false, 'bait must not run even on deny phase');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('F07-03: absolute hook paths behave unchanged', () => {
  const root = tmp();
  try {
    const script = join(root, 'abs.sh');
    writeFileSync(script, '#!/bin/sh\necho ok\n', 'utf8');
    chmodSync(script, 0o755);
    const r = runHookPhase('session_start', [script], { workspaceRoot: root, sessionId: 's1' });
    assert.equal(r.ok, true);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// A relative path containing a traversal (../) is also refused — only truly absolute paths run.
test('F07-03: dot/traversal relative hook paths are refused too', () => {
  const root = tmp();
  try {
    const r = runHookPhase('session_start', ['../somewhere/x.sh', './local.sh'], {
      workspaceRoot: root,
    });
    assert.equal(r.ok, true, 'non-deny phase skips refused relative hooks');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// ─── end F07-03 ────────────────────────────────────────────────────────────────────────────────

test('user_prompt_submit hook denial blocks the prompt', () => {
  const root = tmp();
  try {
    const script = join(root, 'deny.sh');
    writeFileSync(script, '#!/bin/sh\nexit 1\n', 'utf8');
    chmodSync(script, 0o755);
    const r = runHookPhase('user_prompt_submit', [script], {
      workspaceRoot: root,
      prompt: 'hello',
    });
    assert.equal(r.ok, false);
    assert.match(r.message ?? '', /user_prompt_submit/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('notification hook failure does not deny', () => {
  const root = tmp();
  try {
    const script = join(root, 'fail.sh');
    writeFileSync(script, '#!/bin/sh\nexit 2\n', 'utf8');
    chmodSync(script, 0o755);
    const r = runHookPhase('notification', [script], { workspaceRoot: root });
    assert.equal(r.ok, true);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('subagent_stop and session_end hooks run (non-deny phases)', () => {
  const root = tmp();
  try {
    const script = join(root, 'sub.sh');
    writeFileSync(script, '#!/bin/sh\necho sub\n', 'utf8');
    chmodSync(script, 0o755);
    const r1 = runHookPhase('subagent_stop', [script], { workspaceRoot: root, extra: { agent: 'test' } });
    assert.equal(r1.ok, true);
    const r2 = runHookPhase('session_end', [script], { workspaceRoot: root });
    assert.equal(r2.ok, true);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
