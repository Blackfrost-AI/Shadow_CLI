import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { buildDefaultBindings } from '../src/tui/keybindings/defaultBindings.js';
import { parseChord } from '../src/tui/keybindings/parser.js';

/**
 * 1.3 — one-key model switch. The picker existed behind /model only; this pins the default
 * Ctrl+X M chord, its registered handler (with the mid-turn block), and the emacs-style
 * Ctrl+P/Ctrl+N picker navigation.
 */
const TUI = readFileSync(new URL('../src/tui.tsx', import.meta.url), 'utf8');
const PICKER = readFileSync(new URL('../src/tui/keys/pickerOwner.ts', import.meta.url), 'utf8');

test('ctrl+x m is a default Chat binding for chat:openModelPicker', () => {
  const { bindings, warnings } = buildDefaultBindings();
  assert.deepEqual(warnings, [], 'default bindings parse cleanly');
  const hit = bindings.find((b) => b.context === 'Chat' && b.action === 'chat:openModelPicker');
  assert.ok(hit, 'the one-key model switch is advertised as a default binding');
  assert.equal(hit!.chord.length, 2, 'it is the two-keystroke ctrl+x m chord');
});

test('the ctrl+x m chord syntax parses as exactly two keystrokes', () => {
  const chord = parseChord('ctrl+x m');
  assert.ok(chord && chord.length === 2, 'parses at all');
  assert.deepEqual(chord![0], { key: 'x', ctrl: true, shift: false, meta: false });
  assert.deepEqual(chord![1], { key: 'm', ctrl: false, shift: false, meta: false });
});

test('chat:openModelPicker has a registered handler that refuses mid-turn', () => {
  const start = TUI.indexOf("kbRegister('chat:openModelPicker'");
  assert.notEqual(start, -1, 'handler is registered in the TUI');
  // While the picker has focus it captures EVERY key — if it could open mid-turn, Esc would
  // close the picker instead of interrupting the running turn. The block is a safety pin.
  const body = TUI.slice(start, start + 700);
  assert.match(body, /runningRef\.current/, 'the handler checks the running turn');
});

test('the picker keeps emacs-style ctrl+p/ctrl+n navigation (omp muscle memory)', () => {
  assert.match(PICKER, /key\.ctrl && ch === 'p'/, 'ctrl+p steps up');
  assert.match(PICKER, /key\.ctrl && ch === 'n'/, 'ctrl+n steps down');
});
