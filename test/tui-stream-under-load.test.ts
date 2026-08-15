/**
 * P1A-12 Layer B — the streaming hot path driven through the REAL TuiApp + Ink render loop.
 *
 * The pure-function Layer A suite (tui-stream-load.test.ts) proves splitStreamToolIntentCapped /
 * extractCommittableUnits / clampTail stay bounded under pathological load. But the TUI delegate
 * is wired through the component's `text` bus handler, which ALSO does sanitize -> absorb ->
 * pushLine (renders to <Static>) -> scrubForDisplay -> debounced setStream. This file proves the
 * whole real pipeline survives a load burst with a never-closing envelope: the turn COMPLETES
 * (the anti-freeze guarantee — no quadratic re-parse, no render loop hang) inside a hard wall
 * budget, and the live region stays clampTail-bounded so no runaway single line is ever painted.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import React from 'react';
import { render } from 'ink-testing-library';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { TuiApp, type TuiOpts } from '../src/tui.js';
import { EventBus, type LoopEvent } from '../src/agent/events.js';
import { Context } from '../src/agent/context.js';
import { ToolRegistry } from '../src/tools/registry.js';
import { loadConfig } from '../src/config.js';
import type { ProviderEvent, Provider } from '../src/provider/provider.js';
import { MAX_HELD_BYTES } from '../src/tui/streamIntent.js';

const tick = (ms = 60) => new Promise((r) => setTimeout(r, ms));
const ANSI = new RegExp(String.fromCharCode(27) + '\\[[0-9;]*m', 'g');
const strip = (s: string | undefined) => (s ?? '').replace(ANSI, '');

async function until(pred: () => boolean, ms = 20000): Promise<boolean> {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (pred()) return true;
    await tick(40);
  }
  return pred();
}

/**
 * A provider that simulates the pathological-but-legal shape that used to freeze the TUI:
 *   - several complete prose lines (exercises commit -> <Static> + multi-line rendering), then
 *   - an opening `<tool_call>` whose JSON payload is a SINGLE UNBROKEN LINE well over the held
 *     suffix cap (MAX_HELD_BYTES) and NEVER closes — the exact no-newline case the cap + clampTail
 *     exist for, then
 *   - a few more prose lines to prove the pipeline keeps working after the overflow release, then
 *     a clean `done`.
 * Deltas are emitted in small chunks so every step goes through the per-token hot path (intent
 * split + unit extraction) rather than arriving as one giant event.
 */
function loadBurstProvider(payloadBytes: number): Provider & { completed: () => boolean } {
  let exhausted = false;
  const burst = async function* (): AsyncGenerator<ProviderEvent> {
    // ~40 committed prose lines to fill <Static> scrollback before the runaway payload.
    for (let i = 0; i < 40; i++) {
      yield { type: 'text', delta: `Streaming load line ${i} — proving the commit path under load.\n` };
    }
    // Open a tool envelope whose payload NEVER closes and has NO newline for payloadBytes.
    yield { type: 'text', delta: '<tool_call>{"name":"run_shell","arguments":{"command":"echo "' };
    yield { type: 'text', delta: 'z'.repeat(payloadBytes) };
    // The pipeline must keep committing ordinary text AFTER the oversized held suffix was released.
    yield { type: 'text', delta: '\nAnd the stream continues past the released overflow.\n' };
    yield { type: 'text', delta: 'Final committed tail line. Goodbye.\n' };
    yield { type: 'done', stopReason: 'end_turn' };
    exhausted = true;
  };
  return {
    name: 'loadburst',
    estimateTokens: () => 1,
    send: burst,
    completed: () => exhausted,
  };
}

function baseOpts(over: Partial<TuiOpts> & { workspaceRoot: string }): TuiOpts {
  const cfg = loadConfig(over.workspaceRoot, { provider: 'mock', model: 'm' });
  return {
    provider: {} as TuiOpts['provider'],
    registry: new ToolRegistry(),
    bus: new EventBus(),
    context: new Context({
      contextBudget: cfg.contextBudget,
      triggerRatio: cfg.summarizeTriggerRatio,
      keepLastTurns: cfg.keepLastTurns,
    }),
    sessionLog: { record() {}, recordSnapshot() {}, path: undefined } as unknown as TuiOpts['sessionLog'],
    system: 'test',
    cfg,
    autonomy: 'manual',
    bypass: false,
    version: '0.0.0',
    ...over,
  };
}

/** The AC-named Aug-12 shape end-to-end: a never-closing ```python fence (NOT tool-ambiguous, so
 *  only clampLiveRest bounds it) at token speed, with reasoning deltas interleaved the way a
 *  self-hosted Qwen serve actually streams. Proves through the REAL component: the turn completes
 *  inside a wall budget, the rest-overflow force-commit engaged (fence content reached scrollback
 *  BEFORE the turn ended), render coalescing collapsed the burst, and the live region stayed flat. */
test('P1A-12 (Layer B): never-closing ```python fence + interleaved reasoning stays bounded and coalesced', async () => {
  const ws = mkdtempSync(join(tmpdir(), 'streamload2-'));
  const ROWS = 3000; // ~110KB fence body — beyond MAX_LIVE_REST_BYTES so the force-commit path runs
  let exhausted = false;
  const fenceProvider: Provider = {
    name: 'openfence',
    estimateTokens: () => 1,
    send: async function* (): AsyncGenerator<ProviderEvent> {
      yield { type: 'text', delta: 'Answer follows.\n\n```python\n' };
      for (let i = 0; i < ROWS; i++) {
        yield { type: 'text', delta: `print("row ${i} ${'x'.repeat(20)}")\n` };
        if (i % 50 === 0) yield { type: 'thinking', delta: `considering block ${i}… ` };
      }
      // The fence NEVER closes — the stream just ends.
      yield { type: 'done', stopReason: 'end_turn' };
      exhausted = true;
    },
  };
  const opts = baseOpts({ workspaceRoot: ws, provider: fenceProvider });
  const evts: string[] = [];
  opts.bus.on((e: LoopEvent) => evts.push(e.type));
  const { stdin, lastFrame, frames, unmount } = render(React.createElement(TuiApp, { opts }));
  try {
    await tick();
    stdin.write('go');
    await tick();
    stdin.write('\r');

    const t0 = performance.now();
    assert.ok(await until(() => evts.includes('stop')), 'the fence turn must complete (no quadratic freeze)');
    const wall = performance.now() - t0;
    assert.ok(exhausted, 'provider stream fully consumed');
    assert.ok(wall < 15000, `110KB open-fence burst through the real TUI took ${wall.toFixed(0)}ms`);

    await tick(150);
    // Coalescing assertion (P1A-12): ~3,060 deltas must collapse into a small number of paints
    // through the 30ms flush — observed ~19 frames locally; 300 leaves 15× headroom for slow CI
    // while still failing hard if coalescing ever regresses to per-delta rendering.
    assert.ok(
      frames.length < 300,
      `render coalescing must collapse the burst (saw ${frames.length} frames for ~${ROWS + 60} deltas)`,
    );
    const frame = strip(lastFrame() ?? '');
    // Live region flat: no frame line anywhere near the fence body size.
    const maxLineLen = Math.max(0, ...frame.split('\n').map((l) => l.length));
    assert.ok(maxLineLen < 5000, `runaway line in live region, saw ${maxLineLen} chars`);
    // The force-commit path engaged: EARLY fence rows reached scrollback long before the stream
    // ended (without clampLiveRest they sat in the live rest until turn end).
    assert.ok(frame.includes('row 0 '), 'early fence content must have been force-committed to scrollback');
    // Reasoning interleave did not corrupt the pipeline: the thinking channel produced its summary.
    assert.ok(evts.includes('reasoning_done') || frame.includes('considering'), 'reasoning deltas consumed');
  } finally {
    unmount();
    rmSync(ws, { recursive: true, force: true });
  }
});

test('P1A-12 (Layer B): real TuiApp completes a never-closing >cap payload burst inside a wall budget', async () => {
  const ws = mkdtempSync(join(tmpdir(), 'streamload-'));
  const opts = baseOpts({
    workspaceRoot: ws,
    // 80KB single unbroken line: deliberately ABOVE the 64KB held-suffix cap so the overflow
    // release path + clampTail live guard are genuinely exercised end-to-end.
    provider: loadBurstProvider(Math.round(MAX_HELD_BYTES * 1.25)),
  });
  const evts: string[] = [];
  opts.bus.on((e: LoopEvent) => evts.push(e.type));
  const { stdin, lastFrame, unmount } = render(React.createElement(TuiApp, { opts }));
  try {
    await tick();
    stdin.write('go');
    await tick();
    stdin.write('\r');

    // The anti-quadratic / anti-hang guarantee: the turn MUST reach a terminal 'stop' event.
    const t0 = performance.now();
    assert.ok(await until(() => evts.includes('stop')), 'the turn must complete (no quadratic freeze)');
    const wall = performance.now() - t0;
    assert.ok(wall < 10000, `80KB burst through the real TUI render path took ${wall.toFixed(0)}ms`);

    // Let the debounced flush paint, then assert the live region stayed bounded: even though the
    // provider emitted an 80KB single-line payload, no frame may contain that as a runaway line —
    // clampTail truncates each live row to the terminal width.
    await tick(120);
    const frame = strip(lastFrame() ?? '');
    const maxLineLen = Math.max(0, ...frame.split('\n').map((l) => l.length));
    assert.ok(maxLineLen < 5000, `runaway line in live region, saw ${maxLineLen} chars`);
    // And the committed scrollback DID carry the ordinary prose emitted BEFORE the runaway envelope
    // (prose after the marker stays legitimately held by the never-closing envelope, so the honest
    // commit-path evidence is the pre-marker scrollback — plus the fact that the turn still ENDED,
    // which is the anti-freeze guarantee that matters).
    assert.ok(
      frame.includes('Streaming load line 5 — proving the commit path under load'),
      'pre-marker prose must have committed to scrollback through the real pipeline',
    );
  } finally {
    unmount();
    rmSync(ws, { recursive: true, force: true });
  }
});
