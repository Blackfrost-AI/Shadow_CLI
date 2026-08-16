import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  flattenItem,
  flattenItemCached,
  flattenCacheStats,
  type FlattenItem,
  type ViewportTheme,
} from '../src/tui/flatten.js';
import type { ToolRun } from '../src/tui/rows.js';

// P3-03 (F05-05) — render remount economy.
// Acceptance: "Ctrl-O at unchanged width reuses wrap work; rows-only resize never wipes;
// resize-during-stream keeps committed history."
// Two layers of pin: (a) FUNCTIONAL — the flatten memo itself, imported straight from flatten.ts;
// (b) STRUCTURAL — the tui.tsx wiring (FlatItem consults the cache; resize never reflows).

const T: ViewportTheme = {
  fg: '#ffffff', dim: '#b6bcc3', green: '#22c55e', cyan: '#38bdf8',
  yellow: '#eab308', red: '#ef4444', purple: '#a78bfa',
};

const longText = 'The quick brown fox jumps over the lazy dog. '.repeat(12);
const item: FlattenItem = { id: 1, kind: 'assistant', text: longText };

const tui = readFileSync(new URL('../src/tui.tsx', import.meta.url), 'utf8');

test('P3-03: a remount at unchanged layout reuses wrap work — same inputs hit, same array back', () => {
  const before = flattenCacheStats.hits;
  const first = flattenItemCached(item, 80, false, T);
  const second = flattenItemCached(item, 80, false, T);
  assert.equal(flattenCacheStats.hits, before + 1, 'identical inputs are a cache hit');
  assert.equal(second, first, 'the hit returns the SAME array instance — no re-wrap, no re-flatten');
  // The cached output must be identical to a fresh flatten.
  assert.deepEqual(first, flattenItem(item, 80, false, T), 'cached rows match a fresh flatten exactly');
});

test('P3-03: every layout variant stays cached per item — Ctrl-O toggling back and forth re-wraps nothing either way', () => {
  flattenItemCached(item, 80, true, T); // folded variant
  flattenItemCached(item, 80, false, T); // expanded variant
  const hitsBefore = flattenCacheStats.hits;
  flattenItemCached(item, 80, true, T);
  flattenItemCached(item, 80, false, T);
  assert.equal(flattenCacheStats.hits, hitsBefore + 2, 'repeat toggles hit BOTH fold states');
});

test('P3-03: any real layout change is a legitimate miss', () => {
  const missesBefore = flattenCacheStats.misses;
  flattenItemCached(item, 60, false, T); // different width → different wrap → miss
  assert.equal(flattenCacheStats.misses, missesBefore + 1, 'width change re-wraps (a real miss)');
});

test('P3-03: the cache is keyed on the ITEM OBJECT — ids restart at 0 per TuiApp mount, so id keys would serve one transcript’s rows for another’s', () => {
  // The regression this pins: two items with the SAME id (different mounts both start lineId at 0)
  // must never share cache entries. An id-keyed cache collided across ink-testing-library renders
  // and painted the previous session's text into the next one.
  const a: FlattenItem = { id: 0, kind: 'assistant', text: 'EARLY_MARKER from the first mount' };
  const b: FlattenItem = { id: 0, kind: 'assistant', text: 'UNIQUE_ALPHA from the second mount' };
  const rowsA = flattenItemCached(a, 80, false, T);
  const rowsB = flattenItemCached(b, 80, false, T);
  assert.notEqual(rowsA, rowsB, 'same id, different objects → separate entries');
  const textB = rowsB.map((l) => l.spans.map((s) => s.text).join('')).join('\n');
  assert.match(textB, /UNIQUE_ALPHA/, 'the second item renders ITS OWN text');
  assert.doesNotMatch(textB, /EARLY_MARKER/, 'no bleed-through from the first item’s cached rows');
  assert.deepEqual(rowsB, flattenItem(b, 80, false, T), 'and they match a fresh flatten');
});

test('P3-03: the toolRun descriptor is part of the variant key — a restacked run re-wraps', () => {
  const tool: FlattenItem = {
    id: 9, kind: 'tool', text: 'read src/foo.ts',
    tool: { name: 'Read', arg: 'src/foo.ts', ok: true, durationMs: 5, summary: '120 lines' },
  };
  const runA: ToolRun = { pos: 0, len: 2, okCount: 2, failCount: 0, totalMs: 12, collapsed: true, kinds: { read: 2 }, hint: 'src/foo.ts' };
  const runB: ToolRun = { ...runA, pos: 1 };
  flattenItemCached(tool, 80, false, T, false, true, runA);
  const missesBefore = flattenCacheStats.misses;
  flattenItemCached(tool, 80, false, T, false, true, runB);
  assert.equal(flattenCacheStats.misses, missesBefore + 1, 'a changed run descriptor (pos) misses');
  const hitsBefore = flattenCacheStats.hits;
  flattenItemCached(tool, 80, false, T, false, true, runA);
  assert.equal(flattenCacheStats.hits, hitsBefore + 1, 'an unchanged run descriptor hits (content-keyed, not identity-keyed)');
});

test('P3-03: the palette VALUES are part of the variant key — /theme mutates C in place, and a reference-compare would serve pre-switch rows forever', () => {
  // PIN_THEME is a bundle of getters over the mutable C palette; /theme is Object.assign(C, …) —
  // the theme object REFERENCE never changes, only its colors do. Simulate exactly that.
  const live: ViewportTheme = { ...T };
  const before = flattenItemCached(item, 80, false, live);
  live.fg = '#111111';
  live.dim = '#444444';
  const after = flattenItemCached(item, 80, false, live);
  assert.notEqual(after, before, 'a palette swap invalidates the cached variant');
  assert.deepEqual(after, flattenItem(item, 80, false, live), 'the re-wrap carries the new palette');
  // and the old variant is still cached — switching BACK is free too
  live.fg = T.fg;
  live.dim = T.dim;
  const hitsBefore = flattenCacheStats.hits;
  const back = flattenItemCached(item, 80, false, live);
  assert.equal(flattenCacheStats.hits, hitsBefore + 1, 'switching back hits the original variant');
  assert.equal(back, before, 'same array as the pre-switch rows');
});

test('P3-03: the memo is a WeakMap keyed on the item — entries die with the items, no manual reset needed at /clear or context-repaint', () => {
  const flat = readFileSync(new URL('../src/tui/flatten.ts', import.meta.url), 'utf8');
  assert.match(flat, /new WeakMap<FlattenItem/, 'items leaving committed are GC’d with their cached rows');
  assert.doesNotMatch(flat, /flattenCacheReset/, 'no reset wiring exists to forget or mis-order');
  assert.doesNotMatch(tui, /flattenCacheReset/, 'the TUI carries no cache-reset calls either');
});

test('P3-03: FlatItem consults the epoch-independent cache — no bare flattenItem call survives in tui.tsx', () => {
  const i = tui.indexOf('function FlatItem(');
  assert.ok(i > 0, 'FlatItem still exists');
  const body = tui.slice(i, i + 2000);
  assert.match(body, /flattenItemCached\(/, 'FlatItem wraps via the memoized flatten');
  // `flattenItemCached(` does not contain `flattenItem(`, so this is a true bare-call check.
  assert.doesNotMatch(tui, /flattenItem\(/, 'no un-memoized flattenItem call site remains in the TUI');
});

test('P3-03: resize never reflows — rows-only never wipes and resize-during-stream keeps committed history', () => {
  // The old debounced resize→hard-reflow wiring is gone entirely.
  assert.doesNotMatch(tui, /resizeReflowTimer/, 'the resize reflow debounce timer is removed');
  assert.doesNotMatch(tui, /didFirstSizeRef/, 'the resize-effect mount guard is removed with it');
  assert.doesNotMatch(tui, /setTimeout\(\(\) => reflow\(/, 'no delayed reflow of any kind remains');
  // The deleted effect's deps shape must not reappear — a listener keyed on size state.
  assert.doesNotMatch(tui, /\[terminalSize\.cols, terminalSize\.rows/, 'no effect re-subscribes on terminal size change');
  // Reflow is reachable from EXACTLY its 4 user-explicit bindings (Ctrl-O, Alt+O, app:redraw,
  // Ctrl-T). A 5th call site — e.g. a resize→reflow('soft') regression — fails here even though
  // it emits no 3J: soft reflow bumps staticEpoch and re-emits committed history mid-stream,
  // violating criterion 3 while the wipe counter stays 0.
  assert.equal([...tui.matchAll(/\breflow\(/g)].length, 4, 'reflow has exactly its 4 explicit call sites');
  // The only resize listener is useTerminalSize feeding setSize — never reflow.
  const s = tui.indexOf('function useTerminalSize(');
  assert.ok(s > 0, 'useTerminalSize still exists');
  const body = tui.slice(s, tui.indexOf('\n}', s));
  assert.match(body, /stdout\?\.on\?\.\('resize'/, 'resize still tracked for layout state');
  assert.doesNotMatch(body, /reflow|setStaticEpoch|\\x1b/, 'the resize listener only updates size state');
  // Hard reflow (the only scrollback wipe) survives in exactly ONE place: explicit app:redraw.
  const hards = [...tui.matchAll(/reflow\('hard'\)/g)];
  assert.equal(hards.length, 1, 'reflow(\'hard\') is only reachable as the user-explicit app:redraw');
  const before = tui.slice(Math.max(0, hards[0]!.index - 400), hards[0]!.index);
  assert.match(before, /app:redraw/, 'the single hard reflow is the app:redraw binding');
});
