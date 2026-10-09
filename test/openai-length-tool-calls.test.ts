import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { rmSync } from 'node:fs';
import { z } from 'zod';
import { isolateHome, assertStoreIsolated } from './helpers/isolateHome.js';
import type { LoopEvent } from '../src/agent/events.js';
import type { Message, Provider, ProviderEvent } from '../src/provider/provider.js';
import type { Tool } from '../src/tools/types.js';

// Import runtime modules only after HOME isolation: the loop loads globalStore.
const isolated = isolateHome('openai-length-tool-calls');
const [
  { AgentLoop }, { Budget }, { Context }, { EventBus }, { ToolRegistry },
  { AutoApproveGate }, { ok }, { parseOpenAISSE }, { GLOBAL_DIR },
] = await Promise.all([
  import('../src/agent/loop.js'),
  import('../src/agent/budget.js'),
  import('../src/agent/context.js'),
  import('../src/agent/events.js'),
  import('../src/tools/registry.js'),
  import('../src/agent/approval.js'),
  import('../src/tools/types.js'),
  import('../src/provider/openai.js'),
  import('../src/state/globalStore.js'),
]);
assertStoreIsolated(GLOBAL_DIR, isolated.home);
after(() => rmSync(isolated.home, { recursive: true, force: true }));

interface WireCall {
  index: number;
  id: string;
  function: { name: string; arguments: string };
}

function call(id: string, index: number, args: string): WireCall {
  return { index, id, function: { name: 'fixture_counter', arguments: args } };
}

function toolTurn(calls: WireCall[], finishReason = 'length'): string[] {
  return [
    'data: ' + JSON.stringify({ choices: [{ delta: { tool_calls: calls } }] }),
    'data: ' + JSON.stringify({ choices: [{ delta: {}, finish_reason: finishReason }] }),
    'data: [DONE]',
  ];
}

const answerTurn = [
  'data: ' + JSON.stringify({ choices: [{ delta: { content: 'Fixture complete.' }, finish_reason: 'stop' }] }),
  'data: [DONE]',
];

function fixture(turns: string[][]) {
  const runs: string[] = [];
  const requests: Message[][] = [];
  const parsedTurns: ProviderEvent[][] = [];
  const events: LoopEvent[] = [];
  const registry = new ToolRegistry();
  const counter: Tool<{ label: string }> = {
    name: 'fixture_counter',
    description: 'Record a label in memory; no external side effects.',
    risk: 'read',
    inputSchema: z.object({ label: z.string() }),
    async run(input) {
      runs.push(input.label);
      return ok('fixture_counter', 'read', 0, `Recorded ${input.label}.`);
    },
  };
  registry.register(counter);
  const provider: Provider = {
    name: 'fixture',
    estimateTokens: () => 0,
    async *send(req): AsyncIterable<ProviderEvent> {
      const wire = turns[requests.length];
      assert.ok(wire, 'the loop must not request an unscripted provider turn');
      requests.push(structuredClone(req.messages));
      const parsed: ProviderEvent[] = [];
      parsedTurns.push(parsed);
      async function* lines(): AsyncIterable<string> { yield* wire; }
      for await (const event of parseOpenAISSE(lines(), 'fixture-model')) {
        parsed.push(event);
        yield event;
      }
    },
  };
  const bus = new EventBus();
  bus.on((event) => events.push(event));
  const context = new Context({ contextBudget: 1_000_000, triggerRatio: 0.75, keepLastTurns: 6 });
  context.pinTask({ role: 'user', content: [{ type: 'text', text: 'Record the fixture labels.' }] });
  const loop = new AgentLoop({
    provider,
    registry,
    gate: new AutoApproveGate(),
    bus,
    budget: new Budget({ maxIterations: 8 }, 'fixture', { fixture: { input: 0, output: 0 } }, Date.now()),
    context,
    signal: new AbortController().signal,
    model: 'fixture-model',
    system: 'Offline test fixture.',
    maxOutputTokens: 1024,
    workspaceRoot: isolated.home,
    dryRun: false,
    maxToolResultChars: 4096,
    contextBudget: 1_000_000,
    sleep: async () => {},
  }, 'full');
  return { loop, runs, requests, parsedTurns, events };
}

function resultIds(messages: Message[]): string[] {
  return messages.flatMap((message) => message.content.flatMap((block) =>
    block.type === 'tool_result' ? [block.toolCallId] : [],
  ));
}

function texts(messages: Message[]): string[] {
  return messages.flatMap((message) => message.content.flatMap((block) =>
    block.type === 'text' ? [block.text] : [],
  ));
}

test('a complete native call with finish_reason length executes once and continues', async () => {
  const f = fixture([
    toolTurn([call('complete', 0, JSON.stringify({ label: 'complete' }))]),
    answerTurn,
  ]);
  const result = await f.loop.run();

  assert.equal(f.parsedTurns[0]!.find((event) => event.type === 'done')?.stopReason, 'max_tokens');
  assert.deepEqual(f.runs, ['complete'], 'length must not discard a complete native call');
  assert.equal(f.events.filter((event) => event.type === 'tool_start').length, 1);
  assert.equal(f.events.filter((event) => event.type === 'tool_end').length, 1);
  assert.equal(f.events.some((event) => event.type === 'retry'), false);
  assert.deepEqual(resultIds(f.requests[1]!), ['complete'], 'the next request includes the tool result');
  assert.equal(result.stopReason, 'end_turn');
  assert.equal(f.requests.length, 2);
});

test('truncated native arguments with length are rejected and the corrected call runs once', async () => {
  const f = fixture([
    toolTurn([call('truncated', 0, '{"label":"unfinished')]),
    toolTurn([call('corrected', 0, JSON.stringify({ label: 'corrected' }))], 'tool_calls'),
    answerTurn,
  ]);
  const result = await f.loop.run();

  assert.equal(f.parsedTurns[0]!.some((event) => event.type === 'tool_call'), false);
  assert.ok(f.parsedTurns[0]!.some((event) => event.type === 'error' && event.code === 'bad_tool_json'));
  assert.deepEqual(f.runs, ['corrected'], 'the incomplete arguments never reach the tool');
  assert.deepEqual(
    f.events.filter((event) => event.type === 'retry').map((event) => event.reason),
    ['malformed tool-call JSON'],
  );
  assert.ok(texts(f.requests[1]!).some((text) => text.includes('Re-send the tool call with valid JSON')));
  assert.deepEqual(resultIds(f.requests[1]!), [], 'a rejected partial call has no fabricated result');
  assert.deepEqual(resultIds(f.requests[2]!), ['corrected']);
  assert.equal(f.events.filter((event) => event.type === 'tool_start').length, 1);
  assert.equal(f.events.filter((event) => event.type === 'tool_end').length, 1);
  assert.equal(result.stopReason, 'end_turn');
  assert.equal(f.requests.length, 3);
});

test('a length turn with complete and truncated calls runs the complete call and reports the missing sibling', async () => {
  const f = fixture([
    toolTurn([
      call('complete', 0, JSON.stringify({ label: 'complete' })),
      call('truncated', 1, '{"label":"unfinished'),
    ]),
    toolTurn([call('corrected', 0, JSON.stringify({ label: 'corrected' }))], 'tool_calls'),
    answerTurn,
  ]);
  const result = await f.loop.run();

  assert.equal(f.parsedTurns[0]!.find((event) => event.type === 'done')?.stopReason, 'max_tokens');
  assert.deepEqual(f.runs, ['complete', 'corrected'], 'valid work runs once; only the missing call is resent');
  assert.deepEqual(resultIds(f.requests[1]!), ['complete']);
  assert.ok(texts(f.requests[1]!).some((text) => text.includes('1 tool call(s) in your last message could not be run')));
  assert.deepEqual(resultIds(f.requests[2]!), ['complete', 'corrected']);
  assert.deepEqual(
    f.events.filter((event) => event.type === 'tool_start').map((event) => event.call.id),
    ['complete', 'corrected'],
  );
  assert.equal(f.events.filter((event) => event.type === 'tool_end').length, 2);
  assert.equal(f.events.some((event) => event.type === 'retry'), false, 'mixed-call feedback rides with the valid result');
  assert.equal(result.stopReason, 'end_turn');
  assert.equal(f.requests.length, 3);
});
