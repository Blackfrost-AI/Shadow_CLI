import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseOpenAISSE } from '../src/provider/openai.js';
import type { ProviderEvent } from '../src/provider/provider.js';

/**
 * C1 — a 200 that is not an SSE stream used to produce a CLEAN EMPTY TURN, forever.
 *
 * A gateway that ignores `stream: true` (misconfigured LiteLLM/vLLM, a corporate proxy, an older
 * Ollama /v1) answers with a plain JSON completion body. Every line of it fails the `data:` test
 * and was skipped, so the parse produced exactly [usage 0/0/0, done end_turn] — no text, no tool
 * calls, no error. The agent loop saw a clean finish and stopped. Every turn came back blank with
 * no diagnostic anywhere, and the non-stream fallback could not help because it only fires when
 * the parse THROWS, which this never did.
 */
async function* fromBody(body: string): AsyncIterable<string> {
  for (const l of body.split('\n')) yield l;
}
async function collect(body: string): Promise<ProviderEvent[]> {
  const out: ProviderEvent[] = [];
  for await (const e of parseOpenAISSE(fromBody(body))) out.push(e);
  return out;
}
const texts = (evs: ProviderEvent[]): string =>
  evs.filter((e) => e.type === 'text').map((e) => (e as { delta: string }).delta).join('');
const errs = (evs: ProviderEvent[]): string[] =>
  evs.filter((e) => e.type === 'error').map((e) => (e as { code: string }).code);

test('a non-streamed completion body is RECOVERED, not silently dropped', async () => {
  const evs = await collect(
    JSON.stringify({
      id: 'x',
      choices: [{ message: { role: 'assistant', content: 'hello from a non-streaming gateway' }, finish_reason: 'stop' }],
      usage: { prompt_tokens: 10, completion_tokens: 5 },
    }),
  );
  assert.equal(texts(evs), 'hello from a non-streaming gateway', 'the turn must not be blank');
  assert.deepEqual(errs(evs), [], 'a recoverable body is not an error');
  const usage = evs.find((e) => e.type === 'usage') as { inputTokens: number; outputTokens: number };
  assert.equal(usage.inputTokens, 10, 'usage comes across too');
  assert.equal(usage.outputTokens, 5);
});

test('tool calls in a non-streamed body are recovered as well', async () => {
  const evs = await collect(
    JSON.stringify({
      choices: [
        {
          message: {
            role: 'assistant',
            tool_calls: [{ id: 'c1', function: { name: 'read_file', arguments: '{"path":"a.ts"}' } }],
          },
          finish_reason: 'tool_calls',
        },
      ],
    }),
  );
  const call = evs.find((e) => e.type === 'tool_call') as { call: { name: string } } | undefined;
  assert.equal(call?.call.name, 'read_file');
  const done = evs.find((e) => e.type === 'done') as { stopReason: string };
  assert.equal(done.stopReason, 'tool_use');
});

test('an unusable 200 says so LOUDLY instead of finishing clean', async () => {
  for (const [label, body] of [
    ['empty body', ''],
    ['an HTML error page', '<html><body>502 Bad Gateway</body></html>'],
    ['prose', 'Service Unavailable'],
  ] as const) {
    const evs = await collect(body);
    assert.ok(errs(evs).includes('not_sse'), `${label} must surface not_sse`);
    const err = evs.find((e) => e.type === 'error') as { message: string };
    assert.match(err.message, /ignoring `stream: true`/, `${label}: the message must name the cause`);
  }
});

test('the not_sse message quotes the body so the gateway is identifiable', async () => {
  const evs = await collect('<html><body>502 Bad Gateway from squid-proxy</body></html>');
  const err = evs.find((e) => e.type === 'error') as { message: string };
  assert.match(err.message, /squid-proxy/, 'the first bytes are quoted back');
});

test('a REAL SSE stream is completely unaffected', async () => {
  const evs = await collect(
    ['data: ' + JSON.stringify({ choices: [{ delta: { content: 'hi' } }] }), 'data: [DONE]'].join('\n'),
  );
  assert.equal(texts(evs), 'hi');
  assert.deepEqual(errs(evs), [], 'no false not_sse on a legitimate stream');
});

test('a stream that legitimately yields nothing is NOT reported as not_sse', async () => {
  // `data: [DONE]` alone is a real (if empty) stream — erroring here would break valid cases.
  const evs = await collect('data: [DONE]');
  assert.deepEqual(errs(evs), []);
  assert.ok(evs.some((e) => e.type === 'done'));
});
