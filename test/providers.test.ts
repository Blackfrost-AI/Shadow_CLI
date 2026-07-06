import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  parseAnthropicSSE,
  toAnthropicMessages,
  supportsAdaptiveThinking,
  anthropicBetaHeaders,
  buildAnthropicBody,
} from '../src/provider/anthropic.js';
import { parseOpenAISSE, toOpenAIMessages } from '../src/provider/openai.js';
import type { CompletionRequest, Message, ProviderEvent } from '../src/provider/provider.js';

/** Turn a static list of SSE `data:` lines into the AsyncIterable the parsers expect. */
async function* fromLines(lines: string[]): AsyncIterable<string> {
  for (const line of lines) yield line;
}

async function collect(events: AsyncIterable<ProviderEvent>): Promise<ProviderEvent[]> {
  const out: ProviderEvent[] = [];
  for await (const e of events) out.push(e);
  return out;
}

// ── Anthropic ────────────────────────────────────────────────────────────────

test('parseAnthropicSSE assembles a fragmented tool_use into one tool_call', async () => {
  // input_json_delta fragments together form {"path":"a.ts"}.
  const lines = [
    'data: {"type":"message_start","message":{"usage":{"input_tokens":42,"cache_read_input_tokens":10,"cache_creation_input_tokens":5}}}',
    'data: {"type":"content_block_start","index":0,"content_block":{"type":"tool_use","id":"toolu_1","name":"read_file"}}',
    'data: {"type":"content_block_delta","index":0,"delta":{"type":"input_json_delta","partial_json":"{\\"pa"}}',
    'data: {"type":"content_block_delta","index":0,"delta":{"type":"input_json_delta","partial_json":"th\\":\\""}}',
    'data: {"type":"content_block_delta","index":0,"delta":{"type":"input_json_delta","partial_json":"a.ts\\"}"}}',
    'data: {"type":"content_block_stop","index":0}',
    'data: {"type":"message_delta","delta":{"stop_reason":"tool_use"},"usage":{"output_tokens":17}}',
    'data: {"type":"message_stop"}',
  ];

  const events = await collect(parseAnthropicSSE(fromLines(lines)));

  const toolCalls = events.filter((e) => e.type === 'tool_call');
  assert.equal(toolCalls.length, 1, 'exactly one tool_call');
  const call = toolCalls[0]!;
  assert.equal(call.type, 'tool_call');
  if (call.type === 'tool_call') {
    assert.equal(call.call.id, 'toolu_1');
    assert.equal(call.call.name, 'read_file');
    assert.deepEqual(call.call.input, { path: 'a.ts' });
  }

  const partials = events.filter((e) => e.type === 'tool_call_partial');
  assert.ok(partials.length >= 1, 'at least one tool_call_partial');

  const usage = events.find((e) => e.type === 'usage');
  assert.ok(usage && usage.type === 'usage');
  if (usage && usage.type === 'usage') {
    assert.equal(usage.inputTokens, 42);
    assert.equal(usage.outputTokens, 17);
    assert.equal(usage.cacheReadTokens, 10);
    assert.equal(usage.cacheWriteTokens, 5);
  }

  const last = events[events.length - 1]!;
  assert.equal(last.type, 'done');
  if (last.type === 'done') assert.equal(last.stopReason, 'tool_use');
});

test('parseAnthropicSSE streams text deltas and ends end_turn', async () => {
  const lines = [
    'data: {"type":"message_start","message":{"usage":{"input_tokens":3}}}',
    'data: {"type":"content_block_start","index":0,"content_block":{"type":"text"}}',
    'data: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"Hello "}}',
    'data: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"world"}}',
    'data: {"type":"content_block_stop","index":0}',
    'data: {"type":"message_delta","delta":{"stop_reason":"end_turn"},"usage":{"output_tokens":2}}',
    'data: {"type":"message_stop"}',
  ];
  const events = await collect(parseAnthropicSSE(fromLines(lines)));
  const text = events
    .filter((e): e is Extract<ProviderEvent, { type: 'text' }> => e.type === 'text')
    .map((e) => e.delta)
    .join('');
  assert.equal(text, 'Hello world');
  assert.equal(events.filter((e) => e.type === 'tool_call').length, 0);
  const done = events.at(-1)!;
  assert.equal(done.type, 'done');
  if (done.type === 'done') assert.equal(done.stopReason, 'end_turn');
});

test('parseAnthropicSSE surfaces an unparseable tool_use as a recoverable error', async () => {
  const lines = [
    'data: {"type":"content_block_start","index":0,"content_block":{"type":"tool_use","id":"t1","name":"grep"}}',
    'data: {"type":"content_block_delta","index":0,"delta":{"type":"input_json_delta","partial_json":"{not json"}}',
    'data: {"type":"content_block_stop","index":0}',
    'data: {"type":"message_delta","delta":{"stop_reason":"tool_use"}}',
    'data: {"type":"message_stop"}',
  ];
  const events = await collect(parseAnthropicSSE(fromLines(lines)));
  const err = events.find((e) => e.type === 'error');
  assert.ok(err && err.type === 'error');
  if (err && err.type === 'error') {
    assert.equal(err.code, 'bad_tool_json');
    assert.equal(err.recoverable, true);
  }
  assert.equal(events.filter((e) => e.type === 'tool_call').length, 0);
});

test('parseAnthropicSSE captures a thinking block (deltas + signed block) before text', async () => {
  const lines = [
    'data: {"type":"message_start","message":{"usage":{"input_tokens":5}}}',
    'data: {"type":"content_block_start","index":0,"content_block":{"type":"thinking"}}',
    'data: {"type":"content_block_delta","index":0,"delta":{"type":"thinking_delta","thinking":"Let me "}}',
    'data: {"type":"content_block_delta","index":0,"delta":{"type":"thinking_delta","thinking":"reason."}}',
    'data: {"type":"content_block_delta","index":0,"delta":{"type":"signature_delta","signature":"sig-"}}',
    'data: {"type":"content_block_delta","index":0,"delta":{"type":"signature_delta","signature":"abc"}}',
    'data: {"type":"content_block_stop","index":0}',
    'data: {"type":"content_block_start","index":1,"content_block":{"type":"text"}}',
    'data: {"type":"content_block_delta","index":1,"delta":{"type":"text_delta","text":"Done"}}',
    'data: {"type":"content_block_stop","index":1}',
    'data: {"type":"message_delta","delta":{"stop_reason":"end_turn"},"usage":{"output_tokens":9}}',
    'data: {"type":"message_stop"}',
  ];
  const events = await collect(parseAnthropicSSE(fromLines(lines)));

  const thinkText = events
    .filter((e): e is Extract<ProviderEvent, { type: 'thinking' }> => e.type === 'thinking')
    .map((e) => e.delta)
    .join('');
  assert.equal(thinkText, 'Let me reason.');

  const block = events.find((e) => e.type === 'thinking_block');
  assert.ok(block && block.type === 'thinking_block');
  if (block && block.type === 'thinking_block') {
    assert.equal(block.thinking, 'Let me reason.');
    assert.equal(block.signature, 'sig-abc', 'signature deltas are concatenated');
  }

  const text = events
    .filter((e): e is Extract<ProviderEvent, { type: 'text' }> => e.type === 'text')
    .map((e) => e.delta)
    .join('');
  assert.equal(text, 'Done');
});

test('toAnthropicMessages leads with same-model signed thinking and drops unsigned/other-model', async () => {
  const messages: Message[] = [
    { role: 'user', content: [{ type: 'text', text: 'hi' }] },
    {
      role: 'assistant',
      content: [
        { type: 'thinking', thinking: 'unsigned', signature: '', model: 'claude-opus-4-8' }, // dropped — no signature
        { type: 'thinking', thinking: 'other model', signature: 'sig-x', model: 'claude-sonnet-4-6' }, // dropped — wrong model
        { type: 'thinking', thinking: 'signed reasoning', signature: 'sig-1', model: 'claude-opus-4-8' },
        { type: 'text', text: 'answer' },
        { type: 'tool_use', id: 't1', name: 'read_file', input: { path: 'a.ts' } },
      ],
    },
  ];
  const out = toAnthropicMessages(messages, 'claude-opus-4-8');
  const assistant = out.find((m) => m.role === 'assistant')!;
  assert.equal(assistant.content[0]!.type, 'thinking', 'thinking leads the assistant turn');
  const kept = assistant.content.filter((b) => b.type === 'thinking');
  assert.equal(kept.length, 1, 'only the same-model signed block survives');
  // order: thinking → text → tool_use
  assert.deepEqual(
    assistant.content.map((b) => b.type),
    ['thinking', 'text', 'tool_use'],
  );
});

test('anthropicBetaHeaders adds context-1m only for [1m] model variants', async () => {
  assert.deepEqual(anthropicBetaHeaders({ model: 'claude-opus-4-8[1m]' }), ['context-1m-2025-08-07']);
  assert.deepEqual(anthropicBetaHeaders({ model: 'claude-opus-4-8' }), []);
  assert.deepEqual(anthropicBetaHeaders({ model: 'gpt-4o' }), []);
});

test('buildAnthropicBody adds adaptive thinking + effort + max_tokens floor on capable models', async () => {
  const base: CompletionRequest = {
    model: 'claude-opus-4-8',
    system: '',
    messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }],
    tools: [],
    maxOutputTokens: 8192,
    effort: 'medium',
  };
  const body = buildAnthropicBody(base, 'claude-opus-4-8');
  assert.deepEqual(body.thinking, { type: 'adaptive', display: 'summarized' });
  assert.deepEqual(body.output_config, { effort: 'medium' });
  assert.equal(body.max_tokens, 32_000, 'max_tokens floored so thinking is not truncated');
  assert.equal('temperature' in body, false, 'no temperature (400s on opus)');
  // effort defaults to high when unset.
  const dflt = buildAnthropicBody({ ...base, effort: undefined }, 'claude-opus-4-8');
  assert.deepEqual(dflt.output_config, { effort: 'high' });
});

test('buildAnthropicBody sends no thinking config and keeps max_tokens on non-adaptive models', async () => {
  const body = buildAnthropicBody(
    {
      model: 'claude-opus-4-5',
      system: '',
      messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }],
      tools: [],
      maxOutputTokens: 8192,
      effort: 'high',
    },
    'claude-opus-4-5',
  );
  assert.equal('thinking' in body, false);
  assert.equal('output_config' in body, false);
  assert.equal(body.max_tokens, 8192, 'untouched when thinking is off');
});

test('anthropicBetaHeaders adds extended-cache-ttl and fast-mode flags when requested', async () => {
  assert.deepEqual(anthropicBetaHeaders({ model: 'claude-opus-4-8' }), []);
  assert.deepEqual(anthropicBetaHeaders({ model: 'claude-opus-4-8', cacheTtl: '1h' }), ['extended-cache-ttl-2025-04-11']);
  assert.deepEqual(anthropicBetaHeaders({ model: 'claude-opus-4-8', fastMode: true }), ['fast-mode-2026-02-01']);
  assert.deepEqual(anthropicBetaHeaders({ model: 'claude-opus-4-8[1m]', cacheTtl: '1h', fastMode: true }), [
    'context-1m-2025-08-07',
    'extended-cache-ttl-2025-04-11',
    'fast-mode-2026-02-01',
  ]);
});

test('buildAnthropicBody: fast mode sets speed and disables thinking; cacheTtl flows to cache_control', async () => {
  const base: CompletionRequest = {
    model: 'claude-opus-4-8',
    system: 'sys',
    messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }],
    tools: [],
    maxOutputTokens: 8192,
  };
  const fast = buildAnthropicBody({ ...base, fastMode: true }, 'claude-opus-4-8');
  assert.equal(fast.speed, 'fast');
  assert.equal('thinking' in fast, false, 'fast mode is mutually exclusive with extended thinking');
  assert.equal('output_config' in fast, false);

  const oneHour = buildAnthropicBody({ ...base, cacheTtl: '1h' }, 'claude-opus-4-8');
  const sys = oneHour.system as Array<{ cache_control?: { type: string; ttl?: string } }>;
  assert.equal(sys[0]!.cache_control?.ttl, '1h');
  const fiveMin = buildAnthropicBody(base, 'claude-opus-4-8');
  const sys5 = fiveMin.system as Array<{ cache_control?: { type: string; ttl?: string } }>;
  assert.equal(sys5[0]!.cache_control?.ttl, undefined, 'default 5m carries no ttl field');
});

test('buildAnthropicBody marks the last conversation block with cache_control (rolling prefix cache)', async () => {
  const body = buildAnthropicBody(
    {
      model: 'claude-opus-4-8',
      system: 'sys',
      messages: [
        { role: 'user', content: [{ type: 'text', text: 'first' }] },
        { role: 'assistant', content: [{ type: 'text', text: 'reply' }] },
        { role: 'user', content: [{ type: 'text', text: 'second' }] },
      ],
      tools: [],
      maxOutputTokens: 8192,
    },
    'claude-opus-4-8',
  );
  const msgs = body.messages as Array<{ content: Array<{ type: string; cache_control?: unknown }> }>;
  const last = msgs[msgs.length - 1]!;
  assert.ok(last.content[last.content.length - 1]!.cache_control, 'last conversation block carries a cache breakpoint');
  assert.equal(msgs[0]!.content[0]!.cache_control, undefined, 'earlier blocks are not individually cached');
});

// ── P2 parity: tool_choice / stop_sequences / no telemetry metadata / <tool_use_error> ──

test('buildAnthropicBody omits tool_choice, stop_sequences, and metadata by default', async () => {
  const body = buildAnthropicBody(
    {
      model: 'claude-opus-4-8',
      system: '',
      messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }],
      tools: [],
      maxOutputTokens: 8192,
    },
    'claude-opus-4-8',
  );
  assert.equal('tool_choice' in body, false);
  assert.equal('stop_sequences' in body, false);
  assert.equal('metadata' in body, false);
});

test('buildAnthropicBody passes through tool_choice (auto/any + forced tool) and stop_sequences when supplied', async () => {
  const base: CompletionRequest = {
    model: 'claude-opus-4-8',
    system: '',
    messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }],
    tools: [],
    maxOutputTokens: 8192,
  };
  const any = buildAnthropicBody({ ...base, toolChoice: { type: 'any', disableParallelToolUse: true } }, 'claude-opus-4-8');
  assert.deepEqual(any.tool_choice, { type: 'any', disable_parallel_tool_use: true });

  const forced = buildAnthropicBody({ ...base, toolChoice: { type: 'tool', name: 'read_file' } }, 'claude-opus-4-8');
  assert.deepEqual(forced.tool_choice, { type: 'tool', name: 'read_file' });

  const stops = buildAnthropicBody({ ...base, stopSequences: ['STOP', '\n\nUser:'] }, 'claude-opus-4-8');
  assert.deepEqual(stops.stop_sequences, ['STOP', '\n\nUser:']);
  // empty array is treated as "unset" — no key on the wire.
  const noStops = buildAnthropicBody({ ...base, stopSequences: [] }, 'claude-opus-4-8');
  assert.equal('stop_sequences' in noStops, false);
});

test('buildAnthropicBody never sets metadata.user_id', async () => {
  const base: CompletionRequest = {
    model: 'claude-opus-4-8',
    system: '',
    messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }],
    tools: [],
    maxOutputTokens: 8192,
  };
  const body = buildAnthropicBody(base, 'claude-opus-4-8', true);
  assert.equal('metadata' in body, false);
});

test('toAnthropicMessages wraps a failed tool_result in <tool_use_error> but leaves success clean', async () => {
  const messages: Message[] = [
    {
      role: 'tool',
      content: [
        { type: 'tool_result', toolCallId: 't1', ok: false, content: 'boom: file not found' },
        { type: 'tool_result', toolCallId: 't2', ok: true, content: 'ok: 3 matches' },
      ],
    },
  ];
  const out = toAnthropicMessages(messages, 'claude-opus-4-8');
  const user = out.find((m) => m.role === 'user')!;
  const results = user.content as Array<{ type: string; content: string; is_error: boolean }>;
  assert.equal(results[0]!.content, '<tool_use_error>boom: file not found</tool_use_error>');
  assert.equal(results[0]!.is_error, true);
  assert.equal(results[1]!.content, 'ok: 3 matches', 'a successful result is not wrapped');
  assert.equal(results[1]!.is_error, false);
});

test('supportsAdaptiveThinking gates on Claude 4.6+ and Fable, not older/other models', async () => {
  for (const m of ['claude-opus-4-8', 'claude-opus-4-6', 'claude-sonnet-4-6', 'claude-fable-5', 'claude-opus-4-8[1m]']) {
    assert.equal(supportsAdaptiveThinking(m), true, `${m} should support adaptive thinking`);
  }
  for (const m of ['claude-opus-4-5', 'claude-sonnet-4-5', 'claude-haiku-4-5', 'gpt-4o', 'llama-3', '']) {
    assert.equal(supportsAdaptiveThinking(m), false, `${m} should NOT support adaptive thinking`);
  }
});

// ── OpenAI ───────────────────────────────────────────────────────────────────

test('parseOpenAISSE assembles fragmented tool_calls arguments into one tool_call', async () => {
  // The arguments fragments together form {"pattern":"foo"}.
  const lines = [
    'data: {"choices":[{"delta":{"role":"assistant","content":null,"tool_calls":[{"index":0,"id":"call_1","type":"function","function":{"name":"grep","arguments":""}}]}}]}',
    'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"arguments":"{\\"pat"}}]}}]}',
    'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"arguments":"tern\\":\\"foo\\"}"}}]}}]}',
    'data: {"choices":[{"delta":{},"finish_reason":"tool_calls"}]}',
    'data: {"choices":[],"usage":{"prompt_tokens":11,"completion_tokens":7,"prompt_tokens_details":{"cached_tokens":3}}}',
    'data: [DONE]',
  ];

  const events = await collect(parseOpenAISSE(fromLines(lines)));

  const toolCalls = events.filter((e) => e.type === 'tool_call');
  assert.equal(toolCalls.length, 1, 'exactly one tool_call');
  const call = toolCalls[0]!;
  if (call.type === 'tool_call') {
    assert.equal(call.call.id, 'call_1');
    assert.equal(call.call.name, 'grep');
    assert.deepEqual(call.call.input, { pattern: 'foo' });
  }

  assert.ok(events.filter((e) => e.type === 'tool_call_partial').length >= 1, 'at least one partial');

  const usage = events.find((e) => e.type === 'usage');
  assert.ok(usage && usage.type === 'usage');
  if (usage && usage.type === 'usage') {
    assert.equal(usage.inputTokens, 8); // 11 prompt − 3 cached: disjoint, no double-count (review #6)
    assert.equal(usage.outputTokens, 7);
    assert.equal(usage.cacheReadTokens, 3);
  }

  const last = events.at(-1)!;
  assert.equal(last.type, 'done');
  if (last.type === 'done') assert.equal(last.stopReason, 'tool_use');
});

test('parseOpenAISSE routes reasoning_content to the thinking channel and content to text', async () => {
  const lines = [
    'data: {"choices":[{"delta":{"reasoning_content":"let me "}}]}',
    'data: {"choices":[{"delta":{"reasoning_content":"think"}}]}',
    'data: {"choices":[{"delta":{"content":"the answer"}}]}',
    'data: {"choices":[{"delta":{},"finish_reason":"stop"}]}',
    'data: [DONE]',
  ];
  const events = await collect(parseOpenAISSE(fromLines(lines)));
  const think = events.filter((e): e is Extract<ProviderEvent, { type: 'thinking' }> => e.type === 'thinking').map((e) => e.delta).join('');
  const text = events.filter((e): e is Extract<ProviderEvent, { type: 'text' }> => e.type === 'text').map((e) => e.delta).join('');
  assert.equal(think, 'let me think');
  assert.equal(text, 'the answer');
});

test('parseOpenAISSE splits an inline <think> block in content into thinking + text', async () => {
  const lines = [
    'data: {"choices":[{"delta":{"content":"<think>reason"}}]}',
    'data: {"choices":[{"delta":{"content":"ing</think>done"}}]}',
    'data: {"choices":[{"delta":{},"finish_reason":"stop"}]}',
    'data: [DONE]',
  ];
  const events = await collect(parseOpenAISSE(fromLines(lines)));
  const think = events.filter((e): e is Extract<ProviderEvent, { type: 'thinking' }> => e.type === 'thinking').map((e) => e.delta).join('');
  const text = events.filter((e): e is Extract<ProviderEvent, { type: 'text' }> => e.type === 'text').map((e) => e.delta).join('');
  assert.equal(think, 'reasoning');
  assert.equal(text, 'done');
});

test('parseAnthropicSSE surfaces stop_reason pause_turn (so the loop can resume)', async () => {
  const lines = [
    'data: {"type":"content_block_start","index":0,"content_block":{"type":"text"}}',
    'data: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"working…"}}',
    'data: {"type":"content_block_stop","index":0}',
    'data: {"type":"message_delta","delta":{"stop_reason":"pause_turn"},"usage":{"output_tokens":3}}',
    'data: {"type":"message_stop"}',
  ];
  const events = await collect(parseAnthropicSSE(fromLines(lines)));
  const done = events.at(-1)!;
  assert.equal(done.type, 'done');
  if (done.type === 'done') assert.equal(done.stopReason, 'pause_turn');
});

test('parseOpenAISSE captures the Gemini thought_signature on a tool call', async () => {
  const lines = [
    'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"c1","type":"function","function":{"name":"write_file","arguments":"{\\"path\\":\\"a\\"}"},"extra_content":{"google":{"thought_signature":"SIG123"}}}]}}]}',
    'data: {"choices":[{"delta":{},"finish_reason":"tool_calls"}]}',
    'data: [DONE]',
  ];
  const events = await collect(parseOpenAISSE(fromLines(lines)));
  const call = events.find((e) => e.type === 'tool_call');
  assert.ok(call && call.type === 'tool_call');
  if (call && call.type === 'tool_call') {
    assert.equal(call.call.name, 'write_file');
    assert.equal(call.call.signature, 'SIG123');
  }
});

test('toOpenAIMessages echoes a tool_use signature back as Gemini extra_content', async () => {
  const messages: Message[] = [
    { role: 'assistant', content: [{ type: 'tool_use', id: 'c1', name: 'write_file', input: { path: 'a' }, signature: 'SIG123' }] },
  ];
  const out = toOpenAIMessages({ model: 'm', system: '', messages, tools: [], maxOutputTokens: 100 });
  const asst = out.find((m) => m.role === 'assistant') as { tool_calls?: Array<{ extra_content?: { google: { thought_signature: string } } }> };
  assert.equal(asst.tool_calls?.[0]?.extra_content?.google.thought_signature, 'SIG123');
});

test('parseOpenAISSE streams content and reports max_tokens on length finish', async () => {
  const lines = [
    'data: {"choices":[{"delta":{"role":"assistant","content":"Hel"}}]}',
    'data: {"choices":[{"delta":{"content":"lo"},"finish_reason":"length"}]}',
    'data: {"choices":[],"usage":{"prompt_tokens":5,"completion_tokens":9}}',
    'data: [DONE]',
  ];
  const events = await collect(parseOpenAISSE(fromLines(lines)));
  const text = events
    .filter((e): e is Extract<ProviderEvent, { type: 'text' }> => e.type === 'text')
    .map((e) => e.delta)
    .join('');
  assert.equal(text, 'Hello');
  const done = events.at(-1)!;
  assert.equal(done.type, 'done');
  if (done.type === 'done') assert.equal(done.stopReason, 'max_tokens');
});
