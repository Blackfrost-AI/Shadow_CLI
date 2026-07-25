import { test } from 'node:test';
import assert from 'node:assert/strict';
import React from 'react';
import { render } from 'ink-testing-library';
import { readFileSync } from 'node:fs';
import { TuiApp, type TuiOpts } from '../src/tui.js';
import { EventBus } from '../src/agent/events.js';

/**
 * A3 — the composer advertised "Shift+Enter newline" for the whole 3.x line, and it never worked.
 *
 * Terminal.app, iTerm2 and the VS Code terminal all send a BARE `\r` for Shift+Enter, so
 * `key.shift` could never be true. A terminal configured for CSI-u sends `ESC [ 13 ; 2 u`, which
 * Ink's parser does not recognise at all — so it was inserted into the draft as the literal text
 * `[13;2u`.
 */
function makeOpts(): TuiOpts {
  return {
    provider: {} as TuiOpts['provider'],
    registry: {} as TuiOpts['registry'],
    bus: new EventBus(),
    context: {} as TuiOpts['context'],
    sessionLog: { record() {} } as unknown as TuiOpts['sessionLog'],
    system: '',
    workspaceRoot: '/tmp/ws',
    cfg: { provider: 'mock', model: 'm', mouse: false } as unknown as TuiOpts['cfg'],
    autonomy: 'auto-edit',
    bypass: false,
    version: '9.9.9',
  };
}

async function mount(t: { after: (fn: () => void) => void }) {
  const { lastFrame, stdin, unmount } = render(React.createElement(TuiApp, { opts: makeOpts() }));
  await new Promise((r) => setTimeout(r, 120));
  t.after(() => unmount());
  const send = (...c: string[]): void => { for (const x of c) stdin.write(x); };
  const frame = async (): Promise<string> => {
    await new Promise((r) => setTimeout(r, 90));
    // eslint-disable-next-line no-control-regex
    return (lastFrame() ?? '').replace(/\x1b\[[0-9;]*m/g, '');
  };
  return { send, frame };
}

test('CSI-u Shift+Enter inserts a newline instead of the literal escape text', async (t) => {
  const { send, frame } = await mount(t);
  send('first');
  send('\x1b[13;2u'); // what a configured terminal sends
  send('second');
  const f = await frame();
  assert.doesNotMatch(f, /\[13;2u/, 'the escape must never appear as text');
  assert.match(f, /first/);
  assert.match(f, /second/);
  // Two composer rows means the newline landed.
  const rows = f.split('\n').filter((l) => l.includes('first') || l.includes('second'));
  assert.equal(rows.length, 2, 'the draft is two lines');
});

test("xterm's modifyOtherKeys encoding works too", async (t) => {
  const { send, frame } = await mount(t);
  send('a');
  send('\x1b[27;2;13~');
  send('b');
  const f = await frame();
  assert.doesNotMatch(f, /\[27;2;13~/);
});

test('the hint text no longer advertises a binding that does not work', () => {
  const src = readFileSync(new URL('../src/tui.tsx', import.meta.url), 'utf8');
  // The placeholder and both hint rows claimed Shift+Enter on terminals that cannot send it.
  assert.doesNotMatch(src, /Shift\+Enter newline/, 'stop promising what the default terminal cannot do');
  assert.match(src, /Option\+Enter newline/, 'advertise what actually works today');
  assert.match(src, /terminal-setup/, 'and point at the command that enables Shift+Enter');
});

test('/terminal-setup exists and covers the terminals that need it', () => {
  const src = readFileSync(new URL('../src/tui.tsx', import.meta.url), 'utf8');
  assert.match(src, /\{ name: '\/terminal-setup'/, 'the command is listed');
  const body = src.slice(src.indexOf("case '/terminal-setup'"), src.indexOf("case '/vim'"));
  assert.match(body, /iTerm/, 'iTerm2 instructions');
  assert.match(body, /vscode/, 'VS Code instructions');
  assert.match(body, /Apple_Terminal/, 'and an honest answer for Terminal.app, which cannot do it');
  assert.match(body, /13;2u/, 'the actual escape sequence');
});
