import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Context, TRUNCATED_RESULT_SENTINEL } from '../src/agent/context.js';
import { MockProvider } from '../src/provider/mock.js';
import type { Provider, ProviderEvent } from '../src/provider/provider.js';

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
  assert.equal(did, 'summarized', 'force compacts despite being under threshold');
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

test('compaction prompt sees the authoritative recent tail and live goal state', async () => {
  const ctx = new Context({ contextBudget: 1_000_000, triggerRatio: 0.75, keepLastTurns: 2 });
  ctx.pinTask({ role: 'user', content: [{ type: 'text', text: 'repair the release' }] });
  ctx.append({ role: 'assistant', content: [{ type: 'text', text: 'old investigation' }] });
  ctx.append({ role: 'user', content: [{ type: 'text', text: 'do not redo the investigation' }] });
  ctx.append({ role: 'assistant', content: [{ type: 'text', text: 'CURRENTLY editing src/update.ts' }] });
  ctx.append({ role: 'user', content: [{ type: 'text', text: 'NEXT run the signature tests' }] });
  let prompt = '';
  const provider = new MockProvider([
    (messages) => {
      prompt = messages.flatMap((m) => m.content).map((b) => (b.type === 'text' ? b.text : '')).join('\n');
      return [{ type: 'text', delta: 'CURRENT WORK — update.ts.\nNEXT STEP — run signature tests.' }, { type: 'done', stopReason: 'end_turn' }];
    },
  ]);
  const did = await ctx.maybeSummarize(provider, 'mock', true, undefined, {
    continuity: 'Standing goal: finish every confirmed security fix.',
  });
  assert.equal(did, 'summarized');
  assert.match(prompt, /RECENT RETAINED TAIL/);
  assert.match(prompt, /CURRENTLY editing src\/update\.ts/);
  assert.match(prompt, /NEXT run the signature tests/);
  assert.match(prompt, /finish every confirmed security fix/);
});

test('pre-compact callback fires only when a summary request actually starts', async () => {
  const ctx = new Context({ contextBudget: 1_000_000, triggerRatio: 0.9, keepLastTurns: 1 });
  ctx.pinTask({ role: 'user', content: [{ type: 'text', text: 'task' }] });
  ctx.append({ role: 'assistant', content: [{ type: 'text', text: 'one' }] });
  ctx.append({ role: 'user', content: [{ type: 'text', text: 'two' }] });
  let called = 0;
  const provider = new MockProvider([[{ type: 'text', delta: 'NEXT STEP — continue.' }, { type: 'done', stopReason: 'end_turn' }]]);
  assert.equal(await ctx.maybeSummarize(provider, 'mock', false, undefined, { beforeCompact: () => called++ }), false);
  assert.equal(called, 0);
  assert.equal(await ctx.maybeSummarize(provider, 'mock', true, undefined, { beforeCompact: () => called++ }), 'summarized');
  assert.equal(called, 1);
});

test('switching model policy clears the previous provider usage floor', () => {
  const ctx = new Context({ contextBudget: 200_000, triggerRatio: 0.9, keepLastTurns: 12 });
  const provider = new MockProvider();
  ctx.pinTask({ role: 'user', content: [{ type: 'text', text: 'small task' }] });
  ctx.recordActualTokens(150_000);
  assert.equal(ctx.estimateTokens(provider), 150_000);
  ctx.setPolicy({ contextBudget: 24_000, triggerRatio: 0.8, keepLastTurns: 4 }, true);
  assert.ok(ctx.estimateTokens(provider) < 1_000, 'old model usage cannot poison the new model session count');
  assert.deepEqual(ctx.policy(), { contextBudget: 24_000, triggerRatio: 0.8, keepLastTurns: 4 });
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
  assert.equal(await ctx.maybeSummarize(weak, 'mock', true), 'summarized');

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

test('maybeSummarize with an empty summary is a VISIBLE failure and never destroys history', async () => {
  const ctx = new Context({ contextBudget: 1_000_000, triggerRatio: 0.75, keepLastTurns: 1 });
  ctx.pinTask({ role: 'user', content: [{ type: 'text', text: 'the task' }] });
  for (let i = 0; i < 4; i++) ctx.append({ role: i % 2 ? 'user' : 'assistant', content: [{ type: 'text', text: `m${i}` }] });
  const before = ctx.messages().length;
  // Provider yields no text → empty summary. F04-11: that is a failure, not a silent no-op —
  // the caller must be able to tell. With only text turns there is nothing reclaimable locally,
  // so the outcome is 'failed'; history must still NOT be destroyed for nothing.
  const provider = new MockProvider([[{ type: 'done', stopReason: 'end_turn' }]]);
  assert.equal(await ctx.maybeSummarize(provider, 'mock', true), 'failed', 'empty summary → visible failure');
  assert.equal(ctx.messages().length, before, 'history intact');
});

test('maybeSummarize abort after a partial delta leaves context byte-for-byte unchanged', async () => {
  const ctx = new Context({ contextBudget: 1_000_000, triggerRatio: 0.75, keepLastTurns: 1 });
  ctx.pinTask({ role: 'user', content: [{ type: 'text', text: 'the task' }] });
  for (let i = 0; i < 5; i++) {
    ctx.append({ role: i % 2 ? 'user' : 'assistant', content: [{ type: 'text', text: `message ${i}` }] });
  }
  ctx.recordActualTokens(1234);
  const before = structuredClone(ctx.exportState());
  const controller = new AbortController();
  const provider: Provider = {
    name: 'partial-compact',
    estimateTokens: () => 100,
    async *send(): AsyncIterable<ProviderEvent> {
      yield { type: 'text', delta: 'TRUNCATED SUMMARY' };
      controller.abort();
      yield { type: 'done', stopReason: 'end_turn' };
    },
  };

  assert.equal(await ctx.maybeSummarize(provider, 'mock', true, controller.signal), false);
  assert.deepEqual(ctx.exportState(), before, 'an aborted summary cannot rewrite or re-arm context state');
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
  assert.equal(await ctx.maybeSummarize(provider, 'mock', true), 'summarized', 'first compact succeeds');
  const mid = ctx.messages().length;
  // Under threshold + rearmed → auto path no-ops.
  assert.equal(await ctx.maybeSummarize(provider, 'mock', false), false, 'hysteresis blocks re-compact under threshold');
  assert.equal(ctx.messages().length, mid, 'history unchanged under hysteresis');
  // Force still works (manual /compact).
  assert.equal(await ctx.maybeSummarize(provider, 'mock', true), 'summarized', 'force bypasses hysteresis');
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
  assert.equal(await ctx.maybeSummarize(provider, 'mock', true), 'summarized');
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

// F04-11 degradation edge cases surfaced by the pre-release adversarial review.

function toolResult(ctx: Context, id: string): { content: string } | undefined {
  for (const m of ctx.messages()) {
    for (const b of m.content) {
      if (b.type === 'tool_result' && b.toolCallId === id) return b;
    }
  }
  return undefined;
}

test('degraded truncation spares state-bearing results while reproducible output can still pay', async () => {
  const ctx = new Context({ contextBudget: 1_000, triggerRatio: 0.75, keepLastTurns: 1 });
  ctx.pinTask({ role: 'user', content: [{ type: 'text', text: 'objective' }] });
  ctx.append({ role: 'assistant', content: [{ type: 'tool_use', id: 'r1', name: 'read_file', input: {} }] });
  ctx.append({ role: 'user', content: [{ type: 'tool_result', toolCallId: 'r1', ok: true, content: 'x'.repeat(2_400) }] });
  ctx.append({ role: 'assistant', content: [{ type: 'tool_use', id: 'a1', name: 'agent', input: {} }] });
  ctx.append({ role: 'user', content: [{ type: 'tool_result', toolCallId: 'a1', ok: true, content: 'y'.repeat(800) }] });
  ctx.append({ role: 'assistant', content: [{ type: 'text', text: 'z'.repeat(400) }] });
  // Summarizer yields nothing → empty summary → degradation path.
  const provider = new MockProvider([[{ type: 'done', stopReason: 'end_turn' }]]);

  assert.equal(await ctx.maybeSummarize(provider, 'mock', true), 'truncated');
  assert.equal(toolResult(ctx, 'r1')?.content, TRUNCATED_RESULT_SENTINEL, 'reproducible output paid the bill');
  assert.equal(toolResult(ctx, 'a1')?.content, 'y'.repeat(800), 'the state-bearing agent answer was spared');
});

test('degraded truncation only touches state-bearing results once nothing else is left', async () => {
  const ctx = new Context({ contextBudget: 1_000, triggerRatio: 0.75, keepLastTurns: 1 });
  ctx.pinTask({ role: 'user', content: [{ type: 'text', text: 'objective' }] });
  ctx.append({ role: 'assistant', content: [{ type: 'tool_use', id: 'r1', name: 'read_file', input: {} }] });
  ctx.append({ role: 'user', content: [{ type: 'tool_result', toolCallId: 'r1', ok: true, content: 'x'.repeat(40) }] });
  ctx.append({ role: 'assistant', content: [{ type: 'tool_use', id: 'a1', name: 'agent', input: {} }] });
  ctx.append({ role: 'user', content: [{ type: 'tool_result', toolCallId: 'a1', ok: true, content: 'y'.repeat(2_800) }] });
  ctx.append({ role: 'assistant', content: [{ type: 'text', text: 'z'.repeat(400) }] });
  const provider = new MockProvider([[{ type: 'done', stopReason: 'end_turn' }]]);

  assert.equal(await ctx.maybeSummarize(provider, 'mock', true), 'truncated');
  assert.equal(toolResult(ctx, 'r1')?.content, TRUNCATED_RESULT_SENTINEL, 'pass 1 took the reproducible body');
  assert.equal(toolResult(ctx, 'a1')?.content, TRUNCATED_RESULT_SENTINEL, 'pass 2 took the state-bearing body — still over after pass 1');
});

test('microcompact never overwrites the degradation tombstone', () => {
  const ctx = new Context({ contextBudget: 100, triggerRatio: 0.75, keepLastTurns: 1, microcompact: true });
  ctx.pinTask({ role: 'user', content: [{ type: 'text', text: 'task' }] });
  ctx.append({ role: 'assistant', content: [{ type: 'tool_use', id: 'x', name: 'read_file', input: {} }] });
  ctx.append({ role: 'user', content: [{ type: 'tool_result', toolCallId: 'x', ok: true, content: TRUNCATED_RESULT_SENTINEL }] });
  // Pad past MICROCOMPACT_KEEP_RECENT so the tombstoned result is old enough to be a candidate.
  for (let i = 0; i < 9; i++) {
    ctx.append({ role: i % 2 ? 'assistant' : 'user', content: [{ type: 'text', text: `filler ${i}` }] });
  }
  ctx.recordActualTokens(1_000); // push the estimate over the microcompact gate

  const cleared = ctx.microcompact(new MockProvider());
  assert.equal(toolResult(ctx, 'x')?.content, TRUNCATED_RESULT_SENTINEL, 'the forensic marker survives');
  assert.equal(cleared, false, 'nothing reclaimable existed — microcompact must not claim it cleared');
});

test('over budget with nothing compactable is a visible failure, not a silent no-op', async () => {
  const ctx = new Context({ contextBudget: 100, triggerRatio: 0.75, keepLastTurns: 6 });
  ctx.pinTask({ role: 'user', content: [{ type: 'text', text: 'objective' }] });
  ctx.append({ role: 'assistant', content: [{ type: 'text', text: 'A'.repeat(800) }] }); // ≈200 tokens > 75 trigger
  ctx.append({ role: 'user', content: [{ type: 'text', text: 'ok' }] });

  // History is shorter than pin+keep: nothing can be summarized or tombstoned, but the session
  // IS over budget — the CompactResult contract says that must be distinguishable from health.
  assert.equal(await ctx.maybeSummarize(new MockProvider(), 'mock', false), 'failed');
  assert.equal(ctx.messages().length, 3, 'history untouched');
});
