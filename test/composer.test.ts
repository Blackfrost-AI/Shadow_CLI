import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isPathLikeSlashToken, isBigPaste, expandPastes } from '../src/tui/composer.js';

test('isPathLikeSlashToken: a pasted directory path reads as a path, not a command', () => {
  assert.equal(isPathLikeSlashToken('/Users/craigmac/shadow-cli'), true);
  assert.equal(isPathLikeSlashToken('/etc/hosts'), true);
  assert.equal(isPathLikeSlashToken('/tmp/foo.txt'), true); // dot
  assert.equal(isPathLikeSlashToken('/var/log'), true);
});

test('isPathLikeSlashToken: a bare command stays a command', () => {
  assert.equal(isPathLikeSlashToken('/model'), false);
  assert.equal(isPathLikeSlashToken('/compact'), false);
  assert.equal(isPathLikeSlashToken('/modl'), false); // typo — still command-shaped (on-disk check at call site)
});

test('isBigPaste: multi-line or long condenses; short single-line stays inline', () => {
  assert.equal(isBigPaste('a\nb\nc'), true); // 3 lines
  assert.equal(isBigPaste('x'.repeat(400)), true); // long
  assert.equal(isBigPaste('/Users/craigmac/foo'), false); // a pasted path stays inline (still typable)
  assert.equal(isBigPaste('one line'), false);
  assert.equal(isBigPaste('two\nlines'), false); // only one newline — keep inline
});

test('expandPastes: chips are restored to their stored content at submit', () => {
  const pastes = [
    { id: 1, content: '/* css */\nbody{}' },
    { id: 2, content: 'second blob' },
  ];
  assert.equal(
    expandPastes('here: [Pasted text #1 +2 lines] and [Pasted text #2 +1 lines]', pastes),
    'here: /* css */\nbody{} and second blob',
  );
});

test('expandPastes: no chips or empty registry → text unchanged', () => {
  assert.equal(expandPastes('just a message', []), 'just a message');
  assert.equal(expandPastes('no chips here', [{ id: 1, content: 'x' }]), 'no chips here');
});

test('expandPastes: a chip whose paste was cleared is left as-is (never crashes)', () => {
  assert.equal(expandPastes('[Pasted text #9 +5 lines]', [{ id: 1, content: 'x' }]), '[Pasted text #9 +5 lines]');
});
