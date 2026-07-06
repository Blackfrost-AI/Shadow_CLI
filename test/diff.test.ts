import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { diffLines } from '../src/util/diff.js';
import { writeFile } from '../src/tools/writeFile.js';
import type { ToolContext } from '../src/tools/types.js';

test('diffLines returns [] when nothing changed', () => {
  assert.deepEqual(diffLines('a\nb', 'a\nb'), []);
});

test('diffLines marks removed/added lines with surrounding context', () => {
  assert.deepEqual(diffLines('a\nb\nc', 'a\nB\nc'), [
    { tag: ' ', text: 'a' },
    { tag: '-', text: 'b' },
    { tag: '+', text: 'B' },
    { tag: ' ', text: 'c' },
  ]);
});

test('diffLines collapses distant unchanged lines into a … marker', () => {
  const oldText = Array.from({ length: 30 }, (_, i) => `l${i}`).join('\n');
  const newText = oldText.replace('l0', 'CHANGED');
  const d = diffLines(oldText, newText, { context: 2 });
  assert.ok(d.some((l) => l.tag === '+' && l.text === 'CHANGED'));
  assert.ok(d.some((l) => l.tag === '-' && l.text === 'l0'));
  assert.ok(d.some((l) => l.text === '…'), 'far-away unchanged lines collapse');
});

test('write_file attaches a UI diff on overwrite, none on a no-op', async () => {
  const ws = mkdtempSync(join(tmpdir(), 'diff-'));
  const f = join(ws, 'f.txt');
  const ctx: ToolContext = { workspaceRoot: ws, signal: new AbortController().signal, log: () => {}, dryRun: false };
  try {
    await writeFile.run({ path: f, content: 'a\nb\n' }, ctx); // create
    const over = await writeFile.run({ path: f, content: 'a\nB\n' }, ctx); // overwrite
    assert.ok(over.meta.diff?.some((l) => l.tag === '+' && l.text === 'B'), 'overwrite carries a diff');
    assert.ok(over.meta.diff?.some((l) => l.tag === '-' && l.text === 'b'));
    const noop = await writeFile.run({ path: f, content: 'a\nB\n' }, ctx); // identical → unchanged
    assert.equal(noop.meta.diff, undefined, 'a no-op write carries no diff');
  } finally {
    rmSync(ws, { recursive: true, force: true });
  }
});
