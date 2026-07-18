import { test } from 'node:test';
import assert from 'node:assert/strict';
import { renderBrand, renderToolResult, renderToolChild, renderReasoning, renderToolStack } from '../src/tui/rows.js';
import type { ViewportTheme } from '../src/tui/flatten.js';

// The v2 palette (matches PIN_THEME): dim is the EXPLICIT ADA gray, never a faint attribute.
const T: ViewportTheme = {
  fg: '#ffffff',
  dim: '#b6bcc3',
  green: '#22c55e',
  cyan: '#38bdf8',
  yellow: '#eab308',
  red: '#ef4444',
  purple: '#a78bfa',
};

// Guard the design law: NO row renderer may emit the faint `dim: true` boolean — quiet text must
// carry the explicit gray color. This is the ADA rule made executable.
function assertNoFaint(rows: { text: string; dim?: boolean; color?: string }[][], where: string): void {
  for (const row of rows) {
    for (const span of row) {
      assert.notEqual(span.dim, true, `${where}: span "${span.text}" used the banned faint attribute`);
      // A quiet (non-fg, non-accent) run must be explicitly the dim gray, not undefined.
    }
  }
}

test('renderBrand: ✦ sparkle mark, bright name, dim meta — no bordered card', () => {
  const rows = renderBrand(
    { version: '1.0.0', providerModel: 'openai/LUMIX-35B', workspace: '~/app', help: '/help', yolo: false },
    T,
    80,
  );
  assert.equal(rows.length, 2, 'compact form (no art) → two rows when not yolo');
  assert.equal(rows[0]![0]!.text, '✦ ');
  assert.equal(rows[0]![0]!.color, T.cyan);
  assert.equal(rows[0]![1]!.text, 'shadow');
  assert.equal(rows[0]![1]!.bold, true);
  assert.ok(rows[0]![2]!.text.includes('v1.0.0') && rows[0]![2]!.color === T.dim, 'version in dim gray');
  assert.ok(rows[1]![0]!.text.includes('openai/LUMIX-35B') && rows[1]![0]!.text.includes('~/app'));
  assert.equal(rows[1]![0]!.color, T.dim, 'meta line is the explicit gray');
  assertNoFaint(rows, 'brand');
});

test('renderBrand: yolo adds a yellow warning row (compact, no art)', () => {
  const rows = renderBrand({ version: '1', providerModel: 'p/m', workspace: '/w', help: '/help', yolo: true }, T, 80);
  assert.equal(rows.length, 3);
  assert.ok(rows[2]![0]!.text.includes('yolo') && rows[2]![0]!.color === T.yellow);
});

test('renderBrand: two-column — wordmark left, meta right-aligned to the width', () => {
  const art = ['████', '█  █', '████', '█  █', '████', '████']; // 4-wide, 6 rows
  const rows = renderBrand(
    { version: '1.0.0', providerModel: 'openai/LUMIX-35B', workspace: '~/app', help: '/help · /model', yolo: true, art },
    T,
    60,
  );
  assert.equal(rows.length, 6, 'six rows (art height), meta paired into the first five');
  const row0Text = rows[0]!.map((s) => s.text).join('');
  assert.ok(row0Text.startsWith('████'), 'wordmark hard-left');
  assert.ok(row0Text.includes('✦ ') && row0Text.includes('v1.0.0'), 'version on the right');
  // The meta block is right-positioned: its WIDEST line (the yolo warning) hits the screen edge.
  assert.equal(rows[4]!.map((s) => s.text).join('').length, 60, 'widest meta row spans the full width');
  assert.ok(rows[4]!.some((s) => s.text.includes('yolo') && s.color === T.yellow), 'yolo in the right column');
  // The meta block shares ONE left edge across rows (clean column, not ragged left).
  const metaLeft = (r: number) => rows[r]!.slice(0, 2).reduce((n, s) => n + s.text.length, 0); // art + pad
  assert.equal(metaLeft(0), metaLeft(1), 'meta column left edge is constant');
  assert.equal(metaLeft(0), 60 - Math.max(...['✦ v1.0.0', 'openai/LUMIX-35B', '~/app', '/help · /model', '⚠ yolo — all permission checks disabled'].map((s) => s.length)), 'meta hugs the right edge');
});

test('renderBrand: narrow terminal falls back to the compact ✦ form', () => {
  const art = ['████████████████████████████████████████████████████']; // 52 wide
  const rows = renderBrand({ version: '1', providerModel: 'p/m', workspace: '/w', help: '/h', art }, T, 20);
  assert.equal(rows[0]![1]!.text, 'shadow', 'compact form under a narrow width');
});

test('renderToolResult: a single ⏺ dot carries status by COLOR, name bold, args in parens, dim tail', () => {
  const ok = renderToolResult({ name: 'run_shell', arg: 'npm test', ok: true, durationMs: 10200, summary: '630 pass' }, T);
  assert.equal(ok[0]!.text, '⏺ ', 'single dot, not ✓');
  assert.equal(ok[0]!.color, T.green, 'green = ok (color carries state)');
  assert.equal(ok[1]!.text, 'run_shell');
  assert.equal(ok[1]!.bold, true, 'name is bold');
  assert.ok(ok.some((s) => s.text === '(npm test)'), 'arg in parens, printed once');
  assert.ok(ok.some((s) => s.text === ' — 630 pass'), 'summary');
  assert.ok(ok.some((s) => s.text === ' (10.2s)'), 'elapsed formatted');
  assert.ok(ok.every((s) => s.dim !== true), 'no faint attribute');

  const fail = renderToolResult({ name: 'web_fetch', arg: 'example.com', ok: false, durationMs: 400, summary: '404' }, T);
  assert.equal(fail[0]!.text, '✗ ', 'failure swaps the SHAPE to ✗ — state must survive without color (WCAG 1.4.1)');
  assert.equal(fail[0]!.color, T.red, 'red = error (color reinforces the shape)');
  assert.equal(fail[0]!.bold, true, 'failure glyph is bold');
  assert.ok(fail.some((s) => s.text === ' (0.4s)'));
});

test('renderToolResult: sub-100ms calls omit the (0.0s) noise; minutes format as Xm Ys', () => {
  const fast = renderToolResult({ name: 'read', ok: true, durationMs: 12, summary: '' }, T);
  assert.ok(!fast.some((s) => /\(.*s\)/.test(s.text)), 'no timing under 100ms');
  assert.ok(!fast.some((s) => s.text.includes('—')), 'no summary dash when summary empty');
  const slow = renderToolResult({ name: 'build', ok: true, durationMs: 95_000, summary: 'done' }, T);
  assert.ok(slow.some((s) => s.text === ' (1m 35s)'), 'minute formatting');
});

test('renderToolResult: subagent (agent tool) renders as ▸ type · description, not anonymous agent(…)', () => {
  const r = renderToolResult(
    { name: 'agent', arg: 'Explore the auth module', ok: true, durationMs: 8400, summary: '3 files use the old token helper', agent: { subagentType: 'explore', description: 'Map the auth call sites' } },
    T,
  );
  const text = r.map((s) => s.text).join('');
  assert.equal(r[0]!.text, '⏺ ', 'status dot first');
  assert.equal(r[1]!.text, '▸ ', '▸ delegation marker');
  assert.equal(r[1]!.color, T.cyan);
  assert.equal(r[2]!.text, 'explore');
  assert.equal(r[2]!.bold, true, 'subagent type is bold — it replaces the tool name');
  assert.ok(text.includes(' · Map the auth call sites'), 'caller description shown');
  assert.ok(!text.includes('agent('), 'no anonymous agent(arg) form');
  assert.ok(!text.includes('Explore the auth module'), 'raw prompt arg suppressed when a description exists');
  assert.ok(text.includes(' — 3 files use the old token helper'), 'subagent answer summary still shown');
  assert.ok(text.includes(' (8.4s)'), 'elapsed still shown');
  assert.ok(r.every((s) => s.dim !== true), 'no faint attribute');

  // No description → falls back to the (truncated) prompt arg so the row is never blank.
  const noDesc = renderToolResult(
    { name: 'agent', arg: 'Review the diff for races', ok: true, durationMs: 1000, summary: 'ok', agent: { subagentType: 'reviewer' } },
    T,
  );
  assert.ok(noDesc.some((s) => s.text === 'reviewer'));
  assert.ok(noDesc.some((s) => s.text === ' · Review the diff for races'), 'falls back to the prompt arg when no description');

  // No agent attribution → generic name(arg) form (back-compat for older/odd items).
  const generic = renderToolResult({ name: 'agent', arg: 'do thing', ok: true, durationMs: 12, summary: '' }, T);
  assert.ok(generic.some((s) => s.text === 'agent'), 'generic form keeps the literal tool name');
  assert.ok(generic.some((s) => s.text === '(do thing)'), 'generic form keeps args in parens');
});

test('renderToolStack: collapsed run = ⏺ N tools · ✓a ✗b · (total) · ⌄ ^O', () => {
  const r = renderToolStack({ pos: 0, len: 5, okCount: 4, failCount: 1, totalMs: 12300, collapsed: true }, T);
  const text = r.map((s) => s.text).join('');
  assert.equal(r[0]!.text, '⏺ ', 'status dot');
  assert.equal(r[0]!.color, T.red, 'red as soon as one call failed');
  assert.ok(text.includes('5 tools'), 'run length');
  assert.ok(text.includes('✓4'), 'ok tally');
  assert.ok(text.includes('✗1'), 'fail tally');
  assert.ok(text.includes(' (12.3s)'), 'total elapsed');
  assert.ok(text.includes('⌄ ^O'), 'expand hint when collapsed');
});

test('renderToolStack: all-ok run is green; expanded drops the expand hint', () => {
  const ok = renderToolStack({ pos: 0, len: 3, okCount: 3, failCount: 0, totalMs: 500, collapsed: false }, T);
  assert.equal(ok[0]!.color, T.green, 'green when no failures');
  assert.ok(!ok.some((s) => s.text.includes('⌄ ^O')), 'no expand hint when expanded');
  assert.ok(ok.some((s) => s.text.includes('✓3')), 'ok tally shown');
});

test('renderToolChild: collapsed output/diff — ⌄ glyph, +2 indent, dim, ^O hint', () => {
  const c = renderToolChild('output', 29, T);
  assert.equal(c[0]!.text, '  ⌄ output 29 lines · ^O');
  assert.equal(c[0]!.color, T.dim);
  assert.equal(renderToolChild('diff', 1, T)[0]!.text, '  ⌄ diff 1 line · ^O', 'singular');
});

test('renderReasoning: collapsed = thought-for header + ⌄ N lines · ^O; expanded = header only', () => {
  const collapsed = renderReasoning('a\nb\nc', true, T, 9_000);
  assert.equal(collapsed.length, 2, 'header + fold child');
  assert.equal(collapsed[0]![0]!.text, '∴ ', 'therefore glyph');
  assert.equal(collapsed[0]![0]!.color, T.cyan);
  assert.equal(collapsed[0]![1]!.text, 'thought for 9s', 'duration when known');
  assert.equal(collapsed[0]![1]!.italic, true);
  assert.equal(collapsed[1]![0]!.text, '  ⌄ 3 lines · ^O', 'fold child with line count');
  assert.equal(collapsed[1]![0]!.color, T.dim);
  assertNoFaint(collapsed, 'reasoning/collapsed');

  // No duration → plain "Thinking". Expanded is header-ONLY (body is flattenItem's job).
  const expanded = renderReasoning('line one\nline two', false, T);
  assert.equal(expanded.length, 1, 'expanded returns only the header');
  assert.equal(expanded[0]![0]!.text, '∴ ');
  assert.equal(expanded[0]![1]!.text, 'Thinking');
  assertNoFaint(expanded, 'reasoning/expanded');
});

test('renderBrand compact: an over-wide meta line splits at SEGMENTS, never mid-path', () => {
  const rows = renderBrand(
    { version: '2.6.0', providerModel: 'openai/glm-4.6', workspace: '/Users/someone/very/long/project-path', help: '/help · /model · Shift+Tab mode' },
    T, 40,
  );
  const lines = rows.map((r) => r.map((s) => s.text).join(''));
  // No line exceeds the width by wrapping assumptions; the path appears INTACT on its own row.
  assert.ok(lines.some((l) => l.includes('/Users/someone/very/long/project-path')), 'path is whole on one row');
  assert.ok(lines.some((l) => l.trim() === 'openai/glm-4.6'), 'provider/model is its own row');
});

test('renderReasoning duration: 59.7s rounds into the minute branch, never "60s"', () => {
  const at = (ms: number) => renderReasoning('x', false, T, ms)[0]!.map((s) => s.text).join('');
  assert.ok(at(59_700).includes('1m 0s'), '59.7s → 1m 0s');
  assert.ok(at(59_400).includes('59s'), '59.4s stays seconds');
  assert.ok(at(60_100).includes('1m 0s'), '60.1s → 1m 0s');
  assert.ok(!at(59_700).includes('60s'), 'the impossible "thought for 60s" never renders');
});
