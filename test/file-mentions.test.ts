import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  atMentionToken,
  walkWorkspaceFiles,
  rankFileCandidates,
  findMentions,
  expandFileMentions,
} from '../src/tui/fileMentions.js';

test('atMentionToken triggers only on a real @ token (not an email)', () => {
  assert.deepEqual(atMentionToken('@src', 4), { start: 0, partial: 'src' });
  assert.deepEqual(atMentionToken('review @src/foo', 15), { start: 7, partial: 'src/foo' });
  assert.equal(atMentionToken('user@host.com', 13), null, 'email must not trigger');
  assert.equal(atMentionToken('no mention here', 15), null);
  assert.equal(atMentionToken('@src foo', 8), null, 'whitespace after the token closes it');
  assert.deepEqual(atMentionToken('@', 1), { start: 0, partial: '' }, 'bare @ opens the picker');
});

test('walkWorkspaceFiles returns relative paths, skips node_modules/.git and hidden/symlinks', () => {
  const ws = mkdtempSync(join(tmpdir(), 'fm-'));
  try {
    mkdirSync(join(ws, 'src'), { recursive: true });
    mkdirSync(join(ws, 'node_modules/x'), { recursive: true });
    mkdirSync(join(ws, '.git'), { recursive: true });
    writeFileSync(join(ws, 'src/index.ts'), 'x');
    writeFileSync(join(ws, 'README.md'), 'x');
    writeFileSync(join(ws, 'node_modules/x/pkg.js'), 'x');
    writeFileSync(join(ws, '.git/config'), 'x');
    writeFileSync(join(ws, '.env'), 'secret'); // hidden — excluded from the picker
    const files = walkWorkspaceFiles(ws).sort();
    assert.deepEqual(files, ['README.md', 'src/index.ts']);
  } finally {
    rmSync(ws, { recursive: true, force: true });
  }
});

test('rankFileCandidates floats basename matches above deep path matches', () => {
  const files = ['src/unfoo/bar.ts', 'src/foo.ts', 'docs/foo-guide.md', 'lib/other.ts'];
  const ranked = rankFileCandidates(files, 'foo', 8);
  assert.equal(ranked[0], 'src/foo.ts', 'exact basename first');
  assert.ok(ranked.includes('docs/foo-guide.md'));
  assert.ok(!ranked.includes('lib/other.ts'), 'non-matches excluded');
});

test('findMentions extracts @paths and trims trailing punctuation', () => {
  const ms = findMentions('please review @src/a.ts and @docs/b.md, thanks');
  assert.deepEqual(ms.map((m) => m.path), ['src/a.ts', 'docs/b.md']);
  assert.equal(findMentions('an email a@b.com is not a mention').length, 0);
});

test('expandFileMentions inlines real in-jail files, preserves text, and ignores unresolved paths', () => {
  const ws = mkdtempSync(join(tmpdir(), 'fm-exp-'));
  try {
    mkdirSync(join(ws, 'src'), { recursive: true });
    writeFileSync(join(ws, 'src/math.ts'), 'export const add = (a,b)=>a+b;');
    const out = expandFileMentions('explain @src/math.ts and @does/not-exist.ts', ws);
    assert.match(out, /explain @src\/math\.ts/, 'original text preserved verbatim');
    assert.match(out, /--- @src\/math\.ts ---/, 'resolved file is fenced');
    assert.match(out, /export const add/, 'file content inlined');
    assert.doesNotMatch(out, /--- @does/, 'unresolved mention is not inlined');
    // No mentions → unchanged.
    assert.equal(expandFileMentions('plain message', ws), 'plain message');
  } finally {
    rmSync(ws, { recursive: true, force: true });
  }
});

test('expandFileMentions refuses a path escaping the jail', () => {
  const ws = mkdtempSync(join(tmpdir(), 'fm-jail-'));
  const outside = mkdtempSync(join(tmpdir(), 'fm-outside-'));
  try {
    writeFileSync(join(outside, 'secret.txt'), 'TOP SECRET');
    const out = expandFileMentions('read @../' + outside.split('/').pop() + '/secret.txt', ws);
    assert.doesNotMatch(out, /TOP SECRET/, 'a ../ escape is never inlined');
  } finally {
    rmSync(ws, { recursive: true, force: true });
    rmSync(outside, { recursive: true, force: true });
  }
});
