import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Context } from '../src/agent/context.js';
import { MockProvider } from '../src/provider/mock.js';
import {
  estimateTokensFromMessages,
  type Message,
  type Provider,
  type ProviderEvent,
} from '../src/provider/provider.js';

const SENTINEL = '[Old tool result content cleared]';
const BIG = 'x'.repeat(4_000); // ~1k tokens per body via the char/4 heuristic

/** One tool round = assistant tool_use + user tool_result (2 messages). */
function round(id: string, name: string, body: string): Message[] {
  return [
    { role: 'assistant', content: [{ type: 'tool_use', id, name, input: { n: id } }] },
    { role: 'user', content: [{ type: 'tool_result', toolCallId: id, ok: true, content: body }] },
  ];
}

/** Build a context whose heuristic size sits strictly between the micro gate and the summarize
 *  gate, so microcompaction fires but the summarizer (default 0.9) would not. */
function overMicroGate(opts?: { microcompact?: boolean; keepRounds?: number }): Context {
  const ctx = new Context({
    contextBudget: 1_000, // placeholder; re-set below from the real heuristic
    triggerRatio: 0.9,
    keepLastTurns: 12,
    ...(opts?.microcompact === false ? { microcompact: false } : {}),
  });
  ctx.pinTask({ role: 'user', content: [{ type: 'text', text: 'the task' }] });
  // 8 OLD compactable rounds (16 msgs) — well beyond the 8-message recent window.
  for (let i = 0; i < 8; i++) for (const m of round(`old${i}`, 'read_file', BIG)) ctx.append(m);
  // 4 recent rounds (8 msgs) that must stay verbatim.
  for (let i = 0; i < 4; i++) for (const m of round(`new${i}`, 'read_file', BIG)) ctx.append(m);

  const provider = new MockProvider();
  const est = provider.estimateTokens(ctx.messages());
  // est/0.9 < budget < est/0.7  →  micro gate (0.7·budget) < est < summarize gate (0.9·budget).
  ctx.setBudget(Math.round(est / 0.8));
  return ctx;
}

test('microcompaction clears OLD compactable tool_result bodies, keeping id/ok/position intact', () => {
  const ctx = overMicroGate();
  const provider = new MockProvider();

  const before = ctx.messages().map((m) => m.content.length);
  const cleared = ctx.microcompact(provider);
  assert.equal(cleared, true, 'reports it cleared at least one body');

  const msgs = ctx.messages();
  // Block counts and positions are unchanged everywhere (the healer pairs on position).
  assert.deepEqual(
    msgs.map((m) => m.content.length),
    before,
    'no block was dropped or added',
  );

  // First OLD result is at index 2 (pin=1, first tool_use=1, first tool_result=2).
  const first = msgs[2]!.content[0]!;
  assert.equal(first.type, 'tool_result');
  if (first.type === 'tool_result') {
    assert.equal(first.content, SENTINEL, 'old body replaced by the sentinel');
    assert.equal(first.toolCallId, 'old0', 'toolCallId preserved');
    assert.equal(first.ok, true, 'ok flag preserved');
  }
  // The matching tool_use immediately before it is untouched (still pairs by position + id).
  const use = msgs[1]!.content[0]!;
  assert.equal(use.type, 'tool_use');
  if (use.type === 'tool_use') assert.equal(use.id, 'old0');
});

test('microcompaction leaves the recent-N window verbatim', () => {
  const ctx = overMicroGate();
  ctx.microcompact(new MockProvider());
  const msgs = ctx.messages();
  // Last 8 messages (the 4 recent rounds) keep their full bodies.
  for (const m of msgs.slice(-8)) {
    for (const b of m.content) {
      if (b.type === 'tool_result') assert.equal(b.content, BIG, 'recent result kept verbatim');
    }
  }
});

test('microcompaction never clears state-bearing tool results (todo_write, agent)', () => {
  const ctx = new Context({ contextBudget: 1_000, triggerRatio: 0.9, keepLastTurns: 12 });
  ctx.pinTask({ role: 'user', content: [{ type: 'text', text: 'task' }] });
  // Old must-keep rounds, then old compactable rounds, then enough recent filler to push
  // the must-keep + compactable rounds OUT of the 8-message recent window.
  for (const m of round('todo0', 'todo_write', BIG)) ctx.append(m);
  for (const m of round('agent0', 'agent', BIG)) ctx.append(m);
  for (let i = 0; i < 6; i++) for (const m of round(`old${i}`, 'grep', BIG)) ctx.append(m);
  const provider = new MockProvider();
  const est = provider.estimateTokens(ctx.messages());
  ctx.setBudget(Math.round(est / 0.8));

  assert.equal(ctx.microcompact(provider), true, 'compactable grep bodies were cleared');

  const msgs = ctx.messages();
  const todoResult = msgs[2]!.content[0]!; // pin, todo tool_use, todo tool_result
  const agentResult = msgs[4]!.content[0]!;
  assert.equal(todoResult.type, 'tool_result');
  assert.equal(agentResult.type, 'tool_result');
  if (todoResult.type === 'tool_result') assert.equal(todoResult.content, BIG, 'todo_write body kept');
  if (agentResult.type === 'tool_result') assert.equal(agentResult.content, BIG, 'agent body kept');
});

test('microcompaction fires below the summarize gate and reduces tokens WITHOUT a round-trip', async () => {
  const ctx = overMicroGate();
  let sends = 0;
  const provider: Provider = {
    name: 'count',
    estimateTokens: (m) => estimateTokensFromMessages(m),
    async *send(): AsyncIterable<ProviderEvent> {
      sends += 1; // any summarizer call would land here
      yield { type: 'done', stopReason: 'end_turn' };
    },
  };

  // The summarizer (auto, non-force) must NOT fire at this fill (we are below its 0.9 gate).
  assert.equal(await ctx.maybeSummarize(provider, 'mock', false), false, 'summarizer stays idle');
  assert.equal(sends, 0, 'no summarizer round-trip so far');

  const before = ctx.estimateTokens(provider);
  assert.equal(ctx.microcompact(provider), true, 'microcompaction reclaims in place');
  const after = ctx.estimateTokens(provider);
  assert.ok(after < before, `measurable token reduction (${before} -> ${after})`);
  assert.equal(sends, 0, 'microcompaction never calls the provider');
});

test('microcompaction is a no-op below its gate', () => {
  const ctx = new Context({ contextBudget: 1_000_000, triggerRatio: 0.9, keepLastTurns: 12 });
  ctx.pinTask({ role: 'user', content: [{ type: 'text', text: 'task' }] });
  for (let i = 0; i < 8; i++) for (const m of round(`old${i}`, 'read_file', BIG)) ctx.append(m);
  const provider = new MockProvider();
  const snapshot = JSON.stringify(ctx.messages());
  assert.equal(ctx.microcompact(provider), false, 'under the gate → no clearing');
  assert.equal(JSON.stringify(ctx.messages()), snapshot, 'history byte-for-byte unchanged');
});

test('the config flag disables microcompaction (constructor and setPolicy)', () => {
  const off = overMicroGate({ microcompact: false });
  assert.equal(off.microcompact(new MockProvider()), false, 'disabled at construction → no-op');

  const on = overMicroGate();
  on.setPolicy({ microcompact: false });
  assert.equal(on.microcompact(new MockProvider()), false, 'disabled via setPolicy → no-op');
});

test('microcompaction is idempotent and preserves per-turn tool_use↔tool_result pairing', () => {
  const ctx = overMicroGate();
  const provider = new MockProvider();
  assert.equal(ctx.microcompact(provider), true, 'first pass clears');
  assert.equal(ctx.microcompact(provider), false, 'second pass finds nothing new to clear');

  // Every assistant tool_use is still immediately followed by a user turn whose tool_result ids
  // match in the same order and count — exactly the invariant healDanglingToolUses enforces.
  const msgs = ctx.messages();
  for (let i = 0; i < msgs.length; i++) {
    const m = msgs[i]!;
    if (m.role !== 'assistant') continue;
    const useIds = m.content.filter((b) => b.type === 'tool_use').map((b) => (b.type === 'tool_use' ? b.id : ''));
    if (useIds.length === 0) continue;
    const next = msgs[i + 1]!;
    assert.equal(next.role, 'user', 'tool_use turn is followed by a user turn');
    const resIds = next.content
      .filter((b) => b.type === 'tool_result')
      .map((b) => (b.type === 'tool_result' ? b.toolCallId : ''));
    assert.deepEqual(resIds, useIds, 'result ids still pair with use ids in order');
  }
});
