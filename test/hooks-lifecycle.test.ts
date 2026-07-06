import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync, chmodSync } from 'node:fs';
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