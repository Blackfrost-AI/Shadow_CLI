// The TUI bg-drain fix (8.4): background sub-agent results accumulated in
// PendingNotifications forever in TUI sessions — only headless drained them. The fix
// drains at the TUI's turn-build seam (never mid-turn). These tests pin:
//   1. the helper's semantics (prepend, one-shot, passthrough),
//   2. the attach side (bus task_notification → queue → drain once),
//   3. the structural law: tui.tsx drains at exactly ONE seam, before the user message
//      is built — the invariant that keeps a notification from splitting an assistant
//      tool_use from its tool_result (permanent 400).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { drainTurnInput } from '../src/tui/turnInput.js';
import { attachBgAgentDelivery } from '../src/agent/busListeners.js';
import { EventBus } from '../src/agent/events.js';
import { Context } from '../src/agent/context.js';

test('drainTurnInput: notifications prepend, then the queue is empty (one-shot)', () => {
  const queue: string[] = ['[bg agent t1] result A', '[bg agent t2] result B'];
  const pending = { drain: () => queue.splice(0, queue.length), size: () => queue.length };
  assert.equal(drainTurnInput('next task', pending), '[bg agent t1] result A\n[bg agent t2] result B\nnext task');
  assert.deepEqual(pending.drain(), [], 'second drain yields nothing');
  assert.equal(drainTurnInput('after', pending), 'after', 'later turns pass through unchanged');
});

test('drainTurnInput: no pendingNotifications object is fine (older harnesses)', () => {
  assert.equal(drainTurnInput('task', undefined), 'task');
});

test('attachBgAgentDelivery → drain: a bus task_notification reaches the next turn exactly once', () => {
  const bus = new EventBus();
  const context = new Context({ contextBudget: 100_000, triggerRatio: 0.75, keepLastTurns: 2 });
  const pending = attachBgAgentDelivery(bus, context);

  bus.emit({ type: 'task_notification', taskId: 't9', answer: 'found the bug in parser.ts' });
  bus.emit({ type: 'task_notification', taskId: 't10', answer: 'tests pass after fix' });
  assert.equal(pending.size(), 2);

  const merged = drainTurnInput('continue the mission', pending);
  assert.ok(merged.includes('t9'));
  assert.ok(merged.includes('found the bug in parser.ts'));
  assert.ok(merged.endsWith('continue the mission'), 'task text still last — it reads as the user turn');
  assert.equal(pending.size(), 0, 'drained');
  // Non-notification events never enqueue.
  bus.emit({ type: 'tool_end', call: { id: 'x', name: 'read_file', input: {} }, result: { ok: true, summary: '', meta: { tool: 'read_file', durationMs: 1, risk: 'read' } } });
  assert.equal(pending.size(), 0);
});

test('tui.tsx drains at exactly ONE seam, before the user message is built', () => {
  const src = readFileSync(new URL('../src/tui.tsx', import.meta.url), 'utf8');
  const drains = src.match(/drainTurnInput\(|pendingNotifications\?\.drain\(\)/g) ?? [];
  assert.equal(drains.length, 1, `one drain call site in the TUI (found ${drains.length})`);
  const seam = src.indexOf('drainTurnInput(');
  const userMsg = src.indexOf('const userMsg: Message');
  const loopDeps = src.indexOf('const deps = buildLoopDeps({');
  assert.ok(seam !== -1 && userMsg !== -1 && loopDeps !== -1);
  assert.ok(seam < userMsg, 'drain happens BEFORE the user message is assembled');
  assert.ok(userMsg < loopDeps, 'the user message precedes the loop — ordering is the whole fix');
});

test('index.ts keeps the headless twin: drain at its turn seam (parity pin)', () => {
  const src = readFileSync(new URL('../src/index.ts', import.meta.url), 'utf8');
  assert.ok(src.includes('pendingNotifications.drain()'), 'headless still drains');
  assert.ok(src.includes('pendingNotifications,'), 'runTui receives the queue (the TUI side of the fix)');
});

test('turn build: the text block gates on taskText, not task — an image-only send keeps drained results', () => {
  // Regression pin (pre-deploy review F3): `task ? [text] : []` dropped drained bg-agent
  // results whenever the composer was empty and only an image was attached — the drain had
  // already emptied the queue, so the notification was lost silently. The seam must key on
  // the MERGED text (task + drained notes).
  const src = readFileSync(new URL('../src/tui.tsx', import.meta.url), 'utf8');
  assert.match(src, /taskText \? \[\{ type: 'text', text: taskText \}\] : \[\]/, 'content gates on the merged taskText');
  assert.doesNotMatch(src, /task \? \[\{ type: 'text', text: taskText \}\]/, 'the old task-gated form must not return');
});
