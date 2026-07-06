import { test } from 'node:test';
import assert from 'node:assert/strict';
import { startupSequence } from '../src/tui.js';

const CLEAR = '\x1b[2J\x1b[3J\x1b[H'; // wipe screen + SCROLLBACK (3J) + home — same as /clear

test('startupSequence: non-TTY emits nothing (piped/CI stays clean)', () => {
  assert.equal(startupSequence(false, {}), '');
  assert.equal(startupSequence(false, { SHADOW_KEEP_SCROLLBACK: '1' }), '');
});

test('startupSequence: on a TTY, sets the title AND wipes scrollback by default', () => {
  const s = startupSequence(true, {});
  assert.match(s, /\x1b\]2;Shadow\x07/, 'sets terminal title to Shadow (hide cwd)');
  assert.match(s, /\x1b\[22;2t/, 'pushes the prior title onto the stack');
  assert.ok(s.includes(CLEAR), 'wipes screen + scrollback so pre-launch shell history cannot be scrolled to');
  assert.ok(s.includes('\x1b[3J'), 'specifically clears the SCROLLBACK (3J), not just the visible screen');
});

test('startupSequence: SHADOW_KEEP_SCROLLBACK=1 keeps the title but preserves history', () => {
  const s = startupSequence(true, { SHADOW_KEEP_SCROLLBACK: '1' });
  assert.match(s, /\x1b\]2;Shadow\x07/, 'still sets the title');
  assert.ok(!s.includes('\x1b[3J'), 'does NOT wipe scrollback when opted out');
  assert.ok(!s.includes('\x1b[2J'), 'does not wipe the visible screen either');
});
