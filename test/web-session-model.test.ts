import test from 'node:test';
import assert from 'node:assert/strict';
// The browser session model is dependency-free apart from the generated vendor/repeat.js, so it
// runs under node directly — no DOM, no jsdom. This is the store behind the dsh-style console:
// rows, turns, approvals, queue and the stats projection all live here.
import { createSessionModel } from '../src/web/ui/sessionModel.js';

// A fresh instance per test — the model is a factory (one per mounted session).
let model: ReturnType<typeof createSessionModel>;

type Row = {
  kind: string;
  text?: string;
  streaming?: boolean;
  status?: string;
  name?: string;
  args?: Record<string, unknown> | null;
  output?: string;
  data?: unknown;
  diff?: unknown;
  summary?: string;
  truncated?: boolean;
  reason?: string | null;
  outcome?: string;
  stats?: Record<string, unknown>;
};

const rows = (): Row[] => model.snapshot().rows as unknown as Row[];
const kinds = (): string[] => rows().map((r) => r.kind);
const assistants = (): Row[] => rows().filter((r) => r.kind === 'assistant');
const tools = (): Row[] => rows().filter((r) => r.kind === 'tool');

test.beforeEach(() => {
  model = createSessionModel('test-session');
});

/* ------------------------------------------------------------------ rows -- */

test('text deltas accumulate into ONE streaming row, not one per delta', () => {
  model.apply({ type: 'text', delta: 'Hello' });
  model.apply({ type: 'text', delta: ', ' });
  model.apply({ type: 'text', delta: 'world' });
  assert.equal(assistants().length, 1);
  assert.equal(assistants()[0]!.text, 'Hello, world');
  assert.equal(assistants()[0]!.streaming, true);
});

test('assistant_done matching the streamed text does not duplicate it', () => {
  model.apply({ type: 'text', delta: 'The answer is 42 and here is why.' });
  model.apply({ type: 'assistant_done', text: 'The answer is 42 and here is why.' });
  assert.equal(assistants().length, 1, 'streamed answer is kept once');
  assert.equal(assistants()[0]!.streaming, false, 'and is closed');
});

test('a verbatim repeat within the same turn is suppressed (weak local models)', () => {
  model.apply({ type: 'assistant_done', text: 'Here is a sufficiently long answer to dedupe.' });
  model.apply({ type: 'assistant_done', text: 'Here is a sufficiently long answer to dedupe.' });
  assert.equal(assistants().length, 1, 'the repeat is dropped');
});

test('repeat detection is turn-scoped: the same answer in a LATER turn still shows', () => {
  const answer = 'Done — the migration completed successfully.';
  model.apply({ type: 'user', text: 'q1' });
  model.apply({ type: 'assistant_done', text: answer });
  model.apply({ type: 'stop', reason: 'end_turn', finalAnswer: answer });
  model.apply({ type: 'user', text: 'q2' });
  model.apply({ type: 'assistant_done', text: answer });
  assert.equal(assistants().length, 2, 'a genuine identical answer in a new turn is not eaten');
});

test('a DIFFERENT answer is never suppressed', () => {
  model.apply({ type: 'assistant_done', text: 'First distinct answer, long enough to count.' });
  model.apply({ type: 'assistant_done', text: 'Second distinct answer, long enough to count.' });
  assert.equal(assistants().length, 2);
});

test('thinking deltas become their own row and reasoning_done closes it', () => {
  model.apply({ type: 'thinking', delta: 'consider ' });
  model.apply({ type: 'thinking', delta: 'options' });
  const think = rows().find((r) => r.kind === 'think')!;
  assert.equal(think.text, 'consider options');
  assert.equal(think.streaming, true);
  model.apply({ type: 'reasoning_done', text: 'consider options' });
  assert.equal(rows().find((r) => r.kind === 'think')!.streaming, false);
});

/* ----------------------------------------------------------------- tools -- */

test('tool lifecycle: start → running with the wire `input` as args, end → ok + diff + data', () => {
  model.apply({ type: 'tool_start', call: { id: 'c1', name: 'edit_file', input: { path: 'a.ts' } }, risk: 'write' });
  let tool = tools()[0]!;
  assert.equal(tool.status, 'running');
  assert.deepEqual(tool.args, { path: 'a.ts' }, 'the ToolCall field on the wire is `input`');

  model.apply({
    type: 'tool_end',
    call: { id: 'c1', name: 'edit_file', input: { path: 'a.ts' } },
    result: {
      ok: true,
      summary: 'edited 1 file',
      data: { applied: 1 },
      meta: { tool: 'edit_file', durationMs: 12, risk: 'write', diff: [{ tag: '+', text: 'new line' }] },
    },
  });
  tool = tools()[0]!;
  assert.equal(tool.status, 'ok');
  assert.equal(tool.summary, 'edited 1 file');
  assert.deepEqual(tool.diff, [{ tag: '+', text: 'new line' }]);
  assert.deepEqual(tool.data, { applied: 1 }, 'structured payloads ride in .data, not meta');
});

test('shell_output is routed to its own tool by callId', () => {
  model.apply({ type: 'tool_start', call: { id: 'a', name: 'run_shell', input: {} }, risk: 'exec' });
  model.apply({ type: 'tool_start', call: { id: 'b', name: 'run_shell', input: {} }, risk: 'exec' });
  model.apply({ type: 'shell_output', callId: 'a', chunk: 'from-a' });
  model.apply({ type: 'shell_output', callId: 'b', chunk: 'from-b' });
  assert.equal(tools()[0]!.output, 'from-a');
  assert.equal(tools()[1]!.output, 'from-b');
});

test('a denied tool is shown as denied, not as a failure', () => {
  model.apply({ type: 'tool_start', call: { id: 'c1', name: 'run_shell', input: {} }, risk: 'exec' });
  model.apply({ type: 'tool_denied', call: { id: 'c1', name: 'run_shell', input: {} }, reason: 'user declined' });
  const tool = tools()[0]!;
  assert.equal(tool.status, 'denied');
  assert.equal(tool.summary, 'user declined');
});

test('per-tool output is bounded so a build cannot grow the page without limit', () => {
  model.apply({ type: 'tool_start', call: { id: 'c1', name: 'run_shell', input: {} }, risk: 'exec' });
  for (let i = 0; i < 40; i++) {
    model.apply({ type: 'shell_output', callId: 'c1', chunk: 'x'.repeat(10_000) });
  }
  const tool = tools()[0]!;
  assert.ok(tool.output!.length <= 200_000, `output bounded (${tool.output!.length})`);
  assert.equal(tool.truncated, true, 'and the truncation is disclosed');
});

/* -------------------------------------------------------------- bounds -- */

test('the row list is bounded and says so rather than silently losing history', () => {
  for (let i = 0; i < 700; i++) model.apply({ type: 'error', message: `err ${i}` });
  assert.ok(rows().length <= 501, `row count bounded (${rows().length})`);
  assert.equal(rows()[0]!.kind, 'trimmed', 'the top marks that history was trimmed');
});

test('an unknown event type surfaces instead of vanishing', () => {
  model.apply({ type: 'some_future_event', payload: 1 } as never);
  assert.ok(
    rows().some((r) => r.kind === 'status' && r.text?.includes('some_future_event')),
    'a new event type is visible, not silently dropped',
  );
});

/* --------------------------------------------------------------- turns -- */

test('usage→latency (the real wire order) pairs into per-request records; tok/s never fabricates decode time', () => {
  model.apply({ type: 'user', text: 'q' });
  // loop.ts emits `usage` from inside the stream loop and `latency` only in the stream's
  // finally — usage lands FIRST, and the latency event backfills the record usage pushed.
  model.apply({ type: 'usage', inputTokens: 100, outputTokens: 60, costUSD: 0.01, contextPct: 10, ttftMs: 500, iterInputTokens: 100, iterOutputTokens: 60 });
  model.apply({ type: 'latency', ms: 1500 });
  model.apply({ type: 'stop', reason: 'end_turn', finalAnswer: '' });

  const statsRow = rows().find((r) => r.kind === 'stats')!;
  const s = statsRow.stats as Record<string, number | null>;
  assert.equal(s.steps, 0);
  assert.equal(s.ttftMs, 500);
  // decode = 1500 − 500 = 1000ms for 60 tokens → 60 tok/s.
  assert.ok(Math.abs((s.tokPerSec as number) - 60) < 0.01, `tok/s from real decode time (${s.tokPerSec})`);

  // The reversed order (a provider that reports latency first) pairs via the pending slot.
  model.apply({ type: 'user', text: 'q1.5' });
  model.apply({ type: 'latency', ms: 900 });
  model.apply({ type: 'usage', inputTokens: 30, outputTokens: 30, ttftMs: 300, iterInputTokens: 30, iterOutputTokens: 30 });
  model.apply({ type: 'stop', reason: 'end_turn', finalAnswer: '' });
  const mid = [...rows()].reverse().find((r) => r.kind === 'stats')!;
  const ms = mid.stats as Record<string, number | null>;
  // decode = 900 − 300 = 600ms for 30 tokens → 50 tok/s.
  assert.ok(Math.abs((ms.tokPerSec as number) - 50) < 0.01, `reversed order pairs too (${ms.tokPerSec})`);

  // A request with NO measured latency contributes no decode time → no fabricated tok/s.
  model.apply({ type: 'user', text: 'q2' });
  model.apply({ type: 'usage', inputTokens: 1, outputTokens: 1, iterInputTokens: 1, iterOutputTokens: 1 });
  model.apply({ type: 'stop', reason: 'end_turn', finalAnswer: '' });
  const last = [...rows()].reverse().find((r) => r.kind === 'stats')!;
  assert.equal((last.stats as Record<string, unknown>).tokPerSec, null, 'no latency → no tok/s');
});

test('a denial that never saw tool_start still renders — the pre-execution gates emit before any start', () => {
  model.apply({ type: 'user', text: 'run it' });
  model.apply({ type: 'tool_denied', call: { id: 'd1', name: 'run_shell' }, reason: 'exec requires confirmation' });
  const denied = tools()[0]!;
  assert.equal(denied.status, 'denied');
  assert.match(denied.summary ?? '', /exec requires confirmation/);

  // An invalid-input tool_end (also emitted with no preceding start) owns its own row.
  model.apply({ type: 'tool_end', call: { id: 'd2', name: 'read_file' }, result: { ok: false, error: 'invalid path' } });
  const all = tools();
  assert.equal(all.length, 2, 'each orphan terminal event owns a row');
  assert.equal(all[1]!.status, 'error');
  assert.equal(all[1]!.name, 'read_file');
});

test('stop pushes the stats strip only when the turn did something', () => {
  model.apply({ type: 'user', text: 'q' });
  model.apply({ type: 'stop', reason: 'end_turn', finalAnswer: '' });
  assert.ok(!kinds().includes('stats'), 'an empty turn has no strip');
  assert.ok(kinds().includes('status'), 'and says it stopped');
});

test('abnormal stops are named even when a stats strip also lands', () => {
  model.apply({ type: 'user', text: 'q' });
  model.apply({ type: 'latency', ms: 10 });
  model.apply({ type: 'usage', inputTokens: 5, outputTokens: 5, iterInputTokens: 5, iterOutputTokens: 5 });
  model.apply({ type: 'stop', reason: 'interrupted', finalAnswer: '' });
  assert.ok(kinds().includes('stats'), 'the metrics still land');
  const status = rows().find((r) => r.kind === 'status')!;
  assert.match(status.text!, /interrupted/);
});

/* ------------------------------------------------------ docks + queue -- */

test('approval_request parks in the inbox until approval_resolved', () => {
  model.apply({
    type: 'approval_request',
    id: 'ap1',
    kind: 'run_shell',
    tool: 'run_shell',
    risk: 'exec',
    reason: 'exec requires confirmation',
  } as never);
  assert.equal(model.snapshot().approvals.length, 1);
  model.apply({ type: 'approval_resolved', id: 'ap1', outcome: 'answered' });
  assert.equal(model.snapshot().approvals.length, 0, 'resolved asks leave the inbox');
  const outcome = rows().find((r) => r.kind === 'approval_outcome')!;
  assert.equal(outcome.outcome, 'answered');
});

test('todo events replace the list; the queue is ordered and editable', () => {
  model.apply({ type: 'todo', items: [{ id: '1', subject: 'a', status: 'in_progress' }] } as never);
  assert.equal(model.snapshot().todo.length, 1);
  model.enqueue('first');
  model.enqueue('second');
  model.unqueue(0);
  assert.deepEqual(
    model.snapshot().queue.map((q: { text: string }) => q.text),
    ['second'],
  );
  assert.equal(model.dequeue()?.text, 'second');
  assert.equal(model.dequeue(), null, 'an empty queue drains to null');
});

/* ------------------------------------------------- user row handshake -- */

test('the optimistic user row collapses into the bus echo, not beside it', () => {
  model.addUserLocal('do the thing');
  assert.equal(rows().filter((r) => r.kind === 'user').length, 1);
  model.apply({ type: 'user', text: 'do the thing' });
  assert.equal(rows().filter((r) => r.kind === 'user').length, 1, 'one row after the echo');
  // The echo must ADOPT the turn the local add opened — close+reopen would count the first
  // prompt as two turns live while hydration (durable truth) says one.
  assert.equal(model.snapshot().session.turns, 1, 'no phantom pre-echo turn');
});

test('a bus echo with DIFFERENT text keeps both rows (the local row was not this turn)', () => {
  model.addUserLocal('typed locally');
  model.apply({ type: 'user', text: 'echoed from elsewhere' });
  assert.equal(rows().filter((r) => r.kind === 'user').length, 2);
});

/* --------------------------------------------------------- lifecycle -- */

test('hydrate replaces state so a reconnect does not double the transcript', () => {
  model.apply({ type: 'text', delta: 'stale' });
  model.hydrate([{ type: 'text', delta: 'fresh' }, { type: 'assistant_done', text: 'fresh' }]);
  assert.equal(assistants().length, 1);
  assert.equal(assistants()[0]!.text, 'fresh');
});

test('hydrate ending mid-turn keeps that turn open for the live events that follow', () => {
  // A refresh while the turn is still running server-side: the replay has no stop frame.
  model.hydrate([{ type: 'user', text: 'go' }, { type: 'text', delta: 'partial ans' }]);
  model.apply({ type: 'usage', inputTokens: 10, outputTokens: 5, iterInputTokens: 10, iterOutputTokens: 5 });
  model.apply({ type: 'latency', ms: 800 });
  model.apply({ type: 'tool_start', call: { id: 't1', name: 'run_shell' }, risk: 'exec' });
  model.apply({ type: 'tool_end', call: { id: 't1' }, result: { ok: true, summary: '', meta: { tool: 'run_shell', durationMs: 120 } } });
  model.apply({ type: 'stop', reason: 'end_turn', finalAnswer: '' });

  const statsRow = [...rows()].reverse().find((r) => r.kind === 'stats')!;
  const s = statsRow.stats as Record<string, number | null>;
  assert.equal(s.steps, 1, 'the tool accounted into the surviving turn');
  assert.equal(s.llmMs, 800, 'the latency accounted into the surviving turn');
  assert.ok(!kinds().includes('status'), 'no spurious "stopped" row before the real stop');
});

test('subscribers are notified on apply', () => {
  let calls = 0;
  const off = model.subscribe(() => calls++);
  model.apply({ type: 'text', delta: 'x' });
  model.apply({ type: 'text', delta: 'y' });
  off();
  model.apply({ type: 'text', delta: 'z' });
  assert.equal(calls, 2, 'notified while subscribed, silent after unsubscribe');
});

test('usage and latency land in the HUD without transcript rows of their own', () => {
  model.apply({ type: 'usage', inputTokens: 10, outputTokens: 20, costUSD: 0.5, contextPct: 12 });
  model.apply({ type: 'latency', ms: 250 });
  assert.deepEqual(kinds(), [], 'no transcript rows for HUD-only events');
  const hud = model.snapshot().hud as { usage: { inputTokens: number } | null; latencyMs: number | null };
  assert.equal(hud.usage!.inputTokens, 10);
  assert.equal(hud.latencyMs, 250);
});
