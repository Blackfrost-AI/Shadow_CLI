import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync, readFileSync, utimesSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { editFile } from '../src/tools/editFile.js';
import { readFile } from '../src/tools/readFile.js';
import { writeFile } from '../src/tools/writeFile.js';
import { createReadTracker } from '../src/tools/readTracker.js';
import type { ToolContext } from '../src/tools/types.js';

function setup(): { ws: string; ctx: ToolContext } {
  const ws = mkdtempSync(join(tmpdir(), 'rbe-'));
  const ctx: ToolContext = {
    workspaceRoot: ws,
    signal: new AbortController().signal,
    log: () => {},
    dryRun: false,
    readTracker: createReadTracker(),
  };
  return { ws, ctx };
}

test('edit without a prior read_file (or write_file) is REFUSED (Claude "read in conversation" parity)', async () => {
  const { ws, ctx } = setup();
  try {
    writeFileSync(join(ws, 'f.txt'), 'alpha bravo\n');
    const r = await editFile.run({ path: 'f.txt', old_string: 'alpha', new_string: 'ALPHA' }, ctx);
    assert.equal(r.ok, false);
    assert.equal(r.error?.code, 'read_required');
    assert.match(r.error?.message ?? '', /read_file tool on this file before editing/);
    // content unchanged
    assert.equal(readFileSync(join(ws, 'f.txt'), 'utf8'), 'alpha bravo\n');
  } finally {
    rmSync(ws, { recursive: true, force: true });
  }
});

test('read then edit succeeds', async () => {
  const { ws, ctx } = setup();
  try {
    writeFileSync(join(ws, 'f.txt'), 'alpha bravo\n');
    await readFile.run({ path: 'f.txt' }, ctx);
    const r = await editFile.run({ path: 'f.txt', old_string: 'alpha', new_string: 'ALPHA' }, ctx);
    assert.equal(r.ok, true, r.summary);
    assert.equal(readFileSync(join(ws, 'f.txt'), 'utf8'), 'ALPHA bravo\n');
  } finally {
    rmSync(ws, { recursive: true, force: true });
  }
});

test('write then edit succeeds (a written file is known)', async () => {
  const { ws, ctx } = setup();
  try {
    await writeFile.run({ path: 'g.txt', content: 'one two\n' }, ctx);
    const r = await editFile.run({ path: 'g.txt', old_string: 'two', new_string: 'three' }, ctx);
    assert.equal(r.ok, true, r.summary);
    assert.equal(readFileSync(join(ws, 'g.txt'), 'utf8'), 'one three\n');
  } finally {
    rmSync(ws, { recursive: true, force: true });
  }
});

test('edit is refused if the file changed on disk since it was read', async () => {
  const { ws, ctx } = setup();
  try {
    const p = join(ws, 'f.txt');
    writeFileSync(p, 'alpha\n');
    await readFile.run({ path: 'f.txt' }, ctx);
    // Simulate an external change: rewrite + bump mtime forward.
    writeFileSync(p, 'beta\n');
    const future = statSync(p).mtimeMs / 1000 + 5;
    utimesSync(p, future, future);
    const r = await editFile.run({ path: 'f.txt', old_string: 'beta', new_string: 'BETA' }, ctx);
    assert.equal(r.ok, false);
    assert.equal(r.error?.code, 'read_required');
    assert.match(r.error?.message ?? '', /changed on disk/);
  } finally {
    rmSync(ws, { recursive: true, force: true });
  }
});

test('without a readTracker (e.g. isolated tests) the guard is inert', async () => {
  const ws = mkdtempSync(join(tmpdir(), 'rbe-'));
  try {
    writeFileSync(join(ws, 'f.txt'), 'x\n');
    const ctx: ToolContext = { workspaceRoot: ws, signal: new AbortController().signal, log: () => {}, dryRun: false };
    const r = await editFile.run({ path: 'f.txt', old_string: 'x', new_string: 'y' }, ctx);
    assert.equal(r.ok, true, 'no tracker → no guard');
  } finally {
    rmSync(ws, { recursive: true, force: true });
  }
});
