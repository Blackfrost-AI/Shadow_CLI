import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { getCapabilities, setCapabilities } from '@earendil-works/pi-tui';
import { THEME_NAMES } from '../src/tui/theme.js';
import { FlatCell } from '../src/app/cells.js';
import { fullscreenImageProtocol } from '../src/util/termImage.js';
import { fixture } from './helpers/snowfallTerminal.js';

test('Snowfall golden VT frames at 80, 120 and 200 columns in every palette', async () => {
  const expected = JSON.parse(readFileSync(new URL('./fixtures/snowfall-frames.json', import.meta.url), 'utf8')) as Record<string, { lines: string[]; attributes: string }>;
  for (const theme of THEME_NAMES) for (const width of [80, 120, 200]) {
    const f = fixture(theme, width);
    try {
      f.tui.renderNow(true);
      await f.terminal.flush();
      const key = `${theme}/${width}`;
      assert.deepEqual(f.terminal.lines(), expected[key]?.lines, `${key} text and layout`);
      const attributes = createHash('sha256').update(JSON.stringify(f.terminal.cells())).digest('hex');
      assert.equal(attributes, expected[key]?.attributes, `${key} foreground and background`);
      assert.equal(f.terminal.screen.buffer.active.type, 'alternate');
      const text = f.terminal.lines().join('\n');
      assert.match(text, /Enter send/);
      assert.doesNotMatch(text, /WORKSPACE|CONTEXT|AGENTS/, `${key} no sidebar`);
      assert.match(f.terminal.lines().at(-1)!, /1 agent.*1\/3 tasks.*ctx 28%/, `${key} session totals stay in the footer`);
    } finally { f.tui.stop({ preserveScreen: true }); f.terminal.screen.dispose(); }
  }
});

test('fullscreen scroll, search, semantic prompt jumps, short resize, paste and complete exit document', async () => {
  const f = fixture('snowfall', 120);
  try {
    for (let i = 0; i < 45; i++) f.document.addChild(new FlatCell({ id: `history-${i}`, kind: i % 5 === 0 ? 'user' : 'assistant', text: `History line ${i}: a complete durable conversation.` }, false));
    f.tui.renderNow(true);
    await f.terminal.flush();
    assert.match(f.terminal.lines().join('\n'), /History line 44/);
    f.terminal.input('\x1b[5~'); // PageUp
    await f.terminal.flush();
    assert.equal(f.tui.isFollowingOutput, false);
    const beforeJump = f.tui.viewportTop;
    f.terminal.input('\x1b[1;5A'); // Ctrl+Up
    await f.terminal.flush();
    assert.ok(f.tui.viewportTop < beforeJump, 'jump finds a user OSC 133 marker');
    f.terminal.input('\x1b[102;6u'); // Ctrl+Shift+F (Kitty/CSI-u)
    f.terminal.input('History line 12');
    await f.terminal.flush();
    assert.match(f.terminal.lines().join('\n'), /History line 12/);
    assert.ok(f.tui.hasOverlay(), 'search owns focus');
    f.terminal.input('\x1b');
    await f.terminal.flush();
    assert.equal(f.tui.hasOverlay(), false);
    let submits = 0;
    f.editor.onSubmit = () => submits++;
    const paste = '漢字 café\n'.repeat(350);
    f.terminal.input(`\x1b[200~${paste}\x1b[201~`);
    await f.terminal.flush();
    assert.equal(submits, 0);
    assert.equal(f.editor.getExpandedText(), paste);
    for (const [width, height] of [[80, 24], [40, 12], [28, 8], [200, 40]]) {
      f.terminal.resize(width!, height!);
      f.tui.renderNow(true);
      await f.terminal.flush();
      assert.equal(f.terminal.lines().length, height);
      assert.ok(f.terminal.screen.buffer.active.cursorY < height!, 'cursor remains in the viewport');
      assert.match(f.terminal.lines().at(-1)!, /auto-read/, 'status stays pinned');
    }
    f.tui.setLayoutRoot(f.document);
    f.tui.stop();
    await f.terminal.flush();
    assert.equal(f.terminal.screen.buffer.active.type, 'normal');
    const all = f.terminal.lines(true).join('\n');
    assert.match(all, /Finish the Snowfall build/);
    assert.match(all, /History line 0:/);
    assert.match(all, /History line 44:/);
    assert.ok(f.terminal.writes.join('').includes('\x1b[?7h'), 'autowrap restored');
    assert.ok(f.terminal.writes.join('').includes('\x1b[?1006l'), 'mouse protocol disabled');
  } finally { if (!f.terminal.stopped) f.tui.stop({ preserveScreen: true }); f.terminal.screen.dispose(); }
});

test('fullscreen image policy uses managed Kitty PNGs and readable fallbacks', () => {
  for (const name of ['kitty', 'ghostty', 'WezTerm']) {
    assert.equal(fullscreenImageProtocol('image/png', { isTTY: true, env: { TERM_PROGRAM: name } }), 'kitty');
  }
  assert.equal(fullscreenImageProtocol('image/png', { isTTY: true, env: { TERM_PROGRAM: 'iTerm.app' } }), null);
  assert.equal(fullscreenImageProtocol('image/jpeg', { isTTY: true, env: { TERM_PROGRAM: 'kitty' } }), null);
  assert.equal(fullscreenImageProtocol('image/png', { isTTY: true, env: { TERM_PROGRAM: 'kitty', TMUX: 'yes' } }), null);
  assert.equal(fullscreenImageProtocol('image/png', { isTTY: false, env: { TERM_PROGRAM: 'kitty' } }), null);
});

test('image metadata and malformed base64 cannot inject terminal controls', () => {
  const tty = Object.getOwnPropertyDescriptor(process.stdout, 'isTTY');
  const savedEnv = { TERM_PROGRAM: process.env.TERM_PROGRAM, TMUX: process.env.TMUX };
  const caps = getCapabilities();
  const png = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Wl6MqQAAAAASUVORK5CYII=';
  const control = '\x1b]52;c;fake\x07';
  try {
    Object.defineProperty(process.stdout, 'isTTY', { value: true, configurable: true });
    process.env.TERM_PROGRAM = 'kitty';
    delete process.env.TMUX;
    setCapabilities({ images: 'kitty', trueColor: true, hyperlinks: false });
    const render = (bytes: string, mediaType = 'image/png') => new FlatCell({
      id: 'picture', kind: 'image', text: '', image: { bytes, mediaType, alt: 'preview' + control, source: '/tmp/file' + control },
    }, false).render(200).join('\n');
    assert.ok(render(png).includes('\x1b_G'), 'valid PNGs use the managed graphics component');
    const malformed = render(png + control);
    assert.ok(!malformed.includes('\x1b_G'), 'malformed base64 falls back to text');
    for (const frame of [render(png), malformed, render(png, 'image/' + control)]) {
      assert.ok(!frame.includes(control));
      assert.match(frame, /\\x1b\]52;c;fake\\x07/);
    }
  } finally {
    if (tty) Object.defineProperty(process.stdout, 'isTTY', tty);
    else Reflect.deleteProperty(process.stdout, 'isTTY');
    for (const [key, value] of Object.entries(savedEnv)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    setCapabilities(caps);
  }
});
