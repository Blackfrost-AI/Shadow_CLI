import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parsePatch, applyHunks, seekSequence, applyPatch } from '../src/tools/applyPatch.js';
import { extractPatchBlock } from '../src/provider/applyPatch.js';
import type { ToolContext } from '../src/tools/types.js';

function ctxFor(ws: string): ToolContext {
  return { workspaceRoot: ws, signal: new AbortController().signal, log: () => {}, dryRun: false };
}

// ── parser ──
test('parsePatch: add / update(+move) / delete in one envelope', () => {
  const patch = [
    '*** Begin Patch',
    '*** Add File: hello.txt',
    '+Hello world',
    '*** Update File: src/app.py',
    '*** Move to: src/main.py',
    '@@ def greet():',
    '-print("Hi")',
    '+print("Hello, world!")',
    '*** Delete File: obsolete.txt',
    '*** End Patch',
  ].join('\n');
  const r = parsePatch(patch);
  assert.ok(r.ok);
  if (!r.ok) return;
  assert.equal(r.ops.length, 3);
  assert.deepEqual(r.ops[0], { kind: 'add', path: 'hello.txt', lines: ['Hello world'] });
  const upd = r.ops[1];
  assert.equal(upd.kind, 'update');
  if (upd.kind === 'update') {
    assert.equal(upd.path, 'src/app.py');
    assert.equal(upd.moveTo, 'src/main.py');
    assert.equal(upd.hunks[0]!.lines.filter((l) => l.type === 'remove').length, 1);
  }
  assert.deepEqual(r.ops[2], { kind: 'delete', path: 'obsolete.txt' });
});

test('parsePatch: rejects missing Begin/End', () => {
  assert.equal(parsePatch('*** Add File: x\n+y').ok, false);
  assert.equal(parsePatch('*** Begin Patch\n*** Add File: x\n+y').ok, false); // no End
});

// ── hunk application ──
test('applyHunks: context-anchored replacement', () => {
  const content = 'a\nb\nc\nd\n';
  const r = applyHunks(content, [{ lines: [{ type: 'context', text: 'b' }, { type: 'remove', text: 'c' }, { type: 'add', text: 'C' }] }]);
  assert.ok(r.ok);
  if (r.ok) assert.equal(r.content, 'a\nb\nC\nd\n');
});

test('applyHunks: fuzzy (trailing-whitespace) context still matches', () => {
  const content = 'foo  \nbar\n';
  const r = applyHunks(content, [{ lines: [{ type: 'context', text: 'foo' }, { type: 'remove', text: 'bar' }, { type: 'add', text: 'baz' }] }]);
  assert.ok(r.ok);
  if (r.ok) assert.equal(r.content, 'foo  \nbaz\n');
});

test('applyHunks: unmatchable context fails (no silent misapply)', () => {
  const r = applyHunks('a\nb\n', [{ lines: [{ type: 'remove', text: 'zzz' }, { type: 'add', text: 'q' }] }]);
  assert.equal(r.ok, false);
});

test('seekSequence finds exact then advances', () => {
  assert.equal(seekSequence(['a', 'b', 'c'], ['b', 'c'], 0), 1);
  assert.equal(seekSequence(['a', 'b', 'c'], ['x'], 0), -1);
});

// ── text recognizer ──
test('extractPatchBlock pulls the envelope out of surrounding prose', () => {
  const text = 'Sure, here is the patch:\n*** Begin Patch\n*** Add File: a.txt\n+hi\n*** End Patch\nDone!';
  const r = extractPatchBlock(text);
  assert.ok(r);
  assert.match(r!.patch, /^\*\*\* Begin Patch[\s\S]*\*\*\* End Patch$/);
  assert.equal(r!.cleaned, 'Sure, here is the patch:\n\nDone!');
  assert.equal(extractPatchBlock('no patch here'), null);
});

// ── end-to-end tool ──
test('apply_patch tool: add + update + delete, all-or-nothing success', async () => {
  const ws = mkdtempSync(join(tmpdir(), 'ap-'));
  writeFileSync(join(ws, 'app.py'), 'PORT = 3000\napp.run(PORT)\n');
  writeFileSync(join(ws, 'old.txt'), 'gone soon\n');
  try {
    const patch = [
      '*** Begin Patch',
      '*** Add File: src/new.txt',
      '+brand new',
      '*** Update File: app.py',
      '@@',
      '-PORT = 3000',
      '+PORT = 5000',
      '*** Delete File: old.txt',
      '*** End Patch',
    ].join('\n');
    const res = await applyPatch.run({ patch }, ctxFor(ws));
    assert.equal(res.ok, true, res.summary);
    assert.equal(readFileSync(join(ws, 'src/new.txt'), 'utf8'), 'brand new\n');
    assert.equal(readFileSync(join(ws, 'app.py'), 'utf8'), 'PORT = 5000\napp.run(PORT)\n');
    assert.equal(existsSync(join(ws, 'old.txt')), false);
    assert.deepEqual(res.data, { added: 1, updated: 1, deleted: 1, files: ['src/new.txt', 'app.py', 'old.txt'] });
  } finally {
    rmSync(ws, { recursive: true, force: true });
  }
});

test('apply_patch tool: a failing hunk writes NOTHING (all-or-nothing)', async () => {
  const ws = mkdtempSync(join(tmpdir(), 'ap-'));
  writeFileSync(join(ws, 'keep.txt'), 'original\n');
  try {
    const patch = [
      '*** Begin Patch',
      '*** Add File: should_not_exist.txt',
      '+nope',
      '*** Update File: keep.txt',
      '@@',
      '-THIS DOES NOT MATCH',
      '+x',
      '*** End Patch',
    ].join('\n');
    const res = await applyPatch.run({ patch }, ctxFor(ws));
    assert.equal(res.ok, false);
    assert.equal(existsSync(join(ws, 'should_not_exist.txt')), false, 'add must not land when a later hunk fails');
    assert.equal(readFileSync(join(ws, 'keep.txt'), 'utf8'), 'original\n', 'update target untouched');
  } finally {
    rmSync(ws, { recursive: true, force: true });
  }
});

test('apply_patch: Move to an EXISTING file fails and overwrites nothing (review #4)', async () => {
  const ws = mkdtempSync(join(tmpdir(), 'ap-'));
  writeFileSync(join(ws, 'a.txt'), 'aaa\n');
  writeFileSync(join(ws, 'b.txt'), 'IMPORTANT\n');
  try {
    const patch = ['*** Begin Patch', '*** Update File: a.txt', '*** Move to: b.txt', '@@', '-aaa', '+AAA', '*** End Patch'].join('\n');
    const res = await applyPatch.run({ patch }, ctxFor(ws));
    assert.equal(res.ok, false);
    assert.equal(res.error?.code, 'exists');
    assert.equal(readFileSync(join(ws, 'b.txt'), 'utf8'), 'IMPORTANT\n', 'destination must be untouched');
    assert.equal(readFileSync(join(ws, 'a.txt'), 'utf8'), 'aaa\n', 'source untouched (all-or-nothing)');
  } finally {
    rmSync(ws, { recursive: true, force: true });
  }
});

test('apply_patch: two Update sections for the same file stack, no clobber (review #5)', async () => {
  const ws = mkdtempSync(join(tmpdir(), 'ap-'));
  writeFileSync(join(ws, 'f.txt'), 'one\ntwo\nthree\n');
  try {
    const patch = [
      '*** Begin Patch',
      '*** Update File: f.txt',
      '@@',
      '-one',
      '+ONE',
      '*** Update File: f.txt',
      '@@',
      '-three',
      '+THREE',
      '*** End Patch',
    ].join('\n');
    const res = await applyPatch.run({ patch }, ctxFor(ws));
    assert.equal(res.ok, true, res.summary);
    assert.equal(readFileSync(join(ws, 'f.txt'), 'utf8'), 'ONE\ntwo\nTHREE\n', 'both hunks applied, second did not clobber the first');
  } finally {
    rmSync(ws, { recursive: true, force: true });
  }
});

test('apply_patch tool: refuses a path outside the workspace', async () => {
  const ws = mkdtempSync(join(tmpdir(), 'ap-'));
  try {
    const patch = '*** Begin Patch\n*** Add File: ../escape.txt\n+x\n*** End Patch';
    const res = await applyPatch.run({ patch }, ctxFor(ws));
    assert.equal(res.ok, false);
    assert.equal(res.error?.code, 'outside_workspace');
  } finally {
    rmSync(ws, { recursive: true, force: true });
  }
});
