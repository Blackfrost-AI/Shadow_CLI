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

test('wraps a frame write in synchronized-output brackets (atomic repaint)', () => {
  const { stream, writes } = mockStream();
  withSynchronizedOutput(stream).write('FRAME');
  assert.equal(writes[0], BSU + 'FRAME' + ESU);
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
