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
    assert.match(t, /compacted to free context|PROGRESS SUMMARY/i, 'framed as a mid-task compaction, not a fresh start');
    assert.match(t, /NEXT STEP|Continue directly from NEXT STEP/i, 'includes the continuation directive that prevents the greeting');
    assert.match(t, /do NOT greet|not greet/i, 'explicitly forbids greeting/asking after compaction');
  }
  // Pin is reframed as an in-progress objective so the model does not restart from a raw first prompt.
  const pin = after[0]!;
  assert.equal(pin.role, 'user');
  if (pin.content[0]!.type === 'text') {
    assert.match(pin.content[0]!.text, /SESSION OBJECTIVE \(in progress/i, 'pin reframed as in-progress objective');
    assert.match(pin.content[0]!.text, /do NOT restart/i);
  }
});

// The original task must survive compaction even when the summarizer model is weak and drops its
// TASK line — the real-world failure ("continue with remaining files, but I don't have the original
// instructions"). Only the first turn is pinned, so a task stated in a LATER turn would otherwise
// live only inside the lossy summary. The fix preserves human instruction turns verbatim.
test('compaction preserves later-turn instructions verbatim even when the summarizer drops TASK', async () => {
  const ctx = new Context({ contextBudget: 1_000_000, triggerRatio: 0.75, keepLastTurns: 2 });
  ctx.pinTask({ role: 'user', content: [{ type: 'text', text: 'hey' }] }); // short opener gets pinned, not the task
  ctx.append({
    role: 'user',
    content: [{ type: 'text', text: 'Migrate every file in src/legacy from fetchJson to httpClient, one at a time.' }],
  });
  // Machine churn: assistant tool_use turns + user tool_result turns (the latter must NOT be harvested).
  for (let i = 0; i < 6; i++) {
    ctx.append({ role: 'assistant', content: [{ type: 'tool_use', id: `c${i}`, name: 'edit', input: { file: `legacy/f${i}.ts` } }] });
    ctx.append({ role: 'user', content: [{ type: 'tool_result', toolCallId: `c${i}`, ok: true, content: `patched f${i}` }] });
  }
  // Weak local summarizer: keeps NEXT STEP but omits the TASK line entirely.
  const weak = new MockProvider([[{ type: 'text', delta: 'NEXT STEP — continue with remaining files.' }, { type: 'done', stopReason: 'end_turn' }]]);
  assert.equal(await ctx.maybeSummarize(weak, 'mock', true), true);

  const text = ctx.messages().map((m) => m.content.map((b) => (b.type === 'text' ? b.text : '')).join(' ')).join('\n');
  assert.match(text, /fetchJson/, 'the load-bearing instruction survives verbatim');
  assert.match(text, /httpClient/, 'the target of the migration survives verbatim');
  assert.match(text, /SESSION OBJECTIVE \(in progress/, 'objective rides the reframed pin, not a lossy summary alone');
  assert.doesNotMatch(text, /patched f\d/, 'tool_result turns are machine output, never harvested as instructions');
});

// Instructions must survive REPEATED compactions (a game of telephone would otherwise erode them).
test('compaction carries instructions forward across a second compaction', async () => {
  const ctx = new Context({ contextBudget: 1_000_000, triggerRatio: 0.75, keepLastTurns: 1 });
  ctx.pinTask({ role: 'user', content: [{ type: 'text', text: 'start' }] });
  ctx.append({ role: 'user', content: [{ type: 'text', text: 'Rename symbol Foo to Bar across the repo.' }] });
  for (let i = 0; i < 4; i++) ctx.append({ role: 'assistant', content: [{ type: 'text', text: `did ${i}` }] });
  const dropTask = new MockProvider([
    [{ type: 'text', delta: 'NEXT STEP — keep renaming.' }, { type: 'done', stopReason: 'end_turn' }],
    [{ type: 'text', delta: 'NEXT STEP — keep renaming.' }, { type: 'done', stopReason: 'end_turn' }],
  ]);
  await ctx.maybeSummarize(dropTask, 'mock', true); // first compaction
  for (let i = 0; i < 4; i++) ctx.append({ role: 'assistant', content: [{ type: 'text', text: `more ${i}` }] });
  await ctx.maybeSummarize(dropTask, 'mock', true); // second compaction re-summarizes the prior note

  const text = ctx.messages().map((m) => m.content.map((b) => (b.type === 'text' ? b.text : '')).join(' ')).join('\n');
  assert.match(text, /Rename symbol Foo to Bar/, 'original instruction still verbatim after two compactions');
  // It must appear exactly once — carry-forward parses the prior note's block, it does not duplicate it.
  assert.equal(text.split('Rename symbol Foo to Bar').length - 1, 1, 'instruction is carried, not duplicated');
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

test('hysteresis: auto-compact re-arms only when post-compact is under the trigger', async () => {
  // Large budget + short history: after force-compact we sit under the trigger and rearm blocks
  // a second auto-compact until tokens grow. (If still OVER trigger after compact, rearm is 0
  // so we can fire again — that path is required to avoid 32k server 400s.)
  const ctx = new Context({ contextBudget: 100_000, triggerRatio: 0.75, keepLastTurns: 2 });
  ctx.pinTask({ role: 'user', content: [{ type: 'text', text: 'Ship the feature end to end.' }] });
  for (let i = 0; i < 6; i++) {
    ctx.append({ role: 'assistant', content: [{ type: 'text', text: `work ${i}` }] });
    ctx.append({ role: 'user', content: [{ type: 'text', text: `ok ${i}` }] });
  }
  const provider = new MockProvider([
    [{ type: 'text', delta: 'ALREADY DONE — early work.\nNEXT STEP — finish.' }, { type: 'done', stopReason: 'end_turn' }],
    [{ type: 'text', delta: 'should not run' }, { type: 'done', stopReason: 'end_turn' }],
  ]);
  assert.equal(await ctx.maybeSummarize(provider, 'mock', true), true, 'first compact succeeds');
  const mid = ctx.messages().length;
  // Under threshold + rearmed → auto path no-ops.
  assert.equal(await ctx.maybeSummarize(provider, 'mock', false), false, 'hysteresis blocks re-compact under threshold');
  assert.equal(ctx.messages().length, mid, 'history unchanged under hysteresis');
  // Force still works (manual /compact).
  assert.equal(await ctx.maybeSummarize(provider, 'mock', true), true, 'force bypasses hysteresis');
});

test('after compact the pin is not a raw first prompt that invites a restart', async () => {
  const ctx = new Context({ contextBudget: 1_000_000, triggerRatio: 0.75, keepLastTurns: 2 });
  ctx.pinTask({
    role: 'user',
    content: [{ type: 'text', text: 'Refactor the auth module to use the new token helper.' }],
  });
  for (let i = 0; i < 6; i++) {
    ctx.append({ role: 'assistant', content: [{ type: 'text', text: `step ${i}` }] });
    ctx.append({ role: 'user', content: [{ type: 'text', text: `ok continue ${i}` }] });
  }
  const provider = new MockProvider([
    [
      {
        type: 'text',
        delta: 'TASK — auth refactor.\nALREADY DONE — steps 0-4.\nCURRENT WORK — step 5.\nNEXT STEP — finish step 5 then stop.',
      },
      { type: 'done', stopReason: 'end_turn' },
    ],
  ]);
  assert.equal(await ctx.maybeSummarize(provider, 'mock', true), true);
  const pin = ctx.messages()[0]!;
  assert.equal(pin.content[0]!.type, 'text');
  if (pin.content[0]!.type === 'text') {
    const t = pin.content[0]!.text;
    assert.match(t, /SESSION OBJECTIVE \(in progress/i);
    assert.match(t, /token helper/, 'original objective preserved');
    assert.doesNotMatch(t, /^Refactor the auth module/, 'not a bare replay of the first prompt as a new request');
  }
  const all = ctx.messages().map((m) => m.content.map((b) => (b.type === 'text' ? b.text : '')).join('')).join('\n');
  assert.match(all, /ALREADY DONE|NEXT STEP/, 'progress note carries done/next so work is not restarted');
});
