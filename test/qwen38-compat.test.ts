import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  OpenAIProvider,
  buildOpenAIBody,
  isDashScopeBaseUrl,
  isQwen38MaxModel,
  isQwen38Model,
  parseOpenAISSE,
  shouldPreserveQwenReasoning,
  toOpenAIMessages,
  toQwen38ReasoningEffort,
} from '../src/provider/openai.js';
import { eventsFromOpenAICompletion } from '../src/provider/nonStream.js';
import type { CompletionRequest, Effort, Message, ProviderEvent } from '../src/provider/provider.js';
import type { ModelCapabilities } from '../src/config.js';

async function* fromLines(lines: string[]): AsyncIterable<string> {
  for (const line of lines) yield line;
}

async function collect(events: AsyncIterable<ProviderEvent>): Promise<ProviderEvent[]> {
  const out: ProviderEvent[] = [];
  for await (const event of events) out.push(event);
  return out;
}

function request(model: string, temperature = 0.37): CompletionRequest {
  return {
    model,
    system: 'system',
    messages: [{ role: 'user', content: [{ type: 'text', text: 'inspect the repo' }] }],
    tools: [{ name: 'read_file', description: 'Read one file', parameters: { type: 'object' } }],
    maxOutputTokens: 8192,
    temperature,
    effort: 'high',
  };
}

test('Qwen 3.8 detection is broad for future IDs but Max-only for hosted request controls', () => {
  for (const id of ['qwen3.8-max', 'Qwen/Qwen3.8-30B-A3B-Instruct', 'vendor/qwen3_8-thinking']) {
    assert.equal(isQwen38Model(id), true, id);
  }
  assert.equal(isQwen38MaxModel('qwen3.8-max'), true);
  assert.equal(isQwen38MaxModel('qwen3.8-max-preview'), true);
  assert.equal(isQwen38MaxModel('Qwen/Qwen3.8-30B-A3B-Instruct'), false);
  assert.equal(isQwen38Model('qwen3.7-max'), false);
  for (const existing of ['Qwen/Qwen3-8B', 'Qwen/Qwen3-8B-Instruct', 'qwen3-80b']) {
    assert.equal(isQwen38Model(existing), false, `${existing} is a Qwen 3 parameter-count id, not version 3.8`);
  }
});

test('DashScope Qwen 3.8 Max uses its documented output/effort/history controls', () => {
  const req = request('qwen3.8-max');
  const body = buildOpenAIBody(req, 'fallback', true, { dashScope: true });
  assert.equal(body.model, 'qwen3.8-max');
  assert.equal(body.max_completion_tokens, 262_144);
  assert.equal(body.max_tokens, undefined);
  assert.equal(body.reasoning_effort, 'xhigh');
  assert.equal(body.preserve_thinking, true);
  assert.equal(body.temperature, undefined, 'hosted Qwen never receives the self-hosted sampling control');
  assert.deepEqual(body.stream_options, { include_usage: true });
  assert.equal((body.tools as unknown[]).length, 1);
  assert.equal(body.tool_choice, 'auto');

  assert.equal(toQwen38ReasoningEffort('low'), 'low');
  assert.equal(toQwen38ReasoningEffort('medium'), 'medium');
  assert.equal(toQwen38ReasoningEffort('high'), 'xhigh');
  assert.equal(toQwen38ReasoningEffort('max'), 'xhigh');
});

test('self-hosted Qwen 3.8 Max receives the full adaptive-reasoning contract (P1A-06 AC1)', () => {
  // P1A-06: a self-hosted endpoint serving the Qwen 3.8 Max id is a VERIFIED Max endpoint — it gets
  // the 262k output floor, reasoning_effort mapped per /effort, and preserve_thinking, exactly like
  // DashScope (only the token field differs: a self-hosted serve takes max_tokens, not
  // max_completion_tokens).
  const hostedMax = buildOpenAIBody(request('qwen3.8-max'), 'fallback', true, { selfHosted: true });
  assert.equal(hostedMax.max_tokens, 262_144, 'self-hosted Max gets the 262k floor pre-shrink (AC1)');
  assert.equal(hostedMax.max_completion_tokens, undefined, 'self-hosted serve takes max_tokens, not the hosted field');
  assert.equal(hostedMax.reasoning_effort, 'xhigh', 'effort high → xhigh on the Max 3-tier scale');
  assert.equal(hostedMax.preserve_thinking, true, 'self-hosted Max asserts preserve_thinking (AC1)');
  assert.equal(hostedMax.temperature, 0.37, 'an explicitly self-hosted Max id still honors local sampling');

  // Open-weight Qwen 3.8 (non-Max) is NOT guessed into the Max contract — name alone is insufficient.
  const openWeight = buildOpenAIBody(request('Qwen/Qwen3.8-30B-A3B-Instruct'), 'fallback', true, {
    selfHosted: true,
  });
  assert.equal(openWeight.model, 'Qwen/Qwen3.8-30B-A3B-Instruct', 'future model id passes through byte-for-byte');
  assert.equal(openWeight.max_tokens, 8192, 'unknown open-weight capability is not guessed');
  assert.equal(openWeight.max_completion_tokens, undefined);
  assert.equal(openWeight.reasoning_effort, undefined);
  assert.equal(openWeight.preserve_thinking, undefined);
  assert.equal(openWeight.temperature, 0.37, 'self-hosted Qwen keeps the configured sampling temperature');
});

test('self-hosted Qwen 3.5/3.8 captures and replays reasoning history without DashScope controls', async () => {
  for (const model of ['Qwen/Qwen3.5-35B-A3B', 'Qwen/Qwen3.8-30B-A3B-Instruct']) {
    assert.equal(shouldPreserveQwenReasoning(model, { selfHosted: true }), true, model);
    assert.equal(shouldPreserveQwenReasoning(model, {}), false, `${model}: name alone is insufficient`);
  }

  const model = 'Qwen/Qwen3.8-30B-A3B-Instruct';
  const events = await collect(parseOpenAISSE(fromLines([
    'data: {"choices":[{"delta":{"reasoning_content":"inspect "}}]}',
    'data: {"choices":[{"delta":{"reasoning_content":"first","tool_calls":[{"index":0,"id":"q1","function":{"name":"read_file","arguments":"{\\"path\\":\\"x\\"}"}}]},"finish_reason":"tool_calls"}]}',
    'data: [DONE]',
  ]), model, shouldPreserveQwenReasoning(model, { selfHosted: true })));
  assert.deepEqual(events.find((event) => event.type === 'reasoning_block'), {
    type: 'reasoning_block',
    text: 'inspect first',
    field: 'reasoning_content',
  });

  const history: Message[] = [{
    role: 'assistant',
    content: [{ type: 'tool_use', id: 'q1', name: 'read_file', input: { path: 'x' } }],
    providerReasoning: { text: 'inspect first', field: 'reasoning_content', model },
  }];
  const body = buildOpenAIBody({ ...request(model), messages: history }, model, true, { selfHosted: true });
  const assistant = (body.messages as Array<Record<string, unknown>>).find((message) => message.role === 'assistant');
  assert.equal(assistant?.reasoning_content, 'inspect first');
  assert.equal(body.reasoning_effort, undefined, 'DashScope-only request knobs stay disabled');
  assert.equal(body.preserve_thinking, undefined);
});

test('Qwen 3.8 reasoning remains visible but is not replayed on an unverified public endpoint', async () => {
  const lines = [
    'data: {"choices":[{"delta":{"reasoning_content":"inspect "}}]}',
    'data: {"choices":[{"delta":{"reasoning_content":"first"}}]}',
    'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"call_q","function":{"name":"read_file","arguments":"{\\"pa"}}]}}]}',
    'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"arguments":"th\\":\\"src/index.ts\\"}"}}]},"finish_reason":"tool_calls"}]}',
    'data: [DONE]',
  ];
  const events = await collect(parseOpenAISSE(fromLines(lines), 'Qwen/Qwen3.8-30B-A3B'));
  const thinking = events
    .filter((event): event is Extract<ProviderEvent, { type: 'thinking' }> => event.type === 'thinking')
    .map((event) => event.delta)
    .join('');
  assert.equal(thinking, 'inspect first');

  assert.equal(
    events.some((event) => event.type === 'reasoning_block'),
    false,
    'history replay stays disabled without a verified DashScope or self-hosted endpoint',
  );

  const call = events.find((event) => event.type === 'tool_call');
  assert.ok(call && call.type === 'tool_call');
  assert.equal(call.call.name, 'read_file');
  assert.deepEqual(call.call.input, { path: 'src/index.ts' });
});

test('verified DashScope Qwen 3.8 Max captures structured reasoning for exact-field replay', async () => {
  const events = await collect(parseOpenAISSE(fromLines([
    'data: {"choices":[{"delta":{"reasoning_content":"inspect "}}]}',
    'data: {"choices":[{"delta":{"reasoning_content":"first","content":"done"},"finish_reason":"stop"}]}',
    'data: [DONE]',
  ]), 'qwen3.8-max', true));

  assert.deepEqual(events.find((event) => event.type === 'reasoning_block'), {
    type: 'reasoning_block',
    text: 'inspect first',
    field: 'reasoning_content',
  });
});

test('non-stream fallback uses the same verified reasoning-history gate', () => {
  const completion = {
    choices: [{ message: { reasoning: 'private', content: 'visible' }, finish_reason: 'stop' }],
  };
  const ordinary = [...eventsFromOpenAICompletion(completion, 'qwen3.8-max')];
  assert.equal(ordinary.some((event) => event.type === 'reasoning_block'), false);

  const verified = [...eventsFromOpenAICompletion(completion, 'qwen3.8-max', true)];
  assert.deepEqual(verified.find((event) => event.type === 'reasoning_block'), {
    type: 'reasoning_block',
    text: 'private',
    field: 'reasoning',
  });
});

test('preserved Qwen reasoning round-trips in its original field only to the producing model', () => {
  const history: Message[] = [
    {
      role: 'assistant',
      content: [
        { type: 'text', text: 'I will inspect it.' },
        { type: 'tool_use', id: 'call_q', name: 'read_file', input: { path: 'src/index.ts' } },
      ],
      providerReasoning: {
        text: 'private structured reasoning',
        field: 'reasoning_content',
        model: 'qwen3.8-max',
      },
    },
  ];
  const req = { ...request('qwen3.8-max'), messages: history };
  const same = toOpenAIMessages(req, req.model, { preserveProviderReasoning: true }).find((message) => message.role === 'assistant') as {
    reasoning_content?: string;
    content?: string | null;
  };
  assert.equal(same.reasoning_content, 'private structured reasoning');
  assert.equal(same.content, 'I will inspect it.');

  const switched = toOpenAIMessages(
    { ...req, model: 'Qwen/Qwen3.8-30B-A3B' },
    'Qwen/Qwen3.8-30B-A3B',
    { preserveProviderReasoning: true },
  ).find(
    (message) => message.role === 'assistant',
  ) as { reasoning_content?: string };
  assert.equal(switched.reasoning_content, undefined, 'model-bound reasoning is dropped after a switch');

  const sameModelOnUnverifiedEndpoint = toOpenAIMessages(req).find(
    (message) => message.role === 'assistant',
  ) as { reasoning_content?: string };
  assert.equal(
    sameModelOnUnverifiedEndpoint.reasoning_content,
    undefined,
    'the same alias on a local/proxy endpoint cannot inherit DashScope-only history',
  );
});

test('OpenAI provider sends exact Qwen model, DashScope URL, Bearer auth, and no temperature', async () => {
  const originalFetch = globalThis.fetch;
  let capturedUrl = '';
  let capturedHeaders: Record<string, string> = {};
  let capturedBody: Record<string, unknown> = {};
  globalThis.fetch = async (input, init) => {
    capturedUrl = String(input);
    capturedHeaders = init?.headers as Record<string, string>;
    capturedBody = JSON.parse(String(init?.body)) as Record<string, unknown>;
    return new Response(
      'data: {"choices":[{"delta":{"content":"ok"},"finish_reason":"stop"}]}\n\n' +
        'data: {"choices":[],"usage":{"prompt_tokens":2,"completion_tokens":1}}\n\n' +
        'data: [DONE]\n\n',
      { status: 200, headers: { 'content-type': 'text/event-stream' } },
    );
  };

  try {
    const req = request('qwen3.8-max');
    const provider = new OpenAIProvider({
      apiKey: 'dashscope-test-key',
      baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
      model: req.model,
    });
    await collect(provider.send(req));
  } finally {
    globalThis.fetch = originalFetch;
  }

  assert.equal(capturedUrl, 'https://dashscope.aliyuncs.com/compatible-mode/v1/chat/completions');
  assert.equal(capturedHeaders.Authorization, 'Bearer dashscope-test-key');
  assert.equal(capturedBody.model, 'qwen3.8-max');
  assert.equal(capturedBody.reasoning_effort, 'xhigh');
  assert.equal(capturedBody.preserve_thinking, true);
  assert.equal(capturedBody.temperature, undefined);
  assert.equal(isDashScopeBaseUrl('https://workspace.cn-beijing.maas.aliyuncs.com/compatible-mode/v1'), true);
  assert.equal(isDashScopeBaseUrl('https://dashscope-us.aliyuncs.com/compatible-mode/v1'), true);
  assert.equal(isDashScopeBaseUrl('https://dashscope-intl.aliyuncs.com/compatible-mode/v1'), true);
  assert.equal(isDashScopeBaseUrl('https://example.test/compatible-mode/v1'), false);
  assert.equal(isDashScopeBaseUrl('http://dashscope.aliyuncs.com/compatible-mode/v1'), false);
  assert.equal(isDashScopeBaseUrl('https://dashscope.aliyuncs.com:8443/compatible-mode/v1'), false);
});

// ── P1A-06 · declared capability block (self-hosted Qwen 3.8 Max contract) ─────

const MAX_CAPS: ModelCapabilities = {
  preserveThinking: true,
  reasoning: 'interleaved',
  effortScale: ['low', 'medium', 'xhigh'],
  maxOutputTokens: 262144,
};

test('served-model-name alias + explicit capability block reaches the identical Max contract (P1A-06 AC2)', () => {
  // A vLLM `--served-model-name my-alias` id carries NO Qwen marker, so id-regex detection alone
  // would skip the contract. An explicit capability block must activate it byte-identically.
  const aliasBody = buildOpenAIBody(request('my-vllm-alias'), 'fallback', true, {
    selfHosted: true,
    capabilities: MAX_CAPS,
  });
  assert.equal(aliasBody.max_tokens, 262144, 'declared maxOutputTokens is the floor');
  assert.equal(aliasBody.max_completion_tokens, undefined);
  assert.equal(aliasBody.preserve_thinking, true, 'declared preserveThinking activates the wire flag');
  assert.equal(aliasBody.reasoning_effort, 'xhigh', '/effort high maps onto the declared scale');
  assert.equal(aliasBody.temperature, 0.37, 'self-hosted sampling control preserved');
});

test('preserveThinking ALONE yields one consistent wire state: replay on AND preserve_thinking sent (F10-06)', () => {
  // The trap this pins against: the replay gate accepted a lone `preserveThinking: true` while the
  // request-shaping gate demanded `reasoning != null` too — so history was replayed to an endpoint
  // that was never sent `preserve_thinking`. One declared field must flip BOTH sides together.
  const caps = { preserveThinking: true };
  assert.equal(
    shouldPreserveQwenReasoning('my-vllm-alias', { selfHosted: true, capabilities: caps }),
    true,
    'replay side accepts the lone field',
  );
  const body = buildOpenAIBody(request('my-vllm-alias'), 'fallback', true, {
    selfHosted: true,
    capabilities: caps,
  });
  assert.equal(body.preserve_thinking, true, 'wire side must accept the SAME lone field');
  assert.ok(body.reasoning_effort != null, 'effort dial reaches the wire under the declared contract');
  // Without a declared maxOutputTokens an aliased id has no 262k source — the floor falls back to
  // the generic reasoning floor. The startup warning names the FULL block for exactly this reason.
  assert.equal(body.max_tokens, 64_000, 'lone-field floor is the generic reasoning floor, not 262k');
});

test('the same alias WITHOUT a capability block stays plain (no guessed Max contract)', () => {
  const aliasBody = buildOpenAIBody(request('my-vllm-alias'), 'fallback', true, { selfHosted: true });
  assert.equal(aliasBody.max_tokens, 8192, 'an unrecognized alias alone is not guessed into Max');
  assert.equal(aliasBody.reasoning_effort, undefined);
  assert.equal(aliasBody.preserve_thinking, undefined);
});

test('effort dial never emits a tier the declared scale lacks (P1A-06 AC4)', () => {
  const caps: ModelCapabilities = { preserveThinking: true, reasoning: 'hidden', effortScale: ['low', 'high', 'max'] };
  const wire = (effort: Effort) =>
    buildOpenAIBody({ ...request('alias-serve'), effort }, 'fallback', true, {
      selfHosted: true,
      capabilities: caps,
    }).reasoning_effort;

  // Every emitted value must be a member of the DECLARED scale — never medium/xhigh.
  assert.equal(wire('low'), 'low');
  assert.equal(wire('medium'), 'high', 'medium rounds UP because the scale has no medium tier');
  assert.equal(wire('high'), 'high');
  assert.equal(wire('xhigh'), 'max', 'xhigh rounds UP onto the declared max tier');
  assert.equal(wire('max'), 'max');
  // No /effort dial → highest declared tier is the safe default.
  const noDial = buildOpenAIBody({ ...request('alias-serve'), effort: undefined }, 'fallback', true, {
    selfHosted: true,
    capabilities: caps,
  }).reasoning_effort;
  assert.equal(noDial, 'max');
});

test('declared reasoning:inline forces inline think-tag splitting for an unclassified alias (P1A-06)', async () => {
  const events = await collect(
    parseOpenAISSE(fromLines([
      'data: {"choices":[{"delta":{"content":"<thinking>work it "}}]}',
      'data: {"choices":[{"delta":{"content":"out</thinking>answer"}}]}',
      'data: [DONE]',
    ]), 'my-alias-serve', false, { preserveThinking: true, reasoning: 'inline' }),
  );
  const plain = events
    .filter((event): event is Extract<ProviderEvent, { type: 'text' }> => event.type === 'text')
    .map((event) => event.delta)
    .join('');
  assert.equal(plain, 'answer', 'inline reasoning routed away from content (not shown in text)');
  const thinking = events
    .filter((event): event is Extract<ProviderEvent, { type: 'thinking' }> => event.type === 'thinking')
    .map((event) => event.delta)
    .join('');
  assert.equal(thinking, 'work it out', 'inline reasoning captured on the thinking channel');
});

test('shrink ladder recovers a self-hosted Qwen Max when the serve rejects the 262k floor (P1A-06 recovery)', async () => {
  // The 262k floor is a CEILING, not a target: when the real window is smaller (say 16k), the
  // stream layer halves max_tokens on the 400-overflow and re-POSTs until it fits, instead of
  // dying on turn 1. The self-hosted Max body must start at the full floor and walk down.
  const originalFetch = globalThis.fetch;
  const bodiesSeen: number[] = [];
  try {
    globalThis.fetch = async (input, init) => {
      const body = JSON.parse(String(init?.body)) as { max_tokens?: number };
      bodiesSeen.push(body.max_tokens ?? -1);
      if (body.max_tokens && body.max_tokens > 16384) {
        return new Response(
          '{"error":{"message":"This endpoint\'s maximum context length is 16384 tokens, you requested more. Please reduce the length."}}',
          { status: 400, headers: { 'content-type': 'application/json' } },
        );
      }
      return new Response(
        'data: {"choices":[{"delta":{"content":"ok"}}]}\n\n' +
          'data: {"choices":[],"usage":{"prompt_tokens":2,"completion_tokens":1}}\n\n' +
          'data: [DONE]\n\n',
        { status: 200, headers: { 'content-type': 'text/event-stream' } },
      );
    };
    const req = request('qwen3.8-max'); // maxOutputTokens:8192, effort:high
    const provider = new OpenAIProvider({
      baseUrl: 'http://127.0.0.1:8000/v1',
      model: req.model,
      selfHosted: true,
    });
    const events: ProviderEvent[] = [];
    for await (const event of provider.send(req)) events.push(event);
    assert.ok(events.some((e) => e.type === 'text'), 'run recovered into a real text completion');
  } finally {
    globalThis.fetch = originalFetch;
  }
  assert.deepEqual(
    bodiesSeen,
    [262144, 131072, 65536, 32768, 16384],
    'self-hosted Max starts at the 262k floor pre-shrink, then the ladder halves down until it fits',
  );
});
