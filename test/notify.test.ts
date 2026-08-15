import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  detectNotifyChannel,
  resolveNotifyChannel,
  notifySequence,
  emitNotification,
} from '../src/util/notify.js';

test('detectNotifyChannel maps terminals to their native channel, else bell', () => {
  assert.equal(detectNotifyChannel({ TERM_PROGRAM: 'iTerm.app' }), 'iterm2');
  assert.equal(detectNotifyChannel({ TERM_PROGRAM: 'ghostty' }), 'ghostty');
  assert.equal(detectNotifyChannel({ GHOSTTY_RESOURCES_DIR: '/x' }), 'ghostty');
  assert.equal(detectNotifyChannel({ TERM_PROGRAM: 'kitty' }), 'kitty');
  assert.equal(detectNotifyChannel({ KITTY_WINDOW_ID: '1' }), 'kitty');
  assert.equal(detectNotifyChannel({ TERM: 'xterm-kitty' }), 'kitty');
  assert.equal(detectNotifyChannel({ TERM_PROGRAM: 'Apple_Terminal' }), 'bell');
  assert.equal(detectNotifyChannel({}), 'bell');
});

test('resolveNotifyChannel honors explicit channels and off', () => {
  assert.equal(resolveNotifyChannel('off'), null);
  assert.equal(resolveNotifyChannel('bell'), 'bell');
  assert.equal(resolveNotifyChannel('iterm2'), 'iterm2');
  assert.equal(resolveNotifyChannel('auto', { TERM_PROGRAM: 'iTerm.app' }), 'iterm2');
});

test('notifySequence produces the right escape per channel and sanitizes injected control bytes', () => {
  assert.equal(notifySequence('iterm2', 'Turn done', 'ok'), '\x1b]9;Turn done: ok\x07');
  assert.equal(notifySequence('kitty', 'Turn done'), '\x1b]99;;Turn done\x1b\\');
  assert.match(notifySequence('ghostty', 'Turn done', 'ok'), /^\x1b\]777;notify;Turn done;ok\x07$/);
  assert.equal(notifySequence('bell', 'whatever'), '\x07');
  // A crafted title cannot smuggle its own OSC/ST bytes into the stream.
  const evil = notifySequence('iterm2', 'a\x1b]9;evil\x07b', 'c\x07d');
  assert.ok(!evil.includes('evil\x07'), 'embedded escapes are stripped');
});

test('emitNotification never writes into a non-TTY (pipe-guard)', () => {
  const writes: string[] = [];
  const w = (s: string) => writes.push(s);
  assert.equal(emitNotification('bell', 't', 'b', { isTTY: false, write: w }), '');
  assert.equal(writes.length, 0, 'nothing written into a pipe');
  const seq = emitNotification('bell', 't', 'b', { isTTY: true, write: w });
  assert.equal(seq, '\x07');
  assert.deepEqual(writes, ['\x07']);
});

test('emitNotification off is silent even on a TTY', () => {
  const writes: string[] = [];
  assert.equal(emitNotification('off', 't', 'b', { isTTY: true, write: (s) => writes.push(s) }), '');
  assert.equal(writes.length, 0);
});

test('emitNotification auto resolves the terminal channel', () => {
  const writes: string[] = [];
  const seq = emitNotification('auto', 'Turn complete', '3 tools', { isTTY: true, write: (s) => writes.push(s), env: { TERM_PROGRAM: 'iTerm.app' } });
  assert.equal(seq, '\x1b]9;Turn complete: 3 tools\x07');
});
