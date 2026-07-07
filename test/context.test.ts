import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Context } from '../src/agent/context.js';
import { MockProvider } from '../src/provider/mock.js';

test('estimateTokens prefers the real recorded request size over the char/4 heuristic', () => {
  const ctx = new Context({ contextBudget: 100_000, triggerRatio: 0.75, keepLastTurns: 6 });
  ctx.pinTask({ role: 'user', content: [{ type: 'text', text: 'hi' }] });
  const provider = new MockProvider();

  const heuristic = ctx.estimateTokens(provider);
  // The real request (system + tools + messages) was much bigger than the message-only guess.
  ctx.recordActualTokens(heuristic + 5_000);
  assert.equal(ctx.estimateTokens(provider), heuristic + 5_000, 'real count wins when larger');

  // reset() drops the recorded count so it falls back to the heuristic.
  ctx.reset();
  ctx.pinTask({ role: 'user', content: [{ type: 'text', text: 'hi' }] });
  assert.equal(ctx.estimateTokens(provider), heuristic, 'after reset, back to the heuristic');
});

test('maybeSummarize(force) compacts even below the trigger threshold', async () => {
  const ctx = new Context({ contextBudget: 1_000_000, triggerRatio: 0.75, keepLastTurns: 1 });
  ctx.pinTask({ role: 'user', content: [{ type: 'text', text: 'the task' }] });
  for (let i = 0; i < 4; i++) {
    ctx.append({ role: i % 2 ? 'user' : 'assistant', content: [{ type: 'text', text: `msg ${i}` }] });
  }
  const before = ctx.messages().length;
  const provider = new MockProvider([[{ type: 'text', delta: 'SUMMARY' }, { type: 'done', stopReason: 'end_turn' }]]);

  const did = await ctx.maybeSummarize(provider, 'mock', true);
  assert.equal(did, true, 'force compacts despite being under threshold');
  const after = ctx.messages();
  assert.ok(after.length < before, 'history shrank');
  const note = after[1]!;
  // The note is a USER turn (not assistant) so it never coalesces into the kept assistant turn and
  // break Anthropic thinking-first ordering / strict-local role alternation.
  assert.equal(note.role, 'user', 'continuation note is a user turn, not assistant');
  assert.equal(note.content[0]!.type, 'text');
  if (note.content[0]!.type === 'text') {
    const t = note.content[0]!.text;
    assert.match(t, /SUMMARY/, 'carries the generated summary');
    assert.match(t, /compacted to free up context/i, 'framed as a mid-task compaction, not a fresh start');
    assert.match(t, /NEXT STEP|pick up exactly where you left off/i, 'includes the continuation directive that prevents the greeting');
    assert.match(t, /do NOT greet|not greet/i, 'explicitly forbids greeting/asking after compaction');
  }
});

test('maybeSummarize aborts (keeps history) if the summary comes back empty', async () => {
  const ctx = new Context({ contextBudget: 1_000_000, triggerRatio: 0.75, keepLastTurns: 1 });
  ctx.pinTask({ role: 'user', content: [{ type: 'text', text: 'the task' }] });
  for (let i = 0; i < 4; i++) ctx.append({ role: i % 2 ? 'user' : 'assistant', content: [{ type: 'text', text: `m${i}` }] });
  const before = ctx.messages().length;
  // Provider yields no text → empty summary. Must NOT destroy history for nothing.
  const provider = new MockProvider([[{ type: 'done', stopReason: 'end_turn' }]]);
  assert.equal(await ctx.maybeSummarize(provider, 'mock', true), false, 'empty summary → no-op');
  assert.equal(ctx.messages().length, before, 'history intact');
});

test('maybeSummarize without force is a no-op under the threshold', async () => {
  const ctx = new Context({ contextBudget: 1_000_000, triggerRatio: 0.75, keepLastTurns: 1 });
  ctx.pinTask({ role: 'user', content: [{ type: 'text', text: 't' }] });
  ctx.append({ role: 'assistant', content: [{ type: 'text', text: 'a' }] });
  ctx.append({ role: 'user', content: [{ type: 'text', text: 'b' }] });
  assert.equal(await ctx.maybeSummarize(new MockProvider(), 'mock', false), false);
});

test('recordActualTokens ignores non-positive counts', () => {
  const ctx = new Context({ contextBudget: 100_000, triggerRatio: 0.75, keepLastTurns: 6 });
  ctx.pinTask({ role: 'user', content: [{ type: 'text', text: 'hello world' }] });
  const provider = new MockProvider();
  const heuristic = ctx.estimateTokens(provider);
  ctx.recordActualTokens(0);
  assert.equal(ctx.estimateTokens(provider), heuristic, 'a zero usage report does not zero out the estimate');
});
