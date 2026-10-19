// Regression tests for the TUI markdown readability pass (2026-10-18).
// Each test pins a defect that a user actually sees. See research/tui-markdown-audit.md.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseMarkdown, renderTableLines, spanText } from '../src/util/markdown.js';
import { flattenItem, type ViewportTheme } from '../src/tui/flatten.js';
import { PIN_THEME } from '../src/app/ansi.js';
import { displayWidth } from '../src/util/width.js';

const theme = PIN_THEME as ViewportTheme;
const render = (md: string, cols = 96): ReturnType<typeof flattenItem> =>
  flattenItem({ id: 1, kind: 'assistant', text: md }, cols, false, theme);
/** Concatenated text of a row (the first span carries the `✻ ` / `  ` gutter prefix). */
const rowText = (spans: { text: string }[]): string => spans.map((s) => s.text).join('');
const plain = (md: string, cols = 96): string[] => render(md, cols).map((r) => rowText(r.spans));
/** The styled span containing `needle`, ignoring the gutter prefix spans. */
const spanWith = (md: string, needle: string) => {
  const rows = render(md);
  for (const r of rows) {
    // Wrap splits bold runs per WORD, so match on a single word, or on the row's joined text
    // when the caller passed a phrase.
    const hit = r.spans.find((s) => s.text.includes(needle));
    if (hit) return hit;
    if (rowText(r.spans).includes(needle)) {
      const styled = r.spans.find((s) => s.color && s.text.trim() !== '' && !s.text.startsWith('✻'));
      if (styled) return styled;
    }
  }
  throw new Error(`no span containing ${JSON.stringify(needle)} in:\n${rows.map((r) => rowText(r.spans)).join('\n')}`);
};
const styleKey = (s: { color?: string; bold?: boolean; italic?: boolean }): string =>
  `${s.color}|${s.bold ? 'b' : '-'}|${s.italic ? 'i' : '-'}`;

// ─── Tables ────────────────────────────────────────────────────────────────────

test('the grid/fallback decision is monotonic in terminal width', () => {
  // The original bug was NON-MONOTONIC: this table gridded at 78 and 88 cols but collapsed to the
  // `— row N —` fallback at 82 and 84, so widening the window could break the table. Whatever
  // width the grid starts at, it must start there ONCE and hold for every wider terminal.
  const md = [
    '| Component | Responsibility | Files | Risk |',
    '| --- | --- | --- | --- |',
    '| Provider adapter | Normalizes streaming deltas across Anthropic, OpenAI and local endpoints | src/provider/*.ts | high |',
    '| Safety classifier | Gates destructive shell commands before execution | src/safety/classifier.ts | medium |',
  ].join('\n');
  const t = parseMarkdown(md).find((b) => b.type === 'table');
  assert.ok(t && t.type === 'table');
  const isGrid = (w: number): boolean => (renderTableLines(t as never, w)[0] ?? '').startsWith('╭');
  let firstGrid = -1;
  for (let w = 20; w <= 140; w++) {
    if (isGrid(w)) {
      firstGrid = w;
      break;
    }
  }
  assert.ok(firstGrid > 0, 'the table never rendered as a grid at any width');
  for (let w = firstGrid; w <= 140; w++) {
    assert.ok(isGrid(w), `narrowing regression: grid at ${firstGrid} but fallback at ${w}`);
  }
  // And it must actually reach a grid by a realistic terminal width.
  assert.ok(firstGrid <= 80, `grid only appears at ${firstGrid} cols — too late to be useful`);
});

test('every rendered table line stays within maxWidth', () => {
  const md = [
    '| Component | Responsibility | Files | Risk |',
    '| --- | --- | --- | --- |',
    '| Provider adapter | Normalizes streaming deltas across Anthropic, OpenAI and local endpoints | src/provider/*.ts | high |',
    '| Safety classifier | Gates destructive shell commands before execution | src/safety/classifier.ts | medium |',
  ].join('\n');
  const t = parseMarkdown(md).find((b) => b.type === 'table');
  assert.ok(t && t.type === 'table');
  for (let w = 30; w <= 120; w++) {
    for (const line of renderTableLines(t as never, w)) {
      assert.ok(displayWidth(line) <= w, `width ${w}: line is ${displayWidth(line)} wide: ${JSON.stringify(line)}`);
    }
  }
});

test('column allocation keeps short words intact instead of starving a narrow column', () => {
  // Word-aware allocation must not squeeze `Risk` down to 3 cols (rendering `high` as `hig`/`h`
  // and `medium` as `med`/`ium`) while `Responsibility` holds 37 cols.
  const md = [
    '| Component | Responsibility | Files | Risk |',
    '| --- | --- | --- | --- |',
    '| Provider adapter | Normalizes streaming deltas across Anthropic, OpenAI and local endpoints | src/provider/*.ts | high |',
    '| Safety classifier | Gates destructive shell commands before execution | src/safety/classifier.ts | medium |',
  ].join('\n');
  const t = parseMarkdown(md).find((b) => b.type === 'table');
  assert.ok(t && t.type === 'table');
  // 76-104 spans both shapes. On the old code `medium` was dropped outright at 80+ (the column
  // was starved to `med`/`ium` and neither half matched) while 76 fell into the fallback, which
  // is why sweeping a single width missed it.
  for (const w of [76, 80, 88, 96, 104]) {
    const text = renderTableLines(t as never, w).join('\n');
    for (const word of ['component', 'responsibility', 'files', 'risk', 'high', 'medium']) {
      assert.ok(
        text.toLowerCase().includes(word),
        `word '${word}' was lost or split mid-token at width ${w}:\n${text}`,
      );
    }
  }
});

test('a pipe inside a code span does not split the cell', () => {
  // | `ls | wc -l` | used to become two cells, shifting every later column left.
  const md = ['| Command | Effect |', '| --- | --- |', '| `ls | wc -l` | counts lines |'].join('\n');
  const t = parseMarkdown(md).find((b) => b.type === 'table');
  assert.ok(t && t.type === 'table');
  assert.equal(t.header.length, 2);
  assert.equal(t.rows[0]!.length, 2);
  assert.equal(spanText(t.rows[0]![0]!), 'ls | wc -l');
  assert.equal(spanText(t.rows[0]![1]!), 'counts lines');
});

test('an escaped pipe still renders as a literal pipe', () => {
  const md = ['| Cmd | Note |', '| --- | --- |', '| `a \\| b` | literal pipe |'].join('\n');
  const t = parseMarkdown(md).find((b) => b.type === 'table');
  assert.ok(t && t.type === 'table');
  assert.equal(t.rows[0]!.length, 2);
  assert.ok(spanText(t.rows[0]![0]!).includes('|'));
});

test('a link in a cell renders its label, not the URL', () => {
  const md = [
    '| File | Note |',
    '| --- | --- |',
    '| [docs](https://example.com/a/very/long/path/index.html) | see the guide |',
  ].join('\n');
  const t = parseMarkdown(md).find((b) => b.type === 'table');
  assert.ok(t && t.type === 'table');
  const lines = renderTableLines(t as never, 60);
  const widest = Math.max(...lines.map((l) => displayWidth(l)));
  assert.ok(widest <= 60, `table overflowed despite the long link: ${widest} cols`);
  // The label survives; the raw URL does not eat the layout. On the old code the rendered cell
  // was `docs (https://example.com/a/very/long/path/index.html)` — a 52-col cell for a 4-letter
  // label, which then had to be hard-split across three lines to fit.
  assert.ok(lines.some((l) => l.includes('docs')), 'link label was dropped');
  assert.ok(!lines.some((l) => l.includes('https://')), 'the raw URL leaked into the cell');
});

test('a wrapped table does not put a rule between two single-line rows', () => {
  // A rule after EVERY row spent up to 40% of the vertical space on chrome and made the table
  // read as stacked boxes rather than one table.
  const md = [
    '| Component | Responsibility | Files | Risk |',
    '| --- | --- | --- | --- |',
    '| Provider adapter | Normalizes streaming deltas across Anthropic, OpenAI and local endpoints | src/provider/*.ts | high |',
    '| Safety classifier | Gates destructive shell commands before execution | src/safety/classifier.ts | medium |',
  ].join('\n');
  const t = parseMarkdown(md).find((b) => b.type === 'table');
  assert.ok(t && t.type === 'table');
  const lines = renderTableLines(t as never, 76);
  const rules = lines.filter((l) => l.startsWith('├'));
  // One rule under the header, plus one only where a wrapped row meets its neighbour.
  assert.ok(rules.length >= 2, 'a wrapped table still needs a header rule and at least one body rule');
  assert.ok(rules.length < lines.length / 2, `rules are ${rules.length}/${lines.length} of the table`);
});

test('a grid never carves a token it had room to hold', () => {
  // At 65-66 cols this table used to draw `src/safety/classifier.t` + `s` and `mediu` + `m`.
  // Whatever shape the renderer picks, every source token that the terminal is WIDE enough to
  // draw must appear somewhere intact — a split path reads as corruption, not as a wrap.
  const md = [
    '| Component | Responsibility | Files | Risk |',
    '| --- | --- | --- | --- |',
    '| Provider adapter | Normalizes streaming deltas across Anthropic, OpenAI and local endpoints | src/provider/*.ts | high |',
    '| Safety classifier | Gates destructive shell commands before execution | src/safety/classifier.ts | medium |',
  ].join('\n');
  const t = parseMarkdown(md).find((b) => b.type === 'table');
  assert.ok(t && t.type === 'table');
  const words = [...new Set(md.split(/[|\s]+/).filter((w) => w && !/^[-:]+$/.test(w)))];
  for (let w = 60; w <= 90; w++) {
    const out = renderTableLines(t as never, w).join('\n');
    for (const word of words) {
      if (word.length > w) continue; // could not be drawn whole at any shape
      assert.ok(out.includes(word), `width ${w} carved '${word}' in:\n${out}`);
    }
  }
});

test('no rendered table line exceeds the pane, down to pathological widths', () => {
  // Fuzzed 100k renderings across 1-7 columns x 25 widths. The only width that can still
  // overflow is 1, where a double-width glyph (日, 👍) cannot fit in a single column — physics,
  // not layout. From 2 cols up, every line fits.
  const cases = [
    '| a | b | c |\n| - | - | - |\n| alpha | beta | gamma |',
    '| Component | Responsibility | Files | Risk |\n| --- | --- | --- | --- |\n| Provider adapter | Normalizes streaming deltas across Anthropic, OpenAI and local endpoints | src/provider/*.ts | high |',
    '| K | V |\n| --- | --- |\n| 日本 | 👍 emoji |',
    '| One |\n| --- |\n| ' + 'x'.repeat(70) + ' |',
  ];
  for (const md of cases) {
    const t = parseMarkdown(md).find((b) => b.type === 'table');
    assert.ok(t && t.type === 'table');
    for (let w = 2; w <= 120; w++) {
      for (const line of renderTableLines(t as never, w)) {
        assert.ok(
          displayWidth(line) <= w,
          `width ${w}: line is ${displayWidth(line)} wide: ${JSON.stringify(line)}`,
        );
      }
    }
  }
});

test('a table renderer never throws or emits nothing', () => {
  const t = parseMarkdown('| a | b |\n| - | - |\n| 1 | 2 |').find((b) => b.type === 'table');
  assert.ok(t && t.type === 'table');
  for (let w = 1; w <= 200; w++) {
    const lines = renderTableLines(t as never, w);
    assert.ok(lines.length > 0, `width ${w} produced no output`);
  }
});

test('text too narrow for real columns still falls back to key:value', () => {
  const t = parseMarkdown('| a | b | c |\n| - | - | - |\n| alpha | beta | gamma |').find(
    (b) => b.type === 'table',
  );
  assert.ok(t && t.type === 'table');
  const lines = renderTableLines(t as never, 8);
  assert.equal(lines[0], 'a: alpha');
  assert.equal(lines.length, 3);
});

test('the key:value fallback wraps instead of overflowing a narrow pane', () => {
  // The fallback used to stack raw `key: value` strings, so a 30-col pane got an 88-col line —
  // the one place where giving up on the grid also gave up on fitting the terminal.
  const t = parseMarkdown(
    [
      '| Component | Responsibility | Files | Risk |',
      '| --- | --- | --- | --- |',
      '| Provider adapter | Normalizes streaming deltas across Anthropic, OpenAI and local endpoints | src/provider/*.ts | high |',
    ].join('\n'),
  ).find((b) => b.type === 'table');
  assert.ok(t && t.type === 'table');
  for (let w = 12; w <= 44; w++) {
    const lines = renderTableLines(t as never, w);
    for (const line of lines) {
      assert.ok(displayWidth(line) <= w, `width ${w}: ${displayWidth(line)} wide: ${JSON.stringify(line)}`);
    }
    // The value text survives across the wrap.
    assert.ok(lines.join(' ').includes('Normalizes'), `width ${w} lost the value text`);
  }
});

// ─── Headings ──────────────────────────────────────────────────────────────────

test('all six heading levels have distinct styling', () => {
  // Before: H3-H6 were pixel-identical to each other, so depth past H2 was unrecoverable.
  const seen = new Map<string, number>();
  for (let lvl = 1; lvl <= 6; lvl++) {
    const key = styleKey(spanWith(`${'#'.repeat(lvl)} Title`, 'Title'));
    assert.ok(!seen.has(key), `H${lvl} is identical to H${seen.get(key)}: ${key}`);
    seen.set(key, lvl);
  }
});

test('no heading level looks like inline bold prose', () => {
  // The theme reserves `bright` white for inline bold, so parking a heading there made
  // `### Subsection` indistinguishable from a `**bold phrase**` line.
  const boldStyle = styleKey(spanWith('**Bold prose that must not look like a heading**', 'Bold prose'));  for (let lvl = 1; lvl <= 6; lvl++) {
    const key = styleKey(spanWith(`${'#'.repeat(lvl)} Heading text`, 'Heading'));
    assert.notEqual(key, boldStyle, `H${lvl} renders identically to inline bold`);
  }
});

test('H1 and H2 get a short underline, H3+ do not', () => {
  for (const lvl of [1, 2]) {
    const rows = plain(`${'#'.repeat(lvl)} My Title`);
    assert.ok(rows.some((r) => r.trim().startsWith('─')), `H${lvl} lost its underline:\n${rows.join('\n')}`);
    // Short, not full-width: a full-terminal rule fought the content.
    const underline = rows.find((r) => r.trim().startsWith('─'))!;
    assert.ok(underline.trim().length < 90, `H${lvl} underline is full width`);
  }
  for (const lvl of [3, 4, 5, 6]) {
    const rows = plain(`${'#'.repeat(lvl)} My Title`);
    assert.ok(!rows.some((r) => r.trim().startsWith('─')), `H${lvl} should not be underlined`);
  }
});

// ─── Lists ─────────────────────────────────────────────────────────────────────

test('nested ordered lists keep their numbers', () => {
  // `1. a /    1. sub / 2. b` used to render the sub-step as a bullet — a numbered procedure
  // with numbered sub-steps read as a bulleted list.
  const rows = plain(['1. Step one', '   1. Sub-step a', '   2. Sub-step b', '2. Step two'].join('\n'));
  assert.ok(rows.some((r) => r.includes('1. Sub-step a')), `sub-step lost its number:\n${rows.join('\n')}`);
  assert.ok(rows.some((r) => r.includes('2. Sub-step b')), `sub-step lost its number:\n${rows.join('\n')}`);
  assert.ok(rows.some((r) => r.includes('1. Step one')));
  assert.ok(rows.some((r) => r.includes('2. Step two')));
});

test('an ordered sub-list inside a bullet list stays numbered', () => {
  const rows = plain(['- Overview', '  1. first', '  2. second'].join('\n'));
  assert.ok(rows.some((r) => r.includes('1. first')), rows.join('\n'));
  assert.ok(rows.some((r) => r.includes('2. second')), rows.join('\n'));
});

test('a bullet sub-list inside an ordered list stays bullets', () => {
  const rows = plain(['1. Do this', '   - detail a', '   - detail b'].join('\n'));
  assert.ok(rows.some((r) => r.includes('1. Do this')));
  assert.ok(!rows.some((r) => /\d\.\s+detail/.test(r)), 'bullet sub-items were numbered');
});

// ─── Quotes ────────────────────────────────────────────────────────────────────

test('a multi-paragraph blockquote keeps its paragraph breaks', () => {
  // reflowSoftBreaks replaced EVERY \n with a space, so `\n\n` collapsed and the paragraphs ran
  // together with a doubled space where the break used to be.
  const rows = plain('> First quoted paragraph.\n>\n> Second quoted paragraph.');
  const nonEmpty = rows.filter((r) => r.trim() !== '' && r.trim() !== '│');
  assert.ok(nonEmpty.length >= 2, `paragraphs collapsed into one line:\n${rows.join('\n')}`);
  assert.ok(!rows.some((r) => r.includes('paragraph.  Second')), 'paragraph break became a double space');
});

// ─── Soft breaks still reflow ──────────────────────────────────────────────────

test('a single newline inside a paragraph still reflows to a space', () => {
  const rows = plain('A sentence that the model\nwrapped by hand in the middle.');
  assert.ok(rows.some((r) => r.includes('model wrapped by hand')), rows.join('\n'));
});
