import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseMarkdown } from '../src/util/markdown.js';
import { segmentTableLine, isTableRuleLine, TABLE_COLLAPSE_THRESHOLD } from '../src/util/tableStyle.js';
import { flattenItem, type ViewportTheme } from '../src/tui/flatten.js';

const T: ViewportTheme = {
  fg: '#ffffff',
  dim: '#b6bcc3',
  green: '#22c55e',
  cyan: '#38bdf8',
  yellow: '#eab308',
  red: '#ef4444',
  purple: '#a78bfa',
  bright: '#ffffff',
};

test('segmentTableLine: full rule rows are border; data rows split on │', () => {
  assert.equal(isTableRuleLine('╭──┬──╮'), true);
  assert.equal(isTableRuleLine('┌──┬──┐'), true); // legacy corners still recognized
  assert.equal(isTableRuleLine('│ a │ b │'), false);
  const rule = segmentTableLine('├──┼──┤');
  assert.equal(rule.length, 1);
  assert.equal(rule[0]!.kind, 'border');
  const data = segmentTableLine('│ hi │ there │');
  assert.ok(data.some((s) => s.kind === 'border' && s.text === '│'));
  assert.ok(data.some((s) => s.kind === 'text' && s.text.includes('hi')));
  assert.ok(data.every((s) => s.kind === 'border' || s.kind === 'text'));
});

test('table borders are dim; header cells bold; body cells fg', () => {
  const md = `| Path | Purpose |
|------|---------|
| a/   | alpha   |
| b/   | beta    |`;
  const item = { id: 1, kind: 'assistant' as const, text: md };
  const rows = flattenItem(item, 80, false, T, false, false);
  const joined = rows.map((r) => r.spans.map((s) => s.text).join(''));
  assert.ok(joined.some((l) => l.includes('╭')), 'grid renders (under ⏺ gutter)');
  // Top border line: the ╭…╮ segment(s) are dim (gutter may be orange ⏺ / indent)
  const top = rows.find((r) => r.spans.some((s) => s.text.includes('╭')));
  assert.ok(top);
  assert.ok(
    top!.spans.filter((s) => /[╭─┬╮]/.test(s.text)).every((s) => s.color === T.dim),
    'rule chrome is dim',
  );
  // A header data line has bold text segments containing Path
  const headerRow = rows.find((r) => r.spans.some((s) => s.text.includes('Path') && s.bold));
  assert.ok(headerRow, 'header cell text is bold');
  assert.ok(headerRow!.spans.filter((s) => s.text === '│').every((s) => s.color === T.dim), 'header pipes dim');
});

test('large tables fold when foldLargeTables=true', () => {
  const header = '| c1 | c2 |\n|----|----|\n';
  const body = Array.from({ length: TABLE_COLLAPSE_THRESHOLD + 2 }, (_, i) => `| r${i} | v${i} |`).join('\n');
  const md = header + body;
  const item = { id: 2, kind: 'assistant' as const, text: md };

  const folded = flattenItem(item, 80, false, T, false, true);
  const foldText = folded.map((r) => r.spans.map((s) => s.text).join('')).join('\n');
  assert.match(foldText, /⌄ table \d+×2 · \^O/, 'fold summary when over threshold');
  assert.ok(!foldText.includes('╭'), 'no full grid when folded');

  const open = flattenItem(item, 80, false, T, false, false);
  const openText = open.map((r) => r.spans.map((s) => s.text).join('')).join('\n');
  assert.ok(openText.includes('╭'), 'full grid when foldLargeTables=false');
  assert.ok(!openText.includes('⌄ table'), 'no fold glyph when expanded');
});

test('small tables never fold', () => {
  const md = `| a | b |
|---|---|
| 1 | 2 |
| 3 | 4 |`;
  const item = { id: 3, kind: 'assistant' as const, text: md };
  const rows = flattenItem(item, 80, false, T, false, true);
  const text = rows.map((r) => r.spans.map((s) => s.text).join('')).join('\n');
  assert.ok(text.includes('╭'), '≤ threshold stays a grid');
  assert.ok(!text.includes('⌄ table'));
  // sanity: parser saw a table
  assert.ok(parseMarkdown(md).some((b) => b.type === 'table'));
});
