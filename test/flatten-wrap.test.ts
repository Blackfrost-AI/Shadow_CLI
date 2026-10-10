import { GLYPHS } from '../src/tui/glyphs.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { wrapSpansWord, truncateSpans, flattenItem, TOOL_BODY_EXPAND_CAP, itemIsCollapsible, computeToolRuns } from '../src/tui/flatten.js';
import { renderToolResult } from '../src/tui/rows.js';
import type { FlattenItem, ViewportTheme } from '../src/tui/flatten.js';

const T: ViewportTheme = {
  fg: '#ffffff', dim: '#b6bcc3', green: '#22c55e', cyan: '#38bdf8',
  yellow: '#eab308', red: '#ef4444', purple: '#a78bfa',
  userBg: '#1e3a4d',
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

test('assistant Markdown has no per-block speaker header and continuations align', () => {
  const nonBlank = (rows: { spans: { text: string }[] }[]) => rows.filter((r) => r.spans.some((s) => s.text.trim() !== ''));
  const first = nonBlank(flattenItem({ id: 1, kind: 'assistant', text: 'first line second line', speaker: { handle: 'SHADOW', model: 'fixture', color: T.cyan } }, 20, false, T));
  assert.deepEqual(first.map(r => r.spans.map(s => s.text).join('')), [`${GLYPHS.assistant} first line second`, '  line']);
  const cont = nonBlank(flattenItem({ id: 2, kind: 'assistant', text: 'continued paragraph' }, 60, false, T, true));
  assert.deepEqual(cont.map(r => r.spans.map(s => s.text).join('')), ['  continued paragraph']);
});

test('user prompt: background band on EVERY line, bright body (fg), leading blank', () => {
  // The user turn is the only FILLED row in the transcript (v9): it replaced a per-line ▌ gutter,
  // which repeated a glyph down every wrapped row in the same column as answer text. Body is
  // theme.fg — the same readable tier as answer prose. A leading blank always opens the turn.
  const md = 'a prompt long enough to wrap at this narrow measure\n1. a typed list line';
  const rows = flattenItem({ id: 3, kind: 'user', text: `${GLYPHS.promptPrefix}${md}`, color: T.green, bold: true, tight: true }, 30, false, T);
  assert.equal(rows[0]!.spans.every((s) => s.text === ''), true, 'user turns always lead with a blank (tight ignored)');
  const nonBlank = rows.filter((r) => r.spans.some((s) => s.text.trim() !== ''));
  assert.ok(
    nonBlank.every((r) => r.spans.some((s) => s.bg === T.userBg)),
    'every content row carries the band — wraps and typed lines alike',
  );
  assert.ok(
    !nonBlank.some((r) => r.spans.some((s) => s.text.includes(`${GLYPHS.halfBlock}`))),
    'the per-line gutter is gone',
  );
  const body = nonBlank.flatMap((r) => r.spans).filter((s) => s.text.trim() !== '');
  assert.ok(body.every((s) => !s.bold), 'no bold body — the band is the marker');
  const joined = nonBlank.map((r) => r.spans.map((s) => s.text).join('')).join('\n');
  assert.match(joined, /1\. a typed list line/, 'typed text is verbatim — no markdown rewrite');
  assert.ok(!joined.includes(`${GLYPHS.prompt}`), `the baked-in ${GLYPHS.promptPrefix}fallback marker is stripped from styled output`);
  for (const r of rows) assert.ok(r.spans.map((s) => s.text).join('').length <= 30, 'fits the measure');
});

test(`tool output child: collapsed = one-row ⌄ fold; expanded = ${GLYPHS.result} body (no 10-line preview)`, () => {
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
  assert.equal(expanded[0]!.spans[0]!.text, `${GLYPHS.resultPrefix}`, 'branch glyph opens the child');
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
  assert.equal(rows[0]!.spans[0]!.text, `${GLYPHS.resultPrefix}`);
  assert.ok(!rows.some((r) => r.spans.map((s) => s.text).join('').includes('⌄')));
});

test('collapsed long DIFF shows a 2-line teaser then fold for the rest', () => {
  // Edits must stay scannable: first two hunk lines peek, remaining fold under ⌄.
  const lines = Array.from({ length: 10 }, (_, i) => ({
    text: i % 2 === 0 ? `+ added ${i}` : `- removed ${i}`,
    color: i % 2 === 0 ? T.green : T.red,
  }));
  const item = {
    id: 88,
    kind: 'tool' as const,
    text: '',
    meta: 'diff',
    tool: { name: 'edit_file', arg: 'src/x.ts', ok: true, durationMs: 40, summary: '+5 −5' },
    lines,
  };
  const rows = flattenItem(item, 80, true, T);
  // gap (signal tool) + header + 2 teaser + fold
  const text = rows.map((r) => r.spans.map((s) => s.text).join('')).join('\n');
  assert.ok(text.includes('Update'), 'edit display name');
  assert.ok(text.includes('+ added 0'), 'first teaser line visible');
  assert.ok(text.includes('- removed 1'), 'second teaser line visible');
  assert.ok(text.includes('⌄ diff 8 lines'), 'remaining 8 lines folded');
  assert.ok(!text.includes('+ added 2'), 'third line stays under the fold');
});

test(`tool header + nested body: one ${GLYPHS.tool} row + fold child when collapsed`, () => {
  const item = {
    id: 9,
    kind: 'tool' as const,
    text: '',
    meta: 'output',
    tool: { name: 'run_shell', arg: '$ npm test', ok: true, durationMs: 1200, summary: 'exit 0' },
    lines: Array.from({ length: 12 }, (_, i) => ({ text: `out ${i + 1}`, color: T.dim })),
  };
  const collapsed = flattenItem(item, 80, true, T);
  // Signal tools (Bash/Update/…) open with a blank block-boundary so they never blend into recon.
  assert.equal(collapsed.length, 3, 'gap + header + one fold row');
  assert.ok(collapsed[0]!.spans.every((s) => s.text === ''), 'leading blank before signal tool');
  const h = collapsed[1]!.spans.map((s) => s.text).join('');
  assert.ok(h.includes('Bash'), 'header carries display name (run_shell → Bash)');
  assert.ok(h.includes('(npm test)'), 'shell $ prefix stripped from arg');
  assert.match(collapsed[2]!.spans.map((s) => s.text).join(''), /⌄ output 12 lines · \^O/);
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

test('finished reasoning collapses to one summary row while keeping its body available to expand', () => {
  const body = Array.from({ length: 7 }, (_, i) => `Trace step ${i + 1}: inspect the result.`).join('\n');
  for (const reasoningState of ['complete', 'interrupted', 'stopped'] as const) {
    const item: FlattenItem = { id: reasoningState, kind: 'reasoning', text: body, reasoningState, durationMs: 65000 };
    const compact = flattenItem(item, 80, true, T);
    const visible = compact.map((row) => row.spans.map((span) => span.text).join('')).filter((line) => line.trim());
    assert.equal(visible.length, 1, `${reasoningState}: one summary row`);
    assert.match(visible[0]!, /1m/);
    assert.match(visible[0]!, /Ctrl\+O expand/);
    assert.doesNotMatch(visible[0]!, /Trace step|[╭╮╰╯│]/, `${reasoningState}: no preview or empty panel border`);
    if (reasoningState !== 'complete') assert.ok(visible[0]!.includes(reasoningState));
    const expanded = flattenItem(item, 80, false, T).map((row) => row.spans.map((span) => span.text).join('')).join('\n');
    for (let i = 1; i <= 7; i++) assert.ok(expanded.includes(`Trace step ${i}:`), `${reasoningState}: expanded body keeps step ${i}`);
    assert.match(expanded, /Ctrl\+O compact/);
    assert.equal(item.text, body, 'collapsing does not discard the original reasoning');
  }
});

test('streaming reasoning keeps a bounded four-row tail and expands to the full trace', () => {
  const item: FlattenItem = {
    id: 'live-trace', kind: 'reasoning', reasoningState: 'streaming', durationMs: 65000,
    text: Array.from({ length: 7 }, (_, i) => `Live trace ${i + 1}: checking.`).join('\n'),
  };
  const compact = flattenItem(item, 80, true, T).map((row) => row.spans.map((span) => span.text).join(''));
  const preview = compact.filter((line) => line.includes('Live trace'));
  assert.equal(preview.length, 4);
  for (let i = 4; i <= 7; i++) assert.ok(preview.some((line) => line.includes(`Live trace ${i}:`)));
  assert.ok(!compact.some((line) => line.includes('Live trace 1:')));
  assert.match(compact.join('\n'), /Thinking · 1m/);
  assert.match(compact.join('\n'), /Ctrl\+O expand/);
  const expanded = flattenItem(item, 80, false, T).map((row) => row.spans.map((span) => span.text).join('')).join('\n');
  for (let i = 1; i <= 7; i++) assert.ok(expanded.includes(`Live trace ${i}:`));
});

test('empty or whitespace-only reasoning never emits a panel or even a gap row', () => {
  for (const reasoningState of [undefined, 'streaming', 'complete', 'interrupted', 'stopped'] as const) {
    for (const body of ['', ' \n\t\n\u2003 ']) {
      for (const collapsed of [false, true]) {
        assert.deepEqual(
          flattenItem({ id: 'empty', kind: 'reasoning', text: body, reasoningState }, 80, collapsed, T),
          [], `${reasoningState ?? 'legacy'} reasoning, collapsed=${collapsed}`,
        );
      }
    }
  }
});

test('ordinary findings retain every body line at info, warning and error severities', () => {
  for (const severity of ['info', 'warn', 'error']) {
    const rows = flattenItem({
      id: severity, kind: 'finding', title: 'Review note', severity,
      text: 'A useful first finding line.\nThe second line explains the result.',
    }, 80, true, T);
    const rendered = rows.map((row) => row.spans.map((span) => span.text).join('')).join('\n');
    assert.match(rendered, /A useful first finding line\./);
    assert.match(rendered, /The second line explains the result\./);
  }
});

test('tool rows flatten to EXACTLY one content row, even with a huge URL', () => {
  const rows = flattenItem(
    {
      id: 1, kind: 'tool', text: '',
      tool: { name: 'web_fetch', arg: 'https://www.sciencedaily.com/releases/2026/05/260526022012.htm', ok: true, durationMs: 100, summary: 'Fetched https://www.sciencedaily.com/releases/2026/05/260526022012.htm (HTTP 200, text/html, 8035 chars).' },
    },
    80, false, T,
  );
  // Fetch is a signal tool → leading blank + one truncated content row (never wraps).
  assert.equal(rows.length, 2, 'gap + one content row');
  assert.ok(rows[0]!.spans.every((s) => s.text === ''), 'leading blank');
  assert.ok(rows[1]!.spans.map((s) => s.text).join('').length <= 80, 'content truncated to measure');
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
  assert.match(top, new RegExp(`^${GLYPHS.assistant} • top level`), 'marker on the first row');
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

test('table: the HEADER TEXT row is bold, the top border is not (was bolding line 0 = ╭─╮)', () => {
  const md = ['| Name | State |', '| --- | --- |', '| alpha | ok |'].join('\n');
  const rows = flattenItem({ id: 1, kind: 'assistant', text: md }, 60, false, T);
  const tbl = rows.map((r) => ({ text: r.spans.map((s) => s.text).join(''), bold: r.spans.some((s) => s.bold) }));
  const border = tbl.find((r) => r.text.includes('╭'))!;
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

test('collaboration speaker: colored ◆ handle header once per turn, body indents (no orange dot)', () => {
  const spk = { handle: 'grok', color: '#38dbf5', model: 'openai/grok-4' };
  // First block of the seat's turn (continuation=false) → header row + indented body.
  // (Assistant items open with a leading gap blank line, so the header is the first NON-empty row.)
  const first = flattenItem({ id: 1, kind: 'assistant', text: 'the KV cache is the OOM', speaker: spk } as never, 60, false, T, false);
  const headRow = first.find((r) => r.spans.map((s) => s.text).join('').includes('◆'))!;
  const head = headRow.spans.map((s) => s.text).join('');
  assert.match(head, /◆ grok/, `header shows the ${GLYPHS.tool} + handle`);
  assert.match(head, /openai\/grok-4/, 'header shows the model');
  assert.equal(headRow.spans[0]!.color, '#38dbf5', 'header is painted the seat color, not orange');
  // No orange assistant bullet anywhere in a speaker turn (the header is the only bullet).
  assert.ok(!first.slice(1).some((r) => (r.spans[0]?.color) === '#d97757'), `body has no orange ${GLYPHS.tool}`);
  // A continuation block (same turn) draws neither a second header nor a bullet — just indent.
  const cont = flattenItem({ id: 2, kind: 'assistant', text: 'add -ctk q8_0', speaker: spk } as never, 60, false, T, true);
  assert.ok(!cont.some((r) => r.spans.map((s) => s.text).join('').includes('◆')), `continuation has no ${GLYPHS.tool} header`);
});

test('computeToolRuns: only collapsible tools stack; edits/shell break the group', () => {
  const tool = (id: number, name: string, ok: boolean, ms: number, arg?: string) => ({
    id, kind: 'tool', text: '', tool: { name, ok, durationMs: ms, summary: '', arg },
  });
  const items: object[] = [
    { id: 1, kind: 'user', text: 'q' },
    tool(2, 'read_file', true, 100, 'a.ts'),
    tool(3, 'read_file', true, 100, 'b.ts'),
    tool(4, 'grep', true, 200, 'TODO'),
    tool(5, 'edit_file', true, 50, 'a.ts'), // write — NEVER folds; breaks the run
    tool(6, 'read_file', true, 80, 'c.ts'),
    tool(7, 'glob', true, 90, '**/*.ts'),
    tool(8, 'run_shell', true, 300, 'npm test'), // shell — NEVER folds
    { id: 9, kind: 'assistant', text: 'ans' },
    tool(10, 'read_file', true, 40, 'lonely.ts'), // lone read — not grouped
  ];
  const runs = computeToolRuns(items as never, false);
  // Run A: indices 1,2,3 (3 reads/greps before the edit)
  assert.equal(runs.get(1)!.len, 3);
  assert.equal(runs.get(1)!.pos, 0);
  assert.equal(runs.get(2)!.pos, 1);
  assert.equal(runs.get(3)!.pos, 2);
  assert.equal(runs.get(1)!.kinds.read, 2);
  assert.equal(runs.get(1)!.kinds.search, 1);
  assert.equal(runs.get(1)!.hint, 'TODO');
  assert.equal(runs.get(1)!.collapsed, true);
  // Edit and shell are never in a run
  assert.ok(!runs.has(4), 'edit_file is never stacked');
  assert.ok(!runs.has(7), 'run_shell is never stacked');
  // Run B: indices 5,6 (read + glob after the edit)
  assert.equal(runs.get(5)!.len, 2);
  assert.equal(runs.get(5)!.kinds.read, 1);
  assert.equal(runs.get(5)!.kinds.list, 1);
  // Lone read at end is not grouped
  assert.ok(!runs.has(9), 'lone collapsible tool is not in any run');
  assert.equal(computeToolRuns(items as never, true).get(1)!.collapsed, false, 'Ctrl-O flips collapsed off');
});

test('F4: a finding card emits one unique React key per row', () => {
  // The body loop reused `${kp}fb` for every SOURCE line while wrapLine restarts its own counter
  // per call, so a wrapped multi-line finding produced more rows than distinct keys. React then
  // reconciles two different rows onto one key and silently drops or mis-orders body lines.
  // Reachable on any grep with matches.
  const theme = {
    fg: '#fff', dim: '#999', green: '#0f0', red: '#f00', yellow: '#ff0', cyan: '#0ff', purple: '#f0f',
  } as never;
  const item = {
    id: 7,
    kind: 'finding',
    title: 'grep hits',
    severity: 'info',
    text: ['a line long enough that it definitely wraps at this narrow width for sure', 'second', 'third'].join('\n'),
  } as never;
  const lines = flattenItem(item, 40, false, theme, false, false);
  const keys = lines.map((l) => l.key);
  assert.ok(keys.length > 4, 'the fixture must actually wrap, or the test proves nothing');
  assert.equal(new Set(keys).size, keys.length, `duplicate keys: ${keys.filter((k, i) => keys.indexOf(k) !== i).join(', ')}`);
});
