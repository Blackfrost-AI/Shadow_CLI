// A serve that rejects an output-token cap must be ADAPTED TO, not treated as fatal.
//
// The reported failure: a model served with a 64k output ceiling against a 128000 config became
// UNUSABLE — not slow, not degraded, dead on turn 1:
//
//   http_400: {"object":"error","message":"max_completion_tokens is too large: 128000.This model
//   supports at most 65536 completion tokens.","type":"BadRequestError","param":null,"code":400}
//
// stream.ts already had a token-overflow recovery ladder (shrink-and-retry) and a comment claiming
// it covered OpenAI-compatible servers. It did not cover THIS one, for two independent reasons:
//
//   1. The predicate missed it. `max_completion_tokens is too large` has no "context" word, and
//      `max(?:imum)?[ _]?(?:new[ _])?tokens` cannot match `max_completion_tokens` because
//      `_completion` sits between `max` and `tokens`. So the 400 fell through every recovery
//      branch and surfaced as a terminal error on turn 1.
//
//   2. Even when the ladder DID fire, it halved blindly. The server states its ceiling in the same
//      message it rejects us; halving ignores that and walks 128000 -> 64000 -> 32000, costing
//      three round-trips and then throttling the model to half what it would have accepted.
//
// A third gap made it worse: nothing was REMEMBERED, so every turn re-requested 128000 and ate a
// 400 + retry for the whole session.
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { AddressInfo } from 'node:net';
import {
  streamWithRetry,
  parseAdvertisedOutputCap,
  clampMaxTokens,
  tighterOutputCap,
  looksLikeTokenOverflow,
} from '../src/provider/stream.js';
import { buildOpenAIBody } from '../src/provider/openai.js';
import { buildResponsesBody } from '../src/provider/responses.js';
import type { CompletionRequest } from '../src/provider/provider.js';
import type { ModelCapabilities } from '../src/config.js';

function req(model: string, maxOutputTokens: number): CompletionRequest {
  return {
    model,
    system: 'system',
    messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }],
    tools: [],
    maxOutputTokens,
    temperature: 0.37,
  };
}

const REAL =
  'max_completion_tokens is too large: 128000.This model supports at most 65536 completion tokens.';

/** Minimal StreamAttempt with only the fields these tests exercise. */
function att(body: Record<string, unknown>): any {
  return {
    url: 'http://127.0.0.1:1/v1/chat/completions',
    headers: { 'content-type': 'application/json' },
    body,
    signal: new AbortController().signal,
    // Emits one text event per SSE data line carrying content — enough to prove the retry SUCCEEDED
    // rather than merely terminated.
    parse: async function* (lines: AsyncIterable<string>) {
      for await (const line of lines) {
        if (line.includes('"content":"ok"')) yield { type: 'text', delta: 'ok' };
      }
    },
  } as any;
}

/** Drive the generator to completion and return the events it produced. */
async function drain(gen: AsyncIterable<any>): Promise<any[]> {
  const out: any[] = [];
  for await (const ev of gen) out.push(ev);
  return out;
}

// ---------------------------------------------------------------------------
// parseAdvertisedOutputCap — must return the ceiling the serve ACCEPTS, never
// the one it rejected.
// ---------------------------------------------------------------------------

test('parses the accepted ceiling, not the rejected value, from the real message', () => {
  // The discriminator for the whole fix: the message contains BOTH numbers. Returning 128000
  // would 400 again; returning 65536 is correct.
  assert.equal(parseAdvertisedOutputCap(REAL), 65536);
});

test('parses the accepted ceiling across serve dialects', () => {
  const cases: Array<[string, number]> = [
    ['max_tokens must be <= 8192', 8192],
    ['max_completion_tokens cannot exceed 4096 for this deployment', 4096],
    ['output token limit is 16384', 16384],
    ['supports up to 32768 output tokens', 32768],
    ['a maximum of 2048 tokens', 2048],
    ['max_output_tokens must be at most 12288', 12288],
  ];
  for (const [msg, want] of cases) {
    assert.equal(parseAdvertisedOutputCap(msg), want, `expected ${want} from: ${msg}`);
  }
});

test('handles comma-grouped numbers', () => {
  assert.equal(parseAdvertisedOutputCap('supports at most 65,536 completion tokens'), 65536);
});

test('returns undefined when no ceiling is stated', () => {
  assert.equal(parseAdvertisedOutputCap('invalid model name'), undefined);
  assert.equal(parseAdvertisedOutputCap(''), undefined);
});

// ---------------------------------------------------------------------------
// looksLikeTokenOverflow — the predicate miss that made this terminal.
// ---------------------------------------------------------------------------

test('recognizes the real OpenAI-compatible over-cap message', () => {
  assert.equal(looksLikeTokenOverflow(REAL), true);
});

test('recognizes the output-param over-cap family', () => {
  for (const msg of [
    'max_completion_tokens is too large',
    'max_tokens exceeds the model limit',
    'max_output_tokens is greater than 8192',
    'max_tokens must be <= 4096',
  ]) {
    assert.equal(looksLikeTokenOverflow(msg), true, `should match: ${msg}`);
  }
});

test('DISCRIMINATOR: still recognizes the classic context-overflow family', () => {
  // The fix must widen, not swap. Reverting the predicate to the old regex fails these.
  for (const msg of [
    'This model maximum context length is 8192 tokens',
    'request (32925 tokens) exceeds the available context size (32768 tokens)',
    'context_length_exceeded',
    'reduce the length of your input',
    'prompt is too long',
    'too many tokens',
  ]) {
    assert.equal(looksLikeTokenOverflow(msg), true, `should still match: ${msg}`);
  }
});

test('DISCRIMINATOR: a rate limit is NOT token overflow', () => {
  // "at most" plus a number plus a plausible noun is easy to over-match. A 429 that gets pulled
  // onto the token-shrink path would strip max_tokens and retry a rate-limited request.
  for (const msg of [
    'you may send at most 5 requests per minute',
    'rate limit exceeded, retry later',
    'too many requests',
  ]) {
    assert.equal(looksLikeTokenOverflow(msg), false, `must not match: ${msg}`);
  }
});

test('DISCRIMINATOR: an unrelated 400 is NOT token overflow', () => {
  assert.equal(looksLikeTokenOverflow('invalid API key'), false);
  assert.equal(looksLikeTokenOverflow('model not found'), false);
});

// ---------------------------------------------------------------------------
// clampMaxTokens — lands in one retry instead of walking the halving ladder.
// ---------------------------------------------------------------------------

test('clamps every output-token field down to the advertised cap', () => {
  const body = { max_tokens: 128000, max_completion_tokens: 128000, max_output_tokens: 128000 };
  assert.equal(clampMaxTokens(body, 65536), true);
  assert.deepEqual(body, { max_tokens: 65536, max_completion_tokens: 65536, max_output_tokens: 65536 });
});

test('clamps to the advertised value exactly, NOT below it', () => {
  // Discriminator vs. shrinkMaxTokens: halving 128000 gives 64000 — under the 65536 the server
  // offered, silently throttling the model. Clamping must land on the ceiling.
  const body = { max_completion_tokens: 128000 };
  clampMaxTokens(body, 65536);
  assert.equal(body.max_completion_tokens, 65536);
});

test('leaves an already-conforming body untouched and reports no change', () => {
  const body = { max_completion_tokens: 8192 };
  assert.equal(clampMaxTokens(body, 65536), false);
  assert.equal(body.max_completion_tokens, 8192);
});

test('honors a small advertised ceiling rather than a floor', () => {
  // A serve that says "at most 512" gets 512. Applying TOKEN_SHRINK_FLOOR here would re-request a
  // value the server just refused and burn the ladder for nothing.
  const body = { max_completion_tokens: 128000 };
  assert.equal(clampMaxTokens(body, 512), true);
  assert.equal(body.max_completion_tokens, 512);
});

test('ignores a degenerate cap instead of wedging the run at 0', () => {
  const body = { max_completion_tokens: 128000 };
  assert.equal(clampMaxTokens(body, 0), false);
  assert.equal(clampMaxTokens(body, -1), false);
  assert.equal(clampMaxTokens(body, Number.NaN), false);
  assert.equal(body.max_completion_tokens, 128000);
});

test('ignores a non-object body', () => {
  assert.equal(clampMaxTokens(null, 65536), false);
  assert.equal(clampMaxTokens(undefined, 65536), false);
});

// ---------------------------------------------------------------------------
// End-to-end against a real HTTP serve that behaves like the user's.
// ---------------------------------------------------------------------------

/** A serve that rejects an over-cap output request with the user's exact message, then accepts. */
async function startOverCapServe(t: test.TestContext, accepted: number) {
  const seen: number[] = [];
  const server = http.createServer((_req, res) => {
    let raw = '';
    _req.on('data', (c) => (raw += c));
    _req.on('end', () => {
      let cap = 0;
      try { cap = JSON.parse(raw).max_completion_tokens ?? 0; } catch { /* empty body */ }
      seen.push(cap);
      res.setHeader('content-type', 'application/json');
      if (cap > accepted) {
        res.statusCode = 400;
        res.end(JSON.stringify({
          object: 'error',
          message: `max_completion_tokens is too large: ${cap}.This model supports at most ${accepted} completion tokens.`,
          type: 'BadRequestError',
          param: null,
          code: 400,
        }));
        return;
      }
      res.statusCode = 200;
      // The success path must be SSE: streamWithRetry feeds res.body through streamLines into
      // a.parse. A JSON body would parse to nothing and look like an empty stream.
      res.setHeader('content-type', 'text/event-stream');
      res.write('data: {"choices":[{"delta":{"content":"ok"}}]}\n\n');
      res.write('data: [DONE]\n\n');
      res.end();
    });
  });
  server.listen(0, '127.0.0.1');
  await new Promise<void>((r) => server.once('listening', r));
  t.after(() => server.close());
  const { port } = server.address() as AddressInfo;
  return { baseUrl: `http://127.0.0.1:${port}`, seen };
}

test('END-TO-END: an over-cap request recovers in ONE retry and lands on the ceiling', async (t) => {
  const { baseUrl, seen } = await startOverCapServe(t, 65536);
  let discovered: number | undefined;
  const body = { max_completion_tokens: 128000, messages: [], stream: true };
  const a = att(body);
  a.url = `${baseUrl}/v1/chat/completions`;
  a.onOutputCapDiscovered = (cap: number) => { discovered = cap; };

  const events = await drain(streamWithRetry(a));
  const text = events.filter((e) => e.type === 'text').map((e) => e.delta).join('');
  assert.equal(text, 'ok', `expected a successful completion, got ${JSON.stringify(events)}`);
  // No terminal error may surface — this is the exact regression: the 400 used to become fatal
  // `http_400` on turn 1 because the predicate never matched the message.
  assert.equal(events.some((e) => e.type === 'error'), false, 'the 400 must be recovered, not raised');
  // The whole point: two requests total (the rejection and the corrected one), not a halving
  // walk of 128000 -> 64000 -> 32000. And the corrected value is the ceiling, not under it.
  assert.deepEqual(seen, [128000, 65536], `expected one retry to the exact cap, got ${JSON.stringify(seen)}`);
  assert.equal(discovered, 65536, 'the discovered cap must be reported for session memory');
});

test('DISCRIMINATOR: a serve that never states a cap still recovers by halving', async (t) => {
  // Clamping is an OPTIMIZATION over the existing ladder, not a replacement. When the 400 says the
  // request is too large but does not name a ceiling, the old halving behavior must still fire —
  // otherwise this fix would make uninformative serves worse than they were.
  const seen: number[] = [];
  const server = http.createServer((_req, res) => {
    let raw = '';
    _req.on('data', (c) => (raw += c));
    _req.on('end', () => {
      let cap = 0;
      try { cap = JSON.parse(raw).max_completion_tokens ?? 0; } catch { /* empty body */ }
      seen.push(cap);
      if (cap > 8192) {
        res.statusCode = 400;
        res.setHeader('content-type', 'application/json');
        // No number offered — only a complaint.
        res.end(JSON.stringify({ message: 'max_completion_tokens is too large for this model.' }));
        return;
      }
      res.statusCode = 200;
      res.setHeader('content-type', 'text/event-stream');
      res.write('data: {"choices":[{"delta":{"content":"ok"}}]}\n\n');
      res.write('data: [DONE]\n\n');
      res.end();
    });
  });
  server.listen(0, '127.0.0.1');
  await new Promise<void>((r) => server.once('listening', r));
  t.after(() => server.close());
  const { port } = server.address() as AddressInfo;

  const a = att({ max_completion_tokens: 128000, messages: [], stream: true });
  a.url = `http://127.0.0.1:${port}/v1/chat/completions`;
  const events = await drain(streamWithRetry(a));
  assert.equal(events.filter((e) => e.type === 'text').map((e) => e.delta).join(''), 'ok');
  // Halving walk: 128000 -> 64000 -> 32000 -> 16000 -> 8000 (accepted).
  assert.deepEqual(seen, [128000, 64000, 32000, 16000, 8000], `expected a halving walk, got ${JSON.stringify(seen)}`);
});

test('a learned cap clamps the built body so the NEXT turn never 400s', () => {
  // This is what turns a per-turn tax into a one-time discovery. Once the serve has told us its
  // ceiling, every later request is built under it on FIRST contact — no 400, no retry.
  const body = buildOpenAIBody(req('gpt-4o', 128000), 'gpt-4o', true, {
    learnedOutputCap: 65536,
  });
  assert.equal(body.max_tokens, 65536);
});

test('a learned cap also clamps the Chat Completions max_completion_tokens field', () => {
  const body = buildOpenAIBody(req('gpt-4o', 128000), 'gpt-4o', true, {
    learnedOutputCap: 65536,
  });
  // Whichever output field this wire carries must be clamped — clampMaxTokens covers all three.
  const carried = ['max_tokens', 'max_completion_tokens', 'max_output_tokens']
    .filter((f) => typeof body[f] === 'number');
  assert.ok(carried.length > 0, 'the body must carry at least one output-token field');
  for (const f of carried) assert.equal(body[f], 65536, `${f} must be clamped`);
});

test('DISCRIMINATOR: an untouched serve keeps its full reasoning floor', () => {
  // The clamp must fire ONLY after a real rejection. Hosted Qwen's byte-identical 262144 wire
  // contract (AC3) must survive first contact unchanged — reverting the `learnedOutputCap != null`
  // guard to an unconditional clamp fails this test.
  const MAX_CAPS: ModelCapabilities = {
    preserveThinking: true,
    reasoning: 'interleaved',
    effortScale: ['low', 'medium', 'xhigh'],
    maxOutputTokens: 262144,
  };
  const untouched = buildOpenAIBody(req('qwen3.8-max', 65536), 'qwen3.8-max', true, {
    selfHosted: true,
    capabilities: MAX_CAPS,
  });
  assert.equal(untouched.max_tokens, 262144, 'reasoning floor intact on first contact');

  // And once the serve has actually rejected us, the SAME floor yields to the learned cap —
  // because a deliberate minimum for hidden thinking cannot exceed what the server accepts.
  const clamped = buildOpenAIBody(req('qwen3.8-max', 65536), 'qwen3.8-max', true, {
    selfHosted: true,
    capabilities: MAX_CAPS,
    learnedOutputCap: 65536,
  });
  assert.equal(clamped.max_tokens, 65536, 'learned cap wins over the reasoning floor');
});

// ---------------------------------------------------------------------------
// tighterOutputCap — the shared fold both wires use, so they cannot diverge.
// ---------------------------------------------------------------------------

test('tighterOutputCap keeps the tightest advertised ceiling', () => {
  // A serve that reports 65536 on one request and 8192 on a later one has told us 8192 is the
  // ceiling that actually holds. Remembering the looser value would 400 every later turn.
  assert.equal(tighterOutputCap(undefined, 65536), 65536);
  assert.equal(tighterOutputCap(65536, 8192), 8192);
  assert.equal(tighterOutputCap(8192, 65536), 8192, 'a looser later report must not widen');
});

test('tighterOutputCap ignores a degenerate cap rather than poisoning memory', () => {
  assert.equal(tighterOutputCap(undefined, 0), undefined);
  assert.equal(tighterOutputCap(undefined, -1), undefined);
  assert.equal(tighterOutputCap(undefined, Number.NaN), undefined);
  assert.equal(tighterOutputCap(65536, 0), 65536, 'an existing cap survives a bad report');
});

// ---------------------------------------------------------------------------
// The Responses wire must behave identically — it derives max_output_tokens
// from buildOpenAIBody, so a cap learned there has to reach this wire too.
// ---------------------------------------------------------------------------

test('a learned cap reaches the Responses wire max_output_tokens', () => {
  const body = buildResponsesBody(req('gpt-4o', 128000), 'gpt-4o', true, {
    learnedOutputCap: 65536,
  });
  assert.equal(body.max_output_tokens, 65536, 'Responses wire must clamp too');
});

test('DISCRIMINATOR: the Responses wire keeps its floor when no cap is learned', () => {
  const untouched = buildResponsesBody(req('gpt-4o', 128000), 'gpt-4o', true, {});
  assert.notEqual(untouched.max_output_tokens, 65536, 'no cap learned means no clamp');
});
