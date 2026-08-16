/**
 * P2-05 TUI correctness batch — regression pins.
 *
 *  F05-04: sanitizeTerminalEscapes — SGR survives (with per-line auto-reset) in keepSgr mode;
 *          cursor/erase/mode CSI, OSC/DCS, two-byte sequences, C0/C1 noise all stripped; the
 *          display scrub for model text strips SGR too.
 *  F05-06: Esc mirrors the stop-teardown for the stream/think refs, so the 30ms coalescing flush
 *          cannot re-paint the tail that Esc just committed (no duplicate flash).
 *  F05-07: ONE width table — markdown table borders measure through util/width.ts (ZWJ emoji and
 *          Ext-B cells align), chart labels/values pad by display columns (no split surrogates),
 *          and flatten's hanging prefix measures display width.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import React from 'react';
import { render } from 'ink-testing-library';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { sanitizeTerminalEscapes, scrubForDisplay } from '../src/util/scrub.js';
import { parseMarkdown, renderTableLines, type MdBlock } from '../src/util/markdown.js';
import { parseChartSpec, renderChart } from '../src/util/chart.js';
import { displayWidth, takeByWidth } from '../src/util/width.js';
import { flattenItem, type FlattenItem, type ViewportTheme } from '../src/tui/flatten.js';
import { TuiApp, type TuiOpts } from '../src/tui.js';
import { EventBus } from '../src/agent/events.js';
import { Context } from '../src/agent/context.js';
import { ToolRegistry } from '../src/tools/registry.js';
import { loadConfig } from '../src/config.js';
import type { Provider } from '../src/provider/provider.js';

// Literal ESC/control bytes are built at runtime (never spelled in this file).
const ESC = String.fromCharCode(27);
const BEL = String.fromCharCode(7);
const CSI = (body: string) => `${ESC}[${body}`;

// ── F05-04: sanitizeTerminalEscapes ──────────────────────────────────────────

test('F05-04: cursor/erase/mode CSI sequences are stripped, text survives', () => {
  assert.equal(sanitizeTerminalEscapes(`${CSI('2J')}hello${CSI('5;10H')}world`, false), 'helloworld');
  assert.equal(sanitizeTerminalEscapes(`${CSI('K')}x${CSI('?25l')}y${CSI('?1049h')}z`, false), 'xyz');
  assert.equal(sanitizeTerminalEscapes(`${CSI('3;1r')}a${CSI('4l')}b`, false), 'ab', 'scroll-region/insert modes stripped');
});

test('F05-04: keepSgr=true keeps color spans and auto-resets per line', () => {
  // SGR kept; a line that carried SGR always ends with a reset so style cannot leak past it.
  assert.equal(sanitizeTerminalEscapes(`${CSI('32m')}green`, true), `${CSI('32m')}green${CSI('0m')}`);
  // Reset lands BEFORE the newline: the next line starts clean.
  assert.equal(
    sanitizeTerminalEscapes(`a${CSI('31m')}red\nnext`, true),
    `a${CSI('31m')}red${CSI('0m')}\nnext`,
  );
  // Already-reset spans still get the line-end reset (harmless, keeps the invariant simple).
  assert.equal(sanitizeTerminalEscapes(`${CSI('1;33m')}w${CSI('0m')}`, true), `${CSI('1;33m')}w${CSI('0m')}${CSI('0m')}`);
});

test('F05-04: keepSgr=false strips SGR too (model text has no legit rendition codes)', () => {
  assert.equal(sanitizeTerminalEscapes(`${CSI('1;33m')}warning${CSI('0m')}`, false), 'warning');
  assert.equal(sanitizeTerminalEscapes(`${CSI('38;5;196m')}x`, false), 'x', '256-color form stripped');
});

test('F05-04: OSC/DCS payloads dropped whole (BEL- and ST-terminated)', () => {
  assert.equal(sanitizeTerminalEscapes(`pre${ESC}]0;evil title${BEL}post`, false), 'prepost');
  assert.equal(sanitizeTerminalEscapes(`a${ESC}]8;;http://x${ESC}\\link${ESC}]8;;${ESC}\\b`, false), 'alinkb');
  assert.equal(sanitizeTerminalEscapes(`x${ESC}Pq stuff${ESC}\\y`, true), 'xy', 'DCS dropped even in keepSgr');
});

test('F05-04: two-byte sequences, truncated tails, C0/C1/DEL noise', () => {
  assert.equal(sanitizeTerminalEscapes(`${ESC}(Btext`, false), 'text', 'charset designator + param byte');
  assert.equal(sanitizeTerminalEscapes(`${ESC}=text`, false), 'text', 'plain two-byte sequence');
  assert.equal(sanitizeTerminalEscapes(`abc${CSI('3')}`, false), 'abc', 'truncated CSI at end of input dropped');
  assert.equal(sanitizeTerminalEscapes(`abc${ESC}`, false), 'abc', 'bare trailing ESC dropped');
  assert.equal(sanitizeTerminalEscapes('a\rb\bc', false), 'abc', 'CR/BS dropped');
  assert.equal(sanitizeTerminalEscapes(`a${BEL}b`, false), 'ab');
  assert.equal(sanitizeTerminalEscapes('a\x7fb', false), 'ab', 'DEL dropped');
  assert.equal(sanitizeTerminalEscapes(`a${String.fromCharCode(0x9d)}b`, false), 'ab', 'C1 dropped');
  assert.equal(sanitizeTerminalEscapes('a\tb\nc', false), 'a\tb\nc', 'tab + newline survive');
  assert.equal(sanitizeTerminalEscapes('a😀b', false), 'a😀b', 'astral text untouched');
});

// Review-defect regression: a PARTIAL CSI mid-string used to set `i = n`, silently swallowing the
// ENTIRE rest of the output (everything after `ESC[3` vanished). It must drop only the partial
// sequence and resume at the offending byte.
test('F05-04: a mid-string partial CSI drops only itself, the tail survives', () => {
  // Offending byte is a newline — the text after it must survive.
  assert.equal(sanitizeTerminalEscapes(`A${CSI('31')}\nBCDEF`, false), 'A\nBCDEF');
  // Offending byte is a fresh ESC — the valid SGR that follows is still honored in keepSgr.
  assert.equal(
    sanitizeTerminalEscapes(`A${CSI('31')}${CSI('32m')}B`, true),
    `A${CSI('32m')}B${CSI('0m')}`,
    'a valid SGR after the partial one still renders',
  );
  // Offending byte is an astral char — it and the text after it survive.
  assert.equal(sanitizeTerminalEscapes(`A${CSI('31')}😀B`, false), 'A😀B');
  // Same class with keepSgr=false.
  assert.equal(sanitizeTerminalEscapes(`A${CSI('31')}\nBCDEF`, true), 'A\nBCDEF');
});

test('F05-04: scrubForDisplay strips every escape from assistant text', () => {
  assert.equal(scrubForDisplay(`${CSI('2J')}hello${CSI('5;10H')} world`), 'hello world');
  assert.equal(scrubForDisplay(`${ESC}]0;t${BEL}plain`), 'plain');
});

// ── F05-06: Esc flush disarm ─────────────────────────────────────────────────

const tick = (ms = 80) => new Promise((r) => setTimeout(r, ms));
const ANSI = new RegExp(ESC + '\\[[0-9;]*m', 'g');
const strip = (s: string | undefined) => (s ?? '').replace(ANSI, '');
async function until(pred: () => boolean, ms = 3000): Promise<boolean> {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (pred()) return true;
    await tick(40);
  }
  return pred();
}

/** Provider that arms at the first await, yields one delta on release, then stalls. */
function gateProvider(tail: string) {
  const gate = {
    waiting: false,
    release: null as null | (() => void),
    stall: null as null | (() => void),
  };
  const provider: Provider = {
    name: 'gate',
    estimateTokens: () => 1,
    async *send(): AsyncIterable<never> {
      gate.waiting = true;
      await new Promise<void>((r) => (gate.release = r));
      yield { type: 'text', delta: tail } as never;
      await new Promise<void>((r) => (gate.stall = r));
      yield { type: 'done', stopReason: 'end_turn' } as never;
    },
  };
  return { gate, provider };
}

function baseOpts(ws: string, provider: Provider): TuiOpts {
  const cfg = loadConfig(ws, { provider: 'mock', model: 'm', resumeRecap: false });
  return {
    provider: provider as unknown as TuiOpts['provider'],
    registry: new ToolRegistry(),
    bus: new EventBus(),
    context: new Context({ contextBudget: cfg.contextBudget, triggerRatio: cfg.summarizeTriggerRatio, keepLastTurns: cfg.keepLastTurns }),
    sessionLog: { record() {}, recordSnapshot() {}, path: undefined } as unknown as TuiOpts['sessionLog'],
    system: 'test',
    cfg,
    autonomy: 'manual',
    bypass: false,
    version: '0.0.0',
    workspaceRoot: ws,
  };
}

test('F05-06: Esc within the 30ms flush window commits the tail exactly once', async () => {
  const ws = mkdtempSync(join(tmpdir(), 'p2-05-esc-'));
  const TAIL = 'UNIQUETAIL-zx9';
  const { gate, provider } = gateProvider(TAIL);
  try {
    const { stdin, lastFrame, unmount } = render(React.createElement(TuiApp, { opts: baseOpts(ws, provider) }));
    try {
      await tick();
      stdin.write('go');
      await tick();
      stdin.write('\r');
      const deadline = Date.now() + 3000;
      while (!gate.waiting && Date.now() < deadline) await tick(5);
      assert.ok(gate.waiting, 'the provider reached its armed await');
      gate.release!();
      await tick(1); // delta lands in the buffer and arms the 30ms coalescing flush
      stdin.write(ESC); // Esc interrupts INSIDE the flush window
      assert.ok(await until(() => strip(lastFrame() ?? '').includes('interrupted')), 'the interrupt notice rendered');
      gate.stall!(); // let the aborted generator complete
      await tick(120); // well past 30ms: a still-armed flush would have re-painted by now
      const frame = strip(lastFrame() ?? '');
      const n = frame.split(TAIL).length - 1;
      assert.equal(n, 1, `the committed tail appears exactly once (got ${n})`);
    } finally {
      gate.release?.();
      gate.stall?.();
      unmount();
    }
  } finally {
    rmSync(ws, { recursive: true, force: true });
  }
});

// ── F05-07: one width table ──────────────────────────────────────────────────

const FAMILY = String.fromCodePoint(0x1f468, 0x200d, 0x1f469, 0x200d, 0x1f467); // 👨‍👩‍👧 ZWJ run
const EXT_B = String.fromCodePoint(0x20000); // CJK Ext-B ideograph (2 columns, surrogate pair)
const TAILANG = String.fromCodePoint(0x592a, 0x90ce); // 太郎

function hasLoneSurrogate(s: string): boolean {
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c >= 0xd800 && c <= 0xdbff) {
      const next = s.charCodeAt(i + 1);
      if (!(next >= 0xdc00 && next <= 0xdfff)) return true;
      i++;
    } else if (c >= 0xdc00 && c <= 0xdfff) {
      return true;
    }
  }
  return false;
}

test('F05-07: the ZWJ family measures as one 2-column cluster', () => {
  assert.equal(displayWidth(FAMILY), 2);
  assert.equal(displayWidth(EXT_B), 2);
});

// Review-defect regression: the width-table SGR strip used `[0-9;]` only, but
// sanitizeTerminalEscapes(keepSgr=true) preserves the FULL 0x20-0x3f parameter range — including
// colon subparameters (truecolor `38:2::…`, underline `4:3m`). A narrower strip measured those
// escapes as visible text, so styled rows wrapped/truncated early. The strip must match keepSgr's
// grammar exactly.
test('F05-07: colon-subparameter SGR measures as zero width (matches keepSgr grammar)', () => {
  const truecolor = `${ESC}[38:2::255:0:0mX`; // truecolor with empty channels
  assert.equal(displayWidth(truecolor), 1, 'truecolor SGR occupies no columns');
  assert.equal(displayWidth(`${ESC}[4:3mX${ESC}[4:0m`), 1, 'curly-underline SGR occupies no columns');
  const t = takeByWidth(truecolor, 1);
  assert.equal(t.head, 'X', 'takeByWidth does not split mid-escape');
  assert.equal(t.rest, '', 'nothing left after the single visible char');
  assert.ok(!hasLoneSurrogate(t.head) && !hasLoneSurrogate(t.rest));
  // Classic digit/semicolon SGR still strips (no regression from widening the grammar).
  assert.equal(displayWidth(`${ESC}[31mhi${ESC}[0m`), 2);
});

test('F05-07: markdown table rows align under ONE width table (ZWJ + CJK + Ext-B cells)', () => {
  const src = [
    '| status | name |',
    '| --- | --- |',
    `| ${FAMILY} | ${TAILANG} |`,
    `| ok | ${EXT_B} |`,
  ].join('\n');
  const table = parseMarkdown(src).find((b): b is Extract<MdBlock, { type: 'table' }> => b.type === 'table');
  assert.ok(table, 'the table parsed');
  const lines = renderTableLines(table);
  assert.ok(lines.length >= 5);
  const widths = new Set(lines.map((l) => displayWidth(l)));
  assert.equal(widths.size, 1, `every row (borders included) has ONE display width — got ${[...widths].join(', ')}`);
  assert.ok(!lines.some(hasLoneSurrogate), 'no split surrogate pairs in any row');
});

test('F05-07: chart label/value columns pad by display width, truncation never splits a pair', () => {
  // One label longer than the 24-col cap, built from wide chars, forces the truncate path.
  const longCjk = TAILANG.repeat(13); // 26 display columns > 24
  const spec = parseChartSpec(['type: bar', `${FAMILY}region: 1240`, `${longCjk}: 890`, 'us-east: 431'].join('\n'));
  assert.ok(spec, 'the bar spec parsed');
  const rows = renderChart(spec!, 60);
  const labels = rows.map((r) => r.find((s) => s.role === 'label')).filter((s) => s !== undefined);
  assert.ok(labels.length >= 3);
  const ws = new Set(labels!.map((s) => displayWidth(s!.text)));
  assert.equal(ws.size, 1, `label column ragged-right on DISPLAY width (got ${[...ws].join(', ')})`);
  const all = rows.map((r) => r.map((s) => s.text).join('')).join('\n');
  assert.ok(!hasLoneSurrogate(all), 'no lone surrogates — the old .slice truncation split pairs');
});

test('F05-07: flatten hanging prefix keeps wrapped rows aligned (display-width measured)', () => {
  const theme: ViewportTheme = {
    fg: '#ffffff', dim: '#888888', green: '#00ff00', cyan: '#00ffff',
    yellow: '#ffff00', red: '#ff0000', purple: '#ff00ff',
  };
  const item: FlattenItem = {
    id: 1,
    kind: 'user',
    text: `❯ ${'word '.repeat(40).trim()}`, // wraps several rows at 40 cols
  };
  const lines = flattenItem(item, 40, false, theme);
  const rows = lines.map((l) => l.spans.map((s) => s.text).join('')).filter((t) => t !== '');
  assert.ok(rows.length > 1, 'the prompt wrapped');
  for (const text of rows) {
    assert.ok(text.startsWith(String.fromCodePoint(0x258c) + ' '), `every row carries the gutter bar: ${JSON.stringify(text.slice(0, 4))}`);
    assert.ok(displayWidth(text) <= 40, `row fits the budget (${displayWidth(text)} cols)`);
  }
});
