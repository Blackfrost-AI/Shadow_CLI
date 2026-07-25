import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Context } from '../src/agent/context.js';
import { EventBus } from '../src/agent/events.js';
import { attachBgAgentDelivery, formatTaskNotification } from '../src/agent/busListeners.js';
import { toAnthropicMessages } from '../src/provider/anthropic.js';
import type { Message } from '../src/provider/provider.js';

/**
 * T0-6 — the pairing invariant.
 *
 * Every assistant turn carrying `tool_use` blocks must be followed IMMEDIATELY by a user turn
 * satisfying those ids. Break it and Anthropic coalesces the stray user turn into an ordering
 * violation while OpenAI rejects outright — and because the repair only ever inspected the LAST
 * message, a mid-history orphan was permanent: every later turn 400'd until /clear.
 */
export function assertPairedHistory(messages: Message[]): void {
  for (let i = 0; i < messages.length; i++) {
    const m = messages[i]!;
    if (m.role !== 'assistant') continue;
    const uses = m.content.filter((b: any) => b.type === 'tool_use') as Array<{ id: string }>;
    if (!uses.length) continue;
    const next = messages[i + 1];
    assert.ok(next, `assistant tool_use at ${i} has no following turn`);
    assert.equal(next!.role, 'user', `tool_use at ${i} must be followed by a user turn, got ${next!.role}`);
    const satisfied = new Set(
      (next!.content as any[]).filter((b) => b.type === 'tool_result').map((b) => b.tool_use_id as string),
    );
    for (const u of uses) {
      assert.ok(satisfied.has(u.id), `tool_use ${u.id} at index ${i} has no tool_result in the next turn`);
    }
  }
}

const toolUse = (id: string): Message => ({ role: 'assistant', content: [{ type: 'tool_use', id, name: 'run_shell', input: {} }] } as Message);
const toolResult = (id: string): Message => ({ role: 'user', content: [{ type: 'tool_result', tool_use_id: id, content: 'ok' }] } as Message);
const text = (t: string): Message => ({ role: 'user', content: [{ type: 'text', text: t }] } as Message);

test('assertPairedHistory catches the exact shape the bug produced', () => {
  // The helper must be able to FAIL, or it guards nothing.
  assert.throws(() => assertPairedHistory([toolUse('a'), text('a background agent finished'), toolResult('a')]));
  assert.throws(() => assertPairedHistory([toolUse('a')]));
  // …and pass on the correct shape.
  assertPairedHistory([text('hi'), toolUse('a'), toolResult('a')]);
});

test('a background notification arriving mid-tool-window does NOT enter the live context', async () => {
  const ctx = new Context({ contextBudget: 100000, triggerRatio: 0.75, keepLastTurns: 6 });
  const bus = new EventBus();
  const pending = attachBgAgentDelivery(bus, ctx);

  // Simulate the exact race: assistant tool_use committed, tools still running.
  ctx.append(toolUse('call-1'));
  bus.emit({ type: 'task_notification', taskId: 'bg-9', answer: 'done' } as never);
  // …then the tool_result lands, as it always would.
  ctx.append(toolResult('call-1'));

  assertPairedHistory(ctx.messages());
  assert.equal(pending.size(), 1, 'the notification is waiting, not spliced into the transcript');
  const drained = pending.drain();
  assert.match(drained[0]!, /task_id="bg-9"/);
});

test('the adapter cannot represent the malformed history — which is WHY it must never be built', () => {
  // This documents the damage rather than asserting the adapter is fine: feeding it the shape the
  // old code produced, the two user turns coalesce and a tool_result ends up BEHIND free text,
  // which is the ordering rule the API rejects. If this ever stops being true, the upstream guard
  // could be relaxed — until then, busListeners buffering is load-bearing.
  const broken: Message[] = [toolUse('call-1'), text(formatTaskNotification({ taskId: 'bg-9', answer: 'done' })), toolResult('call-1')];
  const out = toAnthropicMessages(broken) as Array<{ role: string; content: any[] }>;
  const violated = out.some((m) => {
    if (!Array.isArray(m.content)) return false;
    const firstResult = m.content.findIndex((b) => b?.type === 'tool_result');
    const firstText = m.content.findIndex((b) => b?.type === 'text');
    return firstResult !== -1 && firstText !== -1 && firstText < firstResult;
  });
  assert.equal(violated, true, 'the broken shape really does produce an API-invalid turn');
});

test('the CORRECT history round-trips through the adapter cleanly', () => {
  const good: Message[] = [text('hi'), toolUse('call-1'), toolResult('call-1')];
  const out = toAnthropicMessages(good) as Array<{ role: string; content: any[] }>;
  for (const m of out) {
    if (!Array.isArray(m.content)) continue;
    const firstResult = m.content.findIndex((b) => b?.type === 'tool_result');
    const firstText = m.content.findIndex((b) => b?.type === 'text');
    if (firstResult !== -1 && firstText !== -1) {
      assert.ok(firstResult < firstText, 'tool_result blocks precede text in a user turn');
    }
  }
});
