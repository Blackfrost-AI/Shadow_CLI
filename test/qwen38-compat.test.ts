import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  OpenAIProvider,
  buildOpenAIBody,
  isDashScopeBaseUrl,
  isQwen38MaxModel,
  isQwen38Model,
  parseOpenAISSE,
  toOpenAIMessages,
  toQwen38ReasoningEffort,
} from '../src/provider/openai.js';
import { eventsFromOpenAICompletion } from '../src/provider/nonStream.js';
import type { CompletionRequest, Message, ProviderEvent } from '../src/provider/provider.js';

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

test('third-party/self-hosted endpoints do not receive DashScope-only optional controls', () => {
  const hostedAlias = buildOpenAIBody(request('qwen3.8-max'), 'fallback', true, { selfHosted: true });
  assert.equal(hostedAlias.max_tokens, 8192, 'a model alias alone does not activate DashScope token shaping');
  assert.equal(hostedAlias.max_completion_tokens, undefined);
  assert.equal(hostedAlias.reasoning_effort, undefined);
  assert.equal(hostedAlias.preserve_thinking, undefined);
  assert.equal(hostedAlias.temperature, 0.37, 'an explicitly self-hosted Max id still honors local sampling');

  const openWeight = buildOpenAIBody(request('Qwen/Qwen3.8-30B-A3B-Instruct'), 'fallback', true, {
    selfHosted: true,
  });
  assert.equal(openWeight.model, 'Qwen/Qwen3.8-30B-A3B-Instruct', 'future model id passes through byte-for-byte');
  assert.equal(openWeight.max_tokens, 8192, 'unknown open-weight capability is not guessed');
  assert.equal(openWeight.max_completion_tokens, undefined);
  assert.equal(openWeight.reasoning_effort, undefined);
  assert.equal(openWeight.temperature, 0.37, 'self-hosted Qwen keeps the configured sampling temperature');
});

test('unannounced open-weight Qwen 3.8 reasoning remains visible but is not assumed replayable', async () => {
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
    'history replay remains capability-neutral until the self-hosted release documents it',
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
