import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { getEventListeners } from 'node:events';
import { rmSync } from 'node:fs';
import { isolateHome } from './helpers/isolateHome.js';

const isolated = isolateHome('stream-interrupt');
const { streamLines, streamWithRetry, fetchNonStreamResponse } = await import('../src/provider/stream.js');
after(() => rmSync(isolated.home, { recursive: true, force: true }));

async function promptly<T>(promise: Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error('cancellation left the body read pending')), 1500);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

test('interrupt releases a stalled body even when transport cancellation never settles', async () => {
  const controller = new AbortController();
  let cancelled = 0;
  const body = new ReadableStream<Uint8Array>({
    start(stream) { stream.enqueue(new TextEncoder().encode('partial response\n')); },
    cancel() { cancelled++; return new Promise<void>(() => {}); },
  });
  const lines = streamLines(body, undefined, controller.signal)[Symbol.asyncIterator]();
  assert.equal((await lines.next()).value, 'partial response');
  const pending = lines.next();
  controller.abort();
  await assert.rejects(promptly(pending), { name: 'AbortError' });
  assert.equal(cancelled, 1);
  assert.equal(body.locked, false);
  assert.equal(getEventListeners(controller.signal, 'abort').length, 0);
});

test('interrupt drops buffered lines and does not emit an obsolete stream tail', async () => {
  const controller = new AbortController();
  const body = new ReadableStream<Uint8Array>({
    start(stream) { stream.enqueue(new TextEncoder().encode('first\nsecond\npartial')); },
  });
  const lines = streamLines(body, undefined, controller.signal)[Symbol.asyncIterator]();
  assert.equal((await lines.next()).value, 'first');
  controller.abort();
  await assert.rejects(promptly(lines.next()), { name: 'AbortError' });
  assert.equal(body.locked, false);
});

test('an already interrupted response never delivers buffered content', async () => {
  const controller = new AbortController();
  controller.abort();
  const body = new ReadableStream<Uint8Array>({
    start(stream) { stream.enqueue(new TextEncoder().encode('obsolete\n')); },
  });
  const lines = streamLines(body, undefined, controller.signal)[Symbol.asyncIterator]();
  await assert.rejects(promptly(lines.next()), { name: 'AbortError' });
  assert.equal(body.locked, false);
});

test('normal body decoding preserves split Unicode and the final unterminated line', async () => {
  const controller = new AbortController();
  const bytes = new TextEncoder().encode('café\n漢字');
  let chunks = 0;
  const body = new ReadableStream<Uint8Array>({
    start(stream) {
      stream.enqueue(bytes.slice(0, 4));
      stream.enqueue(bytes.slice(4, 8));
      stream.enqueue(bytes.slice(8));
      stream.close();
    },
  });
  const output: string[] = [];
  for await (const line of streamLines(body, () => { chunks++; }, controller.signal)) output.push(line);
  assert.deepEqual(output, ['café', '漢字']);
  assert.equal(chunks, 3);
  assert.equal(body.locked, false);
  assert.equal(getEventListeners(controller.signal, 'abort').length, 0);
});

for (const status of [200, 401, 429, 500]) {
  test(`interrupt stops a stalled HTTP ${status} body without retry or fallback`, async (t) => {
    const controller = new AbortController();
    let requests = 0;
    const bodies: ReadableStreamDefaultController<Uint8Array>[] = [];
    t.after(() => { for (const body of bodies) body.error(new Error('test cleanup')); });
    let bodyRead!: () => void;
    const reading = new Promise<void>((resolve) => { bodyRead = resolve; });
    t.mock.method(globalThis, 'fetch', async () => {
      requests++;
      return new Response(new ReadableStream<Uint8Array>({
        start(body) { bodies.push(body); },
        pull() { bodyRead(); },
      }), { status });
    });
    const events: unknown[] = [];
    const running = (async () => {
      for await (const event of streamWithRetry({
        url: 'http://127.0.0.1:1/v1/chat/completions', headers: {}, body: {}, signal: controller.signal,
        parse: async function* (lines) { for await (const line of lines) yield { type: 'text', delta: line }; },
        nonStreamBody: { stream: false },
        parseNonStream: function* () { yield { type: 'text', delta: 'unexpected fallback' }; },
      })) events.push(event);
    })();
    await promptly(reading);
    controller.abort();
    await promptly(running);
    assert.deepEqual(events, []);
    assert.equal(requests, 1);
  });
}

for (const status of [200, 500]) {
  test(`interrupt releases a stalled non-streaming HTTP ${status} response`, async (t) => {
    const controller = new AbortController();
    let bodyController: ReadableStreamDefaultController<Uint8Array> | undefined;
    t.after(() => bodyController?.error(new Error('test cleanup')));
    let bodyRead!: () => void;
    const reading = new Promise<void>((resolve) => { bodyRead = resolve; });
    t.mock.method(globalThis, 'fetch', async () => new Response(new ReadableStream<Uint8Array>({
      start(body) { bodyController = body; },
      pull() { bodyRead(); },
    }), { status }));
    const pending = fetchNonStreamResponse('http://127.0.0.1:1/v1/chat/completions', {}, {}, controller.signal);
    await promptly(reading);
    controller.abort();
    await assert.rejects(promptly(pending), { name: 'AbortError' });
  });
}
