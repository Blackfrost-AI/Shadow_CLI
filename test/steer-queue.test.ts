import { test } from 'node:test';
import assert from 'node:assert/strict';
import { dropOneQueuedByText, queuedAhead } from '../src/agent/steerQueue.js';

// These two helpers encode the FIFO rules the steering protocol depends on. They are shared by
// BOTH frontends (src/app/app.ts and src/tui.tsx / src/tui/keys/composerOwner.ts), so a mistake
// here silently drops or reorders a user's messages.

test('dropOneQueuedByText removes exactly one entry, keeping order', () => {
  const queue = [{ text: 'a' }, { text: 'b' }, { text: 'c' }];
  assert.deepEqual(dropOneQueuedByText(queue, 'b')?.map((q) => q.text), ['a', 'c']);
});

test('dropOneQueuedByText removes ONE of two identical messages, not both', () => {
  // Regression: filtering by text alone (`filter(q => q.text !== text)`) deleted BOTH entries, so a
  // user who typed "yes" twice got only one reply. Each queued message is a distinct intent.
  const queue = [{ text: 'yes' }, { text: 'yes' }];
  const after = dropOneQueuedByText(queue, 'yes');
  assert.equal(after?.length, 1);
  assert.equal(after?.[0].text, 'yes');
});

test('dropOneQueuedByText drops the FIRST match so later duplicates stay queued', () => {
  const queue = [{ text: 'go' }, { text: 'other' }, { text: 'go' }];
  const after = dropOneQueuedByText(queue, 'go');
  assert.deepEqual(after?.map((q) => q.text), ['other', 'go']);
});

test('dropOneQueuedByText returns null when nothing matches (no spurious re-render)', () => {
  assert.equal(dropOneQueuedByText([{ text: 'a' }], 'zzz'), null);
  assert.equal(dropOneQueuedByText([], 'a'), null);
});

test('dropOneQueuedByText does not mutate the input queue', () => {
  const queue = [{ text: 'a' }, { text: 'b' }];
  const copy = queue.map((q) => q.text);
  dropOneQueuedByText(queue, 'a');
  assert.deepEqual(queue.map((q) => q.text), copy);
});

test('queuedAhead counts only entries submitted before the last one', () => {
  // The submitted entry is pushed last, so it must not count itself.
  assert.equal(queuedAhead([{ text: 'new' }]), 0);
  assert.equal(queuedAhead([{ text: 'earlier' }, { text: 'new' }]), 1);
  assert.equal(queuedAhead([{ text: 'a' }, { text: 'b' }, { text: 'new' }]), 2);
});

test('queuedAhead ignores blank entries so an empty submission cannot block steering', () => {
  assert.equal(queuedAhead([{ text: '   ' }, { text: 'new' }]), 0);
  assert.equal(queuedAhead([{ text: '' }, { text: '\t' }, { text: 'new' }]), 0);
  assert.equal(queuedAhead([{ text: '/compact' }, { text: 'new' }]), 1);
});
