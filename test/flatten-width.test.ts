// Regression net for B1 (the 4.0 review): the transcript flattener wrapped by UTF-16 code unit
// while every row renders inside `<Text wrap="truncate">`, so CJK/emoji overflow was DELETED, not
// wrapped — 17 of 40 segments of a long Chinese answer never reached any frame.
//
// These are property tests on purpose: the failure mode is "some row, somewhere, is too wide", and
// a fixed set of examples is exactly what let it survive three releases.
import test from 'node:test';
import assert from 'node:assert/strict';
import { wrapSpans, wrapSpansWord, truncateSpans, type StyledSpan } from '../src/tui/flatten.js';
import { displayWidth } from '../src/util/width.js';

const rowWidth = (row: StyledSpan[]): number => displayWidth(row.map((s) => s.text).join(''));
const textOf = (rows: StyledSpan[][]): string => rows.map((r) => r.map((s) => s.text).join('')).join('');

/**
 * The honest invariant. A row must fit the budget, with exactly one unsatisfiable exception: a
 * SINGLE grapheme cluster wider than the budget itself (a 2-column 中 with cols=1). Nothing can
 * render that within budget, and the alternatives — dropping it, or looping forever trying to place
 * it — are both worse than emitting one over-wide row. Asserting "fits, OR is one indivisible
 * cluster" keeps the test strict everywhere it can be.
 */
function assertRowFits(row: StyledSpan[], cols: number, ctx: string): void {
  const got = rowWidth(row);
  if (got <= cols) return;
  const text = row.map((s) => s.text).join('');
  const clusters = Array.from(
    new Intl.Segmenter(undefined, { granularity: 'grapheme' }).segment(text),
    (g) => g.segment,
  );
  assert.ok(
    clusters.length === 1 && displayWidth(clusters[0]!) > cols,
    `${ctx}: row is ${got} columns (budget ${cols}) — Ink would truncate ${got - cols} away. ` +
      `Row: ${JSON.stringify(text)}`,
  );
}

const CORPUS: ReadonlyArray<readonly [string, string]> = [
  ['ascii prose', 'the quick brown fox jumps over the lazy dog and keeps on running past the fence'],
  ['CJK prose', '这是一个很长的中文句子用来测试终端里的换行行为以及双宽字符的列宽计算是否正确无误'],
  ['japanese', 'これはターミナルの折り返し処理を検証するための日本語のテキストです。全角文字が正しく扱われるか。'],
  ['korean', '이것은 터미널에서 줄 바꿈 동작을 테스트하기 위한 한국어 문장입니다.'],
  ['emoji run', '🎉🎊✨🔥💯🚀🌟⭐️🎯🏆🥇🎨🖼️📊📈📉🗂️📁📂🗃️'],
  ['zwj families', '👨‍👩‍👧‍👦 and 👩‍💻 and 🧑‍🚀 shipping code together every single day of the week'],
  ['mixed', 'Deploy 部署 to 生产环境 now ✅ then verify 验证 the 结果 and report 报告 back 🎯 quickly'],
  ['bmp emoji', '✅ done ⚠ warning ❌ failed ⏩ skipped ⭐ starred ☑ checked ✔ ok'],
  ['fullwidth punct', '你好，世界！这是（全角）标点符号；测试：冒号、顿号。'],
  ['combining', 'égal à côté naïve résumé with combining marks everywhere here'],
  ['no spaces CJK', '中文没有空格所以整段都是一个超长的词元必须硬切分不能溢出边界'],
  ['long url', 'see https://example.com/a/very/long/path/that/never/breaks/anywhere/at/all?q=1&r=2 now'],
  ['indented', '    - nested bullet with 中文 mixed in and a tail long enough to force a wrap'],
  ['single wide', '中'],
  ['newlines', 'first 第一行\nsecond 第二行\nthird 第三行'],
];

const WIDTHS = [1, 2, 3, 5, 8, 13, 20, 40, 76, 120];

test('wrapSpans: no produced row ever exceeds the column budget', () => {
  for (const [name, text] of CORPUS) {
    for (const cols of WIDTHS) {
      for (const row of wrapSpans([{ text }], cols)) assertRowFits(row, cols, `${name} @ cols=${cols}`);
    }
  }
});

test('wrapSpansWord: no produced row ever exceeds the column budget', () => {
  for (const [name, text] of CORPUS) {
    for (const cols of WIDTHS) {
      for (const row of wrapSpansWord([{ text }], cols)) assertRowFits(row, cols, `${name} @ cols=${cols}`);
    }
  }
});

test('wrapSpans is lossless: every character survives somewhere (the 17-of-40 bug)', () => {
  for (const [name, text] of CORPUS) {
    for (const cols of WIDTHS) {
      // Newlines are consumed as row breaks by design; compare against the same removal.
      assert.equal(
        textOf(wrapSpans([{ text }], cols)),
        text.split('\n').join(''),
        `${name} @ cols=${cols}: characters were dropped or duplicated by the wrapper`,
      );
    }
  }
});

test('wrapSpans never splits a grapheme cluster (ZWJ families, flags, combining marks)', () => {
  const samples = ['👨‍👩‍👧‍👦', '🇯🇵', 'é'.normalize('NFD'), '🧑‍🚀'];
  for (const g of samples) {
    for (const cols of WIDTHS) {
      for (const row of wrapSpans([{ text: `${g}${g}${g}${g}` }], cols)) {
        const t = row.map((s) => s.text).join('');
        if (t === '') continue;
        assert.ok(
          t.length % g.length === 0,
          `cols=${cols}: a row (${JSON.stringify(t)}) landed mid-cluster of ${JSON.stringify(g)}`,
        );
      }
    }
  }
});

test('truncateSpans never returns a row wider than the budget', () => {
  for (const [name, text] of CORPUS) {
    for (const cols of WIDTHS) {
      const w = Math.max(4, cols);
      const got = displayWidth(truncateSpans([{ text }], cols).map((s) => s.text).join(''));
      assert.ok(got <= w, `${name} @ cols=${cols}: truncateSpans returned ${got} columns (budget ${w})`);
    }
  }
});

test('truncateSpans keeps multi-span rows within budget when the overflow lands mid-span', () => {
  // The trim-back path: earlier spans must be cut by COLUMNS so one CJK glyph frees two.
  const spans: StyledSpan[] = [
    { text: '中文标签中文标签', color: '#fff' },
    { text: ' — ', dim: true },
    { text: 'a tail that definitely does not fit anywhere near this budget', color: '#aaa' },
  ];
  for (const cols of [4, 6, 9, 12, 17, 25, 40]) {
    const got = displayWidth(truncateSpans(spans, cols).map((s) => s.text).join(''));
    assert.ok(got <= Math.max(4, cols), `cols=${cols}: ${got} columns`);
  }
});

test('the specific regression: 40 columns of CJK prose fits in 40 columns', () => {
  // Before the fix this produced rows of 78 columns — a 38-column overrun, silently truncated.
  const text = CORPUS.find(([n]) => n === 'CJK prose')![1];
  const rows = wrapSpansWord([{ text }], 40);
  const widest = Math.max(...rows.map(rowWidth));
  assert.ok(widest <= 40, `widest row was ${widest} columns`);
  assert.equal(rows.map((r) => r.map((s) => s.text).join('')).join(''), text);
});
