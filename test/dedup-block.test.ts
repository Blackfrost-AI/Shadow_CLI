import { test } from 'node:test';
import assert from 'node:assert/strict';
import { dupKey, repeatStep } from '../src/tui.js';

test('dupKey: strips emoji/punctuation/whitespace, keeps letters+digits lowercased', () => {
  assert.equal(dupKey('Thanks! Glad I could help. 😊'), 'thanksgladicouldhelp');
  assert.equal(dupKey('Thanks!  Glad   I could help.'), 'thanksgladicouldhelp');
});

/** Drive a sequence of blocks through the detector and return which ones were SUPPRESSED. */
function feed(blocks: string[]): boolean[] {
  let run: string[] = [];
  let pos = 0;
  return blocks.map((b) => {
    const r = repeatStep(run, pos, dupKey(b));
    run = r.run;
    pos = r.pos;
    return r.suppress;
  });
}

test('repeatStep: the exact screenshot case — whole answer re-emitted, differing only by an emoji', () => {
  const a = 'Thanks! Glad I could help. If you ever need weather for another city, just say the word. 😊';
  const reemit = 'Thanks! Glad I could help. If you ever need weather for another city, just say the word.';
  // First copy commits, the verbatim (emoji-normalized) re-emit is suppressed.
  assert.deepEqual(feed([a, reemit]), [false, true]);
});

test('repeatStep: a MULTI-block answer repeated verbatim suppresses the whole second run', () => {
  const blocks = ['Here is the first paragraph of the answer.', 'And here is the second paragraph with more detail.'];
  // [A, B, A, B] → the second A,B are the repeat.
  assert.deepEqual(feed([...blocks, ...blocks]), [false, false, true, true]);
});

test('repeatStep: repeat then GENUINELY NEW trailing content — the new block still commits', () => {
  const A = 'Here is the first paragraph of the answer.';
  const B = 'And here is the second paragraph with more detail.';
  const C = 'One more thing I forgot to mention earlier here.';
  // [A, B, A, B, C] → A,B repeat suppressed, C is new and commits.
  assert.deepEqual(feed([A, B, A, B, C]), [false, false, true, true, false]);
});

test('repeatStep: distinct answers are NOT deduped', () => {
  assert.deepEqual(
    feed(['The capital of France is Paris.', 'The capital of Japan is Tokyo.']),
    [false, false],
  );
});

test('repeatStep: an identical short answer in a LATER turn commits (turn-scoped, not global)', () => {
  // The detector is reset between turns, so "Done, all tests pass now." said in two turns is fine.
  const line = 'Done, all tests pass now.';
  // Simulate two turns: each turn starts with a fresh (run=[], pos=0).
  assert.deepEqual(feed([line]), [false]); // turn 1
  assert.deepEqual(feed([line]), [false]); // turn 2 (fresh state) still commits
});

test('repeatStep: short blocks (<12 normalized chars) are never deduped', () => {
  // "Done!" / "Done." normalize to "done" (4 chars) — below the threshold, so both commit; we must
  // not eat a legitimately-repeated short acknowledgement.
  assert.deepEqual(feed(['Done!', 'Done.']), [false, false]);
});

test('repeatStep: a triple emission suppresses both repeats', () => {
  const A = 'The weather in Denver today is sunny and about seventy-five degrees.';
  assert.deepEqual(feed([A, A, A]), [false, true, true]);
});

test('repeatStep: partial repeat that then diverges commits the divergent block', () => {
  const A = 'First block of the streamed answer here.';
  const B = 'Second block of the streamed answer here.';
  const B2 = 'Actually the second block is different this time.';
  // [A, B, A, B2] → A repeats (suppressed at pos 0→1), B2 breaks the repeat → commits.
  assert.deepEqual(feed([A, B, A, B2]), [false, false, true, false]);
});
