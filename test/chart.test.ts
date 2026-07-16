/**
 * Terminal chart renderer — parse + geometry goldens.
 *
 * The contract: a ```chart fence renders as a real unicode chart ONLY when the
 * spec parses; anything ambiguous falls back to a code block (never crash, never
 * guess). Geometry is width-aware: bars scale with eighth-block precision, dense
 * series resample, every emitted row fits the measure.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseChartSpec, renderChart, fmtAxis, CHART_LANGS } from '../src/util/chart.js';
import { flattenItem } from '../src/tui/flatten.js';

const T = {
  fg: '#e5e7eb',
  dim: '#6b7280',
  green: '#22c55e',
  cyan: '#38bdf8',
  yellow: '#eab308',
  red: '#ef4444',
  purple: '#a78bfa',
  bright: '#ffffff',
};

const text = (rows: { text: string }[][]) => rows.map((r) => r.map((s) => s.text).join(''));

test('parseChartSpec: directives, label:value rows, display strings preserved', () => {
  const spec = parseChartSpec('type: bar\ntitle: Spend\ncompute: $12,400\nstorage: 45%\n# comment\n');
  assert.ok(spec);
  assert.equal(spec!.type, 'bar');
  assert.equal(spec!.title, 'Spend');
  assert.equal(spec!.points.length, 2);
  assert.equal(spec!.points[0]!.value, 12400, 'commas and currency stripped for geometry');
  assert.equal(spec!.points[0]!.display, '$12,400', 'original string kept for display');
  assert.equal(spec!.points[1]!.value, 45);
});

test('parseChartSpec: bare number lists; untyped defaults (labels→bar, bare→line)', () => {
  const line = parseChartSpec('3 8 4 12 9');
  assert.ok(line);
  assert.equal(line!.type, 'line', 'unlabeled numbers read as a line chart');
  assert.equal(line!.points.length, 5);
  const bar = parseChartSpec('ok: 620\nflaky: 14');
  assert.equal(bar!.type, 'bar', 'labeled data reads as a bar chart');
});

test('parseChartSpec: prose is NOT a chart (falls back to code)', () => {
  assert.equal(parseChartSpec('this is just prose\nno data'), null);
  assert.equal(parseChartSpec('status: everything is fine'), null, 'label with non-numeric value');
  assert.equal(parseChartSpec(''), null, 'empty block');
  assert.equal(parseChartSpec('type: line\n42'), null, 'a line chart needs ≥ 2 points');
});

test('bar geometry: max value fills the bar column, non-zero values never render empty', () => {
  const spec = parseChartSpec('big: 1000\ntiny: 1\nzero: 0')!;
  const rows = renderChart(spec, 60);
  const lines = text(rows);
  const big = lines.find((l) => l.includes('big'))!;
  const tiny = lines.find((l) => l.includes('tiny'))!;
  const zero = lines.find((l) => l.includes('zero'))!;
  assert.ok((big.match(/█/g) ?? []).length >= 40, 'max value fills the available bar width');
  assert.match(tiny, /[▏▎▍▌▋▊▉█]/, 'a 0.1% value still shows a sliver — nothing lies as zero');
  assert.ok(!/[▏▎▍▌▋▊▉█]/.test(zero), 'a true zero draws no bar');
  for (const l of lines) assert.ok(l.length <= 60, `row fits the measure: ${l.length}`);
  // Values RIGHT-align on a shared edge (ledger style): the last digit of every value
  // lands in the same column, regardless of bar length.
  assert.equal(big.indexOf('1000') + 4, tiny.lastIndexOf('1') + 1, 'value right edges align');
});

test('bar roles: labels/values wear text tokens, only the bar wears the series hue', () => {
  const spec = parseChartSpec('title: T\na: 5\nbb: 3')!;
  const rows = renderChart(spec, 40);
  assert.equal(rows[0]![0]!.role, 'title');
  for (const row of rows.slice(1)) {
    const roles = row.map((s) => s.role);
    assert.deepEqual(roles, ['label', 'bar', 'value'], 'each bar row is label|bar|value');
  }
});

test('spark: one glyph row, resamples when wider than the measure', () => {
  const many = Array.from({ length: 200 }, (_, i) => String(i % 17)).join(' ');
  const spec = parseChartSpec(`type: spark\n${many}`)!;
  const rows = renderChart(spec, 40);
  const glyphRow = text(rows)[rows.length - 1]!;
  assert.ok(glyphRow.length <= 40, 'resampled to the measure');
  assert.match(glyphRow, /[▁▂▃▄▅▆▇█]{4,}/, 'sparkline glyphs');
  assert.match(glyphRow, /0…16$/, 'min…max summary tail');
});

test('line: 6 braille rows, max label on the top row, min on the bottom, width respected', () => {
  const spec = parseChartSpec('type: line\ntitle: L\n120 140 180 900 640 380 200')!;
  const rows = renderChart(spec, 50);
  const lines = text(rows);
  assert.equal(lines.length, 7, 'title + 6 canvas rows');
  assert.match(lines[1]!, /^900 /, 'y-max label on the first canvas row');
  assert.match(lines[6]!, /^120 /, 'y-min label on the last canvas row');
  assert.ok(lines.slice(1).some((l) => /[⠀-⣿]/.test(l)), 'braille strokes painted');
  for (const l of lines) assert.ok(l.length <= 50, `row fits: ${l.length}`);
});

test('line: a flat series draws a mid line instead of dividing by zero', () => {
  const spec = parseChartSpec('type: line\n5 5 5 5')!;
  const lines = text(renderChart(spec, 40));
  assert.ok(lines.some((l) => /[⠀-⣿]/.test(l)), 'flat line still paints');
});

test('fmtAxis: compact k/M/B, decimals trimmed', () => {
  assert.equal(fmtAxis(900), '900');
  assert.equal(fmtAxis(1240), '1.2k');
  assert.equal(fmtAxis(2_500_000), '2.5M');
  assert.equal(fmtAxis(3_000_000_000), '3B');
  assert.equal(fmtAxis(-1500), '-1.5k');
  assert.equal(fmtAxis(0.5), '0.5');
});

test('flatten: a closed ```chart block renders bars (cyan series, no code frame)', () => {
  const md = 'Here:\n\n```chart\ntitle: Hits\na: 10\nb: 5\n```';
  const rows = flattenItem({ id: 1, kind: 'assistant', text: md }, 60, false, T);
  const joined = rows.map((r) => r.spans.map((s) => s.text).join('')).join('\n');
  assert.match(joined, /█/, 'bars painted');
  assert.ok(!joined.includes('╭─ chart'), 'no code-block frame around a rendered chart');
  const barSpan = rows.flatMap((r) => r.spans).find((s) => s.text.includes('█'))!;
  assert.equal(barSpan.color, T.cyan, 'series hue on the bar only');
  const title = rows.flatMap((r) => r.spans).find((s) => s.text === 'Hits')!;
  assert.equal(title.bold, true, 'chart title is bold');
});

test('flatten: an OPEN (streaming) chart fence stays a code block; so does a non-parsing spec', () => {
  const streaming = flattenItem({ id: 2, kind: 'assistant', text: '```chart\na: 10\nb: 5' }, 60, false, T);
  const s = streaming.map((r) => r.spans.map((x) => x.text).join('')).join('\n');
  assert.match(s, /╭─ chart/, 'open fence renders as code until it closes');
  assert.ok(!s.includes('█'), 'no half-painted chart mid-stream');
  const prose = flattenItem({ id: 3, kind: 'assistant', text: '```chart\njust some notes\n```' }, 60, false, T);
  const p = prose.map((r) => r.spans.map((x) => x.text).join('')).join('\n');
  assert.match(p, /just some notes/, 'unparseable spec falls back to visible code');
});

test('CHART_LANGS: chart/graph/spark aliases route; nothing else does', () => {
  for (const l of ['chart', 'graph', 'spark', 'sparkline']) assert.ok(CHART_LANGS.has(l));
  assert.ok(!CHART_LANGS.has('python'));
});
