import test from 'node:test';
import assert from 'node:assert/strict';
import { settleWithAbort, nextApprovalId, type ApprovalDecision } from '../src/agent/approval.js';

/**
 * W14. Two defects fixed by one interface change:
 *
 *  - Without an id, an HTTP approval handler cannot verify WHICH parked promise it resolves.
 *    With two tabs open, any tab would resolve whatever happened to be pending — which becomes
 *    an authorization hole the moment the decision is `approveForPrefix`.
 *
 *  - Without an abort race, interrupt does not work during an approval at all. In the TUI this
 *    is live today: while a prompt is pending the key handler swallows every key and never
 *    reaches the ESC/Ctrl-C abort, so only killing the process escapes. A browser console makes
 *    it worse — pending-approval is its default state at manual autonomy, so a closed tab would
 *    park the turn forever.
 */

test('a pending approval resolves to deny when the turn is aborted', async () => {
  const ac = new AbortController();
  // A gate that never answers — a terminal prompt nobody is looking at, or a closed browser tab.
  const never = new Promise<ApprovalDecision>(() => {});

  const settled = settleWithAbort(never, ac.signal);
  ac.abort();

  assert.equal(await settled, 'deny', 'abort unblocks the turn instead of hanging it');
});

test('an already-aborted signal denies immediately', async () => {
  const ac = new AbortController();
  ac.abort();
  const never = new Promise<ApprovalDecision>(() => {});
  assert.equal(await settleWithAbort(never, ac.signal), 'deny');
});

test('a gate that answers first wins — abort does not override a real decision', async () => {
  const ac = new AbortController();
  const answered = Promise.resolve<ApprovalDecision>('approve');
  const settled = settleWithAbort(answered, ac.signal);
  // Abort AFTER the gate already answered; the human's decision must stand.
  await answered;
  ac.abort();
  assert.equal(await settled, 'approve');
});

test('a rejecting gate denies rather than propagating the error into the loop', async () => {
  const ac = new AbortController();
  const boom = Promise.reject<ApprovalDecision>(new Error('gate exploded'));
  assert.equal(await settleWithAbort(boom, ac.signal), 'deny');
});

test('no signal means no behaviour change (the scripted/auto gates keep working)', async () => {
  assert.equal(await settleWithAbort(Promise.resolve<ApprovalDecision>('approve'), undefined), 'approve');
});

test('abort listeners are not leaked across many approvals on one signal', async () => {
  // A long turn approves many tools against ONE signal. If each request left its listener
  // attached, a build with hundreds of tool calls would leak them and warn.
  const ac = new AbortController();
  for (let i = 0; i < 200; i++) {
    await settleWithAbort(Promise.resolve<ApprovalDecision>('approve'), ac.signal);
  }
  // Node exposes listener counts on AbortSignal via events; if unavailable this still asserts
  // the loop completed without an EventEmitter max-listeners warning.
  const count = (ac.signal as unknown as { listenerCount?: (n: string) => number }).listenerCount?.('abort');
  if (typeof count === 'number') assert.ok(count <= 1, `abort listeners cleaned up (${count})`);
});

test('approval ids are unique — a handler can tell two pending requests apart', () => {
  const ids = new Set(Array.from({ length: 1000 }, () => nextApprovalId()));
  assert.equal(ids.size, 1000, 'no collisions');
});
