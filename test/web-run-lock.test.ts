process.env.NODE_ENV = 'test'; // __resetRunLock is test-gated; set before importing the lock

import test, { beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { runLock, __resetRunLock, CLI_HOLDER } from '../src/web/runLock.js';

/** Turn a pending acquire into an observable so a test can assert it has/hasn't resolved. */
function track<T>(p: Promise<T>): { p: Promise<T>; done: () => boolean; value: () => T | undefined } {
  let resolved = false;
  let value: T | undefined;
  p.then(
    (v) => {
      resolved = true;
      value = v;
    },
    () => {
      resolved = true;
    },
  );
  return { p, done: () => resolved, value: () => value };
}

const tick = (): Promise<void> => new Promise((r) => setImmediate(r));

beforeEach(() => __resetRunLock());

test('tryAcquire is null while the lock is held', () => {
  const r = runLock.tryAcquire('A');
  assert.ok(r, 'first tryAcquire succeeds');
  assert.equal(runLock.tryAcquire('B'), null, 'second is null while held');
  r!();
  assert.ok(runLock.tryAcquire('C'), 'available again after release');
});

test('waiters are served FIFO', async () => {
  const rA = await runLock.acquire('A');
  const order: string[] = [];
  const pB = runLock.acquire('B').then((r) => (order.push('B'), r));
  const pC = runLock.acquire('C').then((r) => (order.push('C'), r));
  const pD = runLock.acquire('D').then((r) => (order.push('D'), r));

  assert.deepEqual(runLock.state().waiting, ['B', 'C', 'D']);
  rA();
  (await pB)();
  (await pC)();
  (await pD)();
  assert.deepEqual(order, ['B', 'C', 'D']);
});

test('priority:true jumps ahead of queued normal waiters (the operator is never starved)', async () => {
  const rA = await runLock.acquire('A');
  const order: string[] = [];
  const pB = runLock.acquire('web-b').then((r) => (order.push('web-b'), r));
  const pC = runLock.acquire('web-c').then((r) => (order.push('web-c'), r));
  const pCli = runLock.acquire(CLI_HOLDER, { priority: true }).then((r) => (order.push(CLI_HOLDER), r));

  assert.deepEqual(runLock.state().waiting, [CLI_HOLDER, 'web-b', 'web-c'], 'cli jumped to the front');
  rA();
  (await pCli)();
  (await pB)();
  (await pC)();
  assert.deepEqual(order, [CLI_HOLDER, 'web-b', 'web-c']);
});

test('a double release is a no-op and never hands the lock to two waiters', async () => {
  const rA = await runLock.acquire('A');
  const pB = track(runLock.acquire('B'));
  const pC = track(runLock.acquire('C'));

  rA(); // → B
  await pB.p;
  assert.equal(runLock.state().holder, 'B');
  rA(); // stale double release — must NOT hand the lock to C
  await tick();
  assert.equal(runLock.state().holder, 'B', 'B still holds');
  assert.equal(pC.done(), false, 'C did not get spuriously granted');
  assert.deepEqual(runLock.state().waiting, ['C']);

  pB.value()!(); // release B → C
  await pC.p;
  assert.equal(runLock.state().holder, 'C');
});

test('a throwing critical section still releases the lock (finally discipline)', async () => {
  const rA = await runLock.acquire('A');
  const pB = runLock.acquire('B');
  await assert.rejects(
    (async () => {
      try {
        throw new Error('boom');
      } finally {
        rA();
      }
    })(),
    /boom/,
  );
  const rB = await pB; // B got the lock despite A's section throwing
  assert.equal(runLock.state().holder, 'B');
  rB();
});

test('an abort while queued de-queues the waiter, rejects it, and never acquires', async () => {
  const rA = await runLock.acquire('A');
  const ac = new AbortController();
  const pB = runLock.acquire('B', { signal: ac.signal });
  const pC = track(runLock.acquire('C'));

  assert.deepEqual(runLock.state().waiting, ['B', 'C']);
  ac.abort();
  await assert.rejects(pB, { name: 'AbortError' });
  assert.deepEqual(runLock.state().waiting, ['C'], 'B removed from the queue');

  rA(); // the lock passes to C, NOT wedged behind the aborted B
  await pC.p;
  assert.equal(runLock.state().holder, 'C');
});

test('acquiring with an already-aborted signal rejects without ever queuing', async () => {
  const rA = await runLock.acquire('A');
  const ac = new AbortController();
  ac.abort();
  await assert.rejects(runLock.acquire('B', { signal: ac.signal }), { name: 'AbortError' });
  assert.deepEqual(runLock.state().waiting, [], 'nothing queued');
  rA();
});

test('releaseFor drops a holder and de-queues its waiters (teardown), never wedging others', async () => {
  const rA = await runLock.acquire('A');
  void rA;
  const pDead = track(runLock.acquire('dead'));
  const pLive = track(runLock.acquire('live'));

  // 'dead' is queued behind A; tear its holder down entirely.
  runLock.releaseFor('dead');
  await assert.rejects(pDead.p);
  assert.deepEqual(runLock.state().waiting, ['live']);

  // Now tear down the current holder A: the lock passes to 'live'.
  runLock.releaseFor('A');
  await pLive.p;
  assert.equal(runLock.state().holder, 'live');
});
