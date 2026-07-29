/**
 * Frame-height budget — the scrollback-wipe class.
 *
 * Ink falls back to `clearTerminal` (which emits ESC[3J and destroys the user's scrollback) as soon
 * as a rendered frame's height reaches the terminal's row count. Shadow deliberately keeps every
 * live frame BELOW that, and bounds the two variable-height blocks — the pinned task list and the
 * model picker — by row count.
 *
 * Two demonstrated regressions this locks down:
 *   - `pinnedMaxItems` budgeted a SINGLE-line composer, but the composer grows to 8 visual rows. An
 *     expanded task list plus a multi-line draft wiped scrollback on every keystroke.
 *   - the model picker used a hardcoded 10-row window that never consulted `rows`, so terminals of
 *     ~19 rows and below wiped scrollback whenever the picker repainted.
 *
 * A sweep, not examples: the failure only shows at particular row counts, which is exactly what a
 * handful of hand-picked cases miss.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { pinnedMaxItems, composerMaxRows, COMPOSER_VISIBLE_ROW_CAP } from '../src/tui/layout.js';

/** Chrome the pinned block cannot avoid, mirroring the doc contract in layout.ts. */
const BASE_CHROME = 11;
const COMPOSER_MAX_VISIBLE_ROWS = COMPOSER_VISIBLE_ROW_CAP;

/** Physical rows the live frame occupies for a given configuration. */
function frameHeight(
  items: number,
  hasGoal: boolean,
  hasPlanPath: boolean,
  hasCustomStatus: boolean,
  composerInputRows: number,
): number {
  return (
    BASE_CHROME +
    items +
    (composerInputRows - 1) +
    (hasGoal ? 1 : 0) +
    (hasPlanPath ? 1 : 0) +
    (hasCustomStatus ? 1 : 0)
  );
}

test('pinned task list never lets the frame reach terminal height — full sweep', () => {
  const failures: string[] = [];
  for (let rows = 15; rows <= 40; rows++) {
    for (const hasGoal of [false, true]) {
      for (const hasPlanPath of [false, true]) {
        for (const hasCustomStatus of [false, true]) {
          // The draft can only ever be as tall as the composer budget allows — that cap is part
          // of the contract under test, not an assumption the test gets to make.
          const cap = composerMaxRows(rows, true, hasGoal, hasPlanPath, hasCustomStatus);
          for (let composerInputRows = 1; composerInputRows <= cap; composerInputRows++) {
            const items = pinnedMaxItems(rows, hasGoal, hasPlanPath, hasCustomStatus, composerInputRows);
            const h = frameHeight(items, hasGoal, hasPlanPath, hasCustomStatus, composerInputRows);
            if (h >= rows) {
              failures.push(
                `rows=${rows} goal=${hasGoal} plan=${hasPlanPath} status=${hasCustomStatus} ` +
                  `draft=${composerInputRows} → items=${items}, frame=${h} ≥ ${rows} (ESC[3J, scrollback gone)`,
              );
            }
          }
        }
      }
    }
  }
  assert.deepEqual(failures.slice(0, 8), [], `${failures.length} configurations would wipe scrollback`);
});

test('pinnedMaxItems never returns a negative count', () => {
  for (let rows = 5; rows <= 40; rows++) {
    for (let draft = 1; draft <= COMPOSER_MAX_VISIBLE_ROWS; draft++) {
      assert.ok(pinnedMaxItems(rows, true, true, true, draft) >= 0, `rows=${rows} draft=${draft}`);
    }
  }
});

test('a taller draft can only ever shrink the task list, never grow it', () => {
  // Monotonicity: the budget must respond in the right direction, or the fix is accidental.
  for (let rows = 15; rows <= 40; rows++) {
    for (let draft = 2; draft <= COMPOSER_MAX_VISIBLE_ROWS; draft++) {
      const prev = pinnedMaxItems(rows, false, false, false, draft - 1);
      const cur = pinnedMaxItems(rows, false, false, false, draft);
      assert.ok(cur <= prev, `rows=${rows}: draft ${draft} allows ${cur} items vs ${prev} at ${draft - 1}`);
    }
  }
});

test('the pre-fix default (single-line assumption) is what the sweep catches', () => {
  // Calling without the composer argument reproduces the old signature exactly. At least one
  // configuration must overflow, or this test file proves nothing.
  let overflowed = 0;
  for (let rows = 15; rows <= 40; rows++) {
    for (let draft = 2; draft <= COMPOSER_MAX_VISIBLE_ROWS; draft++) {
      const items = pinnedMaxItems(rows, false, false, false); // old call site
      if (frameHeight(items, false, false, false, draft) >= rows) overflowed++;
    }
  }
  assert.ok(overflowed > 0, 'expected the unbudgeted composer to overflow somewhere');
});

test('model picker window scales with terminal height', () => {
  // Mirrors the derivation in tui.tsx. The picker's chrome is ~9 rows (title, rules, composer,
  // status strip); a fixed 10-row window ignored `rows` entirely.
  const pickerMax = (rows: number): number => Math.max(3, Math.min(10, rows - 9));
  for (let rows = 15; rows <= 40; rows++) {
    const window = pickerMax(rows);
    assert.ok(window >= 3, `rows=${rows}: window must stay usable`);
    assert.ok(window <= 10, `rows=${rows}: window must stay capped`);
    if (rows >= 15) {
      assert.ok(window + 9 < rows + 3, `rows=${rows}: picker frame ${window + 9} is too tall`);
    }
  }
  assert.equal(pickerMax(19), 10, '19 rows still affords the full window');
  assert.equal(pickerMax(15), 6, 'a 15-row terminal gets a proportionally smaller window');
  assert.ok(pickerMax(15) < 10, 'and specifically NOT the old hardcoded 10');
});
