// P2-06 acceptance pins — every performance clamp this batch ships, in one file.
// F06-05 read_file cap/stream · F06-06 width single-pass · F06-08 reasoning round-trip trim ·
// F06-09 first paint not gated on MCP/hooks · F06-10 sub-agent concurrency semaphore.
// These are the regression contract: a future change that silently loosens any clamp fails here.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync, chmodSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { z } from 'zod';
import { readFile } from '../src/tools/readFile.js';
import { displayWidth, takeByWidth, chunksByWidth } from '../src/tui/width.js';
import { toOpenAIMessages } from '../src/provider/openai.js';
import type { CompletionRequest, Message } from '../src/provider/provider.js';
import { Semaphore } from '../src/util/semaphore.js';
import { runHookPhaseDetached } from '../src/hooks/runner.js';
import { registerMcpServers } from '../src/mcp/client.js';
import { ToolRegistry } from '../src/tools/registry.js';
import { makeAgentTool } from '../src/tools/agentTool.js';
import { Budget } from '../src/agent/budget.js';
import { Context } from '../src/agent/context.js';
import { EventBus } from '../src/agent/events.js';
import { renderSubAgentPanel } from '../src/tui/subagentPanel.js';
import type { SubAgentView } from '../src/tui/subagentPanel.js';
import { ScriptedApprovalGate } from '../src/agent/approval.js';
import { MockProvider } from '../src/provider/mock.js';
import type { LoopDeps } from '../src/agent/loop.js';
import type { ToolContext } from '../src/tools/types.js';
import { ok } from '../src/tools/types.js';

const PRICE = { mock: { input: 1, output: 1 } };

const tctx = (ws: string): ToolContext => ({
  workspaceRoot: ws,
  signal: new AbortController().signal,
  log: () => {},
  dryRun: false,
});

// ---------------------------------------------------------------------------
// F06-05 — read_file: stat-before-read cap, streaming line window, binary sniff
// ---------------------------------------------------------------------------

test('F06-05: files over 10MB are refused by STAT — never read into memory', async () => {
  const ws = mkdtempSync(join(tmpdir(), 'pf-read-'));
  try {
    writeFileSync(join(ws, 'big.log'), Buffer.alloc(11 * 1024 * 1024, 0x61));
    const res = await readFile.run({ path: 'big.log' }, tctx(ws));
    assert.equal(res.ok, false, 'an 11MB file must be refused');
    assert.equal(res.error?.code, 'file_too_large');
    assert.match(res.summary, /grep|run_shell/i, 'the refusal must point at an extraction path');
  } finally {
    rmSync(ws, { recursive: true, force: true });
  }
});

test('F06-05: only the requested line window is retained; totalLines stays exact', async () => {
  const ws = mkdtempSync(join(tmpdir(), 'pf-read-'));
  try {
    const lines = Array.from({ length: 2000 }, (_, i) => `line-${i + 1}`);
    writeFileSync(join(ws, 'f.txt'), lines.join('\n') + '\n');
    const res = await readFile.run({ path: 'f.txt', offset: 100, limit: 5 }, tctx(ws));
    assert.ok(res.ok);
    const d = res.data as { content: string; startLine: number; endLine: number; totalLines: number };
    assert.equal(d.startLine, 100);
    assert.equal(d.endLine, 104);
    assert.equal(d.totalLines, 2000, 'totalLines counts the whole file, not the window');
    assert.equal(d.content, lines.slice(99, 104).join('\n'), 'exactly the window, nothing more');
  } finally {
    rmSync(ws, { recursive: true, force: true });
  }
});

test('F06-05: multi-chunk files stream together intact (lines spanning chunk boundaries)', async () => {
  const ws = mkdtempSync(join(tmpdir(), 'pf-read-'));
  try {
    // ~300KB forces many stream chunks; content must reassemble byte-for-byte.
    const lines = Array.from({ length: 5000 }, (_, i) => `row ${i} ${'x'.repeat(50)}`);
    writeFileSync(join(ws, 'big.txt'), lines.join('\n') + '\n');
    const res = await readFile.run({ path: 'big.txt' }, tctx(ws));
    assert.ok(res.ok);
    const d = res.data as { content: string; totalLines: number };
    assert.equal(d.totalLines, 5000);
    assert.equal(d.content, lines.join('\n'));
  } finally {
    rmSync(ws, { recursive: true, force: true });
  }
});

test('F06-05: a NUL in the first 8KB marks the file binary and refuses it', async () => {
  const ws = mkdtempSync(join(tmpdir(), 'pf-read-'));
  try {
    writeFileSync(join(ws, 'bin.dat'), Buffer.concat([Buffer.from('header'), Buffer.from([0]), Buffer.alloc(64, 0x61)]));
    const res = await readFile.run({ path: 'bin.dat' }, tctx(ws));
    assert.equal(res.ok, false);
    assert.equal(res.error?.code, 'binary');
  } finally {
    rmSync(ws, { recursive: true, force: true });
  }
});

test('F06-05: an empty file reads as 0 lines, not an error', async () => {
  const ws = mkdtempSync(join(tmpdir(), 'pf-read-'));
  try {
    writeFileSync(join(ws, 'empty.txt'), '');
    const res = await readFile.run({ path: 'empty.txt' }, tctx(ws));
    assert.ok(res.ok);
    const d = res.data as { content: string; totalLines: number };
    assert.equal(d.content, '');
    assert.equal(d.totalLines, 0);
  } finally {
    rmSync(ws, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// F06-06 — width: single-pass correctness + no quadratic stall
// ---------------------------------------------------------------------------

test('F06-06: displayWidth parity — ASCII fast path, CJK double width, SGR invisible', () => {
  assert.equal(displayWidth('hello'), 5);
  assert.equal(displayWidth('日本語'), 6, 'CJK ideographs are 2 columns each');
  assert.equal(displayWidth('a日b'), 4, 'mixed content adds correctly');
  assert.equal(displayWidth('\x1b[31mred\x1b[0m'), 3, 'SGR escapes occupy no columns');
});

test('F06-06: takeByWidth never splits a cluster nor overshoots the budget (long CJK)', () => {
  const s = '日本語のテキスト'.repeat(500);
  for (const cols of [1, 2, 3, 7, 61]) {
    const { head, rest, width } = takeByWidth(s, cols);
    assert.ok(displayWidth(head) <= cols, `head must fit the budget (${cols})`);
    assert.equal(head + rest, s, `nothing may be lost or reordered (${cols})`);
    assert.equal(displayWidth(head), width, 'the reported width is the head width');
  }
});

test('F06-06: chunksByWidth covers the string exactly, every chunk within budget (mixed content)', () => {
  const s = 'abc日本語def👨‍👩‍👧ghi'.repeat(300);
  for (const cols of [5, 12, 80]) {
    const chunks = chunksByWidth(s, cols);
    assert.equal(chunks.join(''), s, `concat must restore the original (${cols})`);
    for (const c of chunks) assert.ok(displayWidth(c) <= cols, `every chunk fits (${cols})`);
  }
});

test('F06-06: a cluster wider than the whole budget is emitted alone, never an infinite loop', () => {
  assert.deepEqual(chunksByWidth('日本', 1), ['日', '本']);
  // Mixed content before an oversized cluster: no spurious empty chunks either side.
  assert.deepEqual(chunksByWidth('a日', 1), ['a', '日']);
});

test('F06-06: long CJK lines wrap in one pass — no quadratic stall', () => {
  const s = '漢'.repeat(20_000); // 40k columns of double-width text
  const t0 = Date.now();
  const chunks = chunksByWidth(s, 100);
  takeByWidth(s, 12_345);
  const ms = Date.now() - t0;
  assert.ok(ms < 1000, `single-pass wrapping stayed fast (${ms}ms) — the old cut stalled for seconds here`);
  assert.equal(chunks.join(''), s, 'the fast path must still be lossless');
});

// ---------------------------------------------------------------------------
// F06-08 — reasoning round-trip trim: newest-only replay, none mode, model stamp
// ---------------------------------------------------------------------------

const MODEL = 'qwen3.8-max';
const user = (text: string): Message => ({ role: 'user', content: [{ type: 'text', text }] });
const asst = (text: string, reasoning?: Message['providerReasoning']): Message => ({
  role: 'assistant',
  content: [{ type: 'text', text }],
  ...(reasoning ? { providerReasoning: reasoning } : {}),
});
const reqOf = (messages: Message[]): CompletionRequest => ({ model: MODEL, system: 's', messages, tools: [], maxOutputTokens: 1024 });
const assistantsOf = (out: Array<Record<string, unknown>>): Array<Record<string, unknown>> =>
  out.filter((m) => m.role === 'assistant');

test('F06-08: only the NEWEST reasoning turn round-trips; older thinking is dropped', () => {
  const req = reqOf([
    user('q1'),
    asst('a1', { text: 'THINK-OLD', field: 'reasoning_content', model: MODEL }),
    user('q2'),
    asst('a2', { text: 'THINK-NEW', field: 'reasoning_content', model: MODEL }),
  ]);
  const out = toOpenAIMessages(req, MODEL, { preserveProviderReasoning: true, reasoningRoundtrip: 'last' }) as Array<Record<string, unknown>>;
  const assistants = assistantsOf(out);
  assert.equal(assistants.length, 2);
  assert.equal(assistants[0]!.reasoning_content, undefined, 'the older turn must NOT replay its reasoning');
  assert.equal(assistants[1]!.reasoning_content, 'THINK-NEW', 'the newest turn keeps the continuation contract');
});

test('F06-08: the default roundtrip mode is last (omit the knob, get newest-only)', () => {
  const req = reqOf([
    user('q1'),
    asst('a1', { text: 'T1', field: 'reasoning_content', model: MODEL }),
    asst('a2', { text: 'T2', field: 'reasoning_content', model: MODEL }),
  ]);
  const out = toOpenAIMessages(req, MODEL, { preserveProviderReasoning: true }) as Array<Record<string, unknown>>;
  const assistants = assistantsOf(out);
  assert.equal(assistants[0]!.reasoning_content, undefined);
  assert.equal(assistants[1]!.reasoning_content, 'T2');
});

test('F06-08: reasoningRoundtrip=none replays nothing at all', () => {
  const req = reqOf([
    user('q1'),
    asst('a1', { text: 'T1', field: 'reasoning_content', model: MODEL }),
    asst('a2', { text: 'T2', field: 'reasoning_content', model: MODEL }),
  ]);
  const out = toOpenAIMessages(req, MODEL, { preserveProviderReasoning: true, reasoningRoundtrip: 'none' }) as Array<Record<string, unknown>>;
  for (const m of assistantsOf(out)) {
    assert.equal(m.reasoning_content, undefined);
    assert.equal(m.reasoning, undefined);
  }
});

test('F06-08: reasoning stamped by another model never replays', () => {
  const req = reqOf([user('q1'), asst('a1', { text: 'T', field: 'reasoning_content', model: 'some-other-model' })]);
  const out = toOpenAIMessages(req, MODEL, { preserveProviderReasoning: true }) as Array<Record<string, unknown>>;
  assert.equal(assistantsOf(out)[0]!.reasoning_content, undefined);
});

test('F06-08: the field routes to the exact wire name (reasoning vs reasoning_content)', () => {
  const req = reqOf([user('q1'), asst('a1', { text: 'T', field: 'reasoning', model: MODEL })]);
  const out = toOpenAIMessages(req, MODEL, { preserveProviderReasoning: true }) as Array<Record<string, unknown>>;
  const m = assistantsOf(out)[0]!;
  assert.equal(m.reasoning, 'T');
  assert.equal(m.reasoning_content, undefined);
});

// ---------------------------------------------------------------------------
// F06-09 — first paint: startup is never gated on hooks or a dead MCP server
// ---------------------------------------------------------------------------

test('F06-09: session_start hooks fire detached — first paint is not gated on init scripts', () => {
  const ws = mkdtempSync(join(tmpdir(), 'pf-hook-'));
  try {
    const hook = join(ws, 'slow-init.sh');
    writeFileSync(hook, '#!/bin/sh\nsleep 1\n');
    chmodSync(hook, 0o755);
    const t0 = Date.now();
    runHookPhaseDetached('session_start', [hook], { workspaceRoot: ws, sessionId: 'pin' });
    const ms = Date.now() - t0;
    assert.ok(ms < 500, `detached hook returned in ${ms}ms — must not block first paint behind a 1s init script`);
  } finally {
    rmSync(ws, { recursive: true, force: true });
  }
});

test('F06-09: a dead MCP server cannot gate startup — skipped fast, onClient fires at construction', async () => {
  const registry = new ToolRegistry();
  const constructed: unknown[] = [];
  const t0 = Date.now();
  await registerMcpServers(registry, { dead: { command: '/usr/bin/false' } }, tmpdir(), (c) => constructed.push(c));
  const ms = Date.now() - t0;
  assert.ok(ms < 5000, `a dead server settled in ${ms}ms — startup must not burn the full 10s budget`);
  assert.equal(constructed.length, 1, 'onClient fires at construction so shutdown can kill in-flight children');
  assert.equal(registry.list().length, 0, 'a dead server registers no tools');
});

// ---------------------------------------------------------------------------
// F06-10 — sub-agent concurrency: the semaphore contract + the agent-tool wiring
// ---------------------------------------------------------------------------

test('F06-10: semaphore caps concurrency and grants permits FIFO', async () => {
  const sem = new Semaphore(2);
  let active = 0;
  let maxActive = 0;
  const order: number[] = [];
  const jobs = [0, 1, 2, 3, 4, 5].map((i) =>
    (async () => {
      const release = await sem.acquire();
      order.push(i);
      active++;
      maxActive = Math.max(maxActive, active);
      await new Promise((r) => setTimeout(r, 5));
      active--;
      release();
    })(),
  );
  await Promise.all(jobs);
  assert.ok(maxActive <= 2, `never more than 2 holders at once (saw ${maxActive})`);
  assert.deepEqual(order, [0, 1, 2, 3, 4, 5], 'permits are granted strictly in arrival order');
});

test('F06-10: an aborted waiter is dequeued cleanly and leaks no permit', async () => {
  const sem = new Semaphore(1);
  const release = await sem.acquire();
  const ac = new AbortController();
  const queued = sem.acquire(ac.signal);
  assert.equal(sem.waiting, 1);
  ac.abort();
  await assert.rejects(queued, /aborted while queued/);
  assert.equal(sem.waiting, 0, 'the aborted waiter left the queue');
  // The next acquirer still gets in once the held permit frees — no loss, no inflation.
  const next = sem.acquire();
  release();
  const release2 = await next;
  release2();
});

test('F06-10: tryAcquire never cuts the queue', async () => {
  const sem = new Semaphore(1);
  const release = await sem.acquire();
  const waiting = sem.acquire(); // now queued
  assert.equal(sem.tryAcquire(), null, 'a slot that looks free belongs to the queued waiter');
  release();
  const release2 = await waiting;
  release2();
});

test('F06-10: double-release is a no-op, not permit inflation', () => {
  const sem = new Semaphore(1);
  const release = sem.tryAcquire();
  assert.ok(release);
  release!();
  release!();
  // The double release must have freed exactly ONE slot: one acquire succeeds, the next cannot.
  const again = sem.tryAcquire();
  assert.ok(again, 'one permit exists after a double release');
  assert.equal(sem.tryAcquire(), null, 'no inflated second permit while the slot is held');
});

test('F06-10: agent tool queues excess sub-agents and admits them only on release', async () => {
  const ws = mkdtempSync(join(tmpdir(), 'pf-sem-'));
  try {
    let releaseSlow!: () => void;
    const slowGate = new Promise<void>((r) => {
      releaseSlow = r;
    });
    const slowTool = {
      name: 'slow_tool',
      description: 'blocks until the test releases it',
      risk: 'read' as const,
      inputSchema: z.object({}),
      async run(): Promise<ReturnType<typeof ok>> {
        await slowGate;
        return ok('slow_tool', 'read', 0, 'done');
      },
    };
    const bus = new EventBus();
    const seen: Array<Record<string, unknown>> = [];
    bus.on((e) => seen.push(e as Record<string, unknown>));

    const makeLoopDeps = (): LoopDeps => {
      const registry = new ToolRegistry();
      registry.register(slowTool);
      return {
        provider: new MockProvider([
          [
            { type: 'tool_call', call: { id: 's1', name: 'slow_tool', input: {} } },
            { type: 'done', stopReason: 'tool_use' },
          ],
        ]),
        registry,
        gate: new ScriptedApprovalGate([], 'approve'),
        bus,
        budget: new Budget({ maxIterations: 5 }, 'mock', PRICE, Date.now()),
        context: new Context({ contextBudget: 1_000_000, triggerRatio: 0.75, keepLastTurns: 6 }),
        signal: new AbortController().signal,
        model: 'mock',
        system: 'test',
        maxOutputTokens: 1024,
        workspaceRoot: ws,
        dryRun: false,
        maxToolResultChars: 16_000,
        contextBudget: 1_000_000,
      };
    };
    const tool = makeAgentTool({
      makeLoopDeps,
      getAutonomy: () => 'full',
      contextBudget: 1_000_000,
      triggerRatio: 0.75,
      keepLastTurns: 6,
      maxIterations: 5,
      priceTable: PRICE,
      subagentConcurrency: 1,
    });
    const ctx = tctx(ws);

    // A admits immediately and parks on slow_tool, holding the only slot.
    const runA = tool.run({ prompt: 'A' }, ctx);
    await new Promise((r) => setTimeout(r, 25));
    // B must queue: no permit while A is inside its loop.
    let bDone = false;
    const runB = tool.run({ prompt: 'B' }, ctx).then((res) => {
      bDone = true;
      return res;
    });
    await new Promise((r) => setTimeout(r, 25));

    const starts = seen.filter((e) => e.type === 'subagent_start');
    assert.equal(starts.length, 2, 'A announced admitted, B announced queued — nothing more yet');
    assert.equal(starts[0]!.queued, false, 'A took a free permit');
    assert.equal(starts[1]!.queued, true, 'B must be surfaced as QUEUED while it waits for a slot');
    assert.equal(bDone, false, 'B must not run before A releases the slot');

    releaseSlow();
    const [resA, resB] = await Promise.all([runA, runB]);
    assert.ok(resA.ok);
    assert.ok(resB.ok);
    assert.equal(bDone, true);

    // Admission re-announcement: B gets a SECOND subagent_start with queued cleared.
    const bTaskId = starts[1]!.taskId as string;
    const bStarts = seen.filter((e) => e.type === 'subagent_start' && e.taskId === bTaskId);
    assert.equal(bStarts.length, 2, 'queued announcement + admission announcement');
    assert.equal(bStarts[0]!.queued, true);
    assert.notEqual(bStarts[1]!.queued, true, 'the admission announcement clears queued');

    // Serial execution proof: A's end precedes B's admission announcement.
    const aTaskId = starts[0]!.taskId as string;
    const aEndIdx = seen.findIndex((e) => e.type === 'subagent_end' && e.taskId === aTaskId);
    const bAdmitIdx = seen.findIndex(
      (e) => e.type === 'subagent_start' && e.taskId === bTaskId && e.queued !== true,
    );
    assert.ok(aEndIdx !== -1 && bAdmitIdx !== -1 && aEndIdx < bAdmitIdx, 'B is admitted only AFTER A ends');

    const ends = seen.filter((e) => e.type === 'subagent_end');
    assert.equal(ends.length, 2, 'exactly one end per agent');
    assert.ok(ends.every((e) => e.ok === true));
  } finally {
    rmSync(ws, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// Adversarial-review fixes (2026-08-14) — pins for the defects the 3-lens
// pre-commit review caught. Each one failed (or would crash) before its fix.
// ---------------------------------------------------------------------------

test('F06-08: compaction keeps the NEWEST reasoning per distinct model (switch-back survives)', async () => {
  const context = new Context({ contextBudget: 200_000, triggerRatio: 0.75, keepLastTurns: 5 });
  context.pinTask({ role: 'user', content: [{ type: 'text', text: 'task' }] });
  const asst = (text: string, reasoningText: string, model: string): Message => ({
    role: 'assistant',
    content: [{ type: 'text', text }],
    providerReasoning: { text: reasoningText, field: 'reasoning_content', model },
  });
  context.append({ role: 'user', content: [{ type: 'text', text: 'q1' }] });
  context.append(asst('a1', 'R-QWEN-OLD', 'qwen'));
  context.append({ role: 'user', content: [{ type: 'text', text: 'q2' }] });
  context.append(asst('a2', 'R-KIMI', 'kimi'));
  context.append({ role: 'user', content: [{ type: 'text', text: 'q3' }] });
  context.append(asst('a3', 'R-QWEN-NEW', 'qwen'));

  // force=true; the summarizer emits a non-empty handoff so the replace path runs.
  const summarizer = new MockProvider([[
    { type: 'text', delta: 'handoff' },
    { type: 'usage', inputTokens: 1, outputTokens: 1 },
    { type: 'done', stopReason: 'end_turn' },
  ]]);
  const res = await context.maybeSummarize(summarizer, 'mock', true);
  assert.equal(res, 'summarized');

  // All three reasoning turns sit in the kept tail (7 msgs − keep 5 → end 2 > pinnedPrefix 1).
  // The strip must keep the newest PER MODEL: the qwen switch-back turn AND kimi's turn — a
  // newest-global strip would have deleted the only kimi copy because qwen's is newer.
  const kept = context.messages().filter((m) => m.role === 'assistant' && m.providerReasoning);
  const byModel = new Map(kept.map((m) => [m.providerReasoning!.model, m.providerReasoning!.text]));
  assert.equal(byModel.get('qwen'), 'R-QWEN-NEW', 'qwen thread survives the Qwen→Kimi→Qwen switch-back');
  assert.equal(byModel.get('kimi'), 'R-KIMI', 'kimi thread is the newest of its model, so it stays');
  assert.equal(kept.length, 2, 'the older qwen copy IS stripped — no dead wire state retained');
});

test('F06-10: a nested agent call bypasses admission — it cannot deadlock behind its own parent', async () => {
  const ws = mkdtempSync(join(tmpdir(), 'pf-nest-'));
  try {
    let releaseSlow!: () => void;
    const slowGate = new Promise<void>((r) => {
      releaseSlow = r;
    });
    const slowTool = {
      name: 'slow_tool',
      description: 'blocks until the test releases it',
      risk: 'read' as const,
      inputSchema: z.object({}),
      async run(): Promise<ReturnType<typeof ok>> {
        await slowGate;
        return ok('slow_tool', 'read', 0, 'done');
      },
    };
    const bus = new EventBus();
    const seen: Array<Record<string, unknown>> = [];
    bus.on((e) => seen.push(e as Record<string, unknown>));

    // First sub-loop (agent A) parks on slow_tool; the second (nested B) answers at once.
    // (B gets a REAL text script: the bare end_turn fallback carries no text, and the loop's
    // empty-response ladder would add its backoff to B's completion time.)
    let depCalls = 0;
    const makeLoopDeps = (): LoopDeps => {
      const n = ++depCalls;
      const registry = new ToolRegistry();
      registry.register(slowTool);
      return {
        provider:
          n === 1
            ? new MockProvider([
                [
                  { type: 'tool_call', call: { id: 's1', name: 'slow_tool', input: {} } },
                  { type: 'done', stopReason: 'tool_use' },
                ],
              ])
            : new MockProvider([
                [
                  { type: 'text', delta: 'B done' },
                  { type: 'usage', inputTokens: 1, outputTokens: 1 },
                  { type: 'done', stopReason: 'end_turn' },
                ],
              ]),
        registry,
        gate: new ScriptedApprovalGate([], 'approve'),
        bus,
        budget: new Budget({ maxIterations: 5 }, 'mock', PRICE, Date.now()),
        context: new Context({ contextBudget: 1_000_000, triggerRatio: 0.75, keepLastTurns: 6 }),
        signal: new AbortController().signal,
        model: 'mock',
        system: 'test',
        maxOutputTokens: 1024,
        workspaceRoot: ws,
        dryRun: false,
        maxToolResultChars: 16_000,
        contextBudget: 1_000_000,
      };
    };
    const tool = makeAgentTool({
      makeLoopDeps,
      getAutonomy: () => 'full',
      contextBudget: 1_000_000,
      triggerRatio: 0.75,
      keepLastTurns: 6,
      maxIterations: 5,
      priceTable: PRICE,
      subagentConcurrency: 1, // cap ONE: A holds the only slot for the whole test
    });
    const ctx = tctx(ws);

    // A admits and parks on slow_tool, holding the only permit.
    const runA = tool.run({ prompt: 'A' }, ctx);
    await new Promise((r) => setTimeout(r, 25));

    // B arrives NESTED (a sub-agent spawning its own sub-agent). Pre-fix it queued behind A —
    // forever, since A cannot finish until B returns: the deadlock this pin nails shut.
    const nestedCtx: ToolContext = { ...ctx, nestedAgent: true };
    const runB = tool.run({ prompt: 'B' }, nestedCtx);
    await new Promise((r) => setTimeout(r, 50));

    const starts = seen.filter((e) => e.type === 'subagent_start');
    assert.equal(starts.length, 2, 'A and B each announced once (B never re-announces — it never queues)');
    const bStart = starts[1]!;
    assert.notEqual(bStart!.queued, true, 'a nested agent never reports queued — it bypasses the gate');
    const bEnd = seen.find((e) => e.type === 'subagent_end' && e.taskId === bStart!.taskId);
    assert.ok(bEnd, 'B COMPLETED while A still holds the only slot — no deadlock');
    assert.equal(bEnd!.ok, true);

    releaseSlow();
    const resA = await runA;
    assert.ok(resA.ok);
    const resB = await runB;
    assert.ok(resB.ok);
  } finally {
    rmSync(ws, { recursive: true, force: true });
  }
});

test('F06-10: queue wait is not loop time — restartClock resets the wall-clock budget', () => {
  const b = new Budget({ maxIterations: 0, maxWallClockSec: 10 }, 'mock', PRICE, 1_000);
  assert.equal(b.checkSpending(11_001), 'budget', '10s+ after the original start → over the wall clock');
  b.restartClock(11_000); // admission after a long queue wait
  assert.equal(b.checkSpending(11_001), null, '1ms into the new window — the queue wait is not charged');
  const snap = b.snapshot(12_000);
  assert.ok(Math.abs(snap.elapsedSec - 1) < 0.01, `elapsed reports from admission, got ${snap.elapsedSec}s`);
});

test('F06-10: the panel counts queued agents separately from running ones', () => {
  const mk = (over: Partial<SubAgentView>): SubAgentView => ({
    taskId: 't',
    subagentType: 'explorer',
    toolUseCount: 0,
    inputTokens: 0,
    outputTokens: 0,
    startedAt: 1,
    background: false,
    ...over,
  });
  const lines = renderSubAgentPanel([mk({ taskId: 'a' }), mk({ taskId: 'b', queued: true })], 1, 8);
  assert.equal(lines.length, 1);
  assert.ok(lines[0]!.detail.includes('1 agent'), `running count excludes the queued agent: "${lines[0]!.detail}"`);
  assert.ok(lines[0]!.detail.includes('1 queued'), `the queued agent is still visible: "${lines[0]!.detail}"`);
  assert.ok(!lines[0]!.detail.includes('2 agents'), 'queued must not inflate the running count');
  assert.equal(lines[0]!.running, true, 'queued work keeps the panel live');
});

test('F06-09: a hook that slams stdin or fails to spawn cannot crash the session', async () => {
  const ws = mkdtempSync(join(tmpdir(), 'pf-hookguard-'));
  try {
    // (a) closes its stdin before the payload write lands → EPIPE on the stream must be swallowed
    const stdinSlammer = join(ws, 'slam.sh');
    writeFileSync(stdinSlammer, '#!/bin/sh\nexec 0<&-\nexit 0\n');
    chmodSync(stdinSlammer, 0o755);
    runHookPhaseDetached('session_start', [stdinSlammer], { workspaceRoot: ws, sessionId: 'pin' });
    // (b) a cwd that does not exist → spawn fails ASYNC via the 'error' event; unhandled, that is
    // an uncaught exception at session start. The handler must swallow it.
    runHookPhaseDetached('session_start', ['/bin/true'], {
      workspaceRoot: '/nonexistent/shadow-pin-cwd',
      sessionId: 'pin',
    });
    // Both failure modes surface on later ticks — give them time to fire. Surviving IS the assert:
    // an unhandled 'error' event would take the whole test process down with it.
    await new Promise((r) => setTimeout(r, 200));
    assert.ok(true, 'neither hook failure mode crashed the session');
  } finally {
    rmSync(ws, { recursive: true, force: true });
  }
});
