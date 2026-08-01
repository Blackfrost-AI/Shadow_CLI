/**
 * Sub-agent event isolation.
 *
 * Sub-agents were handed the PARENT's bus, so everything they emitted was indistinguishable from
 * the parent's own output. Three verified defects came from that single wiring:
 *   - the sub-agent's `text`/`assistant_done` streamed into the parent transcript and rendered up
 *     to three times (live stream, commit, and again inside the tool result);
 *   - its per-turn `usage` overwrote the HUD with a foreign context %, and reset the parent's cost
 *     baseline so `/cost` reported nonsense;
 *   - its `stop`/`mode` made the parent look finished while it was still working.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventBus, SubagentBus, SUBAGENT_FORWARDED_EVENTS, type LoopEvent } from '../src/agent/events.js';

function collect(bus: EventBus): LoopEvent[] {
  const seen: LoopEvent[] = [];
  bus.on((e) => seen.push(e));
  return seen;
}

test('the sub-agent answer never reaches the parent bus (the triple-print bug)', () => {
  const parent = new EventBus();
  const seen = collect(parent);
  const sub = new SubagentBus(parent);

  sub.emit({ type: 'text', delta: 'partial answer ' });
  sub.emit({ type: 'text', delta: 'continues' });
  sub.emit({ type: 'assistant_done', text: 'partial answer continues' });

  assert.deepEqual(seen, [], 'no sub-agent answer text may appear in the parent transcript');
});

test("the sub-agent's usage never touches the parent HUD or cost baseline", () => {
  const parent = new EventBus();
  const seen = collect(parent);
  const sub = new SubagentBus(parent);

  sub.emit({ type: 'usage', inputTokens: 5_000, outputTokens: 900, costUSD: 0.42, contextPct: 87 });
  sub.emit({ type: 'latency', ms: 1234 });

  assert.deepEqual(seen, [], 'usage/latency are per-Budget and per-Context — they are not the parent’s');
});

test("the sub-agent's stop/mode cannot make the parent look finished", () => {
  const parent = new EventBus();
  const seen = collect(parent);
  const sub = new SubagentBus(parent);

  sub.emit({ type: 'mode', mode: 'idle' });
  sub.emit({ type: 'stop', reason: 'end_turn', finalAnswer: 'done' });

  assert.deepEqual(seen, [], 'the parent turn is still running — its own loop owns those events');
});

test('tool activity DOES reach the parent — the user must see what a sub-agent is doing', () => {
  const parent = new EventBus();
  const seen = collect(parent);
  const sub = new SubagentBus(parent);
  const call = { id: 'c1', name: 'run_shell', input: { command: 'ls' } };

  sub.emit({ type: 'tool_start', call, risk: 'read' });
  sub.emit({ type: 'tool_end', call, result: { ok: true, summary: 'ok', tool: 'run_shell', risk: 'read' } as never });
  sub.emit({ type: 'tool_denied', call, reason: 'denied by user' });
  sub.emit({ type: 'error', message: 'sub-agent blew up' });

  assert.deepEqual(
    seen.map((e) => e.type),
    ['tool_start', 'tool_end', 'tool_denied', 'error'],
    'tool lifecycle + failures stay visible',
  );
});

test('subagent_usage is forwarded so session cost stays honest', () => {
  const parent = new EventBus();
  const seen = collect(parent);
  const sub = new SubagentBus(parent);
  sub.emit({ type: 'subagent_usage', costUSD: 0.42, subagent: 'general-purpose' });
  assert.deepEqual(seen, [{ type: 'subagent_usage', costUSD: 0.42, subagent: 'general-purpose' }]);
});

test('a local subscriber on the sub-agent bus still sees everything', () => {
  // Forwarding is a parent-facing filter, not a mute: the sub-agent loop itself must be observable.
  const parent = new EventBus();
  const sub = new SubagentBus(parent);
  const local = collect(sub);
  sub.emit({ type: 'text', delta: 'hi' });
  sub.emit({ type: 'stop', reason: 'end_turn', finalAnswer: 'hi' });
  assert.deepEqual(local.map((e) => e.type), ['text', 'stop']);
});

test('the forward list is a deliberate whitelist, not an accidental blacklist', () => {
  // Named explicitly so ADDING an event type to events.ts defaults to NOT leaking into the parent.
  assert.deepEqual(
    [...SUBAGENT_FORWARDED_EVENTS].sort(),
    ['error', 'subagent_usage', 'task_notification', 'tool_denied', 'tool_end', 'tool_start'],
  );
});

test('BUG 3: sub-agent tool events are tagged with the taskId so the parent UI can route them to the panel, never the parent live row', () => {
  // Provenance is the mechanism that stops a delegated agent's tool activity from clobbering the
  // parent's single activeTool slot (the original bug). When SubagentBus is built with meta, the
  // forwarded tool lifecycle carries `subagent: <taskId>`; the UI must not treat it as the parent's.
  const parent = new EventBus();
  const seen = collect(parent);
  const sub = new SubagentBus(parent, undefined, { subagent: 'agent_123_sync' });
  const call = { id: 'c1', name: 'read_file', input: { path: 'a.ts' } };

  sub.emit({ type: 'tool_start', call, risk: 'read' });
  sub.emit({ type: 'tool_end', call, result: { ok: true, summary: 'ok', tool: 'read_file', risk: 'read' } as never });
  sub.emit({ type: 'tool_denied', call, reason: 'denied' });
  // non-tool forwarded events must NOT gain a stray subagent tag (they don't route to the panel)
  sub.emit({ type: 'error', message: 'boom' });
  sub.emit({ type: 'subagent_usage', costUSD: 0.1, subagent: 'explore' });

  assert.equal(seen.length, 5);
  assert.equal((seen[0] as { subagent?: string }).subagent, 'agent_123_sync', 'tool_start tagged');
  assert.equal((seen[1] as { subagent?: string }).subagent, 'agent_123_sync', 'tool_end tagged');
  assert.equal((seen[2] as { subagent?: string }).subagent, 'agent_123_sync', 'tool_denied tagged');
  assert.equal('subagent' in seen[3], false, 'error carries no panel tag');
  assert.deepEqual(seen[4], { type: 'subagent_usage', costUSD: 0.1, subagent: 'explore' });
});

test('BUG 3: a SubagentBus without meta forwards tool events untagged (backward compatible)', () => {
  const parent = new EventBus();
  const seen = collect(parent);
  const sub = new SubagentBus(parent); // no meta — existing call sites unaffected
  const call = { id: 'c1', name: 'read_file', input: { path: 'a.ts' } };
  sub.emit({ type: 'tool_start', call, risk: 'read' });
  assert.equal('subagent' in seen[0], false, 'no meta → no provenance tag');
});
