// T1: toast + context gauge — pure module tests (no Ink, no timers).
// Covers: clampToastText width math (incl. full-width chars), toastColor tinting,
// formatContextGauge bar/level/marker math, fitHud toast budgeting, and the
// strip tier drop ladder that governs when the gauge is shed.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { clampToastText, toastColor, TOAST_TTL_MS, TOAST_INDENT } from '../src/tui/toast.js';
import { displayWidth as displayWidthOf } from '../src/util/width.js';
import { formatContextGauge, gaugeLevel, GAUGE_FILLED, GAUGE_EMPTY, GAUGE_TRIGGER } from '../src/tui/gauge.js';
import { fitHud, formatStatusStrip, type StatusStripInput } from '../src/tui/layout.js';

// ── toast.clampToastText ────────────────────────────────────────────────────

test('clampToastText returns short text unchanged', () => {
  assert.equal(clampToastText('Copied 3 chars', 80), 'Copied 3 chars');
});

test('clampToastText clamps long text to one row with ellipsis', () => {
  const long = 'Theme → catppuccin-mocha ✓ (background: #1e1e2e)'.repeat(4);
  const out = clampToastText(long, 60);
  // budget = cols − TOAST_INDENT(4) − 2; every ASCII char is width 1.
  assert.ok(out.length <= 60 - 4 - 2, `got ${out.length}`);
  assert.ok(out.endsWith('…'));
});

test('clampToastText counts full-width characters as two columns', () => {
  const wide = '日本語テキスト'; // each char = 2 cols; budget = cols − 4 − 2 = 4, '…' reserves 1 col
  const out = clampToastText(wide, 10);
  // Keeps chars while width + w + 1 ≤ 4 → 日本 (4) would leave no room for …,
  // so exactly 日 (2) + … = 3 cols fits; a 2nd char overflows to 5.
  assert.equal(out, wide.slice(0, 1) + '…');
  assert.ok(displayWidthOf(out) <= 4);
});

test('clampToastText never throws on zero/negative widths', () => {
  assert.equal(clampToastText('hello', 0), '…');
  assert.equal(typeof clampToastText('hello', -5), 'string');
});

// ── toast.toastColor ─────────────────────────────────────────────────────────

test('toastColor maps kinds to palette colors', () => {
  const pal = { cyan: '#01', yellow: '#02', red: '#03' };
  assert.equal(toastColor('ok', pal), '#01');
  assert.equal(toastColor('warn', pal), '#02');
  assert.equal(toastColor('error', pal), '#03');
  assert.equal(toastColor('info', pal), '#01');
});

test('toastColor falls back when palette lacks a color', () => {
  assert.equal(typeof toastColor('warn', {}), 'string');
  assert.equal(typeof toastColor('error', {}), 'string');
});

test('TOAST_TTL_MS is the documented ~3.2s window', () => {
  assert.equal(TOAST_TTL_MS, 3200);
});

test('TOAST_INDENT equals the page margin the render side actually indents with', () => {
  // The chrome group prefixes PAGE_MARGIN spaces to the toast text. If this drifts, the
  // clamped row becomes 1+ cols too wide and Ink's truncate clips the ellipsis.
  const src = readFileSync(new URL('../src/tui.tsx', import.meta.url), 'utf8');
  const pm = src.match(/const PAGE_MARGIN = (\d+)/);
  assert.ok(pm, 'PAGE_MARGIN definition found');
  assert.equal(TOAST_INDENT, Number(pm?.[1]), 'clamp indent must match the render indent');
  // And the render site must indent the toast by the page margin (guard against a future
  // rewrite dropping the indent; MARGIN_PAD is ' '.repeat(PAGE_MARGIN) in tui.tsx).
  assert.match(src, /MARGIN_PAD \+ toast\.text/, 'toast row is still indented by the page margin');
});

// ── gauge.formatContextGauge ─────────────────────────────────────────────────

test('gauge bar is 10 cells with a trailing percent label', () => {
  const g = formatContextGauge(43);
  assert.equal(g.bar.length, 10);
  assert.equal(g.label, ' 43%');
  assert.equal(g.level, 'normal');
  assert.equal(g.bar, GAUGE_FILLED.repeat(4) + GAUGE_EMPTY.repeat(6));
});

test('gauge marks the trigger cell when unfilled', () => {
  // trigger at 0.9 → cell index 8 (0-based) gets the marker when the bar is below it.
  const g = formatContextGauge(63, 0.9);
  assert.equal(g.bar[8], GAUGE_TRIGGER);
  assert.equal(g.bar[9], GAUGE_EMPTY);
});

test('gauge omits the trigger marker once it is filled', () => {
  const g = formatContextGauge(95, 0.9);
  assert.ok(!g.bar.includes(GAUGE_TRIGGER));
  assert.equal(g.bar, GAUGE_FILLED.repeat(10));
});

test('gauge levels escalate at 75% and 90%', () => {
  assert.equal(gaugeLevel(74), 'normal');
  assert.equal(gaugeLevel(75), 'warn');
  assert.equal(gaugeLevel(89), 'warn');
  assert.equal(gaugeLevel(90), 'hot');
  assert.equal(formatContextGauge(100).level, 'hot');
});

test('gauge tolerates clamped and degenerate inputs', () => {
  assert.equal(formatContextGauge(250).label, ' 100%');
  const nan = formatContextGauge(Number.NaN);
  assert.equal(nan.level, 'normal');
  assert.equal(nan.bar.length, 10);
});

// ── fitHud: toast budgeting ──────────────────────────────────────────────────

test('fitHud grants the toast row when there is headroom', () => {
  const f = fitHud(40, { liveWant: 2, pinned: true, queued: true, custom: true, toast: true });
  assert.equal(f.toast, true);
});

test('fitHud drops the toast before pinned/queued on short terminals', () => {
  // Phase-B (strip merged into the hint, strip:false). rows=10 → cap 9: base 3 + status 1 +
  // live 2 + hint 1 + pinned 1 + queued 1 = 9 — exactly full, so the toast cannot be granted.
  const f = fitHud(10, { liveWant: 2, pinned: true, queued: true, custom: false, toast: true, strip: false });
  assert.equal(f.pinned, true);
  assert.equal(f.queued, true);
  assert.equal(f.toast, false);
  assert.equal(f.height, 9);
});

test('fitHud never lets toast push height past the rows-1 cap', () => {
  for (const rows of [4, 5, 6, 8, 12, 24, 60]) {
    const f = fitHud(rows, { liveWant: rows, pinned: true, queued: true, custom: true, toast: true });
    assert.ok(f.height <= rows - 1, `rows=${rows} height=${f.height}`);
  }
});

test('fitHud without toast leaves the flag false', () => {
  const f = fitHud(40, { liveWant: 2, pinned: false, queued: false, custom: false });
  assert.equal(f.toast, false);
});

// ── formatStatusStrip: gauge rides the ctx segment, drops with the tier ladder ─

const stripBase: StatusStripInput = {
  provider: 'anthropic',
  model: 'claude-4-sonnet',
  autonomy: 'normal',
  status: 'tokens 1.2M · ctx 95% · $4.20',
  contextPct: 95,
  triggerRatio: 0.9,
};

test('formatStatusStrip includes the gauge in the full tier', () => {
  const out = formatStatusStrip(stripBase, 120);
  assert.ok(out.includes(GAUGE_FILLED), `gauge missing: ${out}`);
  assert.ok(out.includes('95%'));
});

test('formatStatusStrip colors a hot gauge via the palette', () => {
  const out = formatStatusStrip(stripBase, 120, { hot: '#ff0000', warn: '#ffff00' });
  assert.ok(out.includes('\u001b[38;2;255;0;0m'), `expected red SGR in: ${JSON.stringify(out)}`);
});

test('formatStatusStrip paints a warn gauge yellow only', () => {
  const warnStrip: StatusStripInput = { ...stripBase, contextPct: 80 };
  const out = formatStatusStrip(warnStrip, 120, { hot: '#ff0000', warn: '#ffff00' });
  assert.ok(out.includes('\u001b[38;2;255;255;0m'), `expected yellow SGR in: ${JSON.stringify(out)}`);
  assert.ok(!out.includes('\u001b[38;2;255;0;0m'));
});

test('formatStatusStrip leaves a normal gauge uncolored', () => {
  const normalStrip: StatusStripInput = { ...stripBase, contextPct: 40 };
  const out = formatStatusStrip(normalStrip, 120, { hot: '#ff0000', warn: '#ffff00' });
  assert.ok(out.includes(GAUGE_FILLED));
  assert.ok(!out.includes('\u001b[38;2;255;0;0m'));
  assert.ok(!out.includes('\u001b[38;2;255;255;0m'));
});

test('formatStatusStrip sheds the gauge before shedding the usage text', () => {
  // As width shrinks the strip drops extras → mode, and the gauge travels with ctx.
  // At the narrowest tier (min) the ctx segment is dropped entirely.
  const wide = formatStatusStrip(stripBase, 200);
  const min = formatStatusStrip(stripBase, 10);
  assert.ok(wide.includes(GAUGE_FILLED));
  assert.ok(!min.includes(GAUGE_FILLED), `min tier still has gauge: ${min}`);
});

test('formatStatusStrip skips the gauge when contextPct is undefined', () => {
  const out = formatStatusStrip({ ...stripBase, contextPct: undefined }, 120);
  assert.ok(!out.includes(GAUGE_FILLED) && !out.includes(GAUGE_EMPTY));
});
