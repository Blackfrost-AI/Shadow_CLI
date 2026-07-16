/**
 * Paste behavior — bracketed paste (mode 2004), \r normalization, and clipboard read.
 *
 * The key handler must treat a bracketed paste as ONE atomic insert: embedded newlines
 * can't submit mid-paste, and content split across several stdin reads reassembles.
 * Ink's use-input mangles the raw stream (strips a chunk-leading \x1b; delivers a lone
 * \r as key.return with input '') — these tests drive the REAL Ink pipeline via
 * ink-testing-library, so they lock the handler against both quirks.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import React from 'react';
import { render } from 'ink-testing-library';
import { TuiApp, type TuiOpts } from '../src/tui.js';
import { EventBus } from '../src/agent/events.js';
import { Context } from '../src/agent/context.js';
import { resolvePasteBin, readClipboard } from '../src/util/clipboard.js';

function makeOpts(over: Partial<TuiOpts> = {}): TuiOpts {
  return {
    provider: {} as TuiOpts['provider'],
    registry: {} as TuiOpts['registry'],
    bus: new EventBus(),
    context: new Context({ contextBudget: 1000, triggerRatio: 0.75, keepLastTurns: 6 }),
    sessionLog: { record() {} } as unknown as TuiOpts['sessionLog'],
    system: '',
    workspaceRoot: '/tmp',
    cfg: { provider: 'mock', model: 'm' } as unknown as TuiOpts['cfg'],
    autonomy: 'auto-edit',
    bypass: false,
    version: '9.9.9',
    ...over,
  };
}
const tick = () => new Promise((r) => setTimeout(r, 60));
const ANSI = new RegExp(String.fromCharCode(27) + '\\[[0-9;]*m', 'g');
const strip = (s: string | undefined) => (s ?? '').replace(ANSI, '');

test('bracketed paste in one chunk: newlines insert literally, nothing submits', async () => {
  const { stdin, lastFrame, frames, unmount } = render(React.createElement(TuiApp, { opts: makeOpts() }));
  await tick();
  // Terminals send \r for line ends inside a paste. Ink strips the leading \x1b, so the
  // handler sees '[200~line1\rline2\x1b[201~' — it must restore the marker and stay atomic.
  stdin.write('\x1b[200~line1\rline2\x1b[201~');
  await tick();
  const f = strip(lastFrame());
  assert.match(f, /line1/, 'first pasted line in the composer');
  assert.match(f, /line2/, 'second pasted line in the composer');
  assert.doesNotMatch(strip(frames.join('\n')), /Error/, 'the embedded \\r did not submit mid-paste');
  // Caret ends after the paste — typing appends.
  stdin.write('X');
  await tick();
  assert.match(strip(lastFrame()), /line2X/, 'caret sits at the end of the pasted text');
  unmount();
});

test('bracketed paste across chunks: a lone \\r chunk mid-paste is a newline, not a submit', async () => {
  const { stdin, lastFrame, frames, unmount } = render(React.createElement(TuiApp, { opts: makeOpts() }));
  await tick();
  stdin.write('\x1b[200~alpha'); // start marker + first fragment (no end yet)
  await tick();
  stdin.write('\r'); // Ink reports this as key.return with input '' — must buffer as '\n'
  await tick();
  stdin.write('beta\x1b[201~'); // final fragment + end marker
  await tick();
  const f = strip(lastFrame());
  assert.match(f, /alpha/, 'first fragment landed');
  assert.match(f, /beta/, 'second fragment landed');
  assert.doesNotMatch(strip(frames.join('\n')), /Error/, 'the mid-paste Enter never reached the submit handler');
  unmount();
});

test('unbracketed multi-char paste: \\r normalizes to \\n (chip line counts and wrapping stay sane)', async () => {
  const { stdin, lastFrame, unmount } = render(React.createElement(TuiApp, { opts: makeOpts() }));
  await tick();
  stdin.write('one\rtwo'); // legacy path (terminal without mode 2004): one chunk, raw \r inside
  await tick();
  const f = strip(lastFrame());
  assert.match(f, /one/, 'text before the \\r');
  assert.match(f, /two/, 'text after the \\r');
  assert.doesNotMatch(f, /one\rtwo/, 'the raw \\r is gone (normalized to a real newline)');
  unmount();
});

test('huge bracketed paste condenses to a [Pasted text #N] chip with a correct line count', async () => {
  const { stdin, lastFrame, unmount } = render(React.createElement(TuiApp, { opts: makeOpts() }));
  await tick();
  const blob = Array.from({ length: 60 }, (_, i) => `row ${i}`).join('\r'); // \r line ends, like a real terminal
  stdin.write(`\x1b[200~${blob}\x1b[201~`);
  await tick();
  const f = strip(lastFrame());
  assert.match(f, /\[Pasted text #1 \+60 lines\]/, 'chip shows the REAL line count (\\r ends counted)');
  unmount();
});

test('clipboard read helpers: platform paste helper resolves; readClipboard never throws', async () => {
  // On macOS pbpaste ships with the OS; on Linux CI one of wl-paste/xclip/xsel may be absent —
  // the contract is graceful degradation, not availability.
  const spec = resolvePasteBin();
  if (process.platform === 'darwin') {
    assert.ok(spec, 'pbpaste resolves on macOS');
    assert.equal(spec!.bin, 'pbpaste');
  }
  const text = await readClipboard(); // must resolve string|null, never reject
  assert.ok(text === null || typeof text === 'string');
});
