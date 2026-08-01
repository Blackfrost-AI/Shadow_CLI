import { test } from 'node:test';
import assert from 'node:assert/strict';
import React from 'react';
import { render } from 'ink-testing-library';
import { Composer } from '../src/tui.js';
import { layoutComposer, COMPOSER_GUTTER, COMPOSER_MAX_VISIBLE_ROWS } from '../src/tui/composer.js';

/**
 * Render-level regression guard for the Composer (BUG 2: "text doesn't wrap properly in the text
 * entry line"). The pure layout engine is already unit-tested (composer-width/multiline/composer
 * suites) — these tests render the REAL <Composer> through ink-testing-library to prove that the
 * widths the engine measures and the widths the component paints AGREE, so `wrap="truncate"`
 * never clips a character the user typed. They lock in the post-84c98c7/48e3165 correct behavior
 * so a future edit that brings back a measure/paint mismatch fails loudly.
 */

const PADDING = ' '.repeat(4); // PAGE_MARGIN — where the bordered composer box starts on screen

function renderedRows(input: string, cursor: number, cols: number): string[] {
  const tree = render(React.createElement(Composer, { input, cursor, hint: 'hint', cols } as never));
  const out = (tree.lastFrame() ?? '').split('\n');
  tree.unmount();
  return out;
}

/** Content rows are the ones carrying the draft (they begin at the page margin + gutter). */
function contentRows(rows: string[], needle: RegExp): string[] {
  return rows.filter((r) => needle.test(r));
}

test('BUG2 guard: full draft text survives rendering at 80 cols (ascii + long token)', () => {
  const input = 'x'.repeat(300);
  const rows = renderedRows(input, input.length, 80);
  const content = contentRows(rows, /x/);
  const visible = content.join('').split('x').length - 1;
  assert.equal(visible, 300, 'every typed character (incl. inside a 300-char unbroken token) is on screen');
  // No content row may exceed the box width + page margin, otherwise it spilled and got truncated.
  for (const r of content) {
    assert.ok(
      // boxW = cols - PAGE_MARGIN*2, so screen extent = PAGE_MARGIN + boxW = cols - PAGE_MARGIN
      r.length <= 80 - 4 + 2, // allow +2 for CJK/wide measurement slop but require nothing is cut
      `content row is ${r.length} cols (must not exceed the terminal width)`,
    );
  }
});

test('BUG2 guard: CJK wide text is not clipped at row ends (cols=80, 60, 24)', () => {
  const cjk =
    '你好世界这是一个非常长的中文字符串用来测试换行是否正确显示在输入框中是否会被截断显示完整内容。'.repeat(4);
  for (const cols of [80, 60, 24]) {
    const rows = renderedRows(cjk, cjk.length, cols);
    const joined = rows.join('');
    assert.ok(joined.includes('。'), `final CJK char must be visible at cols=${cols}`);
    // ensure we actually wrapped (multi-row), i.e. wrapping is happening, not overflowing
    const content = contentRows(rows, /[\u4e00-\u9fff]/);
    assert.ok(content.length >= 2, `CJK draft wraps to multiple rows at cols=${cols}`);
    for (const r of content) {
      assert.ok(r.length <= cols, `no CJK content row exceeds the terminal width at cols=${cols}`);
    }
  }
});

test('BUG2 guard: emoji graphemes are never split or dropped', () => {
  const input = 'hello '.repeat(8) + '🌍'.repeat(30) + '!';
  const rows = renderedRows(input, input.length, 80);
  const joined = rows.join('');
  assert.ok(joined.includes('🌍'), 'emoji present');
  assert.ok(joined.includes('!'), 'trailing char present');
});

test('BUG2 guard: caret on a full-width row does not overflow (cursor at end)', () => {
  const input = 'c'.repeat(400);
  // Cursor at 400 (end) → caret row is the last, fully-populated row.
  const rows = renderedRows(input, input.length, 80);
  const content = contentRows(rows, /c/);
  for (const r of content) assert.ok(r.length <= 80, `caret row len ${r.length} <= 80`);
  const visible = content.join('').split('c').length - 1;
  assert.equal(visible, 400, 'full draft visible with caret on the last row');
});

test('BUG2 guard: layout engine never emits a row wider than requested (parity with paint)', () => {
  // The engine must never hand the painter a row that fills MORE than inner columns; if it did,
  // the painted gutter + text would exceed the bordered box and truncate. Cross-check the invariant
  // the renderer relies on for a range of widths.
  for (const cols of [24, 40, 60, 80, 120]) {
    const inner = Math.max(8, cols - COMPOSER_GUTTER - 8); // PAGE_MARGIN*2 = 8
    const text = 'a'.repeat(cols * 6);
    const { lines } = layoutComposer(text, inner);
    for (const line of lines) {
      assert.ok(line.length <= inner, `row width ${line.length} <= inner ${inner} at cols=${cols}`);
    }
  }
  void COMPOSER_MAX_VISIBLE_ROWS; // referenced to keep import meaningful
  void PADDING;
});
