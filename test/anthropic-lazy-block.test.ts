import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseAnthropicSSE } from '../src/provider/anthropic.js';
import type { ProviderEvent } from '../src/provider/provider.js';

async function* fromLines(lines: string[]): AsyncIterable<string> {
  for (const line of lines) yield line;
}

async function collect(events: AsyncIterable<ProviderEvent>): Promise<ProviderEvent[]> {
  const out: ProviderEvent[] = [];
  for await (const e of events) out.push(e);
  return out;
}

test('parseAnthropicSSE lazy-creates block on content_block_delta without start (TOOLSURF-2)', async () => {
  const lines = [
    'data: {"type":"content_block_delta","index":0,"delta":{"type":"input_json_delta","partial_json":"{\\"path\\":\\""}}',
    'data: {"type":"content_block_delta","index":0,"delta":{"type":"input_json_delta","partial_json":"a.ts\\"}"}}',
    'data: {"type":"content_block_stop","index":0}',
    'data: {"type":"message_stop"}',
  ];
  const events = await collect(parseAnthropicSSE(fromLines(lines)));
  const partials = events.filter((e) => e.type === 'tool_call_partial');
  assert.ok(partials.length >= 1, 'should emit tool_call_partial even without content_block_start');
});