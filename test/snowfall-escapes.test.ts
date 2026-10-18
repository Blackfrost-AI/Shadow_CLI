/**
 * F11 / F12 regression: untrusted escapes must never reach the terminal from Snowfall's live
 * channels, and the retained live remainder must be bounded.
 *
 * The defect this pins (research/shadow-cli-review.md, F11): Snowfall's ingest points pushed
 * model- and tool-authored bytes straight into FlattenItems, and every cell render path funnels
 * through `flattenItem` → `lineToAnsi`/`spanToAnsi` into the real terminal. Nothing in `src/app`
 * scrubbed, so a fetched page, README, log line or shell body could:
 *   - forge Shadow's own styling (SGR), or hide text with `CSI 8m` conceal — invisible on screen
 *     while intact in scrollback and in any captured transcript,
 *   - issue OSC 52 (clipboard write), OSC 8 (hyperlink to an attacker URL), or cursor/erase CSI
 *     that corrupts the transcript region or repositions the cursor outside the app's own cells.
 *
 * Two properties are asserted, deliberately at different levels:
 *   1. `sanitizeTerminalEscapes` unit-level: conceal is dropped even when rendition is kept, and
 *      truecolor (`38;2;…` / `48;5;…`) is NOT mistaken for conceal. This is the classifier the
 *      whole fix rests on, so it is tested directly rather than only through the renderer.
 *   2. End-to-end through a real ShadowApp on a real terminal emulator: after a turn carrying
 *      hostile bytes, no escape the app did not emit itself appears in the rendered screen, and
 *      Shadow's own styling still works (the fix must not break legitimate SGR).
 *
 * F12 is pinned by the clamp: a never-closing construct must not grow the retained live remainder
 * without bound, and the text must be relocated to scrollback rather than dropped.
 */
import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { isolateHome, assertStoreIsolated } from './helpers/isolateHome.js';
import { HeadlessTerminal } from './helpers/snowfallTerminal.js';

const isolated = isolateHome('snowfall-escapes');
const previousSessionDir = process.env.SHADOW_SESSION_DIR;
delete process.env.SHADOW_SESSION_DIR;
const { loadConfig } = await import('../src/config.js');
const { Context } = await import('../src/agent/context.js');
const { EventBus } = await import('../src/agent/events.js');
const { ToolRegistry } = await import('../src/tools/registry.js');
const { SessionLog } = await import('../src/state/session.js');
const { GLOBAL_DIR } = await import('../src/state/globalStore.js');
const { ShadowApp } = await import('../src/app/app.js');
const { sanitizeTerminalEscapes, scrubForDisplay } = await import('../src/util/scrub.js');
const { clampLiveRest, MAX_LIVE_REST_BYTES } = await import('../src/tui/streamCommit.js');

assertStoreIsolated(GLOBAL_DIR, isolated.home);
after(() => {
  if (previousSessionDir === undefined) delete process.env.SHADOW_SESSION_DIR;
  else process.env.SHADOW_SESSION_DIR = previousSessionDir;
  rmSync(isolated.home, { recursive: true, force: true });
});

const ESC = '\u001b';
const pause = (ms = 40) => new Promise<void>((resolve) => setTimeout(resolve, ms));
async function until(predicate: () => boolean, label: string): Promise<void> {
  const deadline = Date.now() + 5000;
  while (!predicate() && Date.now() < deadline) await pause();
  assert.ok(predicate(), label);
}

/**
 * True when any SGR in `text` sets conceal (param 8) as a standalone attribute. Extended-color
 * arguments (`38;5;8`, `48;2;…`) are skipped, so a palette index of 8 is not a false positive.
 */
function hasConceal(text: string): boolean {
  for (const m of text.matchAll(/\u001b\[([0-9;:]*)m/g)) {
    const ps = m[1].split(/[;:]/);
    for (let k = 0; k < ps.length; k++) {
      const p = ps[k];
      if (p === '38' || p === '48' || p === '58') {
        k += ps[k + 1] === '5' ? 2 : ps[k + 1] === '2' ? 4 : 0;
        continue;
      }
      if (p === '8') return true;
    }
  }
  return false;
}

/** Raw VT stream: `lines()` is plain text (xterm translateToString), so escapes are only visible here. */
const rawStream = (terminal: { writes: string[] }): string => terminal.writes.join('');

/** Cells of the first on-buffer occurrence of `needle` (scrollback included). */
function cellsOf(terminal: InstanceType<typeof HeadlessTerminal>, needle: string) {
  const buf = terminal.screen.buffer.active;
  for (let y = 0; y < buf.length; y++) {
    const line = buf.getLine(y);
    if (!line) continue;
    const x = line.translateToString(true).indexOf(needle);
    if (x < 0) continue;
    const cells = [];
    for (let i = 0; i < needle.length; i++) {
      const c = line.getCell(x + i);
      if (c) cells.push(c);
    }
    return cells;
  }
  return null;
}

/** Hostile signatures Shadow's own renderer never emits (calibrated: research/probes/engine-escapes.txt). */
function hostileSignatures(raw: string): string[] {
  const found: string[] = [];
  if (raw.includes(`${ESC}]52;`)) found.push('OSC 52 clipboard write');
  if (/\u001b\]8;[^\u0007\u001b]*evil\.example/.test(raw)) found.push('OSC 8 link to attacker URL');
  if (hasConceal(raw)) found.push('CSI conceal');
  return found;
}

const HOSTILE = {
  /** Forged rendition: Shadow's own red error styling. */
  forgedColor: `${ESC}[31mFAKE-ERROR${ESC}[0m`,
  /** Invisible on screen, present in scrollback and in any captured transcript. */
  conceal: `${ESC}[8mHIDDEN-PAYLOAD${ESC}[28m`,
  /** Clipboard write — exfiltration the operator never sees. */
  osc52: `${ESC}]52;c;c2VjcmV0${ESC}\\`,
  /** Hyperlink to an attacker-controlled URL. */
  osc8: `${ESC}]8;;https://evil.example/x${ESC}\\CLICK-ME${ESC}]8;;${ESC}\\`,
  /** Cursor/erase CSI: corrupts the transcript region or repositions the cursor. */
  erase: `${ESC}[2J${ESC}[1;1HOVERWRITE`,
};

function hostileBlob(): string {
  return [
    'F11 payload follows.',
    HOSTILE.forgedColor,
    HOSTILE.conceal,
    HOSTILE.osc52,
    HOSTILE.osc8,
    HOSTILE.erase,
    'End of payload.',
  ].join('\n');
}

// --------------------------------------------------------------------------------------
// 1. Classifier unit level — the property the whole fix rests on.
// --------------------------------------------------------------------------------------

test('sanitizeTerminalEscapes drops CSI conceal even when rendition is kept', () => {
  // The escape hatch that matters: tool output legitimately keeps SGR, but conceal must not ride
  // along. Without the exclusion, `keepSgr` would preserve `ESC[8m` and hide text from the operator.
  const concealed = `${ESC}[8mSECRET${ESC}[28m`;
  const kept = sanitizeTerminalEscapes(concealed, true);
  assert.ok(!hasConceal(kept), `conceal must not survive keepSgr: ${JSON.stringify(kept)}`);
  assert.ok(kept.includes('SECRET'), 'the concealed text itself is kept (revealed)');
  // Strict pass removes every escape byte.
  assert.equal(sanitizeTerminalEscapes(concealed, false), 'SECRET');

  for (const params of ['08', '028', '1;08', '08;31']) {
    const padded = sanitizeTerminalEscapes(`${ESC}[${params}mSECRET${ESC}[0m`, true);
    assert.ok(
      !padded.includes(`${ESC}[${params}m`),
      `zero-padded conceal sequence must be removed: ${params}`,
    );
    assert.ok(padded.includes('SECRET'));
  }
});

test('sanitizeTerminalEscapes does not mistake truecolor for conceal', () => {
  // `38;2;…` and `48;5;…` contain an 8 but are color parameters, not conceal. A substring test
  // would break every truecolor tool output; the classifier splits on the parameter separator.
  for (const params of ['38;2;255;0;0', '48;5;196', '1;38;5;9', '38;5;8', '48;2;8;28;0']) {
    const seq = `${ESC}[${params}mX${ESC}[0m`;
    // keepSgr appends a closing reset (closeSgr), so assert the prefix rather than equality.
    const out = sanitizeTerminalEscapes(seq, true);
    assert.ok(out.startsWith(`${ESC}[${params}mX`), `truecolor ${params} must be preserved: ${JSON.stringify(out)}`);
    assert.ok(!hasConceal(out), `${params} is not conceal`);
  }
  // And the strict pass still removes all of it.
  assert.equal(sanitizeTerminalEscapes(`${ESC}[38;2;255;0;0mX`, false), 'X');

  // A real conceal attribute after a complete extended-color form is still rejected.
  const mixed = sanitizeTerminalEscapes(`${ESC}[38;5;8;8mSECRET${ESC}[0m`, true);
  assert.ok(!hasConceal(mixed), `conceal after an indexed color must be removed: ${JSON.stringify(mixed)}`);
  assert.ok(mixed.includes('SECRET'));
});

test('sanitizeTerminalEscapes preserves normal rendition and strips everything else', () => {
  const styled = `${ESC}[1m${ESC}[31mBOLD-RED${ESC}[0m`;
  assert.ok(sanitizeTerminalEscapes(styled, true).startsWith(styled), 'bold/color are legitimate rendition');

  const hostile = `${ESC}]52;c;c2VjcmV0${ESC}\\${ESC}[2J${ESC}[1;1H${ESC}]8;;https://evil.example${ESC}\\`;
  const out = sanitizeTerminalEscapes(hostile, true);
  assert.ok(!out.includes(ESC), 'OSC and cursor/erase CSI are never rendition');
  // An OSC 8 URL lives inside the escape's parameters, so it is dropped with the escape.
  assert.ok(!out.includes('evil.example'), 'a hidden link target never survives as a live escape');
});

// --------------------------------------------------------------------------------------
// 2. End-to-end through the real renderer.
// --------------------------------------------------------------------------------------

test('Snowfall never renders untrusted escapes from the live answer channel', async (t) => {
  const root = mkdtempSync(join(tmpdir(), 'shadow-escapes-live-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const provider = {
    name: 'mock',
    estimateTokens: () => 20,
    async *send(): AsyncIterable<{ type: string; delta?: string; stopReason?: string }> {
      // Streamed in slices so the payload crosses the commit-unit boundary — the live remainder
      // path (pendingStream → StreamCell) is exercised, not just the committed path.
      yield { type: 'text', delta: 'F11 payload follows.\n' };
      yield { type: 'text', delta: `${HOSTILE.forgedColor}\n${HOSTILE.conceal}\n` };
      yield { type: 'text', delta: `${HOSTILE.osc52}${HOSTILE.osc8}${HOSTILE.erase}\n` };
      yield { type: 'text', delta: 'End of payload.' };
      yield { type: 'done', stopReason: 'end_turn' };
    },
  };
  const cfg = loadConfig(root, {
    provider: 'mock', model: 'fixture', reducedMotion: true, notify: 'off',
    instructionAutopilot: false,
  });
  const log = SessionLog.open(root);
  const terminal = new HeadlessTerminal(120, 40);
  const app = new ShadowApp({
    provider: provider as never, cfg, bus: new EventBus(), registry: new ToolRegistry(), sessionLog: log,
    context: new Context({ contextBudget: 32768, triggerRatio: 0.8, keepLastTurns: 4 }),
    system: 'Escape test.', workspaceRoot: root, autonomy: 'manual', bypass: false,
    offline: true, version: 'test',
  }, terminal);
  const inspect = app as unknown as { running: boolean };
  const run = app.run();
  try {
    terminal.input('Render the payload.');
    terminal.input('\r');
    await until(() => !inspect.running, 'the turn completes');
    await terminal.flush();

    // `lines()` is plain text; escapes are only observable in the raw VT stream and cell attributes.
    const screen = terminal.lines(true).join('\n');
    const raw = rawStream(terminal);
    assert.ok(screen.includes('End of payload.'), 'the answer actually rendered');

    const offenders = hostileSignatures(raw);
    assert.deepEqual(offenders, [], `untrusted escapes reached the terminal: ${JSON.stringify(offenders)}`);

    // The payload text is still readable — the fix strips escapes, it does not censor content.
    assert.ok(screen.includes('FAKE-ERROR'), 'the text of a forged-rendition payload stays visible');
    assert.ok(screen.includes('CLICK-ME'), 'link text survives without its attacker URL');
    const hidden = cellsOf(terminal, 'HIDDEN-PAYLOAD');
    assert.ok(hidden, 'concealed text is revealed, not dropped');
    assert.ok(hidden.every((c) => !c.isInvisible()), 'no rendered cell carries the conceal attribute');

    // Positive control: the stream is real and Shadow still styles its own output.
    assert.ok(/\u001b\[[0-9;]*m/.test(raw), 'Shadow must still color its own output');
  } finally {
    app.stop();
    await run;
    log.close();
    terminal.screen.dispose();
  }
});

test('Snowfall scrubs tool and reasoning output too', async (t) => {
  const root = mkdtempSync(join(tmpdir(), 'shadow-escapes-tool-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const bus = new EventBus();
  const cfg = loadConfig(root, {
    provider: 'mock', model: 'fixture', reducedMotion: true, notify: 'off',
    instructionAutopilot: false,
  });
  const log = SessionLog.open(root);
  const terminal = new HeadlessTerminal(120, 40);
  const app = new ShadowApp({
    provider: { name: 'mock', estimateTokens: () => 20, async *send() { yield { type: 'done', stopReason: 'end_turn' }; } } as never,
    cfg, bus, registry: new ToolRegistry(), sessionLog: log,
    context: new Context({ contextBudget: 32768, triggerRatio: 0.8, keepLastTurns: 4 }),
    system: 'Escape test.', workspaceRoot: root, autonomy: 'manual', bypass: false,
    offline: true, version: 'test',
  }, terminal);
  const run = app.run();
  try {
    await pause(60);
    // Tool output is the classic carrier: a grep hit or shell body from untrusted file content.
    // It legitimately KEEPS SGR (ls --color, npm), so this asserts the specific hostile tokens
    // are gone while the body still rendered.
    bus.emit({
      type: 'tool_start',
      call: { id: 'c1', name: 'run_shell', input: { command: `${ESC}[8mrm -rf /${ESC}[28m` } },
    } as never);
    bus.emit({
      type: 'tool_end',
      call: { id: 'c1', name: 'run_shell', input: { command: 'cat notes.md' } },
      result: { ok: true, summary: `read ${ESC}]52;c;c3RvbGVu${ESC}\\ ok`, data: { stdout: hostileBlob() } },
    } as never);
    bus.emit({ type: 'thinking', delta: `${ESC}[8mTHINK-HIDDEN${ESC}[28m` } as never);
    bus.emit({ type: 'reasoning_done', text: `${ESC}[2J${ESC}[1;1H${ESC}]8;;https://evil.example${ESC}\\` } as never);
    bus.emit({ type: 'subagent_start', taskId: 'child', subagentType: `${ESC}[8mHIDDEN-TYPE${ESC}[28m` } as never);
    bus.emit({
      type: 'tool_start',
      subagent: 'child',
      call: { id: 'child-call', name: `${ESC}[8mHIDDEN-TOOL${ESC}[28m`, input: {} },
    } as never);
    bus.emit({
      type: 'tool_end',
      call: { id: 'c2', name: `${ESC}[8mIMAGE-TOOL${ESC}[28m`, input: { payload: HOSTILE.osc52 } },
      result: { ok: true, summary: 'image', images: [{ mediaType: 'image/png', data: 'AA==' }] },
    } as never);
    await pause(120);
    await terminal.flush();

    const raw = rawStream(terminal);
    const offenders = hostileSignatures(raw);
    assert.deepEqual(offenders, [], `untrusted escapes reached the terminal: ${JSON.stringify(offenders)}`);
    assert.ok(raw.includes('cat notes.md'), 'the tool row actually rendered');
    // Collapsed tool bodies are not necessarily on screen; any rendered copy must be visible.
    const hidden = cellsOf(terminal, 'HIDDEN-PAYLOAD');
    if (hidden) assert.ok(hidden.every((c) => !c.isInvisible()), 'concealed tool output is revealed');

    const internal = app as unknown as {
      details: { name: string; inputJson?: string }[];
      items: { tool?: { name: string }; image?: { alt: string } }[];
      subAgents: Map<string, { subagentType: string; tool?: string }>;
    };
    const lastDetail = internal.details.at(-1)!;
    assert.ok(!lastDetail.name.includes(ESC), 'activity tool names are scrubbed at ingest');
    assert.ok(lastDetail.inputJson, 'the hostile tool input reached the activity record');
    assert.ok(!lastDetail.inputJson?.includes(ESC), 'activity input JSON is scrubbed at ingest');
    assert.ok(!internal.items.some((item) => item.tool?.name.includes(ESC)), 'transcript tool names are scrubbed');
    assert.ok(!internal.items.some((item) => item.image?.alt.includes(ESC)), 'image fallback labels are scrubbed');
    assert.ok(!internal.subAgents.get('child')?.subagentType.includes(ESC), 'sub-agent types are scrubbed');
    assert.ok(!internal.subAgents.get('child')?.tool?.includes(ESC), 'sub-agent tool names are scrubbed');
  } finally {
    app.stop();
    await run;
    log.close();
    terminal.screen.dispose();
  }
});

// --------------------------------------------------------------------------------------
// 3. F12 — the retained live remainder is bounded, and bounded by relocation.
// --------------------------------------------------------------------------------------

test('F12: a never-closing construct cannot grow the live remainder without bound', () => {
  // An unterminated code fence keeps the whole tail "live" forever. Unclamped, the splitter
  // rescans an ever-growing buffer on every 30 ms flush (the O(n^2) shape), and the retained
  // string is painted whole into a single StreamCell.
  const limit = MAX_LIVE_REST_BYTES;
  const line = 'const x = 1;\n';
  const lineCount = Math.ceil((limit * 3) / line.length);
  const huge = '```ts\n' + line.repeat(lineCount);
  assert.ok(huge.length > limit, 'the fixture must exceed the clamp to be meaningful');

  let rest = huge;
  let committedTotal = 0;
  const commits: string[] = [];
  let guard = 0;
  while (rest.length > limit && guard++ < 50) {
    const { commit, rest: next } = clampLiveRest(rest);
    assert.ok(commit !== null, 'excess text is committed, not silently dropped');
    committedTotal += commit.length;
    commits.push(commit);
    assert.ok(next.length < rest.length, 'each clamp must strictly shrink the remainder');
    rest = next;
  }
  assert.ok(rest.length <= limit, `remainder bounded by the clamp (got ${rest.length})`);
  assert.ok(committedTotal > 0, 'the overflow was relocated to scrollback');
  // Relocation, not truncation: every content line survives across commits + rest. (The clamp
  // closes and reopens the fence around each commit, so byte totals legitimately differ.)
  const all = [...commits, rest].join('\n');
  assert.equal((all.match(/const x = 1;/g) ?? []).length, lineCount, 'no content may be lost to the clamp');
});

test('F12: scrubForDisplay keeps the live remainder stable for ordinary prose', () => {
  // The clamp must be inert on normal output, or every 30 ms flush would churn the transcript.
  const prose = 'A short answer with no open construct.';
  assert.equal(clampLiveRest(prose).commit, null);
  assert.equal(clampLiveRest(prose).rest, prose);
  // And the live-region scrub preserves a code block's indentation (no trim).
  const indented = '```ts\n  const x = 1;\n```';
  assert.ok(scrubForDisplay(indented).includes('  const x = 1;'), 'indentation survives the live scrub');
});
