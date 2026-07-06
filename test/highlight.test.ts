import { test } from 'node:test';
import assert from 'node:assert/strict';
import { highlight, type CodeRole } from '../src/util/highlight.js';

/** All spans of a given role, joined. */
function roleText(code: string, lang: string, role: CodeRole): string {
  return highlight(code, lang)
    .filter((s) => s.role === role)
    .map((s) => s.text)
    .join('|');
}

test('highlight is lossless — spans reconstruct the original code', () => {
  const code = 'const x = "hi"; // note\nfn(1, 2.5)';
  assert.equal(highlight(code, 'ts').map((s) => s.text).join(''), code);
});

test('classifies keywords, strings, numbers, and // comments', () => {
  const code = 'const n = 42 // count';
  assert.equal(roleText(code, 'ts', 'keyword'), 'const');
  assert.equal(roleText(code, 'ts', 'number'), '42');
  assert.equal(roleText(code, 'ts', 'comment'), '// count');
  const str = highlight('const s = "hello"', 'ts').find((s) => s.role === 'string');
  assert.equal(str?.text, '"hello"');
});

test('uses # line comments for hash-comment languages (python), not //', () => {
  assert.equal(roleText('x = 1  # set x', 'python', 'comment'), '# set x');
  // In a C-family language, # is NOT a comment.
  assert.equal(roleText('a # b', 'ts', 'comment'), '');
});

test('highlights JSON literals and numbers', () => {
  const code = '{"on": true, "n": 3}';
  assert.equal(roleText(code, 'json', 'keyword'), 'true'); // true/false/null colored as literals
  assert.equal(roleText(code, 'json', 'number'), '3');
});
