import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildAnthropicBody } from '../src/provider/anthropic.js';
import { buildOpenAIBody } from '../src/provider/openai.js';
import { eventsFromAnthropicMessage, eventsFromOpenAICompletion } from '../src/provider/nonStream.js';
import type { CompletionRequest, ProviderEvent } from '../src/provider/provider.js';

const BASE_REQ: CompletionRequest = {
  model: 'test',
  system: 'sys',
  messages: [],
  tools: [],
  maxOutputTokens: 1024,
};

function collect(gen: Generator<ProviderEvent>): ProviderEvent[] {
  return [...gen];
}

test('buildAnthropicBody and buildOpenAIBody honor stream=false for fallback bodies', () => {
  assert.equal(buildAnthropicBody(BASE_REQ, 'fb', false).stream, false);
  assert.equal(buildAnthropicBody(BASE_REQ, 'fb', true).stream, true);
  assert.equal(buildOpenAIBody(BASE_REQ, 'fb', false).stream, false);
  assert.equal(buildOpenAIBody(BASE_REQ, 'fb', false).stream_options, undefined);
  assert.deepEqual(buildOpenAIBody(BASE_REQ, 'fb', true).stream_options, { include_usage: true });
});

test('eventsFromAnthropicMessage maps text, tool_use, usage, and done', () => {
  const msg = {
    content: [
      { type: 'text', text: 'Hello ' },
      { type: 'text', text: 'world' },
      { type: 'tool_use', id: 'toolu_1', name: 'read_file', input: { path: 'a.ts' } },
    ],
    stop_reason: 'tool_use',
    usage: {
      input_tokens: 42,
      output_tokens: 17,
      cache_read_input_tokens: 10,
      cache_creation_input_tokens: 5,
    },
  };

  const events = collect(eventsFromAnthropicMessage(msg));
  const text = events
    .filter((e): e is Extract<ProviderEvent, { type: 'text' }> => e.type === 'text')
    .map((e) => e.delta)
    .join('');
  assert.equal(text, 'Hello world');

  const toolCalls = events.filter((e) => e.type === 'tool_call');
  assert.equal(toolCalls.length, 1);
  const call = toolCalls[0]!;
  assert.equal(call.type, 'tool_call');
  if (call.type === 'tool_call') {
    assert.equal(call.call.id, 'toolu_1');
    assert.equal(call.call.name, 'read_file');
    assert.deepEqual(call.call.input, { path: 'a.ts' });
  }

  const usage = events.find((e) => e.type === 'usage');
  assert.ok(usage && usage.type === 'usage');
  if (usage && usage.type === 'usage') {
    assert.equal(usage.inputTokens, 42);
    assert.equal(usage.outputTokens, 17);
    assert.equal(usage.cacheReadTokens, 10);
    assert.equal(usage.cacheWriteTokens, 5);
  }

  const done = events.at(-1)!;
  assert.equal(done.type, 'done');
  if (done.type === 'done') assert.equal(done.stopReason, 'tool_use');
});

test('eventsFromAnthropicMessage emits thinking_block for thinking content', () => {
  const events = collect(
    eventsFromAnthropicMessage({
      content: [{ type: 'thinking', thinking: 'hmm', signature: 'sig-1' }],
      stop_reason: 'end_turn',
      usage: { input_tokens: 1, output_tokens: 2 },
    }),
  );
  const block = events.find((e) => e.type === 'thinking_block');
  assert.ok(block && block.type === 'thinking_block');
  if (block && block.type === 'thinking_block') {
    assert.equal(block.thinking, 'hmm');
    assert.equal(block.signature, 'sig-1');
  }
});

test('eventsFromOpenAICompletion maps content, tool_calls, and usage', () => {
  const obj = {
    choices: [
      {
        message: {
          content: 'Answer.',
          tool_calls: [
            {
              id: 'call_abc',
              type: 'function',
              function: { name: 'grep', arguments: '{"pattern":"foo"}' },
            },
          ],
        },
        finish_reason: 'tool_calls',
      },
    ],
    usage: {
      prompt_tokens: 100,
      completion_tokens: 20,
      prompt_tokens_details: { cached_tokens: 15 },
    },
  };

  const events = collect(eventsFromOpenAICompletion(obj));
  const text = events
    .filter((e): e is Extract<ProviderEvent, { type: 'text' }> => e.type === 'text')
    .map((e) => e.delta)
    .join('');
  assert.equal(text, 'Answer.');

  const toolCalls = events.filter((e) => e.type === 'tool_call');
  assert.equal(toolCalls.length, 1);
  const call = toolCalls[0]!;
  if (call.type === 'tool_call') {
    assert.equal(call.call.name, 'grep');
    assert.deepEqual(call.call.input, { pattern: 'foo' });
  }

  const usage = events.find((e) => e.type === 'usage');
  assert.ok(usage && usage.type === 'usage');
  if (usage && usage.type === 'usage') {
    assert.equal(usage.inputTokens, 85);
    assert.equal(usage.outputTokens, 20);
    assert.equal(usage.cacheReadTokens, 15);
  }

  const done = events.at(-1)!;
  assert.equal(done.type, 'done');
  if (done.type === 'done') assert.equal(done.stopReason, 'tool_use');
});

test('eventsFromOpenAICompletion surfaces reasoning_content as thinking', () => {
  const events = collect(
    eventsFromOpenAICompletion({
      choices: [{ message: { reasoning_content: 'chain', content: 'ok' }, finish_reason: 'stop' }],
      usage: { prompt_tokens: 1, completion_tokens: 1 },
    }),
  );
  const thinking = events
    .filter((e): e is Extract<ProviderEvent, { type: 'thinking' }> => e.type === 'thinking')
    .map((e) => e.delta)
    .join('');
  assert.equal(thinking, 'chain');
});