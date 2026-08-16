import { test } from 'node:test';
import assert from 'node:assert/strict';
import { AgentLoop, type LoopDeps } from '../src/agent/loop.js';
import { Budget } from '../src/agent/budget.js';
import { Context, IMAGE_STRIPPED_SENTINEL, type CompactResult } from '../src/agent/context.js';
import { EventBus, type LoopEvent } from '../src/agent/events.js';
import { ToolRegistry } from '../src/tools/registry.js';
import { AutoApproveGate } from '../src/agent/approval.js';
import { MockProvider, type MockTurn } from '../src/provider/mock.js';
import type { Message, ProviderEvent } from '../src/provider/provider.js';

const BIG = 'x'.repeat(4_000); // ~1k tokens per body via the char/4 heuristic

// ─── rung 2 primitive: stripImageBlocks ────────────────────────────────────────────────────────

test('stripImageBlocks replaces every image block with the sentinel, preserving position', () => {
  const ctx = new Context({ contextBudget: 1_000, triggerRatio: 0.9, keepLastTurns: 12 });
  ctx.pinTask({ role: 'user', content: [{ type: 'text', text: 'the task' }] });
  ctx.append({
    role: 'user',
    content: [
      { type: 'image', mediaType: 'image/png', data: 'QUJD' },
      { type: 'text', text: 'caption' },
      { type: 'image', mediaType: 'image/jpeg', data: 'RVVG' },
    ],
  });
  ctx.append({ role: 'assistant', content: [{ type: 'text', text: 'ok' }] });

  const removed = ctx.stripImageBlocks();
  assert.equal(removed, 2, 'reports every image block removed');
  const msgs = ctx.messages();
  assert.equal(msgs.length, 3, 'no message added or dropped');
  assert.deepEqual(msgs[1]!.content, [
    { type: 'text', text: IMAGE_STRIPPED_SENTINEL },
    { type: 'text', text: 'caption' },
    { type: 'text', text: IMAGE_STRIPPED_SENTINEL },
  ]);
  assert.equal(ctx.stripImageBlocks(), 0, 'idempotent — nothing left to strip');
});

test('stripImageBlocks returns 0 and leaves text-only history untouched', () => {
  const ctx = new Context({ contextBudget: 1_000, triggerRatio: 0.9, keepLastTurns: 12 });
  ctx.pinTask({ role: 'user', content: [{ type: 'text', text: 'the task' }] });
  ctx.append({ role: 'assistant', content: [{ type: 'text', text: 'no images here' }] });
  const before = JSON.stringify(ctx.messages());
  assert.equal(ctx.stripImageBlocks(), 0);
  assert.equal(JSON.stringify(ctx.messages()), before);
});

// ─── rung 2 primitive: shrinkForOverflow ───────────────────────────────────────────────────────

test('shrinkForOverflow caps tool_result bodies HARD at the overflow cap with a marker', () => {
  const ctx = new Context({ contextBudget: 1_000, triggerRatio: 0.9, keepLastTurns: 12 });
  ctx.pinTask({ role: 'user', content: [{ type: 'text', text: 'the task' }] });
  ctx.append({ role: 'assistant', content: [{ type: 'tool_use', id: 't1', name: 'read_file', input: {} }] });
  ctx.append({ role: 'user', content: [{ type: 'tool_result', toolCallId: 't1', ok: true, content: BIG }] });
  ctx.append({ role: 'assistant', content: [{ type: 'tool_use', id: 't2', name: 'read_file', input: {} }] });
  ctx.append({ role: 'user', content: [{ type: 'tool_result', toolCallId: 't2', ok: true, content: 'small' }] });

  assert.equal(ctx.shrinkForOverflow(), true);
  const msgs = ctx.messages();
  const big = msgs[2]!.content[0] as { content: string };
  assert.ok(big.content.endsWith('\n…[truncated for overflow recovery]'));
  assert.ok(big.content.startsWith('x'.repeat(500)), 'keeps the first 500 chars (envelope-safe slice)');
  assert.equal(big.content.length, 500 + '\n…[truncated for overflow recovery]'.length);
  const small = msgs[4]!.content[0] as { content: string };
  assert.equal(small.content, 'small', 'results under the cap are untouched');
});

test('shrinkForOverflow drops thinking from every assistant turn EXCEPT the last one', () => {
  const ctx = new Context({ contextBudget: 1_000, triggerRatio: 0.9, keepLastTurns: 12 });
  ctx.pinTask({ role: 'user', content: [{ type: 'text', text: 'the task' }] });
  ctx.append({
    role: 'assistant',
    content: [
      { type: 'thinking', thinking: 'old thoughts', signature: '' },
      { type: 'text', text: 'a1' },
    ],
  });
  ctx.append({ role: 'user', content: [{ type: 'text', text: 'u1' }] });
  ctx.append({ role: 'assistant', content: [{ type: 'thinking', thinking: 'only thoughts', signature: '' }] });
  ctx.append({ role: 'user', content: [{ type: 'text', text: 'u2' }] });
  ctx.append({
    role: 'assistant',
    content: [
      { type: 'thinking', thinking: 'keep me', signature: '' },
      { type: 'text', text: 'last' },
    ],
  });

  assert.equal(ctx.shrinkForOverflow(), true);
  const msgs = ctx.messages();
  assert.deepEqual(msgs[1]!.content, [{ type: 'text', text: 'a1' }], 'older thinking dropped');
  assert.deepEqual(
    msgs[3]!.content,
    [{ type: 'text', text: '[earlier reasoning dropped for overflow recovery]' }],
    'a turn emptied of thinking gets a placeholder (providers reject empty turns)',
  );
  assert.deepEqual(
    msgs[5]!.content,
    [
      { type: 'thinking', thinking: 'keep me', signature: '' },
      { type: 'text', text: 'last' },
    ],
    'the LAST assistant turn keeps its thinking (continuation state)',
  );
});

test('shrinkForOverflow returns false when there is nothing to reclaim', () => {
  const ctx = new Context({ contextBudget: 1_000, triggerRatio: 0.9, keepLastTurns: 12 });
  ctx.pinTask({ role: 'user', content: [{ type: 'text', text: 'the task' }] });
  ctx.append({ role: 'assistant', content: [{ type: 'tool_use', id: 't1', name: 'read_file', input: {} }] });
  ctx.append({ role: 'user', content: [{ type: 'tool_result', toolCallId: 't1', ok: true, content: 'small' }] });
  ctx.append({ role: 'assistant', content: [{ type: 'thinking', thinking: 'last turn thinking', signature: '' }] });
  assert.equal(ctx.shrinkForOverflow(), false);
});

// ─── the loop-level ladder (F08-06) ────────────────────────────────────────────────────────────

const OVERFLOW_MSG = 'prompt is too long: 120000 tokens > 100000 maximum context length';
const OVERFLOW_TURN: ProviderEvent[] = [
  { type: 'error', recoverable: false, code: 'http_400', message: OVERFLOW_MSG },
  { type: 'done', stopReason: 'end_turn' },
];
const SUMMARY_TURN: ProviderEvent[] = [
  { type: 'text', delta: 'TASK: do the thing\nALREADY DONE: the reads.' },
  { type: 'usage', inputTokens: 10, outputTokens: 5 },
  { type: 'done', stopReason: 'end_turn' },
];

/**
 * One script for every send(): summarizer requests (detected by the compaction prompt marker)
 * get a valid handoff; the Nth MAIN request succeeds (or never, when succeedAt is 0), and every
 * earlier main request dies with a token-overflow 400.
 */
function ladderScript(succeedAt: number, counter: { main: number }): MockTurn {
  return (messages: Message[]): ProviderEvent[] => {
    const summarizer = messages.some((m) =>
      m.content.some((b) => b.type === 'text' && b.text.includes('OLDER HISTORY TO REPLACE')),
    );
    if (summarizer) return SUMMARY_TURN;
    counter.main += 1;
    if (succeedAt > 0 && counter.main >= succeedAt) {
      return [
        { type: 'text', delta: 'Ladder recovered.' },
        { type: 'usage', inputTokens: 10, outputTokens: 4 },
        { type: 'done', stopReason: 'end_turn' },
      ];
    }
    return OVERFLOW_TURN;
  };
}

function round(id: string, opts: { image?: boolean } = {}): Message[] {
  const userBlocks: Message['content'] = [{ type: 'tool_result', toolCallId: id, ok: true, content: BIG }];
  if (opts.image) userBlocks.push({ type: 'image', mediaType: 'image/png', data: 'QUJD' });
  return [
    { role: 'assistant', content: [{ type: 'tool_use', id, name: 'read_file', input: { path: id } }] },
    { role: 'user', content: userBlocks },
  ];
}

/** 3 plain rounds + 2 image-carrying rounds; the image rounds land in the kept tail. */
function seedHistory(ctx: Context): void {
  for (let i = 0; i < 3; i++) for (const m of round(`old${i}`)) ctx.append(m);
  for (let i = 0; i < 2; i++) for (const m of round(`img${i}`, { image: true })) ctx.append(m);
}

function buildLoop(
  provider: MockProvider,
  sessionLog?: LoopDeps['sessionLog'],
  opts: { keepLastTurns?: number; context?: Context } = {},
) {
  const registry = new ToolRegistry();
  const bus = new EventBus();
  const events: LoopEvent[] = [];
  bus.on((e) => events.push(e));
  const budget = new Budget({ maxIterations: 25 }, 'mock', { mock: { input: 1, output: 1 } }, Date.now());
  // Huge budget so PROACTIVE compaction never fires — only the reactive ladder under test can.
  const context =
    opts.context ??
    new Context({ contextBudget: 1_000_000, triggerRatio: 0.75, keepLastTurns: opts.keepLastTurns ?? 6 });
  context.pinTask({ role: 'user', content: [{ type: 'text', text: 'do the thing' }] });
  const deps: LoopDeps = {
    provider,
    registry,
    gate: new AutoApproveGate(),
    bus,
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
    sleep: async () => {},
    sessionLog,
  };
  return { loop: new AgentLoop(deps, 'full'), events, context, deps };
}

/** ladderScript + a record of every MAIN request's message count (freshness assertions). */
function ladderScriptCounts(succeedAt: number, counter: { main: number }, counts: number[]): MockTurn {
  return (messages: Message[]): ProviderEvent[] => {
    const summarizer = messages.some((m) =>
      m.content.some((b) => b.type === 'text' && b.text.includes('OLDER HISTORY TO REPLACE')),
    );
    if (summarizer) return SUMMARY_TURN;
    counter.main += 1;
    counts.push(messages.length);
    if (succeedAt > 0 && counter.main >= succeedAt) {
      return [
        { type: 'text', delta: 'Ladder recovered.' },
        { type: 'usage', inputTokens: 10, outputTokens: 4 },
        { type: 'done', stopReason: 'end_turn' },
      ];
    }
    return OVERFLOW_TURN;
  };
}

test('overflow ladder: rung 1 compaction then rung 2 image-strip + shrink, then the turn succeeds', async () => {
  const counter = { main: 0 };
  const provider = new MockProvider(Array.from({ length: 8 }, () => ladderScript(3, counter)));
  const { loop, events, context } = buildLoop(provider);
  seedHistory(context);

  const res = await loop.run();

  assert.equal(res.finalAnswer, 'Ladder recovered.');
  assert.equal(res.stopReason, 'end_turn');
  assert.equal(counter.main, 3, 'exactly three provider request attempts (no wasted fourth)');

  const retries = events.flatMap((e) =>
    e.type === 'retry' && e.reason.includes('context overflow') ? [e] : [],
  );
  assert.equal(retries.length, 2, 'one retry per rung');
  assert.match(retries[0]!.reason, /compacted and retrying/, 'rung 1 = forced compaction');
  assert.match(retries[1]!.reason, /stripped 2 image block\(s\)/, 'rung 2 reports the image strip');
  assert.match(retries[1]!.reason, /shrunk kept tail/, 'rung 2 reports the local shrink');

  // The images are gone from history, replaced by the sentinel (structure preserved).
  const blocks = context.messages().flatMap((m) => m.content);
  assert.ok(!blocks.some((b) => b.type === 'image'), 'no image block survives rung 2');
  assert.ok(
    blocks.some((b) => b.type === 'text' && b.text === IMAGE_STRIPPED_SENTINEL),
    'sentinel placeholders took their place',
  );

  assert.ok(
    !events.some((e) => e.type === 'finding' && e.severity === 'error'),
    'a recovered ladder emits no irrecoverable finding',
  );
});

test('overflow ladder: a third overflow after both rungs ends irrecoverable with guidance', async () => {
  const counter = { main: 0 };
  const provider = new MockProvider(Array.from({ length: 8 }, () => ladderScript(0, counter)));
  const records: Array<Record<string, unknown>> = [];
  const sessionLog = {
    path: '/tmp/shadow-overflow-ladder-test/none',
    record: (e: Record<string, unknown>) => records.push(e),
    recordSnapshot: () => {},
  } as unknown as LoopDeps['sessionLog'];
  const { loop, events, context } = buildLoop(provider, sessionLog);
  seedHistory(context);

  const res = await loop.run();

  assert.equal(counter.main, 3, 'exactly three attempts — rung 2 must not be skipped or repeated');
  assert.equal(res.stopReason, 'provider_error');
  const finding = events.find((e) => e.type === 'finding' && e.severity === 'error');
  assert.ok(finding && finding.type === 'finding', 'an irrecoverable finding was emitted');
  assert.match(finding.title, /irrecoverable/);
  assert.match(finding.body, /\/clear/, 'guidance offers /clear');
  assert.match(finding.body, /\/rewind/, 'guidance offers /rewind');
  assert.ok(
    records.some((r) => r.kind === 'compaction_degraded' && r.mode === 'overflow_irrecoverable'),
    'the session log records the irrecoverable end state',
  );
});

// ─── adversarial review regressions (2026-08-14): F1 escape, F2 wedge, F3 throw semantics ─────

test('F1: fallback consuming attempt 0 still gives rung-2 recovery its request INSIDE the loop — with LIVE messages, and the turn succeeds', async () => {
  const counterA = { main: 0 };
  const counterB = { main: 0 };
  const countsB: number[] = [];
  // Primary model: first main request dies 529-eligible (fallback fires); nothing else runs there.
  const primary: MockTurn = (messages: Message[]): ProviderEvent[] => {
    const summarizer = messages.some((m) =>
      m.content.some((b) => b.type === 'text' && b.text.includes('OLDER HISTORY TO REPLACE')),
    );
    if (summarizer) return SUMMARY_TURN;
    counterA.main += 1;
    return [
      { type: 'error', recoverable: false, code: 'http_529', message: 'overloaded_error: server is overloaded' },
      { type: 'done', stopReason: 'end_turn' },
    ];
  };
  const providerA = new MockProvider(Array.from({ length: 4 }, () => primary));
  const providerB = new MockProvider(Array.from({ length: 8 }, () => ladderScriptCounts(3, counterB, countsB)));
  const { loop, events, context, deps } = buildLoop(providerA);
  deps.models = [{ model: 'mock-small' }] as NonNullable<LoopDeps['models']>;
  deps.fallbackModel = 'mock-small';
  deps.resolveFallback = async () => ({ provider: providerB, model: 'mock-small' });
  seedHistory(context);

  const res = await loop.run();

  assert.equal(res.finalAnswer, 'Ladder recovered.');
  assert.equal(counterA.main, 1, 'one request on the primary model before fallback');
  assert.equal(counterB.main, 3, 'rung 1 + rung 2 + the request rung 2 earned — all on the fallback model');
  // THE F1 PIN: the 4th overall request (3rd on B) must send the RECLAIMED context, not the
  // pre-ladder snapshot the old after-loop fall-through re-sent (guaranteed re-overflow).
  assert.equal(countsB.length, 3);
  assert.ok(
    countsB[2]! < countsB[0]!,
    `the post-rung-2 request carries fewer messages (${countsB[2]}) than the first (${countsB[0]}) — live reclaimed context`,
  );
  assert.ok(
    !events.some((e) => e.type === 'finding' && e.severity === 'error'),
    'a recovered ladder emits no irrecoverable finding',
  );
});

test('F1: if the 4th request STILL overflows at rung 2, the terminal finding fires inside the loop (not a bare 400)', async () => {
  const counterA = { main: 0 };
  const counterB = { main: 0 };
  const countsB: number[] = [];
  const primary: MockTurn = (messages: Message[]): ProviderEvent[] => {
    const summarizer = messages.some((m) =>
      m.content.some((b) => b.type === 'text' && b.text.includes('OLDER HISTORY TO REPLACE')),
    );
    if (summarizer) return SUMMARY_TURN;
    counterA.main += 1;
    return [
      { type: 'error', recoverable: false, code: 'http_529', message: 'overloaded_error: server is overloaded' },
      { type: 'done', stopReason: 'end_turn' },
    ];
  };
  const providerA = new MockProvider(Array.from({ length: 4 }, () => primary));
  const providerB = new MockProvider(Array.from({ length: 8 }, () => ladderScriptCounts(0, counterB, countsB)));
  const records: Array<Record<string, unknown>> = [];
  const sessionLog = {
    path: '/tmp/shadow-overflow-ladder-test/f1',
    record: (e: Record<string, unknown>) => records.push(e),
    recordSnapshot: () => {},
  } as unknown as LoopDeps['sessionLog'];
  const { loop, events, context, deps } = buildLoop(providerA, sessionLog);
  deps.models = [{ model: 'mock-small' }] as NonNullable<LoopDeps['models']>;
  deps.fallbackModel = 'mock-small';
  deps.resolveFallback = async () => ({ provider: providerB, model: 'mock-small' });
  seedHistory(context);

  const res = await loop.run();

  assert.equal(counterA.main + counterB.main, 4, 'fallback + rung 1 + rung 2 + rung-2 retry');
  assert.equal(res.stopReason, 'provider_error');
  const finding = events.find((e) => e.type === 'finding' && e.severity === 'error');
  assert.ok(finding && finding.type === 'finding', 'the terminal finding fired for the 4th-request overflow');
  assert.match(finding.title, /irrecoverable/);
  assert.ok(
    records.some((r) => r.kind === 'compaction_degraded' && r.mode === 'overflow_irrecoverable'),
    'the session log records the irrecoverable end state',
  );
});

test('F2: rung 1 reclaiming NOTHING (short history) escalates to rung 2 immediately instead of wedging', async () => {
  const counter = { main: 0 };
  const provider = new MockProvider(Array.from({ length: 8 }, () => ladderScript(2, counter)));
  // keepLastTurns 12 → the 11 seeded messages are "too short to summarize": maybeSummarize
  // returns false at rung 1 (end <= pinnedPrefix). The old code returned the bare 400 here and
  // every future turn re-ran the same deterministic failure — rung 2 never got a chance.
  const { loop, events, context } = buildLoop(provider, undefined, { keepLastTurns: 12 });
  seedHistory(context);

  const res = await loop.run();

  assert.equal(res.finalAnswer, 'Ladder recovered.');
  assert.equal(counter.main, 2, 'rung-1 failure + rung-2 local reclaim + one retry — no extra attempts');
  const retries = events.flatMap((e) =>
    e.type === 'retry' && e.reason.includes('context overflow') ? [e] : [],
  );
  assert.equal(retries.length, 1, 'only rung 2 recovered, so only one retry event');
  assert.match(retries[0]!.reason, /stripped 2 image block\(s\)/, 'rung 2 strip reported');
  assert.match(retries[0]!.reason, /shrunk kept tail/, 'rung 2 shrink reported');
  assert.ok(
    !events.some((e) => e.type === 'finding' && e.severity === 'error'),
    'no irrecoverable finding — the ladder recovered after escalation',
  );
});

test('F2: when NOTHING can reclaim (no images, small bodies, short history), rung 2 still runs and the end is an honest irrecoverable finding', async () => {
  const counter = { main: 0 };
  const provider = new MockProvider(Array.from({ length: 8 }, () => ladderScript(0, counter)));
  const records: Array<Record<string, unknown>> = [];
  const sessionLog = {
    path: '/tmp/shadow-overflow-ladder-test/f2',
    record: (e: Record<string, unknown>) => records.push(e),
    recordSnapshot: () => {},
  } as unknown as LoopDeps['sessionLog'];
  const { loop, events, context } = buildLoop(provider, sessionLog, { keepLastTurns: 12 });
  // One small round: nothing to strip, nothing to shrink, nothing to summarize.
  for (const m of [
    { role: 'assistant', content: [{ type: 'tool_use', id: 's0', name: 'read_file', input: {} }] },
    { role: 'user', content: [{ type: 'tool_result', toolCallId: 's0', ok: true, content: 'small' }] },
  ] as Message[]) {
    context.append(m);
  }

  const res = await loop.run();

  assert.equal(counter.main, 1, 'no wasted retries when nothing can reclaim — straight to the terminal state');
  assert.equal(res.stopReason, 'provider_error');
  const finding = events.find((e) => e.type === 'finding' && e.severity === 'error');
  assert.ok(finding && finding.type === 'finding', 'irrecoverable finding on the FIRST overflow turn (no silent wedge)');
  assert.match(finding.title, /irrecoverable/);
  assert.ok(
    records.some((r) => r.kind === 'compaction_degraded' && r.mode === 'overflow_irrecoverable'),
    'the wedge end state is recorded',
  );
});

test('F3: a ladder throw is surfaced even when the degraded-report token was already consumed (no silent swallow)', async () => {
  class ThrowingContext extends Context {
    override async maybeSummarize(): Promise<CompactResult> {
      throw new Error('summarizer exploded');
    }
  }
  const counter = { main: 0 };
  const provider = new MockProvider(Array.from({ length: 8 }, () => ladderScript(0, counter)));
  const records: Array<Record<string, unknown>> = [];
  const sessionLog = {
    path: '/tmp/shadow-overflow-ladder-test/f3',
    record: (e: Record<string, unknown>) => records.push(e),
    recordSnapshot: () => {},
  } as unknown as LoopDeps['sessionLog'];
  const ctx = new ThrowingContext({ contextBudget: 1_000_000, triggerRatio: 0.75, keepLastTurns: 12 });
  const { loop, events, context } = buildLoop(provider, sessionLog, { context: ctx });
  // One small round: rung 2 strip/shrink reclaim nothing, so the rung-2 re-compact throw rethrows.
  for (const m of [
    { role: 'assistant', content: [{ type: 'tool_use', id: 's0', name: 'read_file', input: {} }] },
    { role: 'user', content: [{ type: 'tool_result', toolCallId: 's0', ok: true, content: 'small' }] },
  ] as Message[]) {
    context.append(m);
  }
  // Consume the dedupe token BEFORE the ladder runs — the old gated catch would then swallow the
  // throw with no finding at all.
  assert.equal(context.consumeDegradedReport(), true, 'token consumed up front');

  const res = await loop.run();

  assert.equal(res.stopReason, 'provider_error');
  const warn = events.find((e) => e.type === 'finding' && e.severity === 'warn' && /Compaction error/.test(e.title));
  assert.ok(warn && warn.type === 'finding', 'the ladder throw surfaced despite the consumed dedupe token');
  assert.match(warn.body, /summarizer exploded/);
  assert.ok(records.some((r) => r.kind === 'compaction_degraded' && r.mode === 'error'), 'throw recorded');
  assert.ok(
    events.some((e) => e.type === 'finding' && e.severity === 'error' && /irrecoverable/.test(e.title)),
    'still ends in the honest irrecoverable state',
  );
});
