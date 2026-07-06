import { test } from 'node:test';
import assert from 'node:assert/strict';
import { z } from 'zod';
import { parseAnthropicSSE, toAnthropicMessages } from '../src/provider/anthropic.js';
import { eventsFromAnthropicMessage } from '../src/provider/nonStream.js';
import type { Provider, ProviderEvent, Message } from '../src/provider/provider.js';
import { AgentLoop, type LoopDeps } from '../src/agent/loop.js';
import { Budget } from '../src/agent/budget.js';
import { Context } from '../src/agent/context.js';
import { EventBus } from '../src/agent/events.js';
import { ToolRegistry } from '../src/tools/registry.js';
import { AutoApproveGate } from '../src/agent/approval.js';
import { MockProvider } from '../src/provider/mock.js';
import { ok, type Tool } from '../src/tools/types.js';

async function* fromLines(lines: string[]): AsyncIterable<string> {
  for (const line of lines) yield line;
}
async function collect(events: AsyncIterable<ProviderEvent>): Promise<ProviderEvent[]> {
  const out: ProviderEvent[] = [];
  for await (const e of events) out.push(e);
  return out;
}

test('streaming parser emits a redacted_thinking_block from content_block_start (no deltas)', async () => {
  const lines = [
    'data: {"type":"content_block_start","index":0,"content_block":{"type":"redacted_thinking","data":"ENCRYPTED_BLOB"}}',
    'data: {"type":"content_block_stop","index":0}',
    'data: {"type":"content_block_start","index":1,"content_block":{"type":"text","text":""}}',
    'data: {"type":"content_block_delta","index":1,"delta":{"type":"text_delta","text":"hi"}}',
    'data: {"type":"content_block_stop","index":1}',
    'data: {"type":"message_stop"}',
  ];
  const events = await collect(parseAnthropicSSE(fromLines(lines)));
  const r = events.find((e) => e.type === 'redacted_thinking_block');
  assert.ok(r, 'a redacted_thinking_block was emitted');
  assert.equal((r as { data: string }).data, 'ENCRYPTED_BLOB', 'the encrypted payload is captured verbatim');
  assert.ok(
    events.some((e) => e.type === 'text' && e.delta === 'hi'),
    'sibling text block still parses normally',
  );
});

test('non-stream parser emits a redacted_thinking_block', () => {
  const msg = {
    type: 'message',
    role: 'assistant',
    content: [
      { type: 'redacted_thinking', data: 'BLOB-NS' },
      { type: 'text', text: 'answer' },
    ],
    stop_reason: 'end_turn',
  };
  const events = [...eventsFromAnthropicMessage(msg)];
  const r = events.find((e) => e.type === 'redacted_thinking_block');
  assert.ok(r, 'redacted_thinking_block emitted from a complete message body');
  assert.equal((r as { data: string }).data, 'BLOB-NS');
});

test('toAnthropicMessages replays a redacted_thinking block, leading the turn, model-gated', () => {
  const model = 'claude-opus-4-8';
  const history: Message[] = [
    {
      role: 'assistant',
      content: [
        { type: 'redacted_thinking', data: 'BLOB', model },
        { type: 'text', text: 'using a tool' },
        { type: 'tool_use', id: 't1', name: 'foo', input: {} },
      ],
    },
    { role: 'tool', content: [{ type: 'tool_result', toolCallId: 't1', ok: true, content: 'done' }] },
  ];
  const out = toAnthropicMessages(history, model);
  const assistant = out.find((m) => m.role === 'assistant')!;
  assert.equal(assistant.content[0]?.type, 'redacted_thinking', 'redacted_thinking leads the assistant turn');
  assert.deepEqual(assistant.content[0], { type: 'redacted_thinking', data: 'BLOB' }, 'no model field leaks to the wire');

  // A different model must NOT replay another model's encrypted blob.
  const outOther = toAnthropicMessages(history, 'claude-sonnet-4-6');
  const assistantOther = outOther.find((m) => m.role === 'assistant')!;
  assert.ok(
    !assistantOther.content.some((b) => b.type === 'redacted_thinking'),
    'redacted_thinking is dropped after a /model switch',
  );
});

const echoTool: Tool<{ msg: string }, { echoed: string }> = {
  name: 'echo',
  description: 'echoes a message',
  risk: 'read',
  inputSchema: z.object({ msg: z.string() }),
  run: async (input) => ok('echo', 'read', 1, `echoed: ${input.msg}`, { echoed: input.msg }),
};

test('the loop commits a redacted_thinking block into assistant history (round-trip)', async () => {
  const provider: Provider = new MockProvider([
    [
      { type: 'redacted_thinking_block', data: 'BLOB-LOOP' },
      { type: 'tool_call', call: { id: 't1', name: 'echo', input: { msg: 'hi' } } },
      { type: 'done', stopReason: 'tool_use' },
    ],
    [
      { type: 'text', delta: 'done' },
      { type: 'done', stopReason: 'end_turn' },
    ],
  ]);
  const registry = new ToolRegistry();
  registry.register(echoTool);
  const budget = new Budget({ maxIterations: 25 }, 'mock', { mock: { input: 1, output: 1 } }, Date.now());
  const context = new Context({ contextBudget: 1_000_000, triggerRatio: 0.75, keepLastTurns: 6 });
  context.pinTask({ role: 'user', content: [{ type: 'text', text: 'go' }] });
  const deps: LoopDeps = {
    provider,
    registry,
    gate: new AutoApproveGate(),
    bus: new EventBus(),
    budget,
    context,
    signal: new AbortController().signal,
    model: 'mock',
    system: 'test',
    maxOutputTokens: 1024,
    workspaceRoot: process.cwd(),
    dryRun: false,
    maxToolResultChars: 16384,
    contextBudget: 1_000_000,
  };
  await new AgentLoop(deps, 'full').run();

  const assistant = context.messages().find((m) => m.role === 'assistant' && m.content.some((b) => b.type === 'redacted_thinking'));
  assert.ok(assistant, 'an assistant turn carries the redacted_thinking block');
  const rb = assistant!.content.find((b) => b.type === 'redacted_thinking');
  assert.deepEqual(rb, { type: 'redacted_thinking', data: 'BLOB-LOOP', model: 'mock' }, 'block preserved + model-stamped');
});

test('toAnthropicMessages preserves thinking↔redacted_thinking order in the lead', () => {
  const model = 'claude-opus-4-8';
  const history: Message[] = [
    {
      role: 'assistant',
      content: [
        { type: 'thinking', thinking: 'step one', signature: 'sig1', model },
        { type: 'redacted_thinking', data: 'BLOB', model },
        { type: 'text', text: 'done thinking' },
      ],
    },
  ];
  const assistant = toAnthropicMessages(history, model).find((m) => m.role === 'assistant')!;
  assert.equal(assistant.content[0]?.type, 'thinking', 'signed thinking stays first');
  assert.equal(assistant.content[1]?.type, 'redacted_thinking', 'redacted block keeps its position');
  assert.equal(assistant.content[2]?.type, 'text', 'text follows the reasoning prefix');
});
