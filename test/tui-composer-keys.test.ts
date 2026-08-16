import { test } from 'node:test';
import assert from 'node:assert/strict';
import React from 'react';
import { render } from 'ink-testing-library';
import { TuiApp, type TuiOpts } from '../src/tui.js';
import { EventBus } from '../src/agent/events.js';

/**
 * End-to-end composer editing: drives the REAL <TuiApp> with the exact byte sequences macOS
 * terminals send, so these assertions fail if Ink's parsing, the handler order, or the editing
 * helpers drift. Unit tests on the pure helpers (composer-editing.test.ts) can't catch a chord
 * that never reaches them — which is exactly how Option+Delete stayed a plain backspace and
 * click-to-caret stayed dead code behind an early return.
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
    cfg: { provider: 'mock', model: 'm', mouse: false } as unknown as TuiOpts['cfg'],
    autonomy: 'auto-edit',
    bypass: false,
    version: '9.9.9',
    ...over,
  };
}

/** Ink throttles frame writes (~32ms leading+trailing), so every read waits past one full window. */
const FLUSH_MS = 90;

async function mount(t: { after: (fn: () => void) => void }, cfg: Record<string, unknown> = {}) {
  const opts = makeOpts();
  Object.assign(opts.cfg as unknown as Record<string, unknown>, cfg);
  const { lastFrame, stdin, unmount } = render(React.createElement(TuiApp, { opts }));
  // Let the mount settle (the welcome card commits to <Static> on a startup effect) before typing —
  // keystrokes sent inside that window are lost to the first re-render.
  await new Promise((r) => setTimeout(r, 120));
  const send = (...chunks: string[]): void => {
    for (const c of chunks) stdin.write(c);
  };
  /** The composer draft as plain text: the `❯ ` row, ANSI stripped, trailing caret cell trimmed.
   *  An empty composer paints the dim placeholder — report that as the empty string it represents. */
  const draft = async (): Promise<string> => {
    await new Promise((r) => setTimeout(r, FLUSH_MS));

    const plain = (lastFrame() ?? '').replace(/\x1b\[[0-9;]*m/g, '');
    const row = plain.split('\n').find((r) => r.trimStart().startsWith('❯ '));
    if (!row) return '';
    const body = row.trimStart().slice(2).replace(/\s+$/, '');
    return body.includes('Send a message…') ? '' : body;
  };
  t.after(() => unmount()); // runs even when an assertion throws — a mounted Ink app holds handles
  return { send, draft, lastFrame };
}

test('Option+Delete (\\x1b\\x7f) deletes a WORD, not a character', async (t) => {
  const { send, draft } = await mount(t);
  send('fix the tui spacing');
  assert.equal(await draft(), 'fix the tui spacing');
  send('\x1b\x7f');
  assert.equal(await draft(), 'fix the tui', 'one press removed the whole last word');
  send('\x1b\x7f');
  assert.equal(await draft(), 'fix the');
  // …while a bare Backspace still removes exactly one character. (The buffer here is
  // 'fix the ' — a word delete keeps the separator before it — so the first Backspace
  // eats that trailing space and the second eats the 'e'.)
  send('\x7f', '\x7f');
  assert.equal(await draft(), 'fix th');
});

test('Ctrl+W deletes a word; Ctrl+U kills to line start; Ctrl+Y yanks it back', async (t) => {
  const { send, draft } = await mount(t);
  send('alpha beta gamma');
  send('\x17'); // Ctrl+W
  assert.equal(await draft(), 'alpha beta');
  send('\x15'); // Ctrl+U
  assert.equal(await draft(), '');
  send('\x19'); // Ctrl+Y — yank the kill back
  assert.equal(await draft(), 'alpha beta');
});

test('Ctrl+A / Ctrl+E jump to the line ends and typing lands there', async (t) => {
  const { send, draft } = await mount(t);
  send('world');
  send('\x01'); // Ctrl+A
  send('hello ');
  assert.equal(await draft(), 'hello world');
  send('\x05'); // Ctrl+E
  send('!');
  assert.equal(await draft(), 'hello world!');
});

test('Home / End keys work even though Ink exposes no field for them', async (t) => {
  const { send, draft } = await mount(t);
  send('world');
  send('\x1b[H'); // Home
  send('hello ');
  assert.equal(await draft(), 'hello world');
  send('\x1bOF'); // End (application-cursor form)
  send('!');
  assert.equal(await draft(), 'hello world!');
});

test('Option+Left / Option+Right move by word (CSI and Esc-letter encodings both)', async (t) => {
  const { send, draft } = await mount(t);
  send('alpha beta');
  send('\x1b[1;3D'); // Option+Left → before "beta"
  send('X');
  assert.equal(await draft(), 'alpha Xbeta');
  send('\x1bb', '\x1bb'); // Option+B ×2 → before "alpha"
  send('Y');
  assert.equal(await draft(), 'Yalpha Xbeta');
  send('\x1bf'); // Option+F → end of "Yalpha"
  send('Z');
  assert.equal(await draft(), 'YalphaZ Xbeta');
});

test('forward-delete (\\x1b[3~) deletes RIGHT — Ink reports it as key.delete, same as Backspace', async (t) => {
  const { send, draft } = await mount(t);
  send('abcdef');
  send('\x01'); // Ctrl+A → caret at the start
  send('\x1b[3~');
  assert.equal(await draft(), 'bcdef', 'deleted forward, not backward');
  send('\x1b[3;3~'); // Option+forward-delete → the whole word to the right
  assert.equal(await draft(), '');
});

test('Ctrl+K kills to end of line', async (t) => {
  const { send, draft } = await mount(t);
  send('keep this drop this');
  send('\x1bb', '\x1bb'); // back two words → before "drop"
  send('\x0b'); // Ctrl+K
  assert.equal(await draft(), 'keep this');
});

test('Ctrl+Z undoes a destructive edit', async (t) => {
  const { send, draft } = await mount(t);
  send('one two three');
  send('\x1b\x7f'); // Option+Delete
  assert.equal(await draft(), 'one two');
  send('\x1a'); // Ctrl+Z
  assert.equal(await draft(), 'one two three', 'the word came back');
});

test('an SGR mouse report is never inserted as composer text', async (t) => {
  const { send, draft } = await mount(t);
  send('hi');
  send('\x1b[<0;10;30M');
  send('\x1b[<0;10;30m');
  assert.equal(await draft(), 'hi', 'no [<0;10;30M garbage in the draft');
});

test('a cursor-position report (the click DSR answer) is never inserted as composer text', async (t) => {
  const { send, draft } = await mount(t);
  send('hi');
  send('\x1b[38;1R');
  assert.equal(await draft(), 'hi');
});

test('a click inside the composer places the caret (SGR press → DSR answer → caret)', async (t) => {
  const { send, draft } = await mount(t, { mouse: true });
  send('hello world');
  assert.equal(await draft(), 'hello world');
  // The composer paints at PAGE_MARGIN(4) + the '❯ ' gutter(2), so draft column 5 is terminal
  // column 4+2+5+1 = 12 (1-based). Click there, on the row we then claim the input sits on.
  send('\x1b[<0;12;10M');
  // Ink parks the cursor one row below the frame; below the input line sit the bottom rule and the
  // hint (2 rows), so a resting row of 13 puts the single input row at y=10 — the row we clicked.
  send('\x1b[13;1R');
  send('X');
  assert.equal(await draft(), 'helloX world', 'the caret landed at the clicked column');
});

test('a click OUTSIDE the composer rows leaves the caret alone', async (t) => {
  const { send, draft } = await mount(t, { mouse: true });
  send('hello world');
  send('\x1b[<0;12;3M'); // y=3 — up in the transcript
  send('\x1b[13;1R'); // same geometry: the input row is 10, so this click misses it
  send('X');
  assert.equal(await draft(), 'hello worldX', 'caret stayed at the end of the draft');
});

// ── F03-05: composer robustness ──────────────────────────────────────────────

test('Ctrl+B / Ctrl+F jump a WHOLE grapheme cluster — never land inside one', async (t) => {
  const { send, draft } = await mount(t);
  const EMOJI = String.fromCodePoint(0x1f600); // 😀 — one cluster, two UTF-16 units
  send('a' + EMOJI); // caret parks after the emoji
  send('\x02'); // Ctrl+B — one visual step left must clear the whole cluster
  send('X');
  assert.equal(await draft(), 'aX' + EMOJI, 'Ctrl+B crossed the whole cluster; the old ±1 code-unit move parked the caret between the surrogates');
  send('\x06'); // Ctrl+F — one visual step right, across the whole cluster again
  send('\x06'); // already at the end — the end is a fixed point, no stray step
  send('Y');
  assert.equal(await draft(), 'aX' + EMOJI + 'Y', 'Ctrl+F crossed the cluster and stopped at the end');
});

test('batched chunks: forward-delete still deletes RIGHT when the key repeats into one read', async (t) => {
  const { send, draft } = await mount(t);
  send('abcd');
  send('\x1b[H'); // Home → caret 0
  send('\x1b[3~\x1b[3~'); // key auto-repeat lands in ONE stdin read
  // Ink keeps only the first keypress of a merged read; lastKeySequence recovers it for the
  // raw-sequence test. The old whole-chunk match died on the $ anchor, and Ink's key.delete
  // flag then deleted BACKWARDS (or did nothing at column 0) instead.
  assert.equal(await draft(), 'bcd', 'the forward-delete landed (Ink itself drops the repeat)');
});

test('batched chunks: Home still homes when held (two \\x1b[H in one read)', async (t) => {
  const { send, draft } = await mount(t);
  send('hello');
  send('\x1b[H\x1b[H');
  send('X');
  assert.equal(await draft(), 'Xhello', 'Home fired despite the batched repeat');
});

test('batched chunks: a typed byte right after Home in one read must not defeat the Home match', async (t) => {
  const { send, draft } = await mount(t);
  send('world');
  send('\x1b[Hq'); // Home + 'q' in ONE read: Ink dispatches Home and drops the q itself
  send('Y');
  assert.equal(await draft(), 'Yworld', 'the sequence was trimmed of trailing text before matching');
});

test('Ctrl+D on an EMPTY composer warns first (two-stage arm) and any other key disarms it', async (t) => {
  const { send, draft, lastFrame } = await mount(t);
  assert.equal(await draft(), '');
  send('\x04'); // Ctrl+D once, idle + empty
  await new Promise((r) => setTimeout(r, FLUSH_MS));
  assert.match(lastFrame() ?? '', /press Ctrl\+D again to quit/, 'the first ^D arms instead of quitting');
  assert.match(lastFrame() ?? '', /❯/, 'the app is still mounted after one ^D');
  // Any other key disarms the latch, so a later ^D starts over instead of quitting.
  send('x');
  assert.equal(await draft(), 'x');
  send('\x15'); // Ctrl+U — back to an empty draft
  assert.equal(await draft(), '');
  send('\x04');
  await new Promise((r) => setTimeout(r, FLUSH_MS));
  assert.match(lastFrame() ?? '', /❯/, 'still mounted: the intervening key disarmed the first press');
});

test('Ctrl+D on a NON-EMPTY draft keeps its forward-delete meaning (never arms exit)', async (t) => {
  const { send, draft, lastFrame } = await mount(t);
  send('ab');
  send('\x1b[H'); // caret 0
  send('\x04');
  assert.equal(await draft(), 'b', 'forward-delete, exactly as before F03-05');
  assert.doesNotMatch(lastFrame() ?? '', /press Ctrl\+D again/, 'no exit hint while the draft has text');
});

// ── F03-06: vim multiline drafts ─────────────────────────────────────────────

test('vim NORMAL edits (x, dw) are undoable via Ctrl+Z (F03-06 applyEdit routing)', async (t) => {
  const { send, draft } = await mount(t, { vimMode: true });
  send('hello world');
  send('\x1b');        // ESC → NORMAL, caret clamps onto the last char
  send('x');           // delete 'd'
  assert.equal(await draft(), 'hello worl');
  send('0');           // hard-line start (cursor-only — must NOT push an undo frame)
  send('dw');          // kill 'hello '
  assert.equal(await draft(), 'worl');
  send('\x1a');        // Ctrl+Z — undoes the dw batch
  assert.equal(await draft(), 'hello worl');
  send('\x1a');        // Ctrl+Z — undoes the x
  assert.equal(await draft(), 'hello world');
});

test('vim hard-line keys operate on the caret\'s line in a multiline draft (F03-06)', async (t) => {
  const { send, lastFrame } = await mount(t, { vimMode: true });
  send('foo');
  send('\x1b[13;2u');  // Shift+Enter → newline
  send('bar baz');
  send('\x1b');        // → NORMAL, caret onto 'z'
  send('x');           // delete 'z' — stops at the line end
  send('0');           // hard-line start → 'b', NOT the buffer start
  send('i');           // insert there
  send('X');
  await new Promise((r) => setTimeout(r, FLUSH_MS));
  const plain = (lastFrame() ?? '').replace(/\x1b\[[0-9;]*m/g, '');
  assert.ok(plain.includes('-- NORMAL --') === false, 'i brought the composer back to INSERT');
  assert.ok(plain.includes('Xbar ba'), 'x killed the z and i typed at the hard-line start');
  assert.ok(plain.includes('foo'), 'line one untouched — no key crossed the newline');
});

test('two consecutive Ctrl+D on an EMPTY composer quit — the second advertised exit path', async (t) => {
  const { send, lastFrame } = await mount(t);
  send('\x04');
  await new Promise((r) => setTimeout(r, FLUSH_MS));
  send('\x04');
  await new Promise((r) => setTimeout(r, FLUSH_MS));
  // The app exits through the same latch as Ctrl-C×2. ink-testing-library keeps the last
  // painted frame, so assert DEATH directly: nothing renders afterwards and typed text never
  // lands (a still-mounted app would repaint the composer with the keystrokes).
  const atExit = lastFrame() ?? '';
  send('zombie');
  await new Promise((r) => setTimeout(r, FLUSH_MS));
  assert.equal(lastFrame() ?? '', atExit, 'no further frame rendered after the exit');
  assert.doesNotMatch(lastFrame() ?? '', /zombie/, 'the exited app no longer accepts input');
});
