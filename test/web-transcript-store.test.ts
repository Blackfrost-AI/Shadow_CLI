import test from 'node:test';
import assert from 'node:assert/strict';
// The browser transcript model is dependency-free (its only import is the generated
// vendor/repeat.js), so it runs under node directly — no DOM, no jsdom.
import { createStore } from '../src/web/ui/transcriptStore.js';

// A fresh instance per test — the store is now a factory (one per session), not a singleton.
let store: ReturnType<typeof createStore>;

type Item = {
  kind: string;
  text?: string;
  streaming?: boolean;
  name?: string;
  status?: string;
  output?: string;
  diff?: unknown;
  summary?: string;
  truncated?: boolean;
};

const items = (): Item[] => store.snapshot() as unknown as Item[];
const kinds = (): string[] => items().map((i) => i.kind);
const assistants = (): Item[] => items().filter((i) => i.kind === 'assistant');

test.beforeEach(() => {
  store = createStore();
});

test('text deltas accumulate into ONE streaming item, not one per delta', () => {
  store.apply({ type: 'text', delta: 'Hello' });
  store.apply({ type: 'text', delta: ', ' });
  store.apply({ type: 'text', delta: 'world' });
  assert.equal(assistants().length, 1);
  assert.equal(assistants()[0]!.text, 'Hello, world');
  assert.equal(assistants()[0]!.streaming, true);
});

test('assistant_done matching the streamed text does not duplicate it', () => {
  // loop.ts emits assistant_done with the FULL turn text once per model iteration, so a
  // tool-using turn emits it several times. Naively appending prints the answer twice.
  store.apply({ type: 'text', delta: 'The answer is 42 and here is why.' });
  store.apply({ type: 'assistant_done', text: 'The answer is 42 and here is why.' });
  assert.equal(assistants().length, 1, 'streamed answer is kept once');
  assert.equal(assistants()[0]!.streaming, false, 'and is closed');
});

test('a verbatim repeat within the same turn is suppressed (weak local models)', () => {
  store.apply({ type: 'assistant_done', text: 'Here is a sufficiently long answer to dedupe.' });
  store.apply({ type: 'assistant_done', text: 'Here is a sufficiently long answer to dedupe.' });
  assert.equal(assistants().length, 1, 'the repeat is dropped');
});

test('repeat detection is turn-scoped: the same short answer in a LATER turn still shows', () => {
  const answer = 'Done — the migration completed successfully.';
  store.apply({ type: 'assistant_done', text: answer });
  store.apply({ type: 'stop', reason: 'end_turn', finalAnswer: answer });
  store.apply({ type: 'assistant_done', text: answer });
  assert.equal(assistants().length, 2, 'a genuine identical answer in a new turn is not eaten');
});

test('a DIFFERENT answer is never suppressed', () => {
  store.apply({ type: 'assistant_done', text: 'First distinct answer, long enough to count.' });
  store.apply({ type: 'assistant_done', text: 'Second distinct answer, long enough to count.' });
  assert.equal(assistants().length, 2);
});

test('tool lifecycle: start → running, end → ok with the server-computed diff attached', () => {
  store.apply({ type: 'tool_start', call: { id: 'c1', name: 'edit_file', args: {} }, risk: 'write' });
  let tool = items().find((i) => i.kind === 'tool')!;
  assert.equal(tool.status, 'running');

  store.apply({
    type: 'tool_end',
    call: { id: 'c1', name: 'edit_file', args: {} },
    result: {
      ok: true,
      summary: 'edited 1 file',
      meta: { tool: 'edit_file', durationMs: 12, risk: 'write', diff: [{ tag: '+', text: 'new line' }] },
    },
  });
  tool = items().find((i) => i.kind === 'tool')!;
  assert.equal(tool.status, 'ok');
  assert.equal(tool.summary, 'edited 1 file');
  assert.deepEqual(tool.diff, [{ tag: '+', text: 'new line' }]);
});

test('shell_output is routed to its own tool by callId', () => {
  store.apply({ type: 'tool_start', call: { id: 'a', name: 'run_shell', args: {} }, risk: 'exec' });
  store.apply({ type: 'tool_start', call: { id: 'b', name: 'run_shell', args: {} }, risk: 'exec' });
  store.apply({ type: 'shell_output', callId: 'a', stream: 'stdout', chunk: 'from-a' });
  store.apply({ type: 'shell_output', callId: 'b', stream: 'stdout', chunk: 'from-b' });

  const tools = items().filter((i) => i.kind === 'tool');
  assert.equal(tools[0]!.output, 'from-a');
  assert.equal(tools[1]!.output, 'from-b');
});

test('a denied tool is shown as denied, not as a failure', () => {
  store.apply({ type: 'tool_start', call: { id: 'c1', name: 'run_shell', args: {} }, risk: 'exec' });
  store.apply({ type: 'tool_denied', call: { id: 'c1', name: 'run_shell', args: {} }, reason: 'user declined' });
  const tool = items().find((i) => i.kind === 'tool')!;
  assert.equal(tool.status, 'denied');
  assert.equal(tool.summary, 'user declined');
});

test('per-tool output is bounded so a build cannot grow the page without limit', () => {
  store.apply({ type: 'tool_start', call: { id: 'c1', name: 'run_shell', args: {} }, risk: 'exec' });
  for (let i = 0; i < 40; i++) {
    store.apply({ type: 'shell_output', callId: 'c1', stream: 'stdout', chunk: 'x'.repeat(10_000) });
  }
  const tool = items().find((i) => i.kind === 'tool')!;
  assert.ok(tool.output!.length <= 200_000, `output bounded (${tool.output!.length})`);
  assert.equal(tool.truncated, true, 'and the truncation is disclosed');
});

test('the item list is bounded and says so rather than silently losing history', () => {
  for (let i = 0; i < 700; i++) store.apply({ type: 'error', message: `err ${i}` });
  assert.ok(items().length <= 501, `item count bounded (${items().length})`);
  assert.equal(items()[0]!.kind, 'trimmed', 'the top marks that history was trimmed');
});

test('an unknown event type surfaces instead of vanishing', () => {
  store.apply({ type: 'some_future_event', payload: 1 } as never);
  assert.ok(
    items().some((i) => i.kind === 'status' && i.text?.includes('some_future_event')),
    'a new event type is visible, not silently dropped',
  );
});

test('usage and latency go to the HUD, not the transcript', () => {
  store.apply({ type: 'usage', inputTokens: 10, outputTokens: 20, costUSD: 0.5, contextPct: 12 });
  store.apply({ type: 'latency', ms: 250 });
  assert.deepEqual(kinds(), [], 'no transcript rows for HUD-only events');
  const hud = store.hudState() as { usage: { inputTokens: number } | null; latencyMs: number | null };
  assert.equal(hud.usage!.inputTokens, 10);
  assert.equal(hud.latencyMs, 250);
});

test('hydrate replaces state so a reconnect does not double the transcript', () => {
  store.apply({ type: 'text', delta: 'stale' });
  store.hydrate([
    { type: 'text', delta: 'fresh' },
    { type: 'assistant_done', text: 'fresh' },
  ]);
  assert.equal(assistants().length, 1);
  assert.equal(assistants()[0]!.text, 'fresh');
});

test('subscribers are notified on apply', () => {
  let calls = 0;
  const off = store.subscribe(() => calls++);
  store.apply({ type: 'text', delta: 'x' });
  store.apply({ type: 'text', delta: 'y' });
  off();
  store.apply({ type: 'text', delta: 'z' });
  assert.equal(calls, 2, 'notified while subscribed, silent after unsubscribe');
});

test('a user turn is recorded so the mirror shows the question, not just the answer', () => {
  store.apply({ type: 'user', text: 'Write a haiku about diffs' });
  store.apply({ type: 'text', delta: 'Here it is.' });
  const ks = kinds();
  assert.deepEqual(ks, ['user', 'assistant']);
  assert.equal(items()[0]!.text, 'Write a haiku about diffs');
});

test('a new user turn closes the previous answer and resets repeat detection', () => {
  const answer = 'Done — the migration completed successfully.';
  store.apply({ type: 'user', text: 'first question' });
  store.apply({ type: 'assistant_done', text: answer });
  store.apply({ type: 'user', text: 'second question' });
  store.apply({ type: 'assistant_done', text: answer });
  // Same answer to a different question is legitimate and must not be deduped away.
  assert.equal(assistants().length, 2);
  assert.equal(items().filter((i) => i.kind === 'user').length, 2);
});
