/**
 * P2-08 session & display UX batch — regression pins.
 *
 *  F02-05: themeDetect — TERM=dumb classification, OSC 11 reply parsing, luminance threshold,
 *          and the bounded background query (fake streams, no real terminal involved).
 *  F02-06: paste registry bounds (prunePastes / dropConsumedPastes) and the shared-fence rule
 *          accepting `~~~` in clampTail / clampLiveRest.
 *  F02-04: TUI — /sessions inventory; bare /resume opens the picker with >1 candidate and still
 *          auto-picks the only candidate when there is exactly one.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import React from 'react';
import { render } from 'ink-testing-library';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  isDumbTerm,
  parseOsc11Reply,
  bgLuminance,
  themeForBackground,
  LIGHT_BG_THRESHOLD,
  OSC11_QUERY,
  queryTerminalBackground,
  type QueryStdinLike,
} from '../src/util/themeDetect.js';
import { prunePastes, dropConsumedPastes, pasteChipReferenced, PASTE_CAP } from '../src/tui/composer.js';
import { clampTail, clampLiveRest } from '../src/tui/streamCommit.js';
import { TuiApp, type TuiOpts } from '../src/tui.js';
import { EventBus } from '../src/agent/events.js';
import { Context } from '../src/agent/context.js';
import { ToolRegistry } from '../src/tools/registry.js';
import { loadConfig } from '../src/config.js';
import { SessionLog } from '../src/state/session.js';
import type { Provider } from '../src/provider/provider.js';

// ── F02-05: TERM=dumb classification ─────────────────────────────────────────

test('isDumbTerm: only TERM=dumb (trimmed, case-insensitive) qualifies', () => {
  assert.equal(isDumbTerm({ TERM: 'dumb' }), true);
  assert.equal(isDumbTerm({ TERM: ' dumb ' }), true, 'whitespace trimmed');
  assert.equal(isDumbTerm({ TERM: 'DUMB' }), true, 'case-insensitive');
  assert.equal(isDumbTerm({ TERM: 'xterm-256color' }), false);
  assert.equal(isDumbTerm({ TERM: '' }), false);
  assert.equal(isDumbTerm({}), false, 'no TERM at all is not dumb');
});

// ── F02-05: OSC 11 reply parsing ─────────────────────────────────────────────

test('parseOsc11Reply: BEL- and ST-terminated replies, 4- and 2-digit channels', () => {
  // The canonical 4-digit-per-channel form, BEL-terminated.
  assert.deepEqual(parseOsc11Reply('\x1b]11;rgb:0000/0000/0000\x07'), { r: 0, g: 0, b: 0 });
  assert.deepEqual(parseOsc11Reply('\x1b]11;rgb:ffff/ffff/ffff\x07'), { r: 1, g: 1, b: 1 });
  // ST-terminated (ESC \) — several terminals prefer it.
  assert.deepEqual(parseOsc11Reply('\x1b]11;rgb:ffff/ffff/ffff\x1b\\'), { r: 1, g: 1, b: 1 });
  // 2-digit channels normalize against their OWN width (ff = full, not 0x00ff/65535).
  const two = parseOsc11Reply('\x1b]11;rgb:ff/80/00\x07');
  assert.ok(two);
  assert.equal(two!.r, 1);
  assert.ok(Math.abs(two!.g - 128 / 255) < 1e-9);
  assert.equal(two!.b, 0);
});

test('parseOsc11Reply: tmux DCS-wrapped replies and embedded replies still parse', () => {
  // tmux passthrough re-wraps the reply in a DCS envelope (with doubled ESCs) — the parser scans
  // for the marker anywhere, so the envelope is irrelevant.
  const wrapped = '\x1bPtmux;\x1b\x1b]11;rgb:1234/5678/9abc\x1b\\\x1b\\';
  const bg = parseOsc11Reply(wrapped);
  assert.ok(bg);
  assert.ok(Math.abs(bg!.r - 0x1234 / 65535) < 1e-9);
  assert.ok(Math.abs(bg!.g - 0x5678 / 65535) < 1e-9);
  assert.ok(Math.abs(bg!.b - 0x9abc / 65535) < 1e-9);
});

test('parseOsc11Reply: garbage, truncation, and foreign OSCs return null', () => {
  assert.equal(parseOsc11Reply(''), null);
  assert.equal(parseOsc11Reply('hello world'), null);
  assert.equal(parseOsc11Reply('\x1b]11;rgb:12/34\x07'), null, 'truncated to two channels');
  assert.equal(parseOsc11Reply('\x1b]11;rgb:zzzz/0000/0000\x07'), null, 'non-hex channel');
  assert.equal(parseOsc11Reply('\x1b]10;rgb:ffff/ffff/ffff\x07'), null, 'OSC 10 (foreground) is not a bg reply');
});

// ── F02-05: luminance → theme ────────────────────────────────────────────────

test('bgLuminance + themeForBackground: WCAG luminance against the 0.4 threshold', () => {
  assert.equal(bgLuminance({ r: 0, g: 0, b: 0 }), 0);
  assert.ok(Math.abs(bgLuminance({ r: 1, g: 1, b: 1 }) - 1) < 1e-9);
  // Middle gray is well below the threshold — the default dark palettes fit it.
  const mid = bgLuminance({ r: 0.5, g: 0.5, b: 0.5 });
  assert.ok(mid > 0.2 && mid < 0.25, `middle gray ≈ 0.214 (got ${mid})`);
  assert.equal(LIGHT_BG_THRESHOLD, 0.4);
  assert.equal(themeForBackground({ r: 1, g: 1, b: 1 }), 'light');
  assert.equal(themeForBackground({ r: 0.9333, g: 0.9333, b: 0.9333 }), 'light', '#eeeeee is light');
  assert.equal(themeForBackground({ r: 0, g: 0, b: 0 }), 'og');
  assert.equal(themeForBackground({ r: 0.5, g: 0.5, b: 0.5 }), 'og', 'middle gray stays dark-themed');
});

// ── F02-05: the bounded background query (fake streams) ──────────────────────

class FakeStdin extends EventEmitter {
  isTTY = true;
  rawModes: boolean[] = [];
  resumed = 0;
  paused = 0;
  setRawMode(m: boolean): void {
    this.rawModes.push(m);
  }
  resume(): void {
    this.resumed++;
  }
  pause(): void {
    this.paused++;
  }
}
class FakeStdout {
  writes: string[] = [];
  write(s: string): boolean {
    this.writes.push(s);
    return true;
  }
}
const fakeOpts = (stdin: FakeStdin, stdout: FakeStdout, extra: Record<string, string> = {}) => ({
  env: { ...extra } as NodeJS.ProcessEnv, // explicit env: the NODE_ENV=test skip must not fire here
  stdin: stdin as unknown as QueryStdinLike,
  stdout,
  isTTY: true,
});

test('queryTerminalBackground: a reply resolves the parsed background and restores raw mode', async () => {
  const stdin = new FakeStdin();
  const stdout = new FakeStdout();
  const p = queryTerminalBackground({ ...fakeOpts(stdin, stdout), timeoutMs: 500 });
  setImmediate(() => stdin.emit('data', Buffer.from('\x1b]11;rgb:ffff/ffff/ffff\x07')));
  const bg = await p;
  assert.deepEqual(bg, { r: 1, g: 1, b: 1 });
  assert.deepEqual(stdout.writes, [OSC11_QUERY], 'exactly one OSC 11 query went out');
  assert.deepEqual(stdin.rawModes, [true, false], 'raw mode set then restored');
});

test('queryTerminalBackground: silence resolves null after the bounded wait', async () => {
  const stdin = new FakeStdin();
  const stdout = new FakeStdout();
  const started = process.hrtime.bigint();
  const bg = await queryTerminalBackground({ ...fakeOpts(stdin, stdout), timeoutMs: 30 });
  const ms = Number(process.hrtime.bigint() - started) / 1e6;
  assert.equal(bg, null);
  assert.ok(ms < 1000, `resolved promptly (took ${ms.toFixed(1)}ms)`);
  assert.deepEqual(stdin.rawModes, [true, false], 'raw mode restored even on timeout');
});

test('queryTerminalBackground: opt-out, non-TTY, and garbage-flood all resolve null', async () => {
  // SHADOW_NO_THEME_DETECT=1 — the documented opt-out. It must not even write the query.
  const so = new FakeStdin();
  const soOut = new FakeStdout();
  assert.equal(await queryTerminalBackground({ ...fakeOpts(so, soOut, { SHADOW_NO_THEME_DETECT: '1' }), timeoutMs: 30 }), null);
  assert.deepEqual(soOut.writes, [], 'no query on opt-out');
  assert.deepEqual(so.rawModes, [], 'raw mode untouched on opt-out');
  // Not a TTY — piped/redirected stdout.
  assert.equal(await queryTerminalBackground({ ...fakeOpts(new FakeStdin(), new FakeStdout()), isTTY: false, timeoutMs: 30 }), null);
  // Garbage in (>512 unparseable bytes) — gives up instead of holding raw mode for the window.
  const gs = new FakeStdin();
  const gp = queryTerminalBackground({ ...fakeOpts(gs, new FakeStdout()), timeoutMs: 500 });
  setImmediate(() => gs.emit('data', 'x'.repeat(600)));
  assert.equal(await gp, null);
  assert.deepEqual(gs.rawModes, [true, false], 'raw mode restored after garbage');
});

// ── F02-06: paste registry bounds ────────────────────────────────────────────

const chip = (id: number, lines = 3) => `[Pasted text #${id} +${lines} lines]`;

test('prunePastes: at/below cap returns the registry untouched; above it keeps only referenced entries', () => {
  const three = [{ id: 1, content: 'a' }, { id: 2, content: 'b' }, { id: 3, content: 'c' }];
  assert.equal(prunePastes(three, [], 3), three, 'at cap: same array, no scan');
  assert.equal(prunePastes(three, ['whatever'], 8), three, 'below cap: same array');
  assert.equal(PASTE_CAP, 64, 'the shipped cap');
  const five = [1, 2, 3, 4, 5].map((id) => ({ id, content: `c${id}` }));
  // Over cap 3: only entries whose chip is still referenced survive.
  assert.deepEqual(
    prunePastes(five, [`before ${chip(2)} after`, chip(4)], 3).map((p) => p.id),
    [2, 4],
  );
  // Everything referenced → soft cap keeps ALL of them (content is owed at submit).
  assert.deepEqual(
    prunePastes(five, [chip(1), chip(2), chip(3), chip(4), chip(5)], 3).map((p) => p.id),
    [1, 2, 3, 4, 5],
  );
  // Nothing referenced → the whole unreferenced tail goes.
  assert.deepEqual(prunePastes(five, ['no chips here'], 3), []);
});

test('dropConsumedPastes: submitted chips leave the registry; chip-free submits change nothing', () => {
  const pastes = [1, 2, 3].map((id) => ({ id, content: `c${id}` }));
  const submitted = `look: ${chip(1)} and ${chip(3)}`;
  assert.deepEqual(dropConsumedPastes(pastes, submitted).map((p) => p.id), [2]);
  assert.equal(dropConsumedPastes(pastes, 'plain text, no chips'), pastes, 'same array when nothing consumed');
});

test('pasteChipReferenced: matches by id across any of the texts', () => {
  assert.equal(pasteChipReferenced(7, '', `x ${chip(7)} y`), true);
  assert.equal(pasteChipReferenced(7, chip(17)), false, 'id 17 is not id 7');
  assert.equal(pasteChipReferenced(7), false, 'no texts → unreferenced');
});

// ── F02-06: ~~~ fences in the shared clamp rule (regression pin) ─────────────

test('clampTail: re-opens a scrolled-off ~~~ fence with its original marker, width, and lang', () => {
  const src = ['~~~python', 'l1', 'l2', 'l3', 'l4'].join('\n');
  // Keep the last 2 lines: the opener scrolled off, so the tail must be re-opened.
  assert.equal(clampTail(src, 2), ['~~~python', 'l3', 'l4'].join('\n'));
  // Width-correct: a 4-tilde fence is NOT closed by a 3-tilde line inside it.
  const wide = ['~~~~text', '~~~', 'bodyA', 'bodyB'].join('\n');
  assert.equal(clampTail(wide, 2), ['~~~~text', 'bodyA', 'bodyB'].join('\n'));
  // A CLOSED tilde fence entirely in the dropped head does not re-open.
  const closed = ['~~~', 'x', '~~~', 'tail1', 'tail2'].join('\n');
  assert.equal(clampTail(closed, 2), ['tail1', 'tail2'].join('\n'));
});

test('clampLiveRest: force-committing a ~~~ fence closes the head and re-opens the tail', () => {
  const rest = ['~~~py', 'l1', 'l2', 'l3', 'l4', 'l5'].join('\n') + '\n';
  const { commit, rest: kept } = clampLiveRest(rest, 10);
  assert.ok(commit, 'over-cap: something committed');
  assert.ok(commit!.endsWith('\n~~~'), `committed head closed with a synthetic ~~~ (got ${JSON.stringify(commit)})`);
  assert.ok(kept.startsWith('~~~py\n'), `retained tail re-opened with the original marker+lang (got ${JSON.stringify(kept.slice(0, 12))})`);
  // Under cap: untouched.
  assert.deepEqual(clampLiveRest('~~~py\nok\n', 1024), { commit: null, rest: '~~~py\nok\n' });
});

// ── F02-04: /sessions inventory + explicit bare /resume (TUI level) ──────────

const tick = (ms = 80) => new Promise((r) => setTimeout(r, ms));
const ANSI = new RegExp(String.fromCharCode(27) + '\\[[0-9;]*m', 'g');
const strip = (s: string | undefined) => (s ?? '').replace(ANSI, '');
async function until(pred: () => boolean, ms = 3000): Promise<boolean> {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (pred()) return true;
    await tick(40);
  }
  return pred();
}

/** Seed one resumable session (enough messages + a snapshot) and return its id. */
function seedSession(ws: string): string {
  const log = SessionLog.open(ws);
  const ctx = new Context({ contextBudget: 100000, triggerRatio: 0.9, keepLastTurns: 4 });
  ctx.pinTask({ role: 'user', content: [{ type: 'text', text: 'Task for the seeded session' }] });
  for (let i = 0; i < 3; i++) {
    ctx.append({ role: 'assistant', content: [{ type: 'text', text: `did step ${i}` }] });
    ctx.append({ role: 'user', content: [{ type: 'text', text: `now step ${i + 1}` }] });
  }
  log.recordSnapshot(ctx, 0);
  return SessionLog.sessionIdFromPath(log.path);
}

const noopProvider: Provider = {
  name: 'noop',
  estimateTokens: () => 1,
  async *send(): AsyncIterable<never> {
    yield { type: 'done', stopReason: 'end_turn' } as never;
  },
};

function baseOpts(ws: string): TuiOpts {
  const cfg = loadConfig(ws, { provider: 'mock', model: 'm', resumeRecap: false });
  return {
    provider: noopProvider as unknown as TuiOpts['provider'],
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

test('/sessions lists every resumable session in the workspace (F02-04)', async () => {
  const ws = mkdtempSync(join(tmpdir(), 'p2-08-sessions-'));
  try {
    const id1 = seedSession(ws);
    await tick(10); // session filenames are ms-stamped — keep them distinct
    const id2 = seedSession(ws);
    const { stdin, lastFrame, unmount } = render(React.createElement(TuiApp, { opts: baseOpts(ws) }));
    try {
      await tick();
      stdin.write('/sessions');
      await tick();
      stdin.write('\r');
      assert.ok(await until(() => strip(lastFrame() ?? '').includes(id1) && strip(lastFrame() ?? '').includes(id2)), 'both session ids listed');
      const frame = strip(lastFrame() ?? '');
      assert.match(frame, /Resumable sessions \(2\)/, 'the inventory header carries the count');
      assert.match(frame, /\/resume <id> to load one/, 'points at the loader');
    } finally {
      unmount();
    }
  } finally {
    rmSync(ws, { recursive: true, force: true });
  }
});

test('bare /resume with several candidates opens the picker instead of auto-picking (F02-04)', async () => {
  const ws = mkdtempSync(join(tmpdir(), 'p2-08-resume-multi-'));
  try {
    seedSession(ws);
    await tick(10);
    seedSession(ws);
    const { stdin, lastFrame, unmount } = render(React.createElement(TuiApp, { opts: baseOpts(ws) }));
    try {
      await tick();
      stdin.write('/resume');
      await tick();
      stdin.write('\r');
      assert.ok(await until(() => /resumable sessions — pick one below/.test(strip(lastFrame() ?? '')), 3000), 'the explicit-pick hint appears');
      const frame = strip(lastFrame() ?? '');
      assert.doesNotMatch(frame, /Resumed /, 'nothing was silently auto-resumed');
      assert.match(frame, /Esc closes the menu/, 'the hint says how to back out');
    } finally {
      unmount();
    }
  } finally {
    rmSync(ws, { recursive: true, force: true });
  }
});

test('bare /resume with exactly one candidate still resumes it directly (F02-04 keeps the fast path)', async () => {
  const ws = mkdtempSync(join(tmpdir(), 'p2-08-resume-one-'));
  try {
    const id = seedSession(ws);
    const { stdin, lastFrame, unmount } = render(React.createElement(TuiApp, { opts: baseOpts(ws) }));
    try {
      await tick();
      stdin.write('/resume');
      await tick();
      stdin.write('\r');
      assert.ok(await until(() => strip(lastFrame() ?? '').includes(`Resumed ${id}`), 3000), 'the only session resumed');
    } finally {
      unmount();
    }
  } finally {
    rmSync(ws, { recursive: true, force: true });
  }
});
