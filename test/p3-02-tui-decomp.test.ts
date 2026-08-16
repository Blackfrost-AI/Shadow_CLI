/**
 * P3-02 acceptance pins — tui.tsx decomposition (F06-04).
 *
 *   1. The appendable tool-run cache is EXACTLY the full recompute across every legal transcript
 *      transition (append / Ctrl-O toggle / resets), and pays zero scanning on a render that
 *      committed nothing — the "spinner tick must not run transcript logic" contract, measured
 *      through the toolRunsStats counters the acceptance criterion demands.
 *   2. The cache's O(1) validity check is only exact under the transcript's append-only
 *      invariant, so that invariant is PINNED structurally: every setCommitted site across
 *      tui.tsx + tui/slash.ts either appends via the updater or replaces wholesale with [].
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { computeToolRuns, computeToolRunsAppendable, toolRunsStats } from '../src/tui/flatten.js';
import type { ToolRunsCache } from '../src/tui/flatten.js';

// Deterministic PRNG (mulberry32) so the property test is reproducible.
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

let nextId = 1;
const tool = (name: string, ok: boolean, ms: number, arg?: string) => ({
  id: nextId++,
  kind: 'tool',
  text: '',
  tool: { name, ok, durationMs: ms, summary: '', arg },
});
const other = () => ({ id: nextId++, kind: nextId % 2 ? 'assistant' : 'user', text: `t${nextId}` });
const entriesOf = (m: Map<number, unknown>) => [...m.entries()].sort((a, b) => a[0] - b[0]);

test('P3-02: appendable cache === full recompute across appends, Ctrl-O toggles, and resets', () => {
  const rnd = mulberry32(20260815);
  const COLLAPSIBLE = ['read_file', 'grep', 'glob', 'view'];
  const BREAKING = ['edit_file', 'run_shell', 'agent', 'write_file'];
  let items: object[] = [];
  let allExpanded = false;
  let cache: ToolRunsCache | undefined;
  for (let op = 0; op < 600; op++) {
    const r = rnd();
    if (r < 0.7) {
      const pool = rnd() < 0.6 ? COLLAPSIBLE : BREAKING;
      items = [...items, rnd() < 0.75 ? tool(pool[Math.floor(rnd() * pool.length)]!, rnd() > 0.15, Math.floor(rnd() * 400), `arg${op}`) : other()];
    } else if (r < 0.78) {
      allExpanded = !allExpanded; // Ctrl-O: every descriptor flips → must stay exact
    } else if (r < 0.86) {
      items = []; // /clear-style wholesale reset (fresh array identity)
    } else if (r < 0.93 && items.length > 0) {
      items = items.map((it) => ({ ...(it as Record<string, unknown>) })); // repaint-style: same content, FRESH identity
    } // else: no new lines — the pure-cache-hit case
    const inc = computeToolRunsAppendable(items as never, allExpanded, cache);
    cache = inc.cache;
    const full = computeToolRuns(items as never, allExpanded);
    assert.deepEqual(
      entriesOf(inc.runs),
      entriesOf(full),
      `diverged after op ${op} (items=${items.length}, allExpanded=${allExpanded})`,
    );
  }
});

test('P3-02: a render that commits nothing scans zero items (the spinner-tick contract)', () => {
  const items: object[] = [tool('read_file', true, 5, 'a'), tool('read_file', true, 5, 'b')];
  const first = computeToolRunsAppendable(items as never, false);
  const before = toolRunsStats.itemsScanned;
  const incBefore = toolRunsStats.incremental;
  // Ten renders with the SAME committed array — exactly what 120ms ticks / 30ms flushes do while
  // a slow model is quiet. Every one must hit the cache without scanning a single slot.
  for (let i = 0; i < 10; i++) {
    const hit = computeToolRunsAppendable(items as never, false, first.cache);
    assert.equal(hit.runs, first.runs, 'the live map object is reused, never re-allocated');
  }
  assert.equal(toolRunsStats.itemsScanned, before, 'no new lines → zero transcript scanning');
  assert.equal(toolRunsStats.incremental - incBefore, 10, 'every quiet render took the incremental path');
});

test('P3-02: appends scan only the tail stretch, never the whole transcript', () => {
  // Build a long transcript that ENDS in a collapsible run — the stretch a new read extends.
  let items: object[] = [];
  for (let i = 0; i < 200; i++) items = [...items, tool('read_file', true, 5, `f${i}`)];
  items = [...items, tool('run_shell', true, 9, 'break'), other()]; // close the run
  const base = computeToolRunsAppendable(items as never, false);
  const scannedBefore = toolRunsStats.itemsScanned;
  const fullBefore = toolRunsStats.full;
  // Append a burst of reads AFTER the closer: only the new tail is scanned each time.
  for (let i = 0; i < 50; i++) items = [...items, tool('grep', true, 3, `p${i}`)];
  let cache = base.cache;
  for (let i = items.length - 50; i < items.length; i++) {
    const res = computeToolRunsAppendable(items.slice(0, i + 1) as never, false, cache);
    cache = res.cache;
  }
  const scanned = toolRunsStats.itemsScanned - scannedBefore;
  assert.equal(toolRunsStats.full, fullBefore, 'no append may force a full pass');
  // A full recompute per append would have scanned ~50×252 slots; the tail walk scans ~50×(tail).
  assert.ok(scanned < 50 * 60, `tail-only scanning stayed cheap (scanned ${scanned} slots)`);
  // And it is still EXACT after the burst.
  assert.deepEqual(
    entriesOf(cache.runs),
    entriesOf(computeToolRuns(items as never, false)),
    'the incrementally-built map equals the full recompute',
  );
});

test('P3-02: Ctrl-O and fresh-identity resets invalidate the cache via full passes', () => {
  const items: object[] = [tool('glob', true, 5, 'x'), tool('glob', true, 5, 'y')];
  const r1 = computeToolRunsAppendable(items as never, false);
  const fullBefore = toolRunsStats.full;
  const r2 = computeToolRunsAppendable(items as never, true, r1.cache);
  assert.equal(toolRunsStats.full, fullBefore + 1, 'an allExpanded flip is a full pass');
  assert.equal(r2.runs.get(0)!.collapsed, false);
  const fullBefore2 = toolRunsStats.full;
  const copy = items.map((it) => ({ ...(it as Record<string, unknown>) })); // same content, new identity
  const r3 = computeToolRunsAppendable(copy as never, true, r2.cache);
  assert.equal(toolRunsStats.full, fullBefore2 + 1, 'a fresh-identity array cannot reuse the old cache');
  assert.deepEqual(entriesOf(r3.runs), entriesOf(computeToolRuns(copy as never, true)));
});

test('P3-02: the append-only invariant the cache relies on is pinned in tui.tsx + slash.ts', () => {
  // computeToolRunsAppendable's O(1) boundary check is exact ONLY because committed is append-only
  // (pushLine) or replaced wholesale (/clear, context repaint). If a new setCommitted site ever
  // mutates or swaps MIDDLE entries, the cache can silently go stale — this pin names the contract.
  // Since the P3-02 decomposition the /clear handler lives in src/tui/slash.ts, so the pin
  // covers BOTH files: pushLine's append stayed in tui.tsx, the two wholesale resets split.
  const tui = readFileSync(new URL('../src/tui.tsx', import.meta.url), 'utf8');
  const slash = readFileSync(new URL('../src/tui/slash.ts', import.meta.url), 'utf8');
  const sites = (tui.match(/setCommitted\(/g) ?? []).length + (slash.match(/setCommitted\(/g) ?? []).length;
  assert.equal(sites, 3, 'exactly three setCommitted sites: pushLine append + two wholesale resets');
  const updater = tui.match(/setCommitted\(\(c\) => \{[\s\S]{0,200}?\[\.\.\.c, /);
  assert.ok(updater, 'the pushLine site appends via [...c, entry] — never edits in place');
  const resets = (tui.match(/setCommitted\(\[\]\)/g) ?? []).length + (slash.match(/setCommitted\(\[\]\)/g) ?? []).length;
  assert.equal(resets, 2, 'the other two sites replace the array wholesale with []');
});

test('P3-02 phase 3: the spinner tick runs no transcript logic — toolRuns is memoized on the appendable cache', () => {
  // The 120ms spinner tick re-renders TuiApp. Before the fix, the render body recomputed the tool-run
  // map from scratch on EVERY tick — an O(committed) transcript scan 8×/sec for as long as a turn ran.
  // The fix derives it in a useMemo keyed on the ONLY two inputs that change it (committed + allExpanded),
  // extending the previous run-map via the appendable cache. A pure tick touches neither dep, so React
  // skips the memo and scans zero slots (toolRunsStats.itemsScanned — the instrumented proof the
  // acceptance criterion demands, measured in the zero-scan contract test above). A bare full-recompute
  // call left in the render body would silently re-introduce the per-tick scan, so the pin names both halves.
  const tui = readFileSync(new URL('../src/tui.tsx', import.meta.url), 'utf8');
  // Half 1: the render body derives the map in a useMemo over the appendable cache, keyed correctly.
  const i = tui.indexOf('const toolRuns = useMemo(');
  assert.ok(i > 0, 'toolRuns is derived in a useMemo, not recomputed bare');
  const body = tui.slice(i, i + 400);
  assert.match(
    body,
    /computeToolRunsAppendable\(committed, showAllExpanded, toolRunsCacheRef\.current\)/,
    'the memo extends the previous run-map through the appendable cache',
  );
  assert.match(body, /\[committed, showAllExpanded\]/, 'keyed on exactly the two inputs a tick cannot touch');
  // Half 2: no bare full-recompute survives in the render body (the `(` guard excludes …Appendable).
  assert.doesNotMatch(tui, /computeToolRuns\(/, 'no bare full-recompute call remains — that was the per-tick scan');
});
