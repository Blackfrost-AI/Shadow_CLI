import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Context, TRUNCATED_RESULT_SENTINEL } from '../src/agent/context.js';
import {
  estimateTokensFromMessages,
  type CompletionRequest,
  type Message,
  type Provider,
  type ProviderEvent,
} from '../src/provider/provider.js';

/**
 * P3-10 / F06-12 — token-estimation cache in `Context`.
 *
 * The heuristic estimator re-stringifies every tool input (JSON.stringify on every tool_use
 * block) on every call, and a single turn used to call it several times over (microcompact
 * gate → maybeSummarize → loop). The cache must:
 *  - run the heuristic AT MOST ONCE per history mutation — repeated reads reuse the pass;
 *  - invalidate on EVERY mutation path (append / pinTask / reset / loadState / microcompact /
 *    stripImageBlocks / the compaction replacements);
 *  - key on the provider object (adapters may override the char/4 default estimator);
 *  - stay EXACTLY `max(heuristic(msgs), lastActualTokens)` — call elimination, never a new
 *    formula;
 *  - leave `truncateLocally`'s stop line on the DIRECT provider call, so tombstoning is
 *    measured live and stops at the line instead of exhausting the window.
 */

interface SpyProvider extends Provider {
  calls: number;
}

/** Spy around the real char/4 heuristic (optionally scaled) so values stay comparable. */
function makeSpy(scale = 1): SpyProvider {
  const spy: SpyProvider = {
    calls: 0,
    name: `spy-x${scale}`,
    estimateTokens(messages: Message[]): number {
      spy.calls += 1;
      return Math.ceil(estimateTokensFromMessages(messages) * scale);
    },
    // Any summarizer round trip fails → maybeSummarize degrades to truncateLocally.
    send(_req: CompletionRequest): AsyncIterable<ProviderEvent> {
      throw new Error('summarizer unavailable');
    },
  };
  return spy;
}

const userText = (text: string): Message => ({ role: 'user', content: [{ type: 'text', text }] });
const asstText = (text: string): Message => ({
  role: 'assistant',
  content: [{ type: 'text', text }],
});
/** One assistant tool_use + matching user tool_result (a microcompactable read_file round). */
const toolRound = (id: string, chars = 4000): Message[] => [
  {
    role: 'assistant',
    content: [{ type: 'tool_use', id, name: 'read_file', input: { path: `/tmp/${id}.txt` } }],
  },
  {
    role: 'user',
    content: [{ type: 'tool_result', toolCallId: id, ok: true, content: 'x'.repeat(chars) }],
  },
];

function makeContext(contextBudget = 100_000): Context {
  return new Context({ contextBudget, triggerRatio: 0.9, keepLastTurns: 8 });
}

test('an unchanged history runs the heuristic exactly once, however many times it is read', () => {
  const ctx = makeContext();
  ctx.pinTask(userText('session objective'));
  ctx.append(asstText('working'));
  const spy = makeSpy();
  const first = ctx.estimateTokens(spy);
  for (let i = 0; i < 10; i++) ctx.estimateTokens(spy);
  assert.equal(spy.calls, 1, 'ten reads must reuse the single cached pass');
  assert.equal(ctx.estimateTokens(spy), first);
  assert.equal(first, estimateTokensFromMessages(ctx.messages()), 'cache equals a fresh pass');
});

test('append and pinTask invalidate the cache', () => {
  const ctx = makeContext();
  ctx.pinTask(userText('objective'));
  const spy = makeSpy();
  ctx.estimateTokens(spy);
  assert.equal(spy.calls, 1);

  ctx.append(asstText('more history'));
  assert.equal(ctx.estimateTokens(spy), estimateTokensFromMessages(ctx.messages()));
  assert.equal(spy.calls, 2, 'append must force exactly one fresh pass');

  ctx.pinTask(userText('another pin'));
  assert.equal(ctx.estimateTokens(spy), estimateTokensFromMessages(ctx.messages()));
  assert.equal(spy.calls, 3, 'pinTask must force exactly one fresh pass');
});

test('reset and loadState invalidate the cache', () => {
  const ctx = makeContext();
  ctx.pinTask(userText('objective'));
  ctx.append(asstText('history'));
  const spy = makeSpy();
  ctx.estimateTokens(spy);
  assert.equal(spy.calls, 1);

  ctx.reset();
  assert.equal(ctx.estimateTokens(spy), 0);
  assert.equal(spy.calls, 2, 'reset must force a fresh pass');

  ctx.loadState({ messages: [userText('fresh start')], pinnedPrefix: 1, lastActualTokens: 777 });
  const v = ctx.estimateTokens(spy);
  assert.equal(spy.calls, 3, 'loadState must force a fresh pass');
  assert.equal(v, Math.max(estimateTokensFromMessages(ctx.messages()), 777));
});

test('a fresh actual count rides the cache — no recompute — and max() semantics stay intact', () => {
  const ctx = makeContext();
  ctx.pinTask(userText('objective'));
  const spy = makeSpy();
  const h = ctx.estimateTokens(spy);
  assert.equal(spy.calls, 1);

  ctx.recordActualTokens(h + 500);
  assert.equal(ctx.estimateTokens(spy), h + 500, 'the real count wins while it is the larger term');
  assert.equal(spy.calls, 1, 'recording an actual count must not re-run the heuristic');

  ctx.recordActualTokens(Math.max(1, h - 100));
  assert.equal(ctx.estimateTokens(spy), h, 'the heuristic wins once the real count is smaller');
  assert.equal(spy.calls, 1);

  ctx.append(asstText('growth'));
  assert.equal(
    ctx.estimateTokens(spy),
    Math.max(estimateTokensFromMessages(ctx.messages()), h - 100),
  );
  assert.equal(spy.calls, 2, 'append after an actual count still recomputes exactly once');
});

test('the provider object is part of the cache key', () => {
  const ctx = makeContext();
  ctx.pinTask(userText('objective'));
  ctx.append(asstText('hello'));
  const a = makeSpy(1);
  const b = makeSpy(3);

  const va = ctx.estimateTokens(a);
  ctx.estimateTokens(a);
  ctx.estimateTokens(a);
  assert.equal(a.calls, 1);

  const vb = ctx.estimateTokens(b);
  assert.equal(b.calls, 1, 'a different estimator cannot reuse another provider’s pass');
  assert.equal(vb, va * 3);

  ctx.estimateTokens(a);
  assert.equal(a.calls, 2, 'switching back recomputes under the first estimator');
  assert.equal(ctx.estimateTokens(a), va);
});

test('microcompact invalidates exactly when bodies were cleared', () => {
  // Under the gate: nothing cleared, gate checks reuse the cache.
  const quiet = makeContext();
  quiet.pinTask(userText('objective'));
  const qs = makeSpy();
  assert.equal(quiet.microcompact(qs), false);
  assert.equal(quiet.microcompact(qs), false);
  assert.equal(qs.calls, 1, 'gate checks reuse the cached pass when nothing was cleared');

  // Over the gate: stale read_file bodies cleared → cache invalidated.
  const ctx = makeContext(2000); // gate = 2000 * 0.7 = 1400
  ctx.pinTask(userText('objective'));
  for (let i = 0; i < 8; i++) for (const m of toolRound(`t${i}`)) ctx.append(m);
  const spy = makeSpy();
  const before = ctx.estimateTokens(spy); // pass 1
  assert.ok(before > 1400, 'history must start over the microcompact gate');
  assert.equal(ctx.microcompact(spy), true);
  const after = ctx.estimateTokens(spy); // pass 2 (the gate check itself reused pass 1)
  assert.equal(spy.calls, 2, 'cleared bodies force exactly one fresh pass');
  assert.ok(after < before, 'cleared bodies must shrink the estimate');
  assert.equal(after, estimateTokensFromMessages(ctx.messages()), 'post-clear estimate is exact');
});

test('stripImageBlocks invalidates only when an image was actually removed', () => {
  const ctx = makeContext();
  ctx.pinTask(userText('objective'));
  ctx.append({ role: 'user', content: [{ type: 'image', mediaType: 'image/png', data: 'AAAA' }] });
  const spy = makeSpy();
  const before = ctx.estimateTokens(spy);

  assert.equal(ctx.stripImageBlocks(), 1);
  const after = ctx.estimateTokens(spy);
  assert.equal(spy.calls, 2, 'a removed image must force a fresh pass');
  assert.ok(after < before);
  assert.equal(after, estimateTokensFromMessages(ctx.messages()));

  assert.equal(ctx.stripImageBlocks(), 0);
  assert.equal(ctx.estimateTokens(spy), after);
  assert.equal(spy.calls, 2, 'a no-op strip must not invalidate');
});

test('the estimate equals max(heuristic, lastActual) through every mutation sequence', () => {
  const ctx = makeContext();
  const spy = makeSpy();
  let expectedActual = 0;
  const check = (): void =>
    assert.equal(
      ctx.estimateTokens(spy),
      Math.max(estimateTokensFromMessages(ctx.messages()), expectedActual),
    );

  ctx.pinTask(userText('objective'));
  check();
  ctx.append(asstText('a'));
  check();
  ctx.recordActualTokens(9000);
  expectedActual = 9000;
  check();
  ctx.append(asstText('b'));
  check();
  ctx.setPolicy({ contextBudget: 50_000 }, true);
  expectedActual = 0;
  check();
  ctx.reset();
  check();
  ctx.pinTask(userText('fresh'));
  check();
  ctx.loadState({ messages: [userText('loaded')], pinnedPrefix: 1, lastActualTokens: 777 });
  expectedActual = 777;
  check();
  ctx.append(asstText('c'));
  check();
});

test('shrinkForOverflow invalidates exactly when something was reclaimed', () => {
  // Over the cap: a 4000-char tool_result body (OVERFLOW_TOOL_RESULT_CAP is 500).
  const ctx = makeContext();
  ctx.pinTask(userText('objective'));
  for (const m of toolRound('big', 4000)) ctx.append(m);
  const spy = makeSpy();
  const before = ctx.estimateTokens(spy); // pass 1
  assert.equal(ctx.shrinkForOverflow(), true);
  const after = ctx.estimateTokens(spy); // pass 2
  assert.equal(spy.calls, 2, 'reclaimed bodies must force exactly one fresh pass');
  assert.ok(after < before, 'capped bodies must shrink the estimate');
  assert.equal(after, estimateTokensFromMessages(ctx.messages()), 'post-shrink estimate is exact');

  // Nothing reclaimable: no invalidation.
  const quiet = makeContext();
  quiet.pinTask(userText('objective'));
  quiet.append(asstText('small'));
  const qs = makeSpy();
  const v = quiet.estimateTokens(qs);
  assert.equal(quiet.shrinkForOverflow(), false);
  assert.equal(quiet.estimateTokens(qs), v);
  assert.equal(qs.calls, 1, 'a no-op shrink must not invalidate');
});

test('a successful compaction invalidates — replacement AND in-place reasoning strip', async () => {
  // Two same-model assistant turns in the KEPT tail carry providerReasoning; the strip keeps
  // only the newest per model and deletes the older one IN PLACE — an invalidation the message
  // array never changes shape for.
  const withReasoning = (id: string, reasoning: string): Message[] => [
    {
      role: 'assistant',
      content: [{ type: 'tool_use', id, name: 'read_file', input: { path: `/tmp/${id}` } }],
      providerReasoning: { text: reasoning, field: 'reasoning_content', model: 'test-model' },
    },
    {
      role: 'user',
      content: [{ type: 'tool_result', toolCallId: id, ok: true, content: 'x'.repeat(100) }],
    },
  ];
  const ctx = makeContext(30_000); // keepLastTurns clamps to 6 on small budgets
  ctx.pinTask(userText('objective'));
  for (let i = 0; i < 2; i++) for (const m of toolRound(`old${i}`, 100)) ctx.append(m);
  for (const m of withReasoning('r-old', 'OLDER-REASONING')) ctx.append(m);
  for (const m of toolRound('mid', 100)) ctx.append(m);
  for (const m of withReasoning('r-new', 'NEWER-REASONING')) ctx.append(m);

  const summarizer: SpyProvider = {
    calls: 0,
    name: 'summarizer',
    estimateTokens(messages: Message[]): number {
      summarizer.calls += 1;
      return estimateTokensFromMessages(messages);
    },
    send(_req: CompletionRequest): AsyncIterable<ProviderEvent> {
      return (async function* (): AsyncGenerator<ProviderEvent> {
        yield { type: 'text', delta: 'ALREADY DONE: progress.\nNEXT STEP: continue.' };
        yield { type: 'done', stopReason: 'end_turn' };
      })();
    },
  };

  const res = await ctx.maybeSummarize(summarizer, 'test-model', true);
  assert.equal(res, 'summarized');

  const reasoning = ctx.messages().map((m) => m.providerReasoning?.text).filter(Boolean);
  assert.deepEqual(reasoning, ['NEWER-REASONING'], 'only the newest reasoning per model survives');
  assert.equal(
    ctx.estimateTokens(summarizer),
    estimateTokensFromMessages(ctx.messages()),
    'post-compact estimate is exact — replacement AND reasoning strip invalidated the cache',
  );
  assert.equal(summarizer.calls, 2, 'initial read + post-replacement recompute, then reads reuse');
});

test('truncateLocally stays exact and its stop line reads the provider live', async () => {
  const body = 1500;
  const ctx = makeContext(4000); // trigger = 3600, stop line = 3240
  ctx.pinTask(userText('objective'));
  for (let i = 0; i < 10; i++) for (const m of toolRound(`t${i}`, body)) ctx.append(m);
  const spy = makeSpy();

  const res = await ctx.maybeSummarize(spy, 'test-model', true);
  assert.equal(res, 'truncated');

  const tombstones = ctx
    .messages()
    .flatMap((m) => m.content)
    .filter((b) => b.type === 'tool_result' && b.content === TRUNCATED_RESULT_SENTINEL).length;
  // The summarization window holds seven droppable results; at this budget the stop line is
  // crossed after ~3 tombstones, so tombstoning must halt BEFORE exhausting the window (a
  // stale cached stop line would drop all seven).
  assert.ok(tombstones >= 1 && tombstones <= 6, `stop line halted at ${tombstones}/7 tombstones`);
  assert.ok(spy.calls >= 3, 'the stop line must re-read the provider during tombstoning');
  assert.equal(
    ctx.estimateTokens(spy),
    estimateTokensFromMessages(ctx.messages()),
    'lastActualTokens is zeroed after truncation, so the estimate is the bare heuristic',
  );
});
