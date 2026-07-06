import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseOpenAISSE, buildOpenAIBody, isGrokReasoningModel } from '../src/provider/openai.js';
import type { CompletionRequest, ProviderEvent, ToolCall } from '../src/provider/provider.js';

async function* fromLines(lines: string[]): AsyncIterable<string> {
  for (const l of lines) yield l;
}
async function collect(events: AsyncIterable<ProviderEvent>): Promise<ProviderEvent[]> {
  const out: ProviderEvent[] = [];
  for await (const e of events) out.push(e);
  return out;
}
const toolChunk = (tc: unknown): string => 'data: ' + JSON.stringify({ choices: [{ delta: { tool_calls: [tc] } }] });
const FINISH = 'data: ' + JSON.stringify({ choices: [{ delta: {}, finish_reason: 'tool_calls' }] });
async function callsFrom(lines: string[]): Promise<ToolCall[]> {
  const events = await collect(parseOpenAISSE(fromLines(lines)));
  return events.filter((e): e is Extract<ProviderEvent, { type: 'tool_call' }> => e.type === 'tool_call').map((e) => e.call);
}

test('two calls with ids but NO index do not merge', async () => {
  const calls = await callsFrom([
    toolChunk({ id: 'a', function: { name: 'write_file', arguments: '{"path":"a"}' } }),
    toolChunk({ id: 'b', function: { name: 'read_file', arguments: '{"path":"b"}' } }),
    FINISH,
  ]);
  assert.equal(calls.length, 2);
  assert.deepEqual(calls.map((c) => c.name), ['write_file', 'read_file']);
  assert.deepEqual(calls[0]!.input, { path: 'a' });
  assert.deepEqual(calls[1]!.input, { path: 'b' });
});

test('two calls that both reuse index 0 do not merge (keyed by id)', async () => {
  const calls = await callsFrom([
    toolChunk({ index: 0, id: 'a', function: { name: 'write_file', arguments: '{"path":"a"}' } }),
    toolChunk({ index: 0, id: 'b', function: { name: 'read_file', arguments: '{"path":"b"}' } }),
    FINISH,
  ]);
  assert.equal(calls.length, 2);
});

test('argument deltas split across chunks reassemble into ONE call (indexed)', async () => {
  const calls = await callsFrom([
    toolChunk({ index: 0, id: 'a', function: { name: 'write_file', arguments: '{"pa' } }),
    toolChunk({ index: 0, function: { arguments: 'th":"x"}' } }),
    FINISH,
  ]);
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0]!.input, { path: 'x' });
});

test('continuation with no id and no index attaches to the current call', async () => {
  const calls = await callsFrom([
    toolChunk({ id: 'a', function: { name: 'run_shell', arguments: '{"command":"l' } }),
    toolChunk({ function: { arguments: 's"}' } }),
    FINISH,
  ]);
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0]!.input, { command: 'ls' });
});

test('normal multi-call indexed streaming still works (regression guard)', async () => {
  const calls = await callsFrom([
    toolChunk({ index: 0, id: 'a', function: { name: 'read_file', arguments: '{"path":"x"}' } }),
    toolChunk({ index: 1, id: 'b', function: { name: 'read_file', arguments: '{"path":"y"}' } }),
    FINISH,
  ]);
  assert.equal(calls.length, 2);
  assert.deepEqual(calls.map((c) => (c.input as { path: string }).path), ['x', 'y']);
});

test('name on an index-only chunk then id later (same index) stays ONE call (review #13)', async () => {
  const calls = await callsFrom([
    toolChunk({ index: 0, function: { name: 'write_file', arguments: '{"pa' } }), // name, NO id
    toolChunk({ index: 0, id: 'x', function: { arguments: 'th":"a"}' } }), // id arrives late, same index
    FINISH,
  ]);
  assert.equal(calls.length, 1);
  assert.equal(calls[0]!.id, 'x');
  assert.deepEqual(calls[0]!.input, { path: 'a' });
});

test('calls with no id get distinct synthetic ids (de-dupe, no collision)', async () => {
  const calls = await callsFrom([
    toolChunk({ index: 0, function: { name: 'write_file', arguments: '{"path":"a"}' } }),
    toolChunk({ index: 1, function: { name: 'read_file', arguments: '{"path":"b"}' } }),
    FINISH,
  ]);
  assert.equal(calls.length, 2);
  assert.notEqual(calls[0]!.id, calls[1]!.id);
});

// ── Grok reasoning_effort gating ──
test('isGrokReasoningModel: only the reasoning variants', () => {
  assert.equal(isGrokReasoningModel('grok-3-mini'), true);
  assert.equal(isGrokReasoningModel('grok-4-fast-reasoning'), true);
  assert.equal(isGrokReasoningModel('grok-4'), false);
  assert.equal(isGrokReasoningModel('grok-4-fast-non-reasoning'), false); // review #14
  assert.equal(isGrokReasoningModel('gpt-4o'), false);
});

test('grok reasoning body carries reasoning_effort; plain grok-4 does NOT', () => {
  const req = (m: string): CompletionRequest => ({ model: m, system: 's', messages: [], tools: [], maxOutputTokens: 8192, effort: 'high' });
  assert.equal(buildOpenAIBody(req('grok-3-mini'), 'fb').reasoning_effort, 'high');
  assert.equal(buildOpenAIBody(req('grok-4'), 'fb').reasoning_effort, undefined);
  assert.equal(buildOpenAIBody(req('grok-4'), 'fb').max_tokens, 8192);
});
