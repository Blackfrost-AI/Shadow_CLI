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
    assert.deepEqual(t.align, ['left', 'left']);
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
  assert.ok(lines.length >= 5); // top ┌, header, sep ├, body, bottom └
  assert.equal(lines[0]![0], '┌'); // box-drawing top border
  assert.match(lines[1]!, /Name/); // header on the row after the top border
  assert.ok(lines.some((l) => /Ada/.test(l))); // a body row
  assert.equal(lines[lines.length - 1]![0], '└'); // bottom border
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
