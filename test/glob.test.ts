import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { glob } from '../src/tools/glob.js';
import type { ToolContext } from '../src/tools/types.js';

function tree(): string {
  const ws = mkdtempSync(join(tmpdir(), 'glob-'));
  writeFileSync(join(ws, 'a.txt'), '1');
  mkdirSync(join(ws, 'sub'));
  writeFileSync(join(ws, 'sub', 'b.txt'), '2');
  mkdirSync(join(ws, 'node_modules', 'pkg'), { recursive: true });
  writeFileSync(join(ws, 'node_modules', 'pkg', 'c.txt'), '3'); // must be skipped
  mkdirSync(join(ws, '.git'));
  writeFileSync(join(ws, '.git', 'config'), 'x'); // must be skipped
  return ws;
}

const ctx = (signal?: AbortSignal): ToolContext => ({
  workspaceRoot: '',
  signal: signal ?? new AbortController().signal,
  log: () => {},
  dryRun: false,
});

test('glob matches across depth and skips node_modules/.git', async () => {
  const ws = tree();
  try {
    const c = ctx();
    c.workspaceRoot = ws;
    const r = await glob.run({ pattern: '**/*.txt' }, c);
    assert.ok(r.ok, r.summary);
    const m = (r.data?.matches ?? []).sort();
    assert.deepEqual(m, ['a.txt', 'sub/b.txt'], 'finds both .txt files, excludes node_modules');
    assert.equal(r.data?.truncated, false);
  } finally {
    rmSync(ws, { recursive: true, force: true });
  }
});

test('glob returns promptly when the signal is already aborted (no freeze)', async () => {
  const ws = tree();
  try {
    const ac = new AbortController();
    ac.abort();
    const c = ctx(ac.signal);
    c.workspaceRoot = ws;
    const t0 = Date.now();
    const r = await glob.run({ pattern: '**/*' }, c);
    assert.ok(Date.now() - t0 < 1000, 'aborts fast');
    assert.equal(r.data?.truncated, true);
    assert.match(r.summary, /interrupted/);
  } finally {
    rmSync(ws, { recursive: true, force: true });
  }
});

test('a non-matching ** pattern over a tree still terminates (the home-dir freeze)', async () => {
  const ws = tree();
  try {
    const c = ctx();
    c.workspaceRoot = ws;
    // Pattern that matches nothing (the .git-style case): must complete, not spin.
    const r = await glob.run({ pattern: '**/.does-not-exist' }, c);
    assert.ok(r.ok);
    assert.deepEqual(r.data?.matches, []);
  } finally {
    rmSync(ws, { recursive: true, force: true });
  }
});
