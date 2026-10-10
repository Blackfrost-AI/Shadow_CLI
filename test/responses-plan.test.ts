import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildResponsesBody, eventsFromResponsesCompletion, parseResponsesSSE, ResponsesProvider } from '../src/provider/responses.js';
import type { CompletionRequest, ProviderEvent, ResponsesReasoningItem } from '../src/provider/provider.js';
import { resolveFakeHosts } from './helpers/fakeHostEgress.js';

const req: CompletionRequest = {
  model: 'gpt-6.1-sol', system: 'Use the workspace tools.',
  messages: [{ role: 'user', content: [{ type: 'text', text: 'Find the answer.' }] }],
  tools: [
    { name: 'read_file', description: 'Read a file', parameters: { type: 'object', properties: { path: { type: 'string' } } } },
    { name: 'grep', description: 'Search files', parameters: { type: 'object', properties: { pattern: { type: 'string' } } } },
  ],
  maxOutputTokens: 1024, temperature: 0.5, effort: 'high',
};
async function* lines(events: unknown[]) {
  for (const event of events) yield 'data: ' + JSON.stringify(event);
}
const collect = async (stream: AsyncIterable<ProviderEvent>): Promise<ProviderEvent[]> => {
  const events: ProviderEvent[] = [];
  for await (const event of stream) events.push(event);
  return events;
};
const ofType = <T extends ProviderEvent['type']>(events: ProviderEvent[], type: T) =>
  events.filter((event): event is Extract<ProviderEvent, { type: T }> => event.type === type);
const call = (id = 'call_1', name = 'read_file', args = '{"path":"a.ts"}') =>
  ({ type: 'function_call', id: 'fc_' + id, call_id: id, namespace: 'shadow', name, arguments: args, status: 'completed' });
const terminal = (output: unknown[] = [], extra = {}) =>
  ({ type: 'response.completed', response: { status: 'completed', output, ...extra } });

test('plan body uses the documented stateless streaming namespace contract', () => {
  const body = buildResponsesBody(req, req.model, false, { chatgptPlan: true, selfHosted: true });
  assert.equal(body.store, false);
  assert.equal(body.stream, true);
  assert.equal(body.instructions, req.system);
  assert.deepEqual(body.include, ['reasoning.encrypted_content']);
  assert.deepEqual(body.reasoning, { effort: 'high', summary: 'auto' });
  assert.deepEqual(body.tools, [{
    type: 'namespace', name: 'shadow', description: 'Tools executed by Shadow.',
    tools: req.tools.map((tool) => ({ type: 'function', ...tool, strict: false })),
  }]);
  for (const field of ['max_output_tokens', 'temperature', 'top_p', 'background', 'conversation',
    'previous_response_id', 'metadata', 'prompt', 'truncation', 'user', 'messages']) {
    assert.equal(field in body, false, field + ' must not appear in a plan request');
  }
});

test('Responses input round-trips tools, images and developer instructions in block order', () => {
  const request: CompletionRequest = { ...req, messages: [
    { role: 'system', content: [{ type: 'text', text: 'Extra instructions.' }] },
    { role: 'user', content: [
      { type: 'text', text: 'Look:' }, { type: 'image', mediaType: 'image/png', data: 'Zml4dHVyZQ==' },
    ] },
    { role: 'assistant', content: [
      { type: 'thinking', thinking: 'Other provider summary', signature: 'foreign', model: 'claude' },
      { type: 'text', text: 'Checking.' },
      { type: 'tool_use', id: 'call_1', name: 'read_file', input: { path: 'a.ts' } },
      { type: 'text', text: 'Then compare.' },
      { type: 'tool_use', id: 'call_2', name: 'grep', input: { pattern: 'needle' } },
    ] },
    { role: 'tool', content: [
      { type: 'tool_result', toolCallId: 'call_1', ok: true, content: 'file contents' },
      { type: 'tool_result', toolCallId: 'call_2', ok: false, content: 'no matches' },
    ] },
  ] };
  const input = buildResponsesBody(request, request.model, true, { chatgptPlan: true }).input;
  assert.deepEqual(input, [
    { role: 'developer', content: [{ type: 'input_text', text: 'Extra instructions.' }] },
    { role: 'user', content: [
      { type: 'input_text', text: 'Look:' }, { type: 'input_image', image_url: 'data:image/png;base64,Zml4dHVyZQ==', detail: 'auto' },
    ] },
    { role: 'assistant', content: 'Checking.' },
    { type: 'function_call', call_id: 'call_1', name: 'read_file', namespace: 'shadow', arguments: '{"path":"a.ts"}' },
    { role: 'assistant', content: 'Then compare.' },
    { type: 'function_call', call_id: 'call_2', name: 'grep', namespace: 'shadow', arguments: '{"pattern":"needle"}' },
    { type: 'function_call_output', call_id: 'call_1', output: 'file contents' },
    { type: 'function_call_output', call_id: 'call_2', output: 'no matches' },
  ]);
  const generic = buildResponsesBody(request, request.model).input as Record<string, unknown>[];
  assert.equal(generic.some((item) => item.role === 'tool' || 'tool_calls' in item || 'tool_call_id' in item), false);
  assert.equal(generic.find((item) => item.type === 'function_call')?.namespace, undefined);
});

test('forced plan tool restricts namespace membership; ordinary forced tool uses Responses shape', () => {
  const request = { ...req, toolChoice: { type: 'tool' as const, name: 'grep', disableParallelToolUse: true } };
  const plan = buildResponsesBody(request, req.model, true, { chatgptPlan: true });
  assert.equal(plan.tool_choice, 'required');
  assert.equal(plan.parallel_tool_calls, false);
  const namespace = (plan.tools as { tools: { name: string }[] }[])[0]!;
  assert.deepEqual(namespace.tools.map((tool) => tool.name), ['grep']);
  const normal = buildResponsesBody(request, req.model);
  assert.deepEqual(normal.tool_choice, { type: 'function', name: 'grep' });
  assert.equal((normal.tools as unknown[]).length, 2);
  for (const [type, expected] of [['auto', 'auto'], ['any', 'required'], ['none', 'none']] as const) {
    assert.equal(buildResponsesBody({ ...req, toolChoice: { type } }, req.model, true, { chatgptPlan: true }).tool_choice, expected);
  }
  assert.throws(() => buildResponsesBody({ ...req, toolChoice: { type: 'tool', name: 'absent' } }, req.model, true, { chatgptPlan: true }), /not available/);
});

test('parallel argument deltas stay bound to their item IDs/output indexes and emit once', async () => {
  const first = call('a');
  const second = call('b', 'grep', '{"pattern":"needle"}');
  const events = await collect(parseResponsesSSE(lines([
    { type: 'response.output_item.added', output_index: 0, item: { ...first, arguments: '', status: 'in_progress' } },
    { type: 'response.output_item.added', output_index: 1, item: { ...second, arguments: '', status: 'in_progress' } },
    { type: 'response.function_call_arguments.delta', item_id: first.id, output_index: 0, delta: '{"path":' },
    { type: 'response.function_call_arguments.delta', item_id: second.id, output_index: 1, delta: '{"pattern":' },
    { type: 'response.function_call_arguments.delta', item_id: first.id, output_index: 0, delta: '"a.ts"}' },
    { type: 'response.function_call_arguments.delta', item_id: second.id, output_index: 1, delta: '"needle"}' },
    { type: 'response.function_call_arguments.done', item_id: first.id, output_index: 0, arguments: first.arguments },
    { type: 'response.output_item.done', output_index: 0, item: first },
    { type: 'response.output_item.done', output_index: 1, item: second },
    terminal([first, second]),
  ]), { chatgptPlan: true }));
  assert.deepEqual(ofType(events, 'tool_call').map((event) => event.call), [
    { id: 'a', name: 'read_file', input: { path: 'a.ts' } },
    { id: 'b', name: 'grep', input: { pattern: 'needle' } },
  ]);
  assert.deepEqual(ofType(events, 'tool_call_partial').map((event) => [event.id, event.name]), [
    ['a', 'read_file'], ['b', 'grep'], ['a', 'read_file'], ['b', 'grep'],
  ]);
  assert.equal(ofType(events, 'done')[0]?.stopReason, 'tool_use');
});

test('item.done arguments survive a minimal completed response without output duplication', async () => {
  const item = call();
  const events = await collect(parseResponsesSSE(lines([
    { type: 'response.output_item.added', output_index: 2, item: { ...item, arguments: '', status: 'in_progress' } },
    { type: 'response.output_item.done', output_index: 2, item: { ...item, status: undefined } },
    terminal(),
  ])));
  assert.equal(ofType(events, 'tool_call').length, 1);
  assert.deepEqual(ofType(events, 'tool_call')[0]?.call.input, { path: 'a.ts' });
});

test('final text fills only missing suffixes and separate unstreamed output parts', async () => {
  const events = await collect(parseResponsesSSE(lines([
    { type: 'response.output_text.delta', output_index: 0, item_id: 'msg1', content_index: 0, delta: 'Hel' },
    { type: 'response.output_item.done', output_index: 0, item: { type: 'message', id: 'msg1', content: [{ type: 'output_text', text: 'Hello' }] } },
    terminal([
      { type: 'message', id: 'msg1', content: [{ type: 'output_text', text: 'Hello' }] },
      { type: 'message', id: 'msg2', content: [{ type: 'output_text', text: ' world' }, { type: 'refusal', refusal: 'No.' }] },
    ]),
  ])));
  assert.equal(ofType(events, 'text').map((event) => event.delta).join(''), 'Hello worldNo.');
});

test('reasoning summaries display once; final opaque items are separate from visible events', async () => {
  const item: ResponsesReasoningItem = {
    type: 'reasoning', id: 'rs_1', summary: [{ type: 'summary_text', text: 'Check the file.' }],
    encrypted_content: 'sealed-final-fixture', status: 'completed',
  };
  const events = await collect(parseResponsesSSE(lines([
    { type: 'response.output_item.added', output_index: 0, item: { ...item, encrypted_content: 'partial-fixture', status: 'in_progress', summary: [] } },
    { type: 'response.reasoning_summary_text.delta', output_index: 0, item_id: item.id, summary_index: 0, delta: 'Check ' },
    { type: 'response.output_item.done', output_index: 0, item },
    terminal([item, call()]),
  ]), { chatgptPlan: true }));
  assert.equal(ofType(events, 'thinking').map((event) => event.delta).join(''), 'Check the file.');
  assert.deepEqual(ofType(events, 'response_reasoning_item'), [{ type: 'response_reasoning_item', item }]);
  assert.equal(JSON.stringify(events.filter((event) => event.type !== 'response_reasoning_item')).includes('sealed-final-fixture'), false);
  const historyReq: CompletionRequest = { ...req, messages: [{
    role: 'assistant', content: [{ type: 'tool_use', id: 'call_1', name: 'read_file', input: { path: 'a.ts' } }],
    responsesReasoning: { model: req.model, items: [item] },
  }] };
  const input = buildResponsesBody(historyReq, req.model, true, { chatgptPlan: true }).input as Record<string, unknown>[];
  assert.deepEqual(input[0], item);
  assert.equal(input[1]?.type, 'function_call');
  const anotherModel = buildResponsesBody({ ...historyReq, model: 'different-model' }, req.model).input as Record<string, unknown>[];
  assert.equal(anotherModel.some((part) => part.type === 'reasoning'), false);
  assert.equal((buildResponsesBody(historyReq, req.model, true, { reasoningRoundtrip: 'none' }).input as unknown[]).length, 1);
});

test('incomplete added ciphertext is never promoted to durable reasoning state', async () => {
  const events = await collect(parseResponsesSSE(lines([
    { type: 'response.output_item.added', output_index: 0, item: {
      type: 'reasoning', id: 'rs_bad', summary: [], encrypted_content: 'not-final', status: 'in_progress',
    } },
    terminal([{ type: 'reasoning', id: 'rs_bad', summary: [], status: 'completed' }]),
  ]), { chatgptPlan: true }));
  assert.equal(ofType(events, 'response_reasoning_item')[0]?.item.encrypted_content, undefined);
});

test('failed and incomplete plan responses never dispatch tools or persist opaque reasoning', async () => {
  for (const status of ['failed', 'incomplete']) {
    const events = await collect(parseResponsesSSE(lines([
      { type: 'response.output_item.done', output_index: 0, item: call() },
      { type: 'response.' + status, response: {
        status, output: [call(), { type: 'reasoning', id: 'rs_1', summary: [], encrypted_content: 'opaque' }],
        ...(status === 'failed' ? { error: { code: 'subscription_sharing_usage_limit_exceeded', message: 'Plan limit.' } } :
          { incomplete_details: { reason: 'max_output_tokens' } }),
        usage: { input_tokens: 11, output_tokens: 5 },
      } },
    ]), { chatgptPlan: true }));
    assert.equal(ofType(events, 'tool_call').length, 0, status);
    assert.equal(ofType(events, 'response_reasoning_item').length, 0, status);
    assert.equal(ofType(events, 'error')[0]?.recoverable, false);
    assert.equal(ofType(events, 'usage')[0]?.outputTokens, 5);
  }
});

test('plan usage error after text remains a failure with actionable exact code', async () => {
  const events = await collect(parseResponsesSSE(lines([
    { type: 'response.output_text.delta', delta: 'Partial answer.' },
    { type: 'response.failed', response: { status: 'failed', error: {
      code: 'subscription_sharing_usage_limit_exceeded', message: 'Plan limit.',
    } } },
  ]), { chatgptPlan: true }));
  assert.equal(ofType(events, 'text')[0]?.delta, 'Partial answer.');
  assert.equal(ofType(events, 'error')[0]?.code, 'subscription_sharing_usage_limit_exceeded');
  assert.match(ofType(events, 'error')[0]!.message, /chatgpt.com\/settings\/usage/);
});

test('flat Responses error events preserve code and named parameter', async () => {
  const events = await collect(parseResponsesSSE(lines([{
    type: 'error', code: 'subscription_sharing_unsupported_capability',
    message: 'Unsupported tool.', param: 'tools[0]',
  }]), { chatgptPlan: true }));
  assert.equal(ofType(events, 'error')[0]?.code, 'subscription_sharing_unsupported_capability');
  assert.match(ofType(events, 'error')[0]!.message, /tools\[0\]/);
});

test('early EOF and invalid terminal status cannot authorize tool execution', async () => {
  for (const final of [[], [terminal([], { status: 'in_progress' })], [{ type: 'response.completed' }]]) {
    const events = await collect(parseResponsesSSE(lines([
      { type: 'response.output_item.done', output_index: 0, item: call() }, ...final,
    ]), { chatgptPlan: true }));
    assert.equal(ofType(events, 'tool_call').length, 0);
    assert.ok(ofType(events, 'error').length);
  }
});

test('unknown tool namespaces do not dispatch local tools', async () => {
  const events = await collect(parseResponsesSSE(lines([terminal([{ ...call(), namespace: 'foreign' }])]), { chatgptPlan: true }));
  assert.equal(ofType(events, 'tool_call').length, 0);
  assert.equal(ofType(events, 'error')[0]?.code, 'invalid_tool_call');
});

test('generic Responses incomplete reports max_tokens while failed response preserves error', () => {
  const incomplete = [...eventsFromResponsesCompletion({ status: 'incomplete', incomplete_details: { reason: 'max_output_tokens' },
    output: [{ ...call(), status: 'incomplete', arguments: '{"path":' }], usage: { input_tokens: 10, output_tokens: 2 } })];
  assert.equal(ofType(incomplete, 'done')[0]?.stopReason, 'max_tokens');
  assert.equal(ofType(incomplete, 'tool_call').length, 0);
  const failed = [...eventsFromResponsesCompletion({ status: 'failed', error: { code: 'server_error', message: 'Unavailable.' }, output: [call()] })];
  assert.equal(ofType(failed, 'error')[0]?.code, 'server_error');
  assert.equal(ofType(failed, 'tool_call').length, 0);
});

async function withPlanFetch(
  fetcher: typeof fetch, work: () => Promise<void>,
): Promise<void> {
  const original = globalThis.fetch;
  const restore = resolveFakeHosts();
  globalThis.fetch = fetcher;
  try { await work(); } finally { globalThis.fetch = original; restore(); }
}

test('plan HTTP errors preserve code/status/request ID and never retry or rewrite request', async () => {
  let calls = 0;
  await withPlanFetch(async (url, init) => {
    calls++;
    assert.equal(String(url), 'https://api.openai.com/v1/responses');
    assert.equal(init?.redirect, 'error');
    const body = JSON.parse(String(init?.body));
    assert.equal(body.stream, true);
    assert.equal(body.store, false);
    assert.equal(body.max_output_tokens, undefined);
    return new Response(JSON.stringify({ error: {
      code: 'subscription_sharing_unsupported_capability', message: 'Unsupported tool_choice', param: 'tool_choice',
    } }), { status: 400, headers: { 'x-request-id': 'fixture-request' } });
  }, async () => {
    const provider = new ResponsesProvider({ model: req.model, chatgptPlan: true, apiKey: 'fixture-only-token' });
    assert.equal(provider.allowAutomaticFallback, false);
    const events = await collect(provider.send(req));
    const error = ofType(events, 'error')[0]!;
    assert.equal(error.code, 'subscription_sharing_unsupported_capability');
    assert.match(error.message, /HTTP 400.*fixture-request/);
    assert.equal(calls, 1);
  });
});

test('plan detail-shaped admission errors stay diagnostic and do not trigger retry', async () => {
  let calls = 0;
  await withPlanFetch(async () => {
    calls++;
    return new Response(JSON.stringify({ detail: 'Direct routing unavailable.' }), { status: 503 });
  }, async () => {
    const events = await collect(new ResponsesProvider({ model: req.model, chatgptPlan: true }).send(req));
    assert.equal(ofType(events, 'error')[0]?.code, 'http_503');
    assert.match(ofType(events, 'error')[0]!.message, /Direct routing unavailable/);
    assert.equal(calls, 1);
  });
});

test('plan streaming failure never falls back to a second or non-streaming POST', async () => {
  let calls = 0;
  await withPlanFetch(async () => {
    calls++;
    return new Response(new ReadableStream({ pull() { throw new Error('fixture disconnect'); } }));
  }, async () => {
    const events = await collect(new ResponsesProvider({ model: req.model, chatgptPlan: true }).send(req));
    assert.ok(ofType(events, 'error').length);
    assert.equal(calls, 1);
  });
});

test('plan abort cuts off a pending reader and suppresses cancellation errors', async () => {
  const abort = new AbortController();
  let cancelled = false;
  await withPlanFetch(async () => new Response(new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(new TextEncoder().encode('data: {"type":"response.output_text.delta","delta":"partial"}\n\n'));
    },
    cancel() { cancelled = true; },
  })), async () => {
    const events: ProviderEvent[] = [];
    for await (const event of new ResponsesProvider({ model: req.model, chatgptPlan: true }).send({ ...req, signal: abort.signal })) {
      events.push(event);
      if (event.type === 'text') abort.abort();
    }
    assert.equal(ofType(events, 'text')[0]?.delta, 'partial');
    assert.equal(ofType(events, 'error').length, 0);
    assert.equal(cancelled, true);
  });
});

test('plan credentials reject backend-api, proxy and insecure endpoint overrides', () => {
  for (const baseUrl of ['https://chatgpt.com/backend-api/codex', 'https://proxy.example/v1', 'http://api.openai.com/v1']) {
    assert.throws(() => new ResponsesProvider({ model: req.model, chatgptPlan: true, baseUrl }), /only use/);
  }
});
