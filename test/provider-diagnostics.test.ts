import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { rmSync } from 'node:fs';
import { join } from 'node:path';
import { isolateHome } from './helpers/isolateHome.js';
import type { ProviderEvent } from '../src/provider/provider.js';

const isolated = isolateHome('provider-diagnostics');
const { OpenAIStreamDiagnostics } = await import('../src/provider/streamDiagnostics.js');
const { parseSseData } = await import('../src/provider/sse.js');
const { streamWithRetry } = await import('../src/provider/stream.js');
after(() => rmSync(isolated.home, { recursive: true, force: true }));

test('SSE diagnostics distinguish malformed payloads, keepalives, and salvaged packed frames', () => {
  const diagnostics = new OpenAIStreamDiagnostics();
  const parse = (parts: string[]) => {
    diagnostics.observeDataEvent();
    const frames = parseSseData(parts.join('\n'), parts, (outcome) => diagnostics.observeParseOutcome(outcome));
    frames.forEach((frame) => diagnostics.observeFrame(frame));
    return frames;
  };
  parse(['null']);
  parse(['{"choices":[{"delta":{"content":"hello"}}]}', 'broken']);
  parse(['{"choices":[{"delta":', '{"content":"world"}}]}']);
  parse(['{"choices":[],"usage":{"completion_tokens":2}}']);
  const summary = diagnostics.event().data;
  assert.equal(summary.dataEvents, 4);
  assert.equal(summary.parsedFrames, 3);
  assert.equal(summary.malformedPayloads, 1, 'a successfully reassembled frame is not malformed');
  assert.equal(summary.ignoredJsonValues, 1, 'null is an intentional ignored value');
  assert.equal(summary.unrecognizedFrames, 0, 'the final usage-only frame is recognized');
  assert.equal(summary.contentDeltas, 2);
});

test('tool diagnostics preserve counts and bounded indexes without retaining payload strings', () => {
  const sentinel = 'PRIVATE_SENTINEL_do_not_log';
  const diagnostics = new OpenAIStreamDiagnostics();
  diagnostics.observeFrame({ choices: [{ delta: { content: sentinel, reasoning_content: sentinel }, finish_reason: sentinel }] });
  for (let index = 0; index < 40; index++) {
    diagnostics.observeToolFragment({ index, id: sentinel, function: { name: sentinel, arguments: sentinel } });
  }
  diagnostics.observeToolFragment({ function: { arguments: { private: sentinel } } });
  diagnostics.observeToolFragment({ function: { arguments: 99 } });
  diagnostics.recordToolOutcome('emitted');
  diagnostics.recordToolOutcome('empty');
  diagnostics.recordToolOutcome('nameless');
  diagnostics.recordToolOutcome('invalid_args');
  const event = diagnostics.event();
  assert.ok(!JSON.stringify(event).includes(sentinel));
  assert.equal(event.data.finishReason, 'other');
  assert.deepEqual(event.data.indexes, Array.from({ length: 16 }, (_, i) => i));
  assert.equal(event.data.unlistedIndexFragments, 24);
  assert.equal(event.data.toolFragments, 42);
  assert.equal(event.data.unsupportedToolFragments, 1);
  assert.equal(event.data.argumentFragments, 41);
  assert.equal(event.data.argumentChars, 40 * sentinel.length);
  assert.equal(event.data.objectArgumentFragments, 1);
  assert.equal(event.data.toolSlots, 4);
  assert.deepEqual([event.data.emittedCalls, event.data.emptySlots, event.data.namelessCalls, event.data.invalidArgumentCalls], [1, 1, 1, 1]);
  event.data.indexes.push(999);
  assert.equal(diagnostics.event().data.indexes.length, 16, 'event snapshots do not mutate the accumulator');
});

test('diagnostics distinguish missing calls from unsupported message and legacy call shapes', () => {
  const missing = new OpenAIStreamDiagnostics();
  missing.observeFrame({ choices: [{ delta: {}, finish_reason: 'tool_calls' }] });
  assert.equal(missing.event().data.unsupportedToolFrames, 0);
  assert.equal(missing.event().data.toolFragments, 0);

  const sentinel = 'PRIVATE_UNSUPPORTED_CALL';
  const unsupported = new OpenAIStreamDiagnostics();
  unsupported.observeFrame({ choices: [{ message: { tool_calls: [{ id: sentinel }] }, finish_reason: 'tool_calls' }] });
  unsupported.observeFrame({ choices: [{ delta: { function_call: { name: sentinel } }, finish_reason: 'function_call' }] });
  unsupported.observeFrame({ choices: [{ delta: { tool_calls: { secret: sentinel } } }] });
  unsupported.observeToolFragment({ name: sentinel, arguments: sentinel });
  assert.equal(unsupported.event().data.unsupportedToolFrames, 3);
  assert.equal(unsupported.event().data.unsupportedToolFragments, 1);
  assert.ok(!JSON.stringify(unsupported.event()).includes(sentinel));
});

test('metadata-only diagnostics do not prevent an empty failing stream from using its fallback', async (t) => {
  let requests = 0;
  t.mock.method(globalThis, 'fetch', async (_url: unknown, init?: RequestInit) => {
    requests++;
    const body = JSON.parse(String(init?.body)) as { stream: boolean };
    return new Response(body.stream ? 'data: broken\n' : '{"ok":true}', {
      headers: { 'content-type': body.stream ? 'text/event-stream' : 'application/json' },
    });
  });
  const events: ProviderEvent[] = [];
  for await (const event of streamWithRetry({
    url: 'https://203.0.113.10/v1/chat/completions', headers: {},
    body: { stream: true }, nonStreamBody: { stream: false }, streamRetries: 1,
    parse: async function* () {
      yield new OpenAIStreamDiagnostics().event();
      throw new Error('empty parser failure');
    },
    parseNonStream: function* () {
      yield { type: 'text', delta: 'fallback answer' };
      yield { type: 'done', stopReason: 'end_turn' };
    },
  })) events.push(event);
  assert.equal(requests, 2, 'the diagnostic did not count as streamed output');
  assert.deepEqual(events.map((event) => event.type), ['diagnostic', 'text', 'done']);
});

test('completed main-request metadata persists once without entering answer or model context', async () => {
  const { AgentLoop } = await import('../src/agent/loop.js');
  const { Budget } = await import('../src/agent/budget.js');
  const { Context } = await import('../src/agent/context.js');
  const { EventBus } = await import('../src/agent/events.js');
  const { ToolRegistry } = await import('../src/tools/registry.js');
  const { AutoApproveGate } = await import('../src/agent/approval.js');
  const { MockProvider } = await import('../src/provider/mock.js');
  const { SessionLog } = await import('../src/state/session.js');
  const log = SessionLog.open(join(isolated.home, 'workspace'));
  const context = new Context({ contextBudget: 1_000_000, triggerRatio: 0.75, keepLastTurns: 6 });
  context.pinTask({ role: 'user', content: [{ type: 'text', text: 'hello' }] });
  const bus = new EventBus();
  bus.on((event) => log.recordEvent(event));
  try {
    const result = await new AgentLoop({
      provider: new MockProvider([[new OpenAIStreamDiagnostics().event(), { type: 'text', delta: 'Done.' }, { type: 'done', stopReason: 'end_turn' }]]),
      registry: new ToolRegistry(), gate: new AutoApproveGate(), bus,
      budget: new Budget({ maxIterations: 2 }, 'mock', { mock: { input: 1, output: 1 } }, Date.now()),
      context, signal: new AbortController().signal, model: 'mock', system: 'test',
      maxOutputTokens: 2048, workspaceRoot: isolated.home, dryRun: false,
      maxToolResultChars: 1024, contextBudget: 1_000_000,
    }, 'full').run();
    assert.equal(result.finalAnswer, 'Done.');
    assert.ok(!JSON.stringify(context.messages()).includes('openai_stream_summary'));
    const saved = SessionLog.load(log.path) as Array<Record<string, unknown>>;
    const diagnostics = saved.filter((event) => event.type === 'debug' && event.code === 'openai_stream_summary');
    assert.equal(diagnostics.length, 1);
    assert.equal(JSON.parse(String(diagnostics[0]!.message)).requestedMaxOutputTokens, 2048);
  } finally {
    log.close();
  }
});

async function* fixtureLines(frames: unknown[]): AsyncIterable<string> {
  for (const frame of frames) {
    yield `data: ${JSON.stringify(frame)}`;
    yield '';
  }
  yield 'data: [DONE]';
}

test('actual OpenAI parser reports each assembled slot outcome once without payloads', async () => {
  const { parseOpenAISSE } = await import('../src/provider/openai.js');
  const secret = 'PRIVATE_PAYLOAD_SENTINEL';
  const frames = [
    { choices: [{ delta: { tool_calls: [
      { index: 0, id: secret, function: { name: secret, arguments: '{"path":' } },
      { index: 1, id: 'empty' },
      { index: 2, id: 'nameless', function: { arguments: '{}' } },
      { index: 3, id: 'invalid', function: { name: secret, arguments: '{"path":' } },
    ] } }] },
    { choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: `"${secret}"}` } }] }, finish_reason: 'length' }] },
  ];
  const events: ProviderEvent[] = [];
  for await (const event of parseOpenAISSE(fixtureLines(frames), 'fixture')) events.push(event);
  const diagnostic = events.filter((e) => e.type === 'diagnostic');
  assert.equal(diagnostic.length, 1);
  assert.equal(events.filter((e) => e.type === 'tool_call').length, 1);
  assert.deepEqual(events.slice(-3).map((e) => e.type), ['diagnostic', 'usage', 'done']);
  const summary = diagnostic[0].data;
  assert.equal(summary.finishReason, 'length');
  assert.equal(summary.toolFragments, 5);
  assert.equal(summary.argumentFragments, 4);
  assert.deepEqual(summary.indexes, [0, 1, 2, 3]);
  assert.deepEqual([summary.toolSlots, summary.emittedCalls, summary.emptySlots, summary.namelessCalls, summary.invalidArgumentCalls], [4, 1, 1, 1, 1]);
  assert.ok(!JSON.stringify(diagnostic).includes(secret));
});

test('actual parser distinguishes a missing tool payload from malformed SSE', async () => {
  const { parseOpenAISSE } = await import('../src/provider/openai.js');
  async function* source(): AsyncIterable<string> {
    yield 'data: broken'; yield '';
    yield* fixtureLines([{ choices: [{ delta: {}, finish_reason: 'tool_calls' }] }]);
  }
  const events: ProviderEvent[] = [];
  for await (const event of parseOpenAISSE(source(), 'fixture')) events.push(event);
  const summary = events.find((e) => e.type === 'diagnostic')!;
  assert.equal(summary.data.malformedPayloads, 1);
  assert.equal(summary.data.finishReason, 'tool_calls');
  assert.equal(summary.data.toolFragments, 0);
  assert.equal(summary.data.emittedCalls, 0);
});
