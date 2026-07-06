import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  buildResponsesBody,
  eventsFromResponsesCompletion,
  parseResponsesSSE,
  ResponsesProvider,
  useResponsesWire,
} from '../src/provider/responses.js';
import { createProvider } from '../src/provider/index.js';
import { OpenAIProvider } from '../src/provider/openai.js';
import type { CompletionRequest, ProviderEvent } from '../src/provider/provider.js';

const BASE_REQ: CompletionRequest = {
  model: 'gpt-5',
  system: 's',
  messages: [],
  tools: [],
  maxOutputTokens: 1024,
};

async function* fromLines(lines: string[]): AsyncIterable<string> {
  for (const l of lines) yield l;
}
async function collect(events: AsyncIterable<ProviderEvent>): Promise<ProviderEvent[]> {
  const out: ProviderEvent[] = [];
  for await (const e of events) out.push(e);
  return out;
}

function collectGen(gen: Generator<ProviderEvent>): ProviderEvent[] {
  return [...gen];
}

test('buildResponsesBody honors stream=false for non-stream fallback bodies', () => {
  const req = {
    model: 'gpt-5',
    system: 'sys',
    messages: [{ role: 'user' as const, content: [{ type: 'text' as const, text: 'hi' }] }],
    tools: [],
    maxOutputTokens: 1024,
  };
  assert.equal(buildResponsesBody(req, 'gpt-5', false).stream, false);
  assert.equal(buildResponsesBody(req, 'gpt-5', true).stream, true);
});

test('eventsFromResponsesCompletion maps message text, tool calls, and usage', () => {
  const obj = {
    status: 'completed',
    output: [
      { type: 'message', content: [{ type: 'output_text', text: 'Hello from responses' }] },
      {
        type: 'function_call',
        name: 'read_file',
        call_id: 'c1',
        arguments: '{"path":"a.ts"}',
      },
    ],
    usage: { input_tokens: 20, output_tokens: 8, input_tokens_details: { cached_tokens: 3 } },
  };
  const events = collectGen(eventsFromResponsesCompletion(obj));
  const text = events
    .filter((e): e is Extract<ProviderEvent, { type: 'text' }> => e.type === 'text')
    .map((e) => e.delta)
    .join('');
  assert.equal(text, 'Hello from responses');
  const call = events.find((e) => e.type === 'tool_call');
  assert.ok(call && call.type === 'tool_call');
  if (call && call.type === 'tool_call') {
    assert.equal(call.call.name, 'read_file');
    assert.deepEqual(call.call.input, { path: 'a.ts' });
  }
  const usage = events.find((e) => e.type === 'usage');
  assert.ok(usage && usage.type === 'usage');
  if (usage && usage.type === 'usage') {
    assert.equal(usage.inputTokens, 17);
    assert.equal(usage.outputTokens, 8);
    assert.equal(usage.cacheReadTokens, 3);
  }
  const done = events.at(-1);
  assert.equal(done?.type, 'done');
  if (done?.type === 'done') assert.equal(done.stopReason, 'tool_use');
});

test('eventsFromResponsesCompletion error still terminates with usage and done', () => {
  const events = collectGen(
    eventsFromResponsesCompletion({ error: { message: 'quota exceeded', code: 'rate_limit' } }),
  );
  const err = events.find((e) => e.type === 'error');
  assert.ok(err && err.type === 'error');
  assert.equal(err.code, 'rate_limit');
  assert.equal(events.at(-2)?.type, 'usage');
  assert.equal(events.at(-1)?.type, 'done');
});

test('eventsFromResponsesCompletion accepts { response: … } envelope', () => {
  const events = collectGen(
    eventsFromResponsesCompletion({
      response: {
        status: 'completed',
        output: [{ type: 'message', content: [{ type: 'output_text', text: 'wrapped' }] }],
        usage: { input_tokens: 1, output_tokens: 1 },
      },
    }),
  );
  const text = events
    .filter((e): e is Extract<ProviderEvent, { type: 'text' }> => e.type === 'text')
    .map((e) => e.delta)
    .join('');
  assert.equal(text, 'wrapped');
});

function mockResponsesFetch(opts: {
  nonStreamPayload: unknown;
  streamLines?: string[];
  streamThrows?: boolean;
}): () => void {
  const orig = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    assert.match(String(url), /\/responses$/, 'ResponsesProvider must POST to /responses');
    const body = init?.body ? (JSON.parse(init.body as string) as { stream?: boolean }) : {};
    if (body.stream === false) {
      return {
        ok: true,
        status: 200,
        text: async () => JSON.stringify(opts.nonStreamPayload),
      } as Response;
    }
    if (opts.streamThrows) {
      return {
        ok: true,
        status: 200,
        body: new ReadableStream<Uint8Array>({
          pull() {
            throw new Error('truncated responses SSE — force non-stream fallback');
          },
        }),
      } as Response;
    }
    return {
      ok: true,
      status: 200,
      body: new ReadableStream<Uint8Array>({
        start(controller) {
          for (const line of opts.streamLines ?? []) {
            controller.enqueue(new TextEncoder().encode(line));
          }
          controller.close();
        },
      }),
    } as Response;
  };
  return () => {
    globalThis.fetch = orig;
  };
}

test('ResponsesProvider.send non-stream fallback recovers when stream parse fails', async () => {
  const restore = mockResponsesFetch({
    nonStreamPayload: {
      status: 'completed',
      output: [{ type: 'message', content: [{ type: 'output_text', text: 'fallback via send' }] }],
      usage: { input_tokens: 4, output_tokens: 2 },
    },
    streamThrows: true,
  });
  try {
    const provider = new ResponsesProvider({ model: 'gpt-5', baseUrl: 'http://mock/v1' });
    assert.equal(provider.wire, 'responses');
    const events = await collect(provider.send(BASE_REQ));
    const text = events
      .filter((e): e is Extract<ProviderEvent, { type: 'text' }> => e.type === 'text')
      .map((e) => e.delta)
      .join('');
    assert.equal(text, 'fallback via send');
    assert.equal(events.at(-2)?.type, 'usage');
    assert.equal(events.at(-1)?.type, 'done');
  } finally {
    restore();
  }
});

test('ResponsesProvider.send non-stream error recovery terminates with usage and done', async () => {
  const restore = mockResponsesFetch({
    nonStreamPayload: { error: { message: 'invalid request', code: 'invalid_request' } },
    streamThrows: true,
  });
  try {
    const provider = new ResponsesProvider({ model: 'gpt-5', baseUrl: 'http://mock/v1' });
    const events = await collect(provider.send(BASE_REQ));
    const err = events.find((e) => e.type === 'error');
    assert.ok(err && err.type === 'error');
    assert.equal(err.code, 'invalid_request');
    assert.equal(events.at(-2)?.type, 'usage');
    assert.equal(events.at(-1)?.type, 'done');
  } finally {
    restore();
  }
});

test('createProvider selects ResponsesProvider when SHADOW_WIRE_API=responses', () => {
  const prev = process.env.SHADOW_WIRE_API;
  process.env.SHADOW_WIRE_API = 'responses';
  try {
    const provider = createProvider({ provider: 'openai', model: 'gpt-5' });
    assert.ok(provider instanceof ResponsesProvider);
    assert.equal(provider.wire, 'responses');
    assert.equal(provider.name, 'openai');
  } finally {
    if (prev === undefined) delete process.env.SHADOW_WIRE_API;
    else process.env.SHADOW_WIRE_API = prev;
  }
});

test('buildResponsesBody includes model, input, and tools', () => {
  const body = buildResponsesBody(
    {
      model: 'gpt-5',
      system: 'sys',
      messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }],
      tools: [{ name: 'read_file', description: 'read', parameters: { type: 'object', properties: {} } }],
      maxOutputTokens: 1024,
    },
    'gpt-5',
    true,
  );
  assert.equal(body.model, 'gpt-5');
  assert.ok(Array.isArray(body.input));
  assert.ok(body.tools);
  assert.equal(body.stream, true);
});

test('ResponsesProvider keeps openai family name and responses wire discriminator', () => {
  const responses = new ResponsesProvider({ model: 'gpt-5' });
  const chat = new OpenAIProvider({ model: 'gpt-5' });
  assert.equal(responses.name, chat.name);
  assert.equal(responses.name, 'openai');
  assert.equal(responses.wire, 'responses');
});

test('useResponsesWire reads SHADOW_WIRE_API', () => {
  const prev = process.env.SHADOW_WIRE_API;
  process.env.SHADOW_WIRE_API = 'responses';
  assert.equal(useResponsesWire(), true);
  delete process.env.SHADOW_WIRE_API;
  assert.equal(useResponsesWire(), false);
  if (prev) process.env.SHADOW_WIRE_API = prev;
});

test('parseResponsesSSE surfaces in-stream error on HTTP 200 (not silent)', async () => {
  const lines = [
    'data: {"type":"error","error":{"message":"rate limit exceeded","code":"rate_limit_exceeded","type":"rate_limit"}}',
    'data: [DONE]',
  ];
  const events = await collect(parseResponsesSSE(fromLines(lines)));
  const err = events.find((e) => e.type === 'error');
  assert.ok(err, 'expected an error event');
  assert.equal(err.type === 'error' && err.recoverable, true);
  assert.equal(err.type === 'error' && err.code, 'rate_limit_exceeded');
  assert.match(err.type === 'error' ? err.message : '', /rate limit exceeded/);
  assert.ok(events.some((e) => e.type === 'done'));
});

test('parseResponsesSSE emits parallel tool calls from completed response', async () => {
  const lines = [
    'data: {"type":"response.completed","response":{"status":"completed","output":[' +
      '{"type":"function_call","name":"read_file","call_id":"c1","arguments":"{\\"path\\":\\"a.ts\\"}"},' +
      '{"type":"function_call","name":"read_file","call_id":"c2","arguments":"{\\"path\\":\\"b.ts\\"}"}' +
      '],"usage":{"input_tokens":12,"output_tokens":3}}}',
    'data: [DONE]',
  ];
  const events = await collect(parseResponsesSSE(fromLines(lines)));
  const calls = events.filter((e): e is Extract<ProviderEvent, { type: 'tool_call' }> => e.type === 'tool_call');
  assert.equal(calls.length, 2);
  assert.equal(calls[0]!.call.name, 'read_file');
  assert.equal(calls[1]!.call.id, 'c2');
  const done = events.find((e) => e.type === 'done');
  assert.equal(done?.type === 'done' && done.stopReason, 'tool_use');
});

test('parseResponsesSSE does not duplicate text when output_text deltas were streamed', async () => {
  const lines = [
    'data: {"type":"response.output_text.delta","delta":"Hel"}',
    'data: {"type":"response.output_text.delta","delta":"lo"}',
    'data: {"type":"response.completed","response":{"status":"completed","output":[' +
      '{"type":"message","content":[{"type":"output_text","text":"Hello"}]}' +
      '],"usage":{"input_tokens":2,"output_tokens":2}}}',
    'data: [DONE]',
  ];
  const events = await collect(parseResponsesSSE(fromLines(lines)));
  const text = events
    .filter((e): e is Extract<ProviderEvent, { type: 'text' }> => e.type === 'text')
    .map((e) => e.delta)
    .join('');
  assert.equal(text, 'Hello', 'streamed deltas only — completed message text must not re-emit');
});

test('parseResponsesSSE emits message text from completed when no deltas streamed', async () => {
  const lines = [
    'data: {"type":"response.completed","response":{"status":"completed","output":[' +
      '{"type":"message","content":[{"type":"output_text","text":"only completed"}]}' +
      '],"usage":{"input_tokens":1,"output_tokens":1}}}',
    'data: [DONE]',
  ];
  const events = await collect(parseResponsesSSE(fromLines(lines)));
  const text = events
    .filter((e): e is Extract<ProviderEvent, { type: 'text' }> => e.type === 'text')
    .map((e) => e.delta)
    .join('');
  assert.equal(text, 'only completed');
});

test('parseResponsesSSE yields recoverable bad_tool_json for malformed arguments', async () => {
  const lines = [
    'data: {"type":"response.completed","response":{"status":"completed","output":[' +
      '{"type":"function_call","name":"run_shell","call_id":"bad","arguments":"not-json"}' +
      ']}}',
    'data: [DONE]',
  ];
  const events = await collect(parseResponsesSSE(fromLines(lines)));
  const err = events.find((e) => e.type === 'error');
  assert.ok(err);
  assert.equal(err.type === 'error' && err.code, 'bad_tool_json');
  assert.equal(err.type === 'error' && err.recoverable, true);
});