import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { resolveWithin } from '../src/safety/workspaceJail.js';
import { writeFile } from '../src/tools/writeFile.js';
import type { ToolContext } from '../src/tools/types.js';

test('resolveWithin (single root): allows inside, rejects outside', () => {
  const ws = resolve(mkdtempSync(join(tmpdir(), 'ws-')));
  try {
    assert.equal(resolveWithin(ws, 'a/b.txt'), resolve(ws, 'a/b.txt'));
    assert.throws(() => resolveWithin(ws, '/etc/passwd'), /outside the workspace/);
  } finally {
    rmSync(ws, { recursive: true, force: true });
  }
});

test('resolveWithin (multi-root): a path in a granted dir is allowed; relative still resolves against the workspace', () => {
  const ws = resolve(mkdtempSync(join(tmpdir(), 'ws-')));
  const extra = resolve(mkdtempSync(join(tmpdir(), 'extra-')));
  const other = resolve(mkdtempSync(join(tmpdir(), 'other-')));
  try {
    // absolute path inside the granted dir → allowed
    assert.equal(resolveWithin([ws, extra], join(extra, 'out.txt')), resolve(extra, 'out.txt'));
    // relative path resolves against the FIRST root (the workspace)
    assert.equal(resolveWithin([ws, extra], 'rel.txt'), resolve(ws, 'rel.txt'));
    // a dir that was NOT granted is still rejected
    assert.throws(() => resolveWithin([ws, extra], join(other, 'x.txt')), /outside the workspace/);
  } finally {
    for (const d of [ws, extra, other]) rmSync(d, { recursive: true, force: true });
  }
});

test('write_file: blocked outside the workspace, but succeeds once the dir is granted via additionalRoots', async () => {
  const ws = resolve(mkdtempSync(join(tmpdir(), 'ws-')));
  const granted = resolve(mkdtempSync(join(tmpdir(), 'granted-')));
  const ungranted = resolve(mkdtempSync(join(tmpdir(), 'ungranted-')));
  const base: Omit<ToolContext, 'additionalRoots'> = {
    workspaceRoot: ws,
    signal: new AbortController().signal,
    log: () => {},
    dryRun: false,
  };
  try {
    // Without a grant, a write outside the workspace fails (the original symptom).
    const denied = await writeFile.run({ path: join(granted, 'note.txt'), content: 'hi' }, { ...base });
    assert.equal(denied.ok, false, 'write outside the workspace is blocked without a grant');
    assert.equal(existsSync(join(granted, 'note.txt')), false);

    // With the dir granted, the SAME write lands on disk.
    const ok = await writeFile.run(
      { path: join(granted, 'note.txt'), content: 'hi' },
      { ...base, additionalRoots: [granted] },
    );
    assert.ok(ok.ok, ok.summary);
    assert.equal(readFileSync(join(granted, 'note.txt'), 'utf8'), 'hi');

    // A grant for one dir does not open a different dir.
    const stillDenied = await writeFile.run(
      { path: join(ungranted, 'x.txt'), content: 'no' },
      { ...base, additionalRoots: [granted] },
    );
    assert.equal(stillDenied.ok, false, 'a grant is scoped to the granted dir only');
  } finally {
    for (const d of [ws, granted, ungranted]) rmSync(d, { recursive: true, force: true });
  }
});
