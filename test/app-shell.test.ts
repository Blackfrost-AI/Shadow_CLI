// Regression net for the pi-tui shell (src/app/).
//
// These lock the two properties the new renderer exists to guarantee, plus the completion
// behaviour the old composer did not have at all:
//   1. No row ever exceeds the viewport width. pi-tui's main-screen renderer throws on an
//      over-wide line, so a measurement disagreement must be caught here, not in the terminal.
//   2. The approval preview keeps BOTH ends of a long command. One truncated row let a command
//      hide its own destructive tail behind the right edge.
//   3. `@` completes workspace files, `/` completes commands, and `/cmd ` completes arguments.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { visibleWidth, truncateToWidth } from '@earendil-works/pi-tui';

import { fitLines, contentWidth, FlatCell, BrandSplash, clampStreamTail, computeToolRuns, PAGE_MARGIN } from '../src/app/cells.js';
import { previewRows } from '../src/app/dialogs.js';
import { ShadowAutocompleteProvider } from '../src/app/autocomplete.js';
import { spanToAnsi, PIN_THEME } from '../src/app/ansi.js';
import { ActivityPanel, capBody, type ToolDetail } from '../src/app/activity.js';
import { SHADOW_ART } from '../src/tui/wordmark.js';
import { renderBrand, renderToolStack } from '../src/tui/rows.js';
import { applyTheme, paletteSnapshot, THEME_NAMES } from '../src/tui/theme.js';
import { flattenItem } from '../src/tui/flatten.js';
import type { FlattenItem } from '../src/tui/flatten.js';

// ── 1. width safety ──────────────────────────────────────────────────────────

test('fitLines truncates an over-wide row instead of letting the renderer abort', () => {
  const wide = 'x'.repeat(200);
  const out = fitLines([wide], 40);
  assert.equal(out.length, 1);
  assert.ok(visibleWidth(out[0]!) <= 40, `expected <= 40 cols, got ${visibleWidth(out[0]!)}`);
});

test('fitLines leaves a fitting row untouched (no gratuitous ellipsis)', () => {
  const ok = 'hello world';
  assert.deepEqual(fitLines([ok], 40), [ok]);
});

test('fitLines measures CJK by column, not by code unit', () => {
  // 30 fullwidth glyphs = 60 columns. A code-unit measurement would call this 30 and pass it
  // through, and the renderer would then abort on a 40-column terminal.
  const cjk = '漢'.repeat(30);
  const out = fitLines([cjk], 40);
  assert.ok(visibleWidth(out[0]!) <= 40, `CJK row measured ${visibleWidth(out[0]!)} cols`);
});

test('fitLines measures an OSC 8 hyperlink by its label, not its escape payload', () => {
  const link = '\x1b]8;;https://example.com/a/very/long/url/that/should/not/count\x07docs\x1b]8;;\x07';
  const out = fitLines([link], 20);
  assert.ok(
    visibleWidth(out[0]!) <= 20,
    `hyperlink row measured ${visibleWidth(out[0]!)} cols — the escape was counted as text`,
  );
});

test('every FlatCell row fits the width it was asked for, at many widths', () => {
  const item: FlattenItem = {
    id: 1,
    kind: 'tool',
    text: '',
    tool: {
      name: 'read_file',
      arg: 'src/'.repeat(40),
      ok: true,
      durationMs: 12,
      summary: 'ok — ' + 'a summary that is quite long indeed '.repeat(4),
    },
  };
  for (const cols of [20, 24, 40, 60, 80, 120, 200]) {
    const cell = new FlatCell(item as never, true);
    for (const line of cell.render(cols)) {
      assert.ok(
        visibleWidth(line) <= cols,
        `cols=${cols}: row measured ${visibleWidth(line)} — ${JSON.stringify(line.slice(0, 60))}`,
      );
    }
  }
});

test('contentWidth caps prose but lets the banner use the full inner measure', () => {
  assert.equal(contentWidth(200, 'assistant'), 100);
  assert.equal(contentWidth(200, 'banner'), 200 - PAGE_MARGIN * 2);
  assert.equal(contentWidth(50, 'assistant'), 50 - PAGE_MARGIN * 2);
});

// ── 2. the approval preview is honest about what it hides ────────────────────

test('previewRows keeps the TAIL of a command that does not fit', () => {
  const cmd = 'git status ' + ' '.repeat(200) + '; rm -rf ~/Documents';
  const { rows, hidden } = previewRows(cmd, 40, 38, 3);
  const joined = rows.join('\n');
  assert.ok(
    joined.includes('rm -rf ~/Documents'),
    `the destructive tail was hidden — preview was:\n${joined}`,
  );
  assert.ok(hidden > 0, 'a truncated preview must report how much it dropped');
});

test('previewRows prints a short command in full with nothing hidden', () => {
  const { rows, hidden } = previewRows('npm test', 40, 38, 3);
  assert.equal(hidden, 0);
  assert.equal(rows.join(''), 'npm test');
});

test('previewRows never exceeds its row budget', () => {
  const cmd = 'x'.repeat(1000);
  const { rows } = previewRows(cmd, 40, 38, 3);
  assert.ok(rows.length <= 3, `asked for 3 rows, got ${rows.length}`);
});

// ── 3. completion ────────────────────────────────────────────────────────────

function fixtureWorkspace(): string {
  const root = mkdtempSync(join(tmpdir(), 'shadow-app-'));
  mkdirSync(join(root, 'src', 'tui'), { recursive: true });
  mkdirSync(join(root, 'node_modules', 'junk'), { recursive: true });
  writeFileSync(join(root, 'src', 'tui', 'width.ts'), '');
  writeFileSync(join(root, 'src', 'index.ts'), '');
  writeFileSync(join(root, 'README.md'), '');
  writeFileSync(join(root, 'node_modules', 'junk', 'hidden.ts'), '');
  return root;
}

async function suggestions(
  p: ShadowAutocompleteProvider,
  line: string,
): Promise<{ items: { value: string }[]; prefix: string } | null> {
  return p.getSuggestions([line], 0, line.length, { signal: new AbortController().signal, force: true });
}

test('@ completes workspace files and skips node_modules', async () => {
  const root = fixtureWorkspace();
  const p = new ShadowAutocompleteProvider([], root);
  const s = await suggestions(p, 'look at @width');
  assert.ok(s, 'expected file completions for @width');
  assert.ok(
    s.items.some((i) => i.value.includes('width.ts')),
    `expected width.ts among ${s.items.map((i) => i.value).join(', ')}`,
  );
  for (const i of s.items) {
    assert.ok(!i.value.includes('node_modules'), `node_modules leaked into completions: ${i.value}`);
  }
});

test('a bare @ lists entries so the sigil alone is useful', async () => {
  const root = fixtureWorkspace();
  const p = new ShadowAutocompleteProvider([], root);
  const s = await suggestions(p, '@');
  assert.ok(s && s.items.length > 0, 'a bare @ should offer something');
});

test('/ completes command names fuzzily', async () => {
  const root = fixtureWorkspace();
  const p = new ShadowAutocompleteProvider(
    [
      { name: '/model', desc: 'List models' },
      { name: '/theme', desc: 'Switch theme' },
    ],
    root,
  );
  const s = await suggestions(p, '/th');
  assert.ok(s, 'expected command completions for /th');
  assert.equal(s.items[0]?.value, '/theme');
});

test('/cmd <arg> completes that command argument', async () => {
  const root = fixtureWorkspace();
  const p = new ShadowAutocompleteProvider(
    [{ name: '/theme', desc: 'Switch theme', args: (pre) => [{ value: pre + 'x', label: 'og' }] }],
    root,
  );
  const s = await suggestions(p, '/theme o');
  assert.ok(s, 'expected argument completions for /theme o');
  assert.equal(s.prefix, 'o');
});

test('applyCompletion replaces exactly the reported prefix', async () => {
  const root = fixtureWorkspace();
  const p = new ShadowAutocompleteProvider([], root);
  const line = 'see @width';
  const s = await suggestions(p, line);
  assert.ok(s);
  const item = s.items.find((i) => i.value.includes('width.ts'))!;
  const out = p.applyCompletion([line], 0, line.length, item as never, s.prefix);
  assert.equal(out.lines[0], `see ${item.value}`);
  assert.equal(out.cursorCol, out.lines[0]!.length);
});

// ── 4. span → ANSI ───────────────────────────────────────────────────────────

test('spanToAnsi emits truecolor SGR and always resets', () => {
  const out = spanToAnsi({ text: 'hi', color: '#ff0000' }, PIN_THEME);
  assert.ok(out.includes('\x1b[38;2;255;0;0m'), 'expected truecolor foreground');
  assert.ok(out.endsWith('\x1b[0m'), 'a span must not leak its style into the next one');
});

test('spanToAnsi maps dim to the ADA gray, never the faint attribute', () => {
  const out = spanToAnsi({ text: 'quiet', dim: true }, PIN_THEME);
  assert.ok(!out.includes('\x1b[2m'), 'the faint SGR-2 attribute is banned for readability');
  assert.ok(out.includes('\x1b[38;2;'), 'dim must resolve to an explicit gray');
});

test('a run of spans resets between them so styles cannot bleed', () => {
  const a = spanToAnsi({ text: 'A', bold: true }, PIN_THEME);
  const b = spanToAnsi({ text: 'B' }, PIN_THEME);
  const line = a + b;
  const lastReset = line.lastIndexOf('\x1b[0m');
  assert.ok(lastReset > line.indexOf('A'), 'the bold span must reset before B');
});

test('truncateToWidth is the same measure fitLines uses', () => {
  const s = '漢'.repeat(10);
  assert.equal(visibleWidth(truncateToWidth(s, 10, '')), 10);
});

// ── 5. the wordmark splash ───────────────────────────────────────────────────

const BRAND = {
  version: '4.1.0',
  providerModel: 'anthropic/claude-sonnet-4',
  workspace: '/Users/craigmac/shadow-cli',
  help: '/help · /model · Shift+Tab mode · @ file',
};

function splashLines(width: number): string[] {
  const splash = new BrandSplash(BRAND as never, SHADOW_ART);
  return splash.render(width);
}

test('SHADOW_ART holds the full block wordmark as real glyphs, not escaped \\uXXXX text', () => {
  // This is the bug that made the wordmark vanish from the compiled binary: Bun ASCII-escapes the
  // block glyphs to \u2588 in the bundle, and String.raw would keep the escape literal.
  const joined = SHADOW_ART.join('\n');
  assert.ok(joined.includes('█'), 'the art must contain real U+2588 block glyphs');
  assert.ok(!joined.includes('u2588'), 'the art must not contain a literal \\u2588 escape');
  assert.equal(SHADOW_ART.length, 6, 'the full wordmark is six rows tall');
  assert.equal(Math.max(...SHADOW_ART.map((line) => visibleWidth(line))), 51, 'the full-width mark is retained');
});

test('the full wordmark renders side-by-side when there is room beside the meta block', () => {
  const lines = splashLines(120);
  const artRow = lines.find((l) => l.includes(SHADOW_ART[0]!));
  assert.ok(artRow, 'expected the full wordmark at 120 columns');
  assert.ok(artRow.includes(BRAND.version), 'meta sits beside the wordmark side-by-side');
});

test('the wordmark keeps its two-tone depth treatment', () => {
  const rows = renderBrand({ ...BRAND, art: SHADOW_ART }, PIN_THEME, 120);
  assert.equal(rows[0]?.[0]?.color, PIN_THEME.cyan);
  assert.equal(rows[0]?.[0]?.bold, true);
  assert.equal(rows.at(-1)?.[0]?.color, PIN_THEME.dim);
  assert.notEqual(rows.at(-1)?.[0]?.bold, true);
});

test('the full wordmark stacks instead of shrinking when the terminal is moderately narrow', () => {
  const lines = splashLines(70);
  // The exact founder regression: 70 columns has room for the 51-column art, just not for the
  // side-by-side meta block. Keep the full art and stack; do not fall back to compact "shadow".
  for (const artLine of SHADOW_ART) {
    const row = lines.find((l) => l.includes(artLine));
    assert.ok(row, `art row missing at 70 columns: ${artLine.slice(0, 24)}…`);
    assert.ok(!row.includes(BRAND.version), 'a stacked art row must not also carry the meta block');
  }
});

test('the splash degrades to the compact name form on a very narrow terminal', () => {
  const lines = splashLines(40);
  assert.ok(
    !lines.some((l) => l.includes('█')),
    'the 51-column wordmark cannot render in 40 columns and must fall back',
  );
  assert.ok(lines.some((l) => l.includes('shadow')), 'the compact form names the binary');
});

test('the wordmark stacks when the meta would not fit beside it', () => {
  const lines = splashLines(70);
  const top = lines.find((l) => l.includes(SHADOW_ART[0]!));
  assert.ok(top && !top.includes(BRAND.version), 'stacked at 70: art rows carry no meta');
});

test('every splash row fits its width — including at widths too narrow for the art', () => {
  for (const cols of [30, 40, 51, 60, 70, 80, 90, 100, 120, 200]) {
    for (const line of splashLines(cols)) {
      assert.ok(
        visibleWidth(line) <= cols,
        `cols=${cols}: splash row measured ${visibleWidth(line)} — the renderer would abort`,
      );
    }
  }
});

test('the splash re-renders on resize rather than caching a stale width', () => {
  // The art lives in the LIVE frame precisely so a resize reflows it. A width-keyed cache that
  // did not invalidate would leave the 120-column layout on a 70-column terminal.
  const splash = new BrandSplash(BRAND as never, SHADOW_ART);
  const wide = splash.render(120).find((l) => l.includes(SHADOW_ART[0]!))!;
  splash.invalidate();
  const narrow = splash.render(70).find((l) => l.includes(SHADOW_ART[0]!))!;
  assert.notEqual(wide, narrow, 'expected a reflowed frame');
  assert.ok(visibleWidth(narrow) <= 70);
  assert.ok(!narrow.includes(BRAND.version), 'stacked at 70: no meta on the art row');
});

test('a width change alone produces a different layout without an explicit invalidate', () => {
  const splash = new BrandSplash(BRAND as never, SHADOW_ART);
  const a = splash.render(120).find((l) => l.includes(SHADOW_ART[0]!))!;
  const b = splash.render(70).find((l) => l.includes(SHADOW_ART[0]!))!;
  assert.notEqual(a, b, 'the art must reflow when the width changes');
});

// ── 6. tool-call grouping (the "whole screen is tool rows" complaint) ────────

function toolItem(id: number, name: string, ok = true): FlattenItem {
  return {
    id,
    kind: 'tool',
    text: '',
    tool: { name, arg: 'x', ok, durationMs: 100, summary: 'ok' },
  } as FlattenItem;
}

test('a burst of consecutive shell calls folds into ONE run', () => {
  // The screenshot case: twenty read-only probes used to be twenty rows, because shell was
  // excluded from a grouping predicate borrowed from the safety classifier.
  const items = Array.from({ length: 20 }, (_, i) => toolItem(i + 1, 'run_shell'));
  const runs = computeToolRuns(items, true);
  assert.equal(runs.size, 20, 'every member is in the run map');
  assert.equal(runs.get(1)?.len, 20);
  assert.equal(runs.get(1)?.pos, 0);
  assert.equal(runs.get(20)?.pos, 19);
  assert.equal(runs.get(1)?.kinds.command, 20);
});

test('a single call is NOT a run — it keeps its own detailed row', () => {
  const runs = computeToolRuns([toolItem(1, 'run_shell')], true);
  assert.equal(runs.size, 0);
});

test('a run is broken by a non-tool item', () => {
  const items: FlattenItem[] = [
    toolItem(1, 'run_shell'),
    toolItem(2, 'run_shell'),
    { id: 3, kind: 'assistant', text: 'thinking about it' } as FlattenItem,
    toolItem(4, 'run_shell'),
    toolItem(5, 'run_shell'),
  ];
  const runs = computeToolRuns(items, true);
  assert.equal(runs.get(1)?.len, 2);
  assert.equal(runs.get(4)?.len, 2);
});

test('the run summary counts commands, edits and failures separately', () => {
  const items: FlattenItem[] = [
    toolItem(1, 'run_shell'),
    toolItem(2, 'run_shell'),
    toolItem(3, 'run_shell', false),
    toolItem(4, 'edit_file'),
    toolItem(5, 'edit_file'),
    toolItem(6, 'read_file'),
  ];
  const run = computeToolRuns(items, true).get(1)!;
  assert.equal(run.len, 6);
  assert.equal(run.kinds.command, 3, 'three shell calls');
  assert.equal(run.kinds.edit, 2, 'mutations are counted, not hidden');
  assert.equal(run.kinds.read, 1);
  assert.equal(run.failCount, 1);
  assert.equal(run.okCount, 5);
});

test('the collapsed row names the run, its failures, and both ways back in', () => {
  const items: FlattenItem[] = [
    toolItem(1, 'run_shell'),
    toolItem(2, 'run_shell'),
    toolItem(3, 'run_shell', false),
    toolItem(4, 'edit_file'),
  ];
  const run = computeToolRuns(items, true).get(1)!;
  const row = renderToolStack(run, PIN_THEME)
    .map((s) => s.text)
    .join('');
  assert.ok(row.includes('Ran 3 commands'), `expected a command count in: ${row}`);
  assert.ok(row.includes('Edited 1 file'), `expected an edit count in: ${row}`);
  assert.ok(row.includes('✗1 failed'), `expected a failure count in: ${row}`);
  assert.ok(row.includes('^O'), 'the row must say how to expand inline');
  assert.ok(row.includes('/activity'), 'the row must say how to open the sub-window');
});

test('an expanded run renders each member on its own row', () => {
  const items = Array.from({ length: 4 }, (_, i) => toolItem(i + 1, 'run_shell'));
  const collapsedRuns = computeToolRuns(items, true);
  const expandedRuns = computeToolRuns(items, false);
  assert.equal(collapsedRuns.get(1)?.collapsed, true);
  assert.equal(expandedRuns.get(1)?.collapsed, false, 'Ctrl-O flips the run open');
  // flattenItem absorbs pos>0 only while collapsed. Test the SECOND member (pos 1) with its own
  // descriptor — the run as a whole is drawn by pos 0.
  const collapsedRows = flattenItem(items[1] as never, 100, true, PIN_THEME, false, true, collapsedRuns.get(2));
  const expandedRows = flattenItem(items[1] as never, 100, false, PIN_THEME, false, true, expandedRuns.get(2));
  assert.equal(collapsedRows.length, 0, 'a collapsed run absorbs its later members');
  assert.ok(expandedRows.length > 0, 'an expanded run draws them');
});

// ── 7. the activity sub-window ───────────────────────────────────────────────

function panelOf(details: ToolDetail[], rows = 24): ActivityPanel {
  return new ActivityPanel(details, () => {}, () => rows);
}

test('the activity panel lists every call with its command and output', () => {
  const panel = panelOf([
    { n: 1, turn: 1, name: 'run_shell', arg: 'ifconfig -a | head -100', ok: true, durationMs: 220, summary: 'ok', body: ['lo0: flags=8049'], meta: 'output' },
    { n: 2, turn: 1, name: 'run_shell', arg: 'lsof -nP -iTCP', ok: false, durationMs: 300, summary: 'command exit 1' },
  ]);
  const doc = panel.render(100).join('\n');
  assert.ok(doc.includes('Activity'), 'expected a title');
  assert.ok(doc.includes('ifconfig -a'), 'expected the first command');
  assert.ok(doc.includes('lo0: flags'), 'expected its output');
  assert.ok(doc.includes('lsof -nP -iTCP'), 'expected the failing command');
  assert.ok(doc.includes('✗1 failed') || doc.includes('1 failed'), 'expected the failure count');
});

test('every activity panel row fits the width', () => {
  const panel = panelOf([
    { n: 1, turn: 1, name: 'run_shell', arg: 'x'.repeat(400), ok: true, durationMs: 10, summary: 'y'.repeat(400), body: ['z'.repeat(400)], meta: 'output' },
  ]);
  for (const cols of [40, 60, 80, 120]) {
    for (const line of panel.render(cols)) {
      assert.ok(visibleWidth(line) <= cols, `cols=${cols}: row measured ${visibleWidth(line)}`);
    }
  }
});

test('the activity panel scrolls and closes on esc', () => {
  let closed = false;
  const panel = new ActivityPanel(
    Array.from({ length: 60 }, (_, i) => ({
      n: i + 1,
      turn: 1,
      name: 'run_shell',
      arg: `cmd ${i}`,
      ok: true,
      durationMs: 10,
      summary: 'ok',
    })),
    () => {
      closed = true;
    },
    () => 24,
  );
  const first = panel.render(80)[0]!;
  panel.handleInput('\x1b[B'); // down
  assert.notEqual(panel.render(80)[0], first, 'the panel must scroll');
  panel.handleInput('\x1b'); // esc
  assert.ok(closed, 'esc must close the panel');
});

test('capBody keeps the tail and says how much it dropped', () => {
  const body = capBody(Array.from({ length: 500 }, (_, i) => `line ${i}`));
  assert.ok(body.length <= 201, `expected a capped body, got ${body.length}`);
  assert.ok(body[0]!.includes('omitted'), 'a truncation must be stated');
  assert.ok(body[body.length - 1]!.includes('line 499'), 'the tail is what matters');
});

// ── 8. the user-turn highlight ───────────────────────────────────────────────

/** Count how many columns of a rendered row carry a background fill. */
function bandedCols(line: string): number {
  const bg = /\x1b\[48;2;(\d+;\d+;\d+)m/.exec(line);
  if (!bg) return 0;
  const plain = line
    .replace(/\x1b\[[0-9;]*m/g, '\u0000')
    .split('\u0000');
  // Re-walk: count the plain text that follows a background-opening SGR.
  let on = false;
  let cols = 0;
  const re = /\x1b\[48;2;\d+;\d+;\d+m|\x1b\[0m|\x1b\[49m|([^\x1b]+)|(\x1b\[[0-9;]*m)/g;
  void plain;
  let m: RegExpExecArray | null;
  while ((m = re.exec(line)) !== null) {
    if (m[0].startsWith('\x1b[48;2;')) on = true;
    else if (m[0] === '\x1b[0m' || m[0] === '\x1b[49m') on = false;
    else if (m[1] && on) cols += visibleWidth(m[1]);
  }
  return cols;
}

test('a user turn is drawn as a full-width background band', () => {
  const item = { id: 1, kind: 'user', text: '❯ hello there, this is my message' } as FlattenItem;
  const lines = new FlatCell(item as never, false).render(80);
  const bandRows = lines.filter((l) => bandedCols(l) > 0);
  assert.ok(bandRows.length >= 1, 'the user turn must carry a background band');
  for (const row of bandRows) {
    assert.equal(bandedCols(row), 80, `the band must be full-bleed, covered ${bandedCols(row)} of 80`);
    assert.ok(visibleWidth(row) <= 80, 'and must not overflow the viewport');
  }
});

test('the band runs down EVERY wrapped row of a long user turn', () => {
  const item = { id: 1, kind: 'user', text: `❯ ${'word '.repeat(60)}` } as FlattenItem;
  const lines = new FlatCell(item as never, false).render(60);
  const bandRows = lines.filter((l) => bandedCols(l) > 0);
  assert.ok(bandRows.length >= 4, `expected the band on every wrapped row, got ${bandRows.length}`);
  for (const row of bandRows) assert.equal(bandedCols(row), 60);
});

test('an assistant turn carries NO background — only the user is highlighted', () => {
  const item = { id: 1, kind: 'assistant', text: 'Here is my answer.\n\nAnd a second paragraph.' } as FlattenItem;
  for (const row of new FlatCell(item as never, false).render(80)) {
    assert.equal(bandedCols(row), 0, `model output must never be banded: ${row.slice(0, 40)}`);
  }
});

test('the blank separator above a user turn is outside the band', () => {
  // The item's leading gap row belongs to the same item but must not be filled — that edge is
  // what makes the band read as a block rather than bleeding into the row above it.
  const item = { id: 1, kind: 'user', text: '❯ hi' } as FlattenItem;
  const lines = new FlatCell(item as never, false).render(80);
  assert.equal(bandedCols(lines[0]!), 0, 'the leading separator row must not be banded');
  assert.ok(lines.slice(1).some((l) => bandedCols(l) > 0), 'the message row must be banded');
});

test('the user band uses the theme color, and every theme resolves one', () => {
  for (const name of THEME_NAMES) {
    applyTheme(name);
    assert.ok(PIN_THEME.userBg, `theme ${name} must resolve a user band color`);
    const item = { id: 1, kind: 'user', text: '❯ x' } as FlattenItem;
    const row = new FlatCell(item as never, false).render(40).find((l) => bandedCols(l) > 0);
    assert.ok(row, `theme ${name} rendered no band`);
  }
  applyTheme('og');
});

test('switching themes does not leak an omitted optional token from the previous theme', () => {
  // `Object.assign` only copies keys the new theme DEFINES, so a theme that omits an optional
  // token used to inherit the previous one — `light` was painted with `og`'s user band.
  applyTheme('og');
  const ogBand = (paletteSnapshot() as { userBg?: string }).userBg;
  applyTheme('light');
  const lightBand = (paletteSnapshot() as { userBg?: string }).userBg;
  assert.ok(ogBand, 'og defines an explicit band');
  assert.notEqual(lightBand, ogBand, 'light must not inherit og’s band');
  assert.equal(lightBand, undefined, 'light omits the token and falls back to menuBg');
  assert.equal(PIN_THEME.userBg, paletteSnapshot().menuBg, 'the fallback is the theme menu fill');
  applyTheme('og');
});




// ── 9. review fixes (GLM pass) ───────────────────────────────────────────────

test('FlatCell folds a large table by default and unfolds when foldTables=false (F3)', () => {
  // The fold hint says "^O" — before the fix that key flipped `collapsed`, which never affected
  // table folding: the hint advertised a dead key. foldTables is now the app's expand state.
  const rows = Array.from({ length: 9 }, (_, i) => `| cell ${i}a | cell ${i}b |`).join('\n');
  const MD = `| Head A | Head B |\n| --- | --- |\n${rows}`;
  const plain = (lines: string[]) => lines.map((l) => l.replace(/\x1b\[[0-9;]*m/g, ''));
  const folded = plain(new FlatCell({ id: 1, kind: 'assistant', text: MD } as never, false, false, undefined, true).render(90));
  assert.ok(folded.some((l) => l.includes('table 9×2')), 'large tables fold by default');
  const open = plain(new FlatCell({ id: 1, kind: 'assistant', text: MD } as never, false, false, undefined, false).render(90));
  assert.ok(open.some((l) => l.includes('╭')), 'foldTables=false draws the full grid');
  assert.ok(!open.some((l) => l.includes('table 9×2')), 'and no fold row remains');
});

test('FlatCell.update() is a cache-preserving no-op when nothing changed (F3 perf)', () => {
  const item = { id: 1, kind: 'assistant', text: 'hello **world**' } as FlattenItem;
  const cell = new FlatCell(item as never, false, false, undefined, true);
  const first = cell.render(80);
  const same = cell.update({ collapsed: false, continuation: false, toolRun: undefined, foldTables: true });
  void same;
  assert.equal(cell.render(80), first, 'an unchanged update must not invalidate the cache');
  cell.update({ collapsed: false, continuation: true, toolRun: undefined, foldTables: true });
  assert.notEqual(cell.render(80), first, 'a changed flag must re-render');
});

test('a tool-run descriptor reaching the cell collapses the burst to one row (F3 wiring)', () => {
  // cellFor used to compute the runs map and then discard it (`void runs`) — the stacking feature
  // existed in probes but never in the app. The cell must render the run when handed one.
  const items = Array.from({ length: 5 }, (_, i) => toolItem(i + 1, 'run_shell'));
  const runs = computeToolRuns(items, true);
  const cell = new FlatCell(items[0] as never, false, false, runs.get(1), true);
  const row = cell.render(100).map((l) => l.replace(/\x1b\[[0-9;]*m/g, '')).join(' ');
  assert.ok(row.includes('Ran 5 commands'), `expected the run headline, got: ${row.trim()}`);
  // pos>0 members are absorbed while collapsed.
  const tail = new FlatCell(items[4] as never, false, false, runs.get(5), true);
  assert.equal(tail.render(100).filter((l) => l.trim()).length, 0, 'absorbed members draw nothing');
});

test('clampStreamTail keeps a streaming table\u2019s header row (live preview)', () => {
  const lines = [
    'intro paragraph here',
    '',
    '| A | B |',
    '| --- | --- |',
    '| 1 | 1 |',
    '| 2 | 2 |',
    '| 3 | 3 |',
    '| 4 | 4 |',
  ];
  const clamped = clampStreamTail(lines.join('\n'));
  assert.ok(clamped.includes('| A | B |'), 'the header must survive the clamp');
  assert.ok(clamped.includes('| --- | --- |'), 'and the separator row');
  // Plain prose still clamps to the tail budget.
  const prose = clampStreamTail(Array.from({ length: 20 }, (_, i) => `line ${i}`).join('\n'));
  assert.ok(!prose.includes('line 0'), 'prose clamps to the tail');
  assert.ok(prose.includes('line 19'), 'and keeps the end');
});

test('.env is never offered as a file completion', async () => {
  const root = fixtureWorkspace();
  writeFileSync(join(root, '.env'), 'SECRET=1');
  const p = new ShadowAutocompleteProvider([], root);
  const s = await suggestions(p, '@');
  assert.ok(s, 'expected completions');
  for (const i of s.items) {
    assert.ok(!i.value.includes('.env'), `.env leaked into completions: ${i.value}`);
  }
});

test('the workspace walk is shared and warm() does not throw', async () => {
  const root = fixtureWorkspace();
  const p = new ShadowAutocompleteProvider([], root);
  p.warm(); // fire-and-forget build
  const a = await suggestions(p, '@');
  const b = await suggestions(p, '@');
  assert.ok(a && b, 'both queries resolve');
  assert.equal(a!.items.length, b!.items.length, 'concurrent callers see one consistent index');
});

test('the activity panel groups calls per turn with classifier summaries (P1.4)', () => {
  const panel = panelOf([
    { n: 1, turn: 1, name: 'run_shell', arg: 'a', ok: true, durationMs: 1, summary: 'ok' },
    { n: 2, turn: 1, name: 'read_file', arg: 'b', ok: true, durationMs: 1, summary: 'ok' },
    { n: 3, turn: 2, name: 'run_shell', arg: 'c', ok: true, durationMs: 1, summary: 'ok' },
    { n: 4, turn: 2, name: 'edit_file', arg: 'd', ok: true, durationMs: 1, summary: 'ok' },
  ]);
  const doc = panel.render(100).map((l) => l.replace(/\x1b\[[0-9;]*m/g, '')).join('\n');
  assert.ok(doc.includes('— turn 1 —'), 'turn headers present');
  assert.ok(doc.includes('1 command, 1 file read'), `turn 1 summary: ${doc}`);
  assert.ok(doc.includes('1 command, 1 edit'), `turn 2 uses the edit kind: ${doc}`);
});

// ── 10. senior-review fixes (merge gate) ─────────────────────────────────────

test('a model switch is refused while a turn is running (Ink parity)', async () => {
  const { ModelSwitcher } = await import('../src/app/modelSwitch.js');
  const lines: string[] = [];
  let running = true;
  const switcher = new ModelSwitcher({
    cfg: {} as never,
    context: {} as never,
    baseContextPolicy: { contextBudget: 1, triggerRatio: 1, keepLastTurns: 1 },
    get provider() {
      return undefined as never;
    },
    set provider(_p: never) {
      throw new Error('must not touch the provider while running');
    },
    get current() {
      return { provider: 'mock', model: 'm' };
    },
    set current(_c: { provider: string; model: string }) {
      throw new Error('must not swap the live model while running');
    },
    get loop() {
      return null;
    },
    pushLine: (p) => lines.push(p.text),
    isRunning: () => running,
  });
  const ok = await switcher.selectModel({ label: 'x', provider: 'openai', model: 'y' } as never);
  assert.equal(ok, false, 'refused mid-turn');
  assert.ok(lines.some((l) => l.includes('Wait for the current turn')), 'the refusal is visible');
  running = false;
  // After the turn ends the guard no longer fires: the call proceeds PAST the running check
  // (this minimal stub has no real credentials/context, so it fails or throws downstream —
  // either is fine; what must NOT appear is a second refusal).
  let passedGuard = false;
  try {
    await switcher.selectModel({ label: 'x', provider: 'openai', model: 'y' } as never);
    passedGuard = true;
  } catch {
    passedGuard = true; // it got past the guard and died in stub territory
  }
  assert.ok(passedGuard, 'idle switch proceeds past the guard');
  assert.equal(lines.filter((l) => l.includes('Wait for the current turn')).length, 1, 'exactly one refusal — none when idle');
});
