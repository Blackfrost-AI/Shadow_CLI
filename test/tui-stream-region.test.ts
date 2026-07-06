import { test } from 'node:test';
import assert from 'node:assert/strict';
import React from 'react';
import { render } from 'ink-testing-library';
import { TuiApp, type TuiOpts } from '../src/tui.js';
import { EventBus } from '../src/agent/events.js';

/**
 * Behavioral proof of the streaming-composer fix: while an answer streams, the
 * live region (and therefore the input composer pinned below it) must NOT grow
 * with the answer. Completed markdown blocks are committed to <Static> and leave
 * the live region; the still-open block is clamped to its tail. We drive the
 * EventBus directly (the component subscribes to it) and inspect lastFrame() —
 * which in ink-testing-library is the *transient* live region, not the cumulative
 * Static scrollback (that's what frames[] accumulates).
 */
function makeOpts(over: Partial<TuiOpts> = {}): TuiOpts {
  return {
    provider: {} as TuiOpts['provider'],
    registry: {} as TuiOpts['registry'],
    bus: new EventBus(),
    context: {} as TuiOpts['context'],
    sessionLog: { record() {} } as unknown as TuiOpts['sessionLog'],
    system: '',
    workspaceRoot: '/tmp/ws',
    cfg: { provider: 'mock', model: 'claude-opus-4-8' } as unknown as TuiOpts['cfg'],
    autonomy: 'auto-edit',
    bypass: false,
    version: '9.9.9',
    ...over,
  };
}

const tick = (ms = 60) => new Promise((r) => setTimeout(r, ms));

test('streaming keeps the live region bounded: finished blocks commit away, the open block is tail-clamped', async () => {
  const bus = new EventBus();
  const { lastFrame, frames, unmount } = render(React.createElement(TuiApp, { opts: makeOpts({ bus }) }));
  await tick(); // let the component mount + subscribe

  // 1) A finished paragraph (terminated by a blank line) must commit to scrollback
  //    and leave the live region.
  bus.emit({ type: 'text', delta: 'EARLY_MARKER finished paragraph.\n\n' });
  await tick();

  // 2) A long, still-OPEN code fence — the worst case from the bug report (a big
  //    file streaming in). It must stay clamped, never reproduce the whole block live.
  const codeLines = Array.from({ length: 200 }, (_, i) => `CODE_${String(i).padStart(3, '0')}`);
  bus.emit({ type: 'text', delta: '```ts\n' + codeLines.join('\n') });
  await tick();

  const live = lastFrame() ?? '';
  void frames;

  // BLOCK-COMMIT: the finished paragraph is still visible (in committed scrollback)
  // even though 200 lines streamed AFTER it. Clamp-only (no block-commit) would have
  // scrolled it out of the live buffer's tail and it would be gone — so its survival
  // proves it was committed to <Static> the moment its block closed.
  assert.match(live, /EARLY_MARKER/, 'finished paragraph committed to scrollback, survives later streaming');

  // TAIL-CLAMP: the still-open 200-line code block shows only its tail.
  assert.match(live, /CODE_199/, 'newest streamed line stays visible');
  assert.doesNotMatch(live, /CODE_000/, 'oldest line of a 200-line open block is clamped away');

  // Hard bound: the OPEN block contributes only a handful of lines, so the composer
  // below it cannot be pushed down by a long answer.
  const liveCodeLines = (live.match(/CODE_\d{3}/g) ?? []).length;
  assert.ok(liveCodeLines < 60, `open block must stay bounded, saw ${liveCodeLines} code lines`);

  unmount();
});

test('assistant_done flushes the open tail so both blocks of a streamed answer land', async () => {
  const bus = new EventBus();
  const { lastFrame, unmount } = render(React.createElement(TuiApp, { opts: makeOpts({ bus }) }));
  await tick();

  bus.emit({ type: 'text', delta: 'UNIQUE_ALPHA one.\n\nUNIQUE_BETA two' });
  await tick();
  // ALPHA committed during streaming; BETA is the open tail. assistant_done flushes BETA
  // from the stream buffer (not the full e.text), so the answer is complete and the live
  // streaming region is cleared.
  bus.emit({ type: 'assistant_done', text: 'UNIQUE_ALPHA one.\n\nUNIQUE_BETA two' });
  await tick();

  const live = lastFrame() ?? '';
  assert.match(live, /UNIQUE_ALPHA/, 'first block present in scrollback');
  assert.match(live, /UNIQUE_BETA/, 'final tail flushed on assistant_done');

  unmount();
});
