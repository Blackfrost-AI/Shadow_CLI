import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseAnthropicSSE } from '../src/provider/anthropic.js';
import type { ProviderEvent } from '../src/provider/provider.js';

async function* fromLines(lines: string[]): AsyncIterable<string> {
  for (const l of lines) yield l;
}
async function collect(lines: string[]): Promise<ProviderEvent[]> {
  const out: ProviderEvent[] = [];
  for await (const e of parseAnthropicSSE(fromLines(lines))) out.push(e);
  return out;
}
const D = (o: unknown): string => 'data: ' + JSON.stringify(o);
const START = (i: number, cb: unknown) => D({ type: 'content_block_start', index: i, content_block: cb });
const JSONDELTA = (i: number, pj: string) => D({ type: 'content_block_delta', index: i, delta: { type: 'input_json_delta', partial_json: pj } });
const STOP = (i: number) => D({ type: 'content_block_stop', index: i });
const MSG_STOP = D({ type: 'message_stop' });
const count = (evts: ProviderEvent[], t: string) => evts.filter((e) => e.type === t).length;

test('CRITICAL: a normal complete tool turn emits the call EXACTLY once (no double-emit)', async () => {
  const evts = await collect([
    START(0, { type: 'tool_use', id: 't1', name: 'write_file' }),
    JSONDELTA(0, '{"path":"a"}'),
    STOP(0),
    D({ type: 'message_delta', delta: { stop_reason: 'tool_use' } }),
    MSG_STOP,
  ]);
  assert.equal(count(evts, 'tool_call'), 1, 'must not double-emit on the end flush');
  assert.equal(count(evts, 'done'), 1, 'exactly one done');
  const tc = evts.find((e) => e.type === 'tool_call');
  assert.ok(tc && tc.type === 'tool_call');
  assert.deepEqual(tc.call.input, { path: 'a' });
});

test('in-flight tool_use at message_stop (no content_block_stop) is flushed BEFORE done', async () => {
  const evts = await collect([
    START(0, { type: 'tool_use', id: 't1', name: 'write_file' }),
    JSONDELTA(0, '{"path":"a"}'),
    // no content_block_stop
    MSG_STOP,
  ]);
  assert.equal(count(evts, 'tool_call'), 1);
  const ti = evts.findIndex((e) => e.type === 'tool_call');
  const di = evts.findIndex((e) => e.type === 'done');
  assert.ok(ti !== -1 && di !== -1 && ti < di, 'tool_call must come before done');
});

test('stream truncated with no message_stop: salvage the call + synthesize usage/done', async () => {
  const evts = await collect([
    START(0, { type: 'tool_use', id: 't1', name: 'run_shell' }),
    JSONDELTA(0, '{"command":"ls"}'),
    // stream just ends
  ]);
  assert.equal(count(evts, 'tool_call'), 1);
  assert.equal(count(evts, 'done'), 1, 'sentinel done so the loop completes the turn');
  assert.equal(count(evts, 'usage'), 1);
});

test('a normal TEXT turn flushes nothing and ends with one done', async () => {
  const evts = await collect([
    START(0, { type: 'text' }),
    D({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'hi' } }),
    STOP(0),
    MSG_STOP,
  ]);
  assert.equal(count(evts, 'tool_call'), 0);
  assert.equal(count(evts, 'done'), 1);
});

test('a zero-arg tool_use with no content_block_stop still flushes as {} (review #12)', async () => {
  const evts = await collect([
    START(0, { type: 'tool_use', id: 't1', name: 'list_todos' }),
    // no input_json_delta (zero-arg call), no content_block_stop
    MSG_STOP,
  ]);
  assert.equal(count(evts, 'tool_call'), 1);
  const tc = evts.find((e) => e.type === 'tool_call');
  assert.ok(tc && tc.type === 'tool_call');
  assert.deepEqual(tc.call.input, {});
});

test('two complete tool_use blocks emit twice, not four times', async () => {
  const evts = await collect([
    START(0, { type: 'tool_use', id: 't1', name: 'read_file' }),
    JSONDELTA(0, '{"path":"x"}'),
    STOP(0),
    START(1, { type: 'tool_use', id: 't2', name: 'read_file' }),
    JSONDELTA(1, '{"path":"y"}'),
    STOP(1),
    MSG_STOP,
  ]);
  assert.equal(count(evts, 'tool_call'), 2);
});
