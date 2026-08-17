// Transcript wrapping polish pins (the "world-class text wrapping" batch).
// OSC 8 hyperlinks: the flattener embeds REAL hyperlink escapes into span text (mdSpanToStyled),
// but width.ts only stripped SGR — so a link measured label + entire URL (a 14-col link measured
// 112) and hard-splits cut MID-ESCAPE, committing rows of raw unterminated URL fragments. The
// width paths now strip OSC (split rows degrade to the plain label) and the word-wrap tokenizer
// re-merges a split link so a row boundary can never land inside an escape pair.
// VS16: base+FE0F requests emoji presentation = 2 columns; the max-codepoint measure said 1 and
// wrap="truncate" silently deleted the overrun column.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { displayWidth, takeByWidth } from '../src/util/width.js';
import { wrapSpansWord } from '../src/tui/flatten.js';
import { hyperlink } from '../src/util/hyperlinks.js';

const link = hyperlink('the Array docs', 'https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Global_Objects/Array/map');

test('displayWidth: OSC 8 hyperlink measures its LABEL, not label + URL', () => {
  assert.equal(displayWidth(link), 'the Array docs'.length);
  // SGR behavior unchanged (regression guard for the shared strip).
  assert.equal(displayWidth('\x1b[31mred\x1b[0m'), 3);
});

test('takeByWidth: a hard split degrades to plain label text, never a cut escape', () => {
  const { head, rest } = takeByWidth(link, 5);
  assert.ok(!head.includes('\x1b'), 'head must not carry a partial escape');
  assert.ok(!rest.includes('\x1b'), 'rest must not carry a partial escape');
  assert.equal(displayWidth(head), 5);
});

test('wrapSpansWord: a multi-word link label stays one token across row boundaries', () => {
  const rows = wrapSpansWord([{ text: `Read ${link} for flatMap.`, color: 'c' }], 20);
  for (const row of rows) {
    for (const sp of row) {
      // Every row's escapes must be BALANCED (an unterminated open styles the rest of the row —
      // and beyond — as the link URL).
      const opens = (sp.text.match(/\x1b\]8;;[^\x07\x1b]+?(?:\x07|\x1b\\)/g) ?? []).length;
      const closes = (sp.text.match(/\x1b\]8;;(?:\x07|\x1b\\)/g) ?? []).length;
      assert.equal(opens, closes, `unbalanced link escape in row text ${JSON.stringify(sp.text)}`);
    }
  }
  // And the link itself was not dropped: some row carries the label.
  const flat = rows.map((r) => r.map((s) => s.text).join('')).join('\n');
  assert.ok(flat.includes('the Array docs'), 'label text survives');
});

test('wrapSpansWord: rows never exceed the column budget with links present', () => {
  const rows = wrapSpansWord([{ text: `See ${link} plus ${link} again.`, color: 'c' }], 24);
  for (const row of rows) {
    const w = row.reduce((n, s) => n + displayWidth(s.text), 0);
    assert.ok(w <= 24, `row measures ${w}`);
  }
});

test('clusterWidth: text-default symbol + VS16 (emoji presentation) is 2 columns', () => {
  assert.equal(displayWidth('❤️'), 2); // U+2764 U+FE0F — measured 1 before
  assert.equal(displayWidth('⚠️'), 2); // U+26A0 U+FE0F
  assert.equal(displayWidth('❤'), 1); // bare heart, no selector — still 1
  assert.equal(displayWidth('✅'), 2); // emoji-default already 2 via the table
});

// Soft-break reflow: a single newline inside paragraph/quote prose is a SPACE (CommonMark soft
// break), not a row break. Models that hard-wrap prose at ~72 cols used to render as a ragged
// 72-column block on a wide terminal — half the width unused. Mirrors the live preview's rule
// (markdown.ts wrapSpans). Structure blocks (code) keep their source lines.
import { flattenItem } from '../src/tui/flatten.js';
import type { ViewportTheme } from '../src/tui/flatten.js';

const theme: ViewportTheme = { fg: '#fff', dim: '#888', green: 'g', cyan: 'c', yellow: 'y', red: 'r', purple: 'p' };
const rowText = (rows: { spans: { text: string }[] }[]): string[] => rows.map((r) => r.spans.map((s) => s.text).join(''));

test('hard-wrapped paragraph prose reflows to the terminal width', () => {
  const para = [
    'Hard-wrapped prose that a model',
    'broke at 30 columns reflows',
    'into one wide row.',
  ].join('\n');
  const rows = flattenItem({ id: 1, kind: 'assistant', text: para, tight: true }, 100, false, theme);
  const content = rowText(rows).filter((t) => t.trim() !== '');
  assert.equal(content.length, 1, `one logical paragraph paints as ONE row at width 100, got ${JSON.stringify(content)}`);
  assert.ok(displayWidth(content[0]!) > 60, `reflows wide, got ${displayWidth(content[0]!)}`);
  assert.ok(content[0]!.includes('model broke'), 'the soft break became a space');
});

test('quote soft breaks reflow; the │ bar stays on every wrapped row', () => {
  const rows = flattenItem({ id: 2, kind: 'assistant', text: '> one two three four five six', tight: true }, 14, false, theme);
  const content = rowText(rows).filter((t) => t.trim() !== '');
  assert.ok(content.length >= 2, 'wraps at the narrow width');
  for (const t of content) assert.ok(t.includes('│'), `bar missing on ${JSON.stringify(t)}`);
  const flat = content.join(' ');
  assert.ok(!flat.match(/one\ntwo|three\nfour/), 'no source newline survives inside the quote body');
});

test('code blocks keep their source lines — soft-break reflow never touches code', () => {
  const rows = flattenItem({ id: 3, kind: 'assistant', text: '```\nab\ncd\n```', tight: true }, 100, false, theme);
  const content = rowText(rows);
  const ab = content.findIndex((t) => t.includes('ab'));
  const cd = content.findIndex((t) => t.includes('cd'));
  assert.ok(ab >= 0 && cd >= 0, 'both code lines paint');
  assert.notEqual(ab, cd, 'source lines stay on separate rows');
});

test('H1 underline matches the title width in COLUMNS (CJK title)', () => {
  const rows = flattenItem({ id: 4, kind: 'assistant', text: '# 你好世界', tight: true }, 100, false, theme);
  const content = rowText(rows);
  const title = content.find((t) => t.includes('你好世界'));
  const rule = content.find((t) => /^\s*─+\s*$/.test(t));
  assert.ok(title && rule, 'title and underline both paint');
  const bar = rule!.match(/─+/)![0]!;
  assert.equal(displayWidth(bar), 8, '4 CJK glyphs → 8 columns of rule');
});

test('finding-card header truncates to the width (long title never splits the border row)', () => {
  const rows = flattenItem({ id: 5, kind: 'finding', title: 'x'.repeat(120), text: 'body', severity: 'warn' }, 40, false, theme);
  const header = rowText(rows).find((t) => t.includes('╭─'))!;
  assert.ok(displayWidth(header) <= 40, `header fits 40 cols, got ${displayWidth(header)}`);
  assert.ok(header.includes('…'), 'ellipsis marks the cut');
});
