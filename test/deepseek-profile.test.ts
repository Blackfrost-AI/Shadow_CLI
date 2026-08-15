import { test } from 'node:test';
import assert from 'node:assert/strict';
import { OpenAIProvider, buildOpenAIBody } from '../src/provider/openai.js';
import { familyProfile } from '../src/config/familyProfiles.js';
import type { CompletionRequest, ProviderEvent } from '../src/provider/provider.js';

/** Mirrors Shadow's real config default (config.ts maxOutputTokens default 65,536) — the exact
 *  value that used to 400-cascade against DeepSeek's documented output caps (F09-06). */
function request(model: string, maxOutputTokens = 65_536): CompletionRequest {
  return {
    model,
    system: 'system',
    messages: [{ role: 'user', content: [{ type: 'text', text: 'inspect the repo' }] }],
    tools: [{ name: 'read_file', description: 'Read one file', parameters: { type: 'object' } }],
    maxOutputTokens,
    temperature: 0.2,
    effort: 'high',
  };
}

test('deepseek family profiles pin the DOCUMENTED platform caps (8k chat / 64k reasoner)', () => {
  assert.equal(familyProfile('deepseek-chat')?.family, 'deepseek-chat');
  assert.equal(familyProfile('deepseek-chat')?.maxOutputCap, 8_192, 'platform docs: max_tokens ≤ 8,192');
  assert.equal(familyProfile('deepseek/deepseek-chat')?.maxOutputCap, 8_192, 'OpenRouter-prefixed id');
  assert.equal(familyProfile('deepseek-chat-v3.1')?.maxOutputCap, 8_192, 'versioned chat id');
  // The reasoner keeps its existing 64k floor AND gains the documented 64K (65,536) completion cap.
  assert.equal(familyProfile('deepseek-reasoner')?.minOutputTokens, 64_000);
  assert.equal(familyProfile('deepseek-reasoner')?.maxOutputCap, 65_536);
  assert.equal(familyProfile('deepseek-r1')?.maxOutputCap, 65_536);
  // Third-party rehosts of the weights under other ids stay capability-neutral (narrow matchers).
  assert.equal(familyProfile('deepseek-ai/DeepSeek-V3'), undefined);
});

test('deepseek-chat FIRST request fits the 8k cap — no over-cap value that would 400 (F09-06)', () => {
  const body = buildOpenAIBody(request('deepseek-chat'), 'fallback', true, {});
  assert.equal(body.max_tokens, 8_192, 'the 65,536 default is clamped to the documented cap up front');
  assert.equal(body.max_completion_tokens, undefined);
  assert.equal(body.reasoning_effort, undefined, 'deepseek-chat is not a reasoner — no effort param');
  assert.equal(body.temperature, undefined, 'cloud endpoint never receives the self-hosted sampling control');

  // The cap is a CEILING, not a target: a smaller explicit ask passes through untouched.
  const small = buildOpenAIBody(request('deepseek-chat', 4_096), 'fallback', true, {});
  assert.equal(small.max_tokens, 4_096);
});

test('deepseek-reasoner keeps its larger 64K reasoning budget and never over-asks', () => {
  // Default config: floor(64,000) ∨ default(65,536) = 65,536 — exactly the documented 64K cap.
  const body = buildOpenAIBody(request('deepseek-reasoner'), 'fallback', true, {});
  assert.equal(body.max_tokens, 65_536, 'thinking + answer budget preserved at the documented maximum');
  // An explicit over-ask used to walk 200k → 100k → 50k through the shrink ladder; now it fits first.
  const big = buildOpenAIBody(request('deepseek-reasoner', 200_000), 'fallback', true, {});
  assert.equal(big.max_tokens, 65_536);
});

test('a declared capabilities.maxOutputTokens outranks family knowledge (operator assertion wins)', () => {
  const body = buildOpenAIBody(request('deepseek-chat'), 'fallback', true, {
    capabilities: { maxOutputTokens: 100_000 },
  });
  assert.equal(body.max_tokens, 100_000, 'family cap never re-caps an explicit capability block');
});

test('non-deepseek models keep their exact cap — family caps change nothing elsewhere', () => {
  assert.equal(buildOpenAIBody(request('llama3.1'), 'fallback', true, {}).max_tokens, 65_536);
  assert.equal(buildOpenAIBody(request('mistral-large-latest', 8_192), 'fallback', true, {}).max_tokens, 8_192);
});

test('end-to-end: deepseek-chat completes in ONE request — the shrink cascade is gone', async () => {
  const originalFetch = globalThis.fetch;
  const bodiesSeen: number[] = [];
  try {
    globalThis.fetch = async (_input, init) => {
      const body = JSON.parse(String(init?.body)) as { max_tokens?: number };
      bodiesSeen.push(body.max_tokens ?? -1);
      if (body.max_tokens && body.max_tokens > 8_192) {
        // DeepSeek's real over-cap rejection shape (matches looksLikeTokenOverflow).
        return new Response(
          '{"error":{"message":"Invalid max_tokens value, the valid range of max_tokens is [1, 8192]","type":"invalid_request_error"}}',
          { status: 400, headers: { 'content-type': 'application/json' } },
        );
      }
      return new Response(
        'data: {"choices":[{"delta":{"content":"ok"},"finish_reason":"stop"}]}\n\n' +
          'data: {"choices":[],"usage":{"prompt_tokens":2,"completion_tokens":1}}\n\n' +
          'data: [DONE]\n\n',
        { status: 200, headers: { 'content-type': 'text/event-stream' } },
      );
    };
    const req = request('deepseek-chat');
    const provider = new OpenAIProvider({
      apiKey: 'test-key',
      baseUrl: 'https://api.deepseek.com/v1',
      model: req.model,
    });
    const events: ProviderEvent[] = [];
    for await (const event of provider.send(req)) events.push(event);
    assert.ok(events.some((e) => e.type === 'text'), 'turn completed with real text');
  } finally {
    globalThis.fetch = originalFetch;
  }
  assert.deepEqual(bodiesSeen, [8_192], 'exactly one request — no 65536→32768→16384 shrink walk');
});

test('the shrink ladder REMAINS the net when the real cap is below family knowledge', async () => {
  // A gateway fronting deepseek-chat with a tighter window than the platform docs: the first
  // request uses the documented 8,192, then the ladder self-corrects exactly as before.
  const originalFetch = globalThis.fetch;
  const bodiesSeen: number[] = [];
  try {
    globalThis.fetch = async (_input, init) => {
      const body = JSON.parse(String(init?.body)) as { max_tokens?: number };
      bodiesSeen.push(body.max_tokens ?? -1);
      if (body.max_tokens && body.max_tokens > 4_096) {
        return new Response(
          '{"error":{"message":"Invalid max_tokens value, the valid range of max_tokens is [1, 4096]","type":"invalid_request_error"}}',
          { status: 400, headers: { 'content-type': 'application/json' } },
        );
      }
      return new Response(
        'data: {"choices":[{"delta":{"content":"ok"},"finish_reason":"stop"}]}\n\n' + 'data: [DONE]\n\n',
        { status: 200, headers: { 'content-type': 'text/event-stream' } },
      );
    };
    const req = request('deepseek-chat');
    const provider = new OpenAIProvider({ apiKey: 'test-key', baseUrl: 'https://api.deepseek.com/v1', model: req.model });
    const events: ProviderEvent[] = [];
    for await (const event of provider.send(req)) events.push(event);
    assert.ok(events.some((e) => e.type === 'text'));
  } finally {
    globalThis.fetch = originalFetch;
  }
  assert.deepEqual(bodiesSeen, [8_192, 4_096], 'ladder still walks down from the family cap');
});
