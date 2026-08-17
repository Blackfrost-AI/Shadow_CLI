import { test } from 'node:test';
import assert from 'node:assert/strict';
import { withSynchronizedOutput } from '../src/tui/syncOutput.js';

const BSU = '\x1b[?2026h';
const ESU = '\x1b[?2026l';

function mockStream(): { stream: NodeJS.WriteStream; writes: string[] } {
  const writes: string[] = [];
  const stream = {
    write: (chunk: unknown) => {
      writes.push(String(chunk));
      return true;
    },
    columns: 120,
    rows: 40,
    isTTY: true,
    on: () => stream,
  } as unknown as NodeJS.WriteStream;
  return { stream, writes };
}

test('one frame = one bracket: writes in the same tick share a single BSU…ESU pair', async () => {
  // An Ink frame is several writes (clear-lines, frame, cursor) issued back-to-back. Bracketing
  // each write flipped the terminal 3× per frame — the half-drawn flicker DEC-2026 exists to kill.
  const { stream, writes } = mockStream();
  const w = withSynchronizedOutput(stream);
  w.write('CLEAR');
  w.write('FRAME');
  w.write('CURSOR');
  // Still open mid-batch: first write carries BSU, the rest go bare — no ESU between them.
  assert.deepEqual(writes, [BSU + 'CLEAR', 'FRAME', 'CURSOR']);
  await new Promise((r) => setImmediate(r));
  assert.equal(writes[3], ESU, 'section closes at end of tick');
  assert.equal(writes.filter((x) => x.startsWith(BSU)).length, 1, 'exactly one BSU');
  assert.equal(writes.filter((x) => x === ESU).length, 1, 'exactly one ESU');
});

test('writes in a later tick open a fresh section (frames stay separate)', async () => {
  const { stream, writes } = mockStream();
  const w = withSynchronizedOutput(stream);
  const tick = () => new Promise((r) => setImmediate(r));
  w.write('frame-1');
  await tick();
  w.write('frame-2');
  await tick();
  assert.equal(writes.filter((x) => x.startsWith(BSU)).length, 2, 'two sections');
  assert.equal(writes.filter((x) => x === ESU).length, 2);
  assert.equal(writes[0], BSU + 'frame-1');
  assert.equal(writes[1], ESU);
  assert.equal(writes[2], BSU + 'frame-2');
  assert.equal(writes[3], ESU);
});

test('delegates non-write properties straight through (columns/rows/isTTY)', () => {
  const w = withSynchronizedOutput(mockStream().stream);
  assert.equal(w.columns, 120);
  assert.equal(w.rows, 40);
  assert.equal(w.isTTY, true);
});

test('does not bracket an empty write', () => {
  const { stream, writes } = mockStream();
  withSynchronizedOutput(stream).write('');
  assert.equal(writes[0], ''); // untouched — no BSU/ESU around nothing
  // And the empty write did not OPEN a section: the next real write starts one cleanly.
  withSynchronizedOutput(stream).write('X');
  assert.deepEqual(writes.slice(1), [BSU + 'X']);
});

test('SHADOW_NO_SYNC_OUTPUT disables the wrapper (returns the raw stream)', () => {
  const prev = process.env.SHADOW_NO_SYNC_OUTPUT;
  process.env.SHADOW_NO_SYNC_OUTPUT = '1';
  try {
    const { stream, writes } = mockStream();
    const w = withSynchronizedOutput(stream);
    assert.equal(w, stream); // same object — no proxy
    w.write('FRAME');
    assert.equal(writes[0], 'FRAME'); // not bracketed
  } finally {
    if (prev === undefined) delete process.env.SHADOW_NO_SYNC_OUTPUT;
    else process.env.SHADOW_NO_SYNC_OUTPUT = prev;
  }
});
