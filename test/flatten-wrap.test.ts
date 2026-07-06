import { test } from 'node:test';
import assert from 'node:assert/strict';
import { wrapSpansWord, truncateSpans, flattenItem } from '../src/tui/flatten.js';
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
