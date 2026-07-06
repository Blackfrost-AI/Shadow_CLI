import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { ProviderEvent } from '../src/provider/provider.js';

/**
 * Regression: nonStreamFallback must return false after yielding
 * non_stream_fallback_failed so streamWithRetry can surface stream_error.
 */
test('failed non-stream fallback does not suppress stream_error', async () => {
  const orig = globalThis.fetch;
  globalThis.fetch = async (_url, init) => {
    const body = init?.body ? (JSON.parse(init.body as string) as { stream?: boolean }) : {};
    if (body.stream === false) throw new Error('non-stream POST failed');
    return {
      ok: true,
      status: 200,
      body: new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(new TextEncoder().encode('line\n'));
          controller.close();
        },
      }),
    } as Response;
  };

  try {
    const { streamWithRetry } = await import('../src/provider/stream.js');
    const events: ProviderEvent[] = [];
    for await (const e of streamWithRetry({
      url: 'http://mock/test',
      headers: { 'Content-Type': 'application/json' },
      body: { stream: true },
      nonStreamBody: { stream: false },
      // eslint-disable-next-line require-yield -- intentionally throws before yielding (emitted===0 path)
      parse: async function* (lines) {
        // throw BEFORE emitting anything → fallback IS attempted (nothing was streamed yet)
        for await (const line of lines) {
          void line;
          throw new Error('parse blew up');
        }
      },
      parseNonStream: () => {
        throw new Error('unreachable');
      },
    })) {
      events.push(e);
    }

    const codes = events.filter((e) => e.type === 'error').map((e) => e.code);
    assert.ok(codes.includes('non_stream_fallback_failed'), codes.join(','));
    assert.ok(codes.includes('stream_error'), codes.join(','));
  } finally {
    globalThis.fetch = orig;
  }
});

/**
 * Regression: after PARTIAL output (some events already streamed), a mid-stream failure must NOT trigger
 * the non-stream re-fetch — that would duplicate the text/tool calls already delivered. It surfaces
 * stream_error directly, and the already-streamed text appears exactly once.
 */
test('mid-stream failure after partial output does not re-fetch (no duplication)', async () => {
  const orig = globalThis.fetch;
  let nonStreamCalls = 0;
  globalThis.fetch = async (_url, init) => {
    const body = init?.body ? (JSON.parse(init.body as string) as { stream?: boolean }) : {};
    if (body.stream === false) {
      nonStreamCalls++;
      throw new Error('non-stream POST should never be called here');
    }
    return {
      ok: true,
      status: 200,
      body: new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(new TextEncoder().encode('line\n'));
          controller.close();
        },
      }),
    } as Response;
  };
  try {
    const { streamWithRetry } = await import('../src/provider/stream.js');
    const events: ProviderEvent[] = [];
    for await (const e of streamWithRetry({
      url: 'http://mock/test',
      headers: {},
      body: { stream: true },
      nonStreamBody: { stream: false },
      parse: async function* (lines) {
        yield { type: 'text', delta: 'start' }; // partial output emitted
        for await (const line of lines) {
          void line;
          throw new Error('parse blew up after emitting');
        }
      },
      parseNonStream: () => {
        throw new Error('unreachable');
      },
    })) {
      events.push(e);
    }
    const codes = events.filter((e) => e.type === 'error').map((e) => e.code);
    const textCount = events.filter((e) => e.type === 'text').length;
    assert.equal(nonStreamCalls, 0, 'must NOT re-fetch after partial output');
    assert.ok(!codes.includes('non_stream_fallback_failed'), 'no fallback attempted');
    assert.ok(codes.includes('stream_error'), 'surfaces stream_error directly');
    assert.equal(textCount, 1, 'the streamed text is delivered exactly once (not duplicated)');
  } finally {
    globalThis.fetch = orig;
  }
});