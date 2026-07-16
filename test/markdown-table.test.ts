import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseMarkdown, renderTableLines, spanText } from '../src/util/markdown.js';

test('parses a simple GFM table into header + rows', () => {
  const md = ['| Name | Age |', '| --- | --- |', '| Ada | 36 |', '| Alan | 41 |'].join('\n');
  const blocks = parseMarkdown(md);
  const t = blocks.find((b) => b.type === 'table');
  assert.ok(t, 'expected a table block');
  if (t!.type === 'table') {
    assert.deepEqual(t.header.map(spanText), ['Name', 'Age']);
    assert.equal(t.rows.length, 2);
    assert.deepEqual(t.rows[0]!.map(spanText), ['Ada', '36']);
    // Bare `---` separators parse as 'auto' — numeric columns right-align at render time.
    assert.deepEqual(t.align, ['auto', 'auto']);
  }
});

test('parses alignment from the separator row', () => {
  const md = ['| L | C | R |', '| :--- | :---: | ---: |', '| a | b | c |'].join('\n');
  const t = parseMarkdown(md).find((b) => b.type === 'table');
  if (t!.type === 'table') assert.deepEqual(t.align, ['left', 'center', 'right']);
});

test('renders a horizontal box-drawing table that fits the width', () => {
  const md = ['| Name | Age |', '| --- | --- |', '| Ada | 36 |'].join('\n');
  const t = parseMarkdown(md).find((b) => b.type === 'table')!;
  const lines = renderTableLines(t as Extract<typeof t, { type: 'table' }>, 100);
  assert.ok(lines.length >= 5); // top ╭, header, sep ├, body, bottom ╰
  assert.equal(lines[0]![0], '╭'); // rounded top border — same family as code blocks
  assert.match(lines[1]!, /Name/); // header on the row after the top border
  assert.ok(lines.some((l) => /Ada/.test(l))); // a body row
  assert.equal(lines[lines.length - 1]![0], '╰'); // rounded bottom border
});

test('numeric columns auto-right-align under a bare --- separator; explicit :--- stays left', () => {
  const md = ['| Region | Requests | Note |', '| --- | --- | :--- |', '| us-east | 42 | ok |', '| eu-west | 1,024 | ok |'].join('\n');
  const t = parseMarkdown(md).find((b) => b.type === 'table')!;
  const lines = renderTableLines(t as Extract<typeof t, { type: 'table' }>, 100);
  const row = lines.find((l) => l.includes('42'))!;
  const cells = row.split('│').slice(1, -1);
  assert.match(cells[1]!, / 42 $/, 'numeric cell hugs the right edge of its column (ledger style)');
  assert.match(cells[0]!, /^ us-east +$/, 'text column stays left');
  assert.match(cells[2]!, /^ ok +$/, 'explicit :--- forces left even though cells look uniform');
  // Mixed column (numbers + words) stays left — conservatism beats cleverness.
  const md2 = ['| a | b |', '| --- | --- |', '| 1 | 2 files |'].join('\n');
  const t2 = parseMarkdown(md2).find((b) => b.type === 'table')!;
  const lines2 = renderTableLines(t2 as Extract<typeof t2, { type: 'table' }>, 100);
  const row2 = lines2.find((l) => l.includes('files'))!;
  assert.match(row2.split('│')[2]!, /^ 2 files +$/, '"2 files" is not numeric — column stays left');
});

test('collapses to vertical key:value layout when too wide', () => {
  const md = ['| alpha | beta | gamma |', '| --- | --- | --- |', '| x | y | z |'].join('\n');
  const t = parseMarkdown(md).find((b) => b.type === 'table')!;
  // Force the narrow path with a tiny max width.
  const lines = renderTableLines(t as Extract<typeof t, { type: 'table' }>, 8);
  assert.ok(lines.some((l) => /^alpha: x$/.test(l)));
  assert.ok(lines.some((l) => /gamma: z/.test(l)));
});

test('honors escaped pipes inside cells', () => {
  const md = ['| expr | val |', '| --- | --- |', '| a\\|b | 1 |'].join('\n');
  const t = parseMarkdown(md).find((b) => b.type === 'table')!;
  if (t.type === 'table') assert.equal(spanText(t.rows[0]![0]!), 'a|b');
});

test('a header with no separator yet is NOT a table (streaming-safe)', () => {
  const md = ['| Name | Age |', '| Ada | 36 |'].join('\n'); // no separator line
  const blocks = parseMarkdown(md);
  assert.equal(blocks.find((b) => b.type === 'table'), undefined);
});

test('inline markdown inside cells is parsed', () => {
  const md = ['| col |', '| --- |', '| **bold** |'].join('\n');
  const t = parseMarkdown(md).find((b) => b.type === 'table')!;
  if (t.type === 'table') assert.equal(t.rows[0]![0]![0]!.bold, true);
});

test('right/center alignment keeps every rendered line the same width (pipes align)', () => {
  const md = ['| name | count |', '| --- | ----: |', '| foo | 12 |'].join('\n');
  const t = parseMarkdown(md).find((b) => b.type === 'table')!;
  const lines = renderTableLines(t as Extract<typeof t, { type: 'table' }>, 100);
  const len = lines[0]!.length;
  assert.ok(
    lines.every((l) => l.length === len),
    `misaligned:\n${lines.map((l) => `${l.length}|${l}`).join('\n')}`,
  );
});

test('header is padded when the separator has more columns than the header', () => {
  const md = ['| a | b |', '|---|---|---|', '| 1 | 2 | 3 |'].join('\n');
  const t = parseMarkdown(md).find((b) => b.type === 'table')!;
  if (t.type === 'table') assert.equal(t.header.length, 3); // padded to colCount
  const lines = renderTableLines(t as Extract<typeof t, { type: 'table' }>, 100);
  // header row (line 1, after the top border) has 3 cells → 4 vertical bars
  assert.equal((lines[1]!.match(/│/g) ?? []).length, 4);
});

test('emoji cells: borders stay aligned by DISPLAY width (✅ is 2 columns, not 1)', () => {
  const md = ['| Feature | Status |', '| --- | --- |', '| Tables | ✅ done |', '| Lists | no |'].join('\n');
  const block = parseMarkdown(md).find((b) => b.type === 'table')!;
  const lines = renderTableLines(block as never, 80);
  // Measure every line by the same display-width rule (emoji=2): all must be equal, so the │
  // verticals align in a real terminal even with a ✅ in one cell.
  const width = (s: string): number => [...s].reduce((n, ch) => {
    const cp = ch.codePointAt(0)!;
    return n + (cp === 0x2705 || cp >= 0x1f000 ? 2 : 1);
  }, 0);
  const widths = lines.map(width);
  assert.ok(widths.every((w) => w === widths[0]), `all lines equal display width, saw ${widths.join(',')}`);
});

test('a WIDE table WRAPS ITS CELLS into a grid instead of collapsing to key:value (the screenshot bug)', () => {
  // The exact failure: a 3-column table whose natural width exceeds the terminal rendered as
  // "— row N — / Subject: … / What it is: …" labeled lines. It must render a real grid with
  // wrapped cells at any sane width.
  const md = [
    '| Subject | What it is | Why it matters |',
    '| --- | --- | --- |',
    '| Aerodynamics | Lift, drag, stalls, spins, turns | Understand why the plane behaves — not just what to do |',
    '| Weather / Meteorology | Clouds, fronts, METARs, TAFs, winds, icing | Weather kills pilots. Learn to read it cold. |',
  ].join('\n');
  const t = parseMarkdown(md).find((b) => b.type === 'table')!;
  const lines = renderTableLines(t as Extract<typeof t, { type: 'table' }>, 100);
  assert.ok(lines[0]!.startsWith('╭'), 'renders a GRID, not the vertical fallback');
  assert.ok(!lines.some((l) => l.startsWith('— row')), 'no "— row N —" labels');
  // Every line fits and all lines are the same width (verticals align).
  for (const l of lines) assert.ok(l.length <= 100, `line fits: ${l.length}`);
  assert.ok(new Set(lines.map((l) => l.length)).size === 1, 'all lines equal width');
  // Nothing lost: every word of the longest cell survives the wrap.
  const joined = lines.join(' ');
  for (const wordText of ['Understand', 'behaves', 'cold.', 'METARs,', 'Aerodynamics']) {
    assert.ok(joined.includes(wordText), `cell content preserved: ${wordText}`);
  }
  // Wrapped rows are separated by inter-row rules for legibility.
  assert.ok(lines.filter((l) => l.startsWith('├')).length >= 2, 'header rule + at least one inter-row rule');
});

test('a table that fits at natural width keeps the tight single-line form (no inter-row rules)', () => {
  const md = ['| a | b |', '| --- | --- |', '| 1 | 2 |', '| 3 | 4 |'].join('\n');
  const t = parseMarkdown(md).find((b) => b.type === 'table')!;
  const lines = renderTableLines(t as Extract<typeof t, { type: 'table' }>, 80);
  assert.equal(lines.filter((l) => l.startsWith('├')).length, 1, 'only the header separator');
  assert.equal(lines.length, 6, '╭ header ├ row row ╰');
});
