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

test('an EMPTY old_string is refused, never a wildcard over every blank line', () => {
  // countOccurrences() returns 0 for an empty needle (its `if (!needle) return 0` guard), so the
  // exact strategy was skipped and the LINE-BASED ladder ran with oldLines === [''] — matching every
  // blank line in the file. `old_string: ""` + replace_all then rewrote each one, dropped the
  // file's trailing newline, and reported "replaced 3 occurrence(s) (matched via trailing-ws)".
  const file = 'a\n\nb\n\nc\n';
  const r = applyStringEdit(file, '', 'Z', true);
  assert.equal(r.ok, false, 'an empty old_string is never a valid edit');
  assert.equal((r as { reason: string }).reason, 'empty');
  // …and the same without replace_all (which previously reported the baffling "matches 3 times").
  assert.equal(applyStringEdit(file, '', 'Z', false).ok, false);
});

test('a multi-line old_string that ends with a newline still matches (the phantom blank line)', () => {
  // `split('\n')` yields a trailing '' for a trailing newline, and findBlockMatches required the
  // FILE to have a blank line there — so a block copied WITH its terminator (the exact case the
  // tolerant ladders exist for) could never match: exact failed on whitespace and both ladders
  // failed on the phantom blank, reporting a spurious "not found".
  const drifted = 'a\n  b\n  c\nd\n';
  const r = applyStringEdit(drifted, 'b\nc\n', 'B\nC\n', false);
  assert.equal(r.ok, true, 'trailing newline must not break the ladder');
  assert.ok(r.ok);
  // No blank line is inserted, and the block keeps the file's own indentation.
  assert.equal(r.updated, 'a\n  B\n  C\nd\n');
  // Exact match with a trailing newline is unchanged (it never reached the ladder).
  assert.deepEqual(applyStringEdit('a\nb\nc\nd\n', 'b\nc\n', 'B\nC\n', false), {
    ok: true,
    updated: 'a\nB\nC\nd\n',
    count: 1,
    strategy: 'exact',
  });
  // A trailing newline in old_string with none in new_string simply joins the lines.
  assert.equal(applyStringEdit('a\n  b\n  c\nd\n', 'b\nc\n', 'B', false).ok, true);
});
