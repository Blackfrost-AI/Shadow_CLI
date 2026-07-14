import { test } from 'node:test';
import assert from 'node:assert/strict';
import { formatDiffStats } from '../src/tui.js';

test('formatDiffStats: counts + and − lines, ignores elision and file headers', () => {
  assert.equal(formatDiffStats([]), '');
  assert.equal(
    formatDiffStats([
      { text: '… 5 earlier lines omitted …' },
      { text: '+++ b/foo' },
      { text: '--- a/foo' },
      { text: '+added' },
      { text: '+also' },
      { text: '-removed' },
      { text: ' context' },
    ]),
    '+2 −1',
  );
  assert.equal(formatDiffStats([{ text: '+only' }]), '+1');
  assert.equal(formatDiffStats([{ text: '-only' }]), '−1');
});
