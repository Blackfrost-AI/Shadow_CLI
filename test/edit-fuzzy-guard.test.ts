import { test } from 'node:test';
import assert from 'node:assert/strict';
import { applyStringEdit } from '../src/tools/util.js';

/**
 * G1 — fuzzy matching could rewrite a line the model never read.
 *
 * Bigram similarity is least discriminating on SHORT strings. Verified against the old code:
 * `old_string: "  const RETRY_LIMIT = 5;"` matched a file containing `= 3;` above the 0.85
 * threshold and rewrote it — changing a value the model had not seen, with no approval at the
 * default autonomy. The repair ladder earns its keep on multi-line hunks whose whitespace has
 * drifted; on ONE line the exact / trailing-ws / indent strategies already cover every
 * legitimate case, so anything reaching fuzzy is a guess.
 */
const FILE = ['function f() {', '  const RETRY_LIMIT = 3;', '  return RETRY_LIMIT;', '}'].join('\n');

test('a single-line near-miss is REFUSED, not guessed', () => {
  const r = applyStringEdit(FILE, '  const RETRY_LIMIT = 5;', '  const RETRY_LIMIT = 9;', false);
  assert.equal(r.ok, false, 'must not rewrite a line the model never read');
});

test('a single-line EXACT match still applies', () => {
  const r = applyStringEdit(FILE, '  const RETRY_LIMIT = 3;', '  const RETRY_LIMIT = 9;', false);
  assert.equal(r.ok, true);
  assert.equal((r as { strategy: string }).strategy, 'exact');
  assert.match((r as { updated: string }).updated, /RETRY_LIMIT = 9/);
});

test('a multi-line hunk with drifted whitespace still repairs — that is what the ladder is for', () => {
  const r = applyStringEdit(
    FILE,
    'function f() {\n   const RETRY_LIMIT = 3;', // note the extra space
    'function f() {\n  const RETRY_LIMIT = 9;',
    false,
  );
  assert.equal(r.ok, true, 'the multi-line repair path is untouched');
  assert.match((r as { updated: string }).updated, /RETRY_LIMIT = 9/);
});

test('single-line whitespace drift is still handled by the EXACT-adjacent strategies', () => {
  // Trailing whitespace is a normalization, not a guess — it must keep working on one line.
  const r = applyStringEdit(FILE, '  const RETRY_LIMIT = 3;   ', '  const RETRY_LIMIT = 9;', false);
  assert.equal(r.ok, true, 'trailing-ws repair does not depend on fuzzy');
});
