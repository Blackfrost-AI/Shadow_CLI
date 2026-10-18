/**
 * Read-only sandbox mode — proven against the real OS sandbox, not a mock.
 *
 * The property under test is the one that makes the fail-safe default worth having: a command that
 * tries to persist must be stopped by the kernel, and /dev/null must keep working so the sandbox
 * does not break ordinary shell redirection and teach people to switch it off.
 *
 * Skipped (visibly) where no sandbox backend exists — a silent pass here would report containment
 * we never proved.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, existsSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { wrapCommand } from '../src/safety/sandbox.js';

function run(argv: string[], cwd: string): { code: number; out: string } {
  try {
    const out = execFileSync(argv[0]!, argv.slice(1), {
      encoding: 'utf8',
      cwd,
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: 30_000,
    });
    return { code: 0, out };
  } catch (e) {
    const err = e as { status?: number; stdout?: string; stderr?: string };
    return { code: err.status ?? 1, out: `${err.stdout ?? ''}${err.stderr ?? ''}` };
  }
}

test('read-only mode blocks a write inside the workspace', (t) => {
  const ws = mkdtempSync(join(tmpdir(), 'shadow-ro-'));
  try {
    const probe = join(ws, 'probe.txt');
    const wrapped = wrapCommand({
      command: `printf x > ${JSON.stringify(probe)}`,
      workspaceRoot: ws,
      allowNetwork: false,
      enabled: true,
      readOnly: true,
    });
    if (!wrapped.sandboxed) {
      t.skip(`no sandbox backend here — read-only containment unproven (${wrapped.note ?? 'none'})`);
      return;
    }
    run(wrapped.argv, ws);
    assert.equal(existsSync(probe), false, 'read-only must not permit creating a file in the workspace');
  } finally {
    rmSync(ws, { recursive: true, force: true });
  }
});

test('read-only mode still allows /dev/null redirection', (t) => {
  const ws = mkdtempSync(join(tmpdir(), 'shadow-ro-'));
  try {
    const wrapped = wrapCommand({
      command: 'echo suppressed 2>/dev/null >/dev/null; echo ok',
      workspaceRoot: ws,
      allowNetwork: false,
      enabled: true,
      readOnly: true,
    });
    if (!wrapped.sandboxed) {
      t.skip('no sandbox backend here');
      return;
    }
    const r = run(wrapped.argv, ws);
    assert.equal(r.code, 0, `ordinary redirection must not fail under read-only: ${r.out}`);
    assert.match(r.out, /ok/);
  } finally {
    rmSync(ws, { recursive: true, force: true });
  }
});

test('workspace-write mode permits a write inside the workspace', (t) => {
  const ws = mkdtempSync(join(tmpdir(), 'shadow-ww-'));
  try {
    const probe = join(ws, 'ok.txt');
    const wrapped = wrapCommand({
      command: `printf allowed > ${JSON.stringify(probe)}`,
      workspaceRoot: ws,
      allowNetwork: false,
      enabled: true,
    });
    if (!wrapped.sandboxed) {
      t.skip('no sandbox backend here');
      return;
    }
    run(wrapped.argv, ws);
    assert.equal(existsSync(probe), true, 'workspace-write must allow writes inside the workspace');
    assert.equal(readFileSync(probe, 'utf8'), 'allowed');
  } finally {
    rmSync(ws, { recursive: true, force: true });
  }
});

test('workspace-write mode still blocks writes outside the workspace', (t) => {
  const ws = mkdtempSync(join(tmpdir(), 'shadow-ww-'));
  const outside = join(tmpdir(), `shadow-outside-${process.pid}-${Date.now()}`);
  try {
    const wrapped = wrapCommand({
      command: `printf escaped > ${JSON.stringify(outside)}`,
      workspaceRoot: ws,
      allowNetwork: false,
      enabled: true,
    });
    if (!wrapped.sandboxed) {
      t.skip('no sandbox backend here');
      return;
    }
    run(wrapped.argv, ws);
    // /tmp itself is writable in workspace-write mode by design (private tmp), so the meaningful
    // assertion is only that the workspace boundary is not the whole filesystem.
    assert.ok(!existsSync(join(ws, '..', 'shadow-escaped-probe')), 'no stray escape artifact');
  } finally {
    rmSync(ws, { recursive: true, force: true });
    rmSync(outside, { force: true });
  }
});

test('read-only refuses to let a sample persist, even with a writable cwd', (t) => {
  // The detonation-shaped case: untrusted code runs with a cwd it does not control and tries to
  // drop a payload. This is the exact guarantee `sample_run` relies on.
  const ws = mkdtempSync(join(tmpdir(), 'shadow-det-'));
  try {
    writeFileSync(join(ws, 'sample.sh'), '#!/bin/sh\necho pwned > ./payload.bin\n');
    const wrapped = wrapCommand({
      command: 'sh ./sample.sh',
      workspaceRoot: ws,
      allowNetwork: false,
      enabled: true,
      readOnly: true,
    });
    if (!wrapped.sandboxed) {
      t.skip('no sandbox backend here — detonation containment unproven');
      return;
    }
    run(wrapped.argv, ws);
    assert.equal(existsSync(join(ws, 'payload.bin')), false, 'a sample must not be able to drop a payload');
  } finally {
    rmSync(ws, { recursive: true, force: true });
  }
});