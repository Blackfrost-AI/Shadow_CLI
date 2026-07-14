import { test } from 'node:test';
import assert from 'node:assert/strict';
import { wrapSpansWord, truncateSpans, flattenItem, TOOL_BODY_EXPAND_CAP, itemIsCollapsible } from '../src/tui/flatten.js';
import { renderToolResult } from '../src/tui/rows.js';
import type { ViewportTheme } from '../src/tui/flatten.js';

const T: ViewportTheme = {
  fg: '#ffffff', dim: '#b6bcc3', green: '#22c55e', cyan: '#38bdf8',
  yellow: '#eab308', red: '#ef4444', purple: '#a78bfa',
};

const text = (rows: { text: string }[][]) => rows.map((r) => r.map((s) => s.text).join(''));

test('wrapSpansWord: breaks at spaces, never mid-word — kills the DOS edge-wrap', () => {
  const rows = text(wrapSpansWord([{ text: 'the quick brown foxes jumped over the lazy dog' }], 16));
  assert.deepEqual(rows, ['the quick brown', 'foxes jumped', 'over the lazy', 'dog']);
  for (const r of rows) assert.ok(r.length <= 16 && !r.startsWith(' ') && !r.endsWith(' '));
});

test('wrapSpansWord: a token wider than the measure still hard-splits (URLs)', () => {
  const rows = text(wrapSpansWord([{ text: 'see https://averyveryverylongdomainname.example/path ok' }], 20));
  assert.equal(rows[0], 'see');
  assert.ok(rows[1]!.length === 20, 'over-long token hard-split at the measure');
  assert.ok(rows.join('').includes('averyveryverylongdomainname'), 'nothing lost');
});

test('wrapSpansWord: preserves styles across the wrap', () => {
  const rows = wrapSpansWord([{ text: 'bold words here', bold: true }], 6);
  for (const row of rows) for (const s of row) assert.equal(s.bold, true);
});

test('truncateSpans: single row with ellipsis, never exceeds the measure', () => {
  const spans = truncateSpans([{ text: '✓ ', color: '#22c55e' }, { text: 'x'.repeat(200), color: '#b6bcc3' }], 40);
  const s = spans.map((x) => x.text).join('');
  assert.ok(s.length <= 40);
  assert.ok(s.endsWith('…'));
});

test('truncateSpans: a span filling EXACTLY to the width + a follower never overflows by one (audit #5)', () => {
  // The overflow case: span 1 fills len to exactly w, span 2 needs an ellipsis. Naively appending
  // '…' after the full-width span made the row w+1 → the terminal hard-wrapped it. The trim guard
  // must claw back a column first.
  const spans = truncateSpans([{ text: 'a'.repeat(40) }, { text: 'bcd' }], 40);
  const s = spans.map((x) => x.text).join('');
  assert.equal(s.length, 40, 'row is exactly the width, not w+1');
  assert.ok(s.endsWith('…'), 'ellipsis present');
});

test('ordered list: a nested sub-bullet does NOT inflate the next top-level number (audit #3)', () => {
  const md = ['1. first', '   - sub bullet', '2. second', '3. third'].join('\n');
  const rows = flattenItem({ id: 1, kind: 'assistant', text: md }, 60, false, T);
  const joined = rows.map((r) => r.spans.map((s) => s.text).join('')).join('\n');
  assert.match(joined, /1\. first/, 'first stays 1.');
  assert.match(joined, /2\. second/, 'second is 2. (not 3.) — nested bullet did not advance the counter');
  assert.match(joined, /3\. third/, 'third is 3.');
  assert.doesNotMatch(joined, /\b4\. /, 'no skipped number');
});

test('wide table vertical fallback wraps instead of terminal hard-wrapping mid-word (audit #6)', () => {
  // A 2-col table far wider than `cols` collapses to key:value lines; a long value must WRAP at the
  // measure, not run past it (the DOS edge-wrap the redesign killed everywhere else).
  const md = ['| Key | Value |', '| --- | --- |', `| name | ${'x'.repeat(80)} |`].join('\n');
  const rows = flattenItem({ id: 1, kind: 'assistant', text: md }, 30, false, T);
  for (const r of rows) {
    const w = r.spans.map((s) => s.text).join('').length;
    assert.ok(w <= 30, `every table row fits ${30} cols, saw ${w}`);
  }
});

test('assistant ⏺ turn bullet: on the first block, indent-only on continuations (once per turn)', () => {
  // A streamed answer commits as MANY assistant items; the ⏺ must mark the turn ONCE. The first
  // block draws the orange ⏺ on line 0; a continuation block (same turn) gets the 2-col indent so it
  // aligns under the first block's text — never a second dot.
  const DOT = process.platform === 'darwin' ? '⏺' : '●';
  const nonBlank = (rows: { spans: { text: string }[] }[]) => rows.filter((r) => r.spans.some((s) => s.text.trim() !== ''));

  const first = nonBlank(flattenItem({ id: 1, kind: 'assistant', text: 'first line\nsecond line' }, 60, false, T));
  assert.equal(first[0]!.spans[0]!.text, `${DOT} `, 'first block: ⏺ on the first content line');
  assert.equal(first[0]!.spans[0]!.color, '#d97757', 'the dot is Claude orange');
  assert.equal(first[1]!.spans[0]!.text, '  ', 'wrapped line of the first block aligns under the dot (indent)');
  assert.equal(first.filter((r) => r.spans[0]!.text === `${DOT} `).length, 1, 'exactly one ⏺ in the first block');

  const cont = nonBlank(flattenItem({ id: 2, kind: 'assistant', text: 'continued paragraph' }, 60, false, T, true));
  assert.equal(cont[0]!.spans[0]!.text, '  ', 'continuation block: indent, NOT a second ⏺');
  assert.ok(cont.every((r) => r.spans[0]!.text !== `${DOT} `), 'no ⏺ anywhere in a continuation block');
});

test('user prompt: ❯ gutter on line 0, dim body, hanging indent on wraps and typed lines', () => {
  // The typed prompt must not render as a full-width bold-green blob: ❯ marks the turn (green,
  // like the assistant's ⏺), the body is the quiet dim tier, and every wrapped or subsequent
  // typed line aligns under the text via the 2-col gutter.
  const md = 'a prompt long enough to wrap at this narrow measure\n1. a typed list line';
  const rows = flattenItem({ id: 3, kind: 'user', text: `❯ ${md}`, color: T.green, bold: true }, 30, false, T);
  const nonBlank = rows.filter((r) => r.spans.some((s) => s.text.trim() !== ''));
  assert.equal(nonBlank[0]!.spans[0]!.text, '❯ ', '❯ gutter on the first content line');
  assert.equal(nonBlank[0]!.spans[0]!.color, T.green, 'the marker is green');
  assert.ok(nonBlank.slice(1).every((r) => r.spans[0]!.text === '  '), 'every other row aligns under the text');
  assert.equal(nonBlank.filter((r) => r.spans[0]!.text === '❯ ').length, 1, 'exactly one ❯');
  const body = nonBlank.flatMap((r) => r.spans.slice(1));
  assert.ok(body.every((s) => s.color === T.dim), 'body is the quiet dim tier, not bold green');
  assert.ok(body.every((s) => !s.bold), 'no bold body');
  const joined = nonBlank.map((r) => r.spans.map((s) => s.text).join('')).join('\n');
  assert.match(joined, /1\. a typed list line/, 'typed text is verbatim — no markdown rewrite');
  for (const r of rows) assert.ok(r.spans.map((s) => s.text).join('').length <= 30, 'fits the measure');
});

test('tool output child: collapsed = one-row ⌄ fold; expanded = ⎿ body (no 10-line preview)', () => {
  const lines = Array.from({ length: 15 }, (_, i) => ({ text: `line ${i + 1}`, color: T.dim }));
  const item = { id: 7, kind: 'tool' as const, text: '', meta: 'output', lines };

  const join = (rows: { spans: { text: string }[] }[]) => rows.map((r) => r.spans.map((s) => s.text).join(''));

  // Collapsed → exactly ONE row: `  ⌄ output 15 lines · ^O` (design law: no multi-line teaser).
  const collapsed = flattenItem(item, 80, true, T);
  assert.equal(collapsed.length, 1, 'collapsed body is a single fold row');
  const foldText = join(collapsed)[0]!;
  assert.match(foldText, /⌄ output 15 lines · \^O/);
  assert.ok(!foldText.includes('line 1'), 'raw body never peeks when collapsed');

  // Expanded (Ctrl-O) → full body under ⎿, no fold glyph.
  const expanded = flattenItem(item, 80, false, T);
  const expandedText = join(expanded);
  assert.equal(expanded[0]!.spans[0]!.text, '  ⎿ ', 'branch glyph opens the child');
  assert.equal(expanded[1]!.spans[0]!.text, '    ', 'subsequent lines align under the branch');
  assert.ok(expandedText.some((r) => r.includes('line 15')), 'expanded shows every line');
  assert.ok(!expandedText.some((r) => r.includes('· ^O')), 'no fold hint when fully expanded');
});

test('tool output child: short body (≤3 lines) stays inline even when collapsed=true', () => {
  const lines = [
    { text: 'a', color: T.dim },
    { text: 'b', color: T.dim },
    { text: 'c', color: T.dim },
  ];
  const item = { id: 8, kind: 'tool' as const, text: '', meta: 'output', lines };
  const rows = flattenItem(item, 80, true, T);
  assert.equal(rows.length, 3, '≤3 lines never fold');
  assert.equal(rows[0]!.spans[0]!.text, '  ⎿ ');
  assert.ok(!rows.some((r) => r.spans.map((s) => s.text).join('').includes('⌄')));
});

test('tool header + nested body: one ⏺ row + fold child when collapsed', () => {
  const item = {
    id: 9,
    kind: 'tool' as const,
    text: '',
    meta: 'output',
    tool: { name: 'run_shell', arg: '$ npm test', ok: true, durationMs: 1200, summary: 'exit 0' },
    lines: Array.from({ length: 12 }, (_, i) => ({ text: `out ${i + 1}`, color: T.dim })),
  };
  const collapsed = flattenItem(item, 80, true, T);
  assert.equal(collapsed.length, 2, 'header + one fold row');
  const h = collapsed[0]!.spans.map((s) => s.text).join('');
  assert.ok(h.includes('run_shell'), 'header carries tool name');
  assert.match(collapsed[1]!.spans.map((s) => s.text).join(''), /⌄ output 12 lines · \^O/);
});

test('tool body expanded hard-caps at TOOL_BODY_EXPAND_CAP, keeping the TAIL (the signal end)', () => {
  const n = TOOL_BODY_EXPAND_CAP + 25;
  const lines = Array.from({ length: n }, (_, i) => ({ text: `L${i + 1}`, color: T.dim }));
  const item = { id: 10, kind: 'tool' as const, text: '', meta: 'output', lines };
  const rows = flattenItem(item, 80, false, T);
  // 1 elision note + TOOL_BODY_EXPAND_CAP content rows
  assert.equal(rows.length, TOOL_BODY_EXPAND_CAP + 1);
  const first = rows[0]!.spans.map((s) => s.text).join('');
  assert.match(first, /\+25 earlier lines elided/, 'elision note leads');
  const last = rows[rows.length - 1]!.spans.map((s) => s.text).join('');
  assert.ok(last.includes(`L${n}`), 'the LAST line of the output is visible — tail is kept');
  const texts = rows.map((r) => r.spans.map((s) => s.text).join('').trim());
  assert.ok(!texts.includes('L25'), 'the elided head (L1–L25) is gone');
  assert.ok(texts.includes('L26'), 'the first kept line is L26');
});

test('itemIsCollapsible: threshold 3, header-only tools never fold', () => {
  assert.equal(itemIsCollapsible({ kind: 'reasoning', text: 'x' }), true);
  assert.equal(itemIsCollapsible({ kind: 'tool', tool: {}, lines: [{}, {}, {}] }), false, '3 lines stay inline');
  assert.equal(itemIsCollapsible({ kind: 'tool', tool: {}, lines: [{}, {}, {}, {}] }), true, '4+ folds');
  assert.equal(itemIsCollapsible({ kind: 'tool', tool: {}, text: 'ok' }), false, 'header-only (no lines) not collapsible');
});

test('tool rows flatten to EXACTLY one row, even with a huge URL', () => {
  const rows = flattenItem(
    {
      id: 1, kind: 'tool', text: '',
      tool: { name: 'web_fetch', arg: 'https://www.sciencedaily.com/releases/2026/05/260526022012.htm', ok: true, durationMs: 100, summary: 'Fetched https://www.sciencedaily.com/releases/2026/05/260526022012.htm (HTTP 200, text/html, 8035 chars).' },
    },
    80, false, T,
  );
  assert.equal(rows.length, 1, 'one row, no wrapping');
  assert.ok(rows[0]!.spans.map((s) => s.text).join('').length <= 80);
});

test('renderToolResult: protocol stripped, long args middle-truncated, URL not repeated in summary', () => {
  const spans = renderToolResult(
    { name: 'web_fetch', arg: 'https://www.sciencedaily.com/releases/2026/05/260526022012.htm', ok: true, durationMs: 150, summary: 'Fetched https://www.sciencedaily.com/releases/2026/05/260526022012.htm (HTTP 200, text/html, 8035 chars).' },
    T,
  );
  const s = spans.map((x) => x.text).join('');
  assert.ok(!s.includes('https://'), 'protocol stripped from the display arg');
  assert.equal(s.match(/sciencedaily/g)!.length, 1, 'URL appears exactly ONCE (was printed twice)');
  assert.ok(s.includes('(HTTP 200, text/html, 8035 chars)'), 'the useful part of the summary survives');
});

test('renderToolResult: de-noising the arg from the summary is TOKEN-anchored, not substring (audit #4)', () => {
  // arg "err" must not be scrubbed out of "terror" / "errors" in the summary — the old split().join()
  // stripped every substring occurrence and mangled real words.
  const spans = renderToolResult(
    { name: 'grep', arg: 'err', ok: true, durationMs: 120, summary: 'err — matched terror and errors in 3 files' },
    T,
  );
  const s = spans.map((x) => x.text).join('');
  assert.ok(s.includes('terror') && s.includes('errors'), 'words containing the arg substring are intact');
  assert.ok(s.includes('3 files'), 'the informative tail survives');
});

// ── v2.6 formatting fix pack ──────────────────────────────────────────────────

test('wrapSpansWord: leading indentation at a logical-line start is PRESERVED (nested bullets)', () => {
  const rows = text(wrapSpansWord([{ text: '    indented start of a line' }], 40));
  assert.equal(rows[0], '    indented start of a line', 'the 4-space indent survives');
  // …but the space at a WRAP point is still dropped (flush-left continuations).
  const wrapped = text(wrapSpansWord([{ text: 'aaaa bbbb cccc' }], 4));
  assert.deepEqual(wrapped, ['aaaa', 'bbbb', 'cccc'], 'wrap-point spaces still dropped');
});

test('wrapSpansWord: indent + over-wide token keeps the indent and splits after it', () => {
  const rows = text(wrapSpansWord([{ text: '  ' }, { text: 'x'.repeat(30) }], 10));
  assert.equal(rows[0], '  ' + 'x'.repeat(8), 'first row: indent kept, token split after it');
  assert.ok(rows.join('').includes('x'.repeat(30).slice(0, 8)), 'nothing lost');
  for (const r of rows) assert.ok(r.length <= 10);
});

test('nested list items keep their depth indent AND wrap with a hanging indent under the text', () => {
  const md = ['- top level item that is long enough to wrap onto a second row for sure', '  - nested item'].join('\n');
  const rows = flattenItem({ id: 1, kind: 'assistant', text: md }, 40, false, T);
  const lines = rows.map((r) => r.spans.map((s) => s.text).join('')).filter((l) => l.trim() !== '');
  // Body indent is 2 (the ⏺ gutter). Top-level marker at col 2; its wrapped row aligns under the TEXT.
  const top = lines.find((l) => l.includes('top level'))!;
  const topCont = lines[lines.indexOf(top) + 1]!;
  assert.match(top, /^(⏺|●) • top level/, 'marker on the first row');
  assert.match(topCont, /^ {4}\S/, 'continuation aligns under the text (hanging indent), not the margin');
  const nested = lines.find((l) => l.includes('nested item'))!;
  assert.match(nested, /^ {2} {2}◦ nested item/, 'nested bullet keeps its 2-space depth indent + ◦ glyph');
});

test('blockquote: the │ bar repeats on EVERY wrapped row', () => {
  const md = '> a quoted sentence that is definitely long enough to wrap onto a second row here';
  const rows = flattenItem({ id: 1, kind: 'assistant', text: md }, 40, false, T);
  const quoteRows = rows.filter((r) => r.spans.some((s) => s.text.includes('│')));
  assert.ok(quoteRows.length >= 2, `quote wrapped to ${quoteRows.length} rows, bar on each`);
  for (const r of quoteRows) {
    const bar = r.spans.find((s) => s.text.includes('│'))!;
    assert.equal(bar.color, T.yellow, 'bar keeps the accent color on every row');
  }
});

test('table: the HEADER TEXT row is bold, the top border is not (was bolding line 0 = ┌─┐)', () => {
  const md = ['| Name | State |', '| --- | --- |', '| alpha | ok |'].join('\n');
  const rows = flattenItem({ id: 1, kind: 'assistant', text: md }, 60, false, T);
  const tbl = rows.map((r) => ({ text: r.spans.map((s) => s.text).join(''), bold: r.spans.some((s) => s.bold) }));
  const border = tbl.find((r) => r.text.includes('┌'))!;
  const header = tbl.find((r) => r.text.includes('Name'))!;
  assert.equal(border.bold, false, 'top border NOT bold');
  assert.equal(header.bold, true, 'header text row IS bold');
});

test('link label renders in the cyan link accent; the (url) tail stays dim', () => {
  const rows = flattenItem({ id: 1, kind: 'assistant', text: 'see [the docs](https://example.com) now' }, 60, false, T);
  const spans = rows.flatMap((r) => r.spans);
  const label = spans.find((s) => s.text.includes('docs'))!;
  const url = spans.find((s) => s.text.includes('example.com'))!;
  assert.equal(label.color, T.cyan, 'label = link accent');
  assert.equal(url.color, T.dim, 'url tail = dim');
});
