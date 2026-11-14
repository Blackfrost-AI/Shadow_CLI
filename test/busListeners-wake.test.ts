// 11.6.0 WAKE — the notification → idle wake seam.
//
// attachBgAgentDelivery buffered task_notification events, but nothing connected completion to
// turn-start: an IDLE session never picked up a finished sub-agent's result. The seam now takes
// an optional onTerminal callback (wired in index.ts through wakeup.tryFire) and coalesces a
// batch of notifications into at most ONE wake per turn-end batch. These tests pin:
//   1. idle fire → startTurn, with the drained buffer carrying the real content,
//   2. mid-turn coalescing (N notifications → 1 queued wake) and re-arming after drain,
//   3. B1: EVERY status wakes — 'partial' (ceiling-truncated) above all — with no status filter,
//   4. rate-limited drops preserve the buffer and retry; visibility via onRateLimited,
//   5. the ordering invariant: a wake never injects mid-history (the original 400 bug),
//   6. latch mechanics: set-before-call (sync drain inside the callback), throw-safety,
//   7. structural pins on the production wiring (content-based, not line numbers).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { attachBgAgentDelivery, type PendingNotifications } from '../src/agent/busListeners.js';
import { EventBus } from '../src/agent/events.js';
import { Context } from '../src/agent/context.js';
import {
  WakeupScheduler,
  MAX_WAKEUPS_PER_WINDOW,
  WAKEUP_RATE_WINDOW_MS,
  type WakeupJob,
} from '../src/agent/wakeup.js';
import type { Message } from '../src/provider/provider.js';

/** The exact synthetic job index.ts fires — short line, real content rides in the drained buffer. */
const wakeJob = (): WakeupJob => ({
  id: 'bg-task-wake',
  delaySec: 0,
  reason: 'background task',
  task: 'pick up the task notification(s) and continue',
  at: 0,
});

/**
 * Minimal twin of the hosts' idle-safe fire (app.ts / tui.tsx / headless index.ts):
 * running → queue to turn-end; idle → startTurn. startTurn drains the notification buffer
 * BEFORE building the user text — the same wire contract as drainTurnInput.
 */
function makeHost(getPending: () => PendingNotifications) {
  const state = {
    running: false,
    queued: [] as string[],
    turns: [] as Array<{ line: string; text: string; drained: string[] }>,
  };
  const startTurn = (line: string): void => {
    state.running = true;
    const drained = getPending().drain();
    const text = drained.length ? `${drained.join('\n')}\n${line}` : line;
    state.turns.push({ line, text, drained });
  };
  const fire = (task: string, reason: string): void => {
    const line = `[wakeup: ${reason}] ${task}`;
    if (state.running) {
      state.queued.push(line);
      return;
    }
    startTurn(line);
  };
  const endTurn = (): void => {
    state.running = false;
    const next = state.queued.shift();
    if (next !== undefined) startTurn(next);
  };
  return { state, startTurn, fire, endTurn };
}

/** bus + context + real scheduler + host, wired exactly like index.ts. */
function makeRig() {
  const clockRef = { t: 1_000_000 };
  const bus = new EventBus();
  const ctx = new Context({ contextBudget: 100_000, triggerRatio: 0.75, keepLastTurns: 2 });
  const limited: WakeupJob[] = [];
  const scheduler = new WakeupScheduler({ now: () => clockRef.t, onRateLimited: (j) => limited.push(j) });
  const host = makeHost(() => pending);
  const pending = attachBgAgentDelivery(bus, ctx, () => scheduler.tryFire(wakeJob(), host.fire));
  return { bus, ctx, pending, host, scheduler, limited, clockRef };
}

test('idle session: a completion fires a wake turn that carries the drained notification', () => {
  const rig = makeRig();
  rig.bus.emit({ type: 'task_notification', taskId: 't1', answer: 'found the bug in parser.ts', status: 'completed' });
  assert.equal(rig.host.state.turns.length, 1, 'idle → startTurn, not a queued line');
  assert.equal(rig.host.state.queued.length, 0);
  const turn = rig.host.state.turns[0]!;
  assert.equal(turn.line, '[wakeup: background task] pick up the task notification(s) and continue');
  assert.match(turn.text, /task_id="t1"/);
  assert.match(turn.text, /found the bug in parser\.ts/);
  assert.ok(turn.text.endsWith(turn.line), 'the synthetic line is last — notifications prepend');
  assert.equal(rig.pending.size(), 0, 'the wake turn drained the buffer');
});

test('mid-turn: N notifications coalesce to ONE queued wake; the turn-end batch drains them all', () => {
  const rig = makeRig();
  rig.host.startTurn('human task'); // a turn is running
  rig.bus.emit({ type: 'task_notification', taskId: 'a', answer: 'A done', status: 'completed' });
  rig.bus.emit({ type: 'task_notification', taskId: 'b', answer: 'B truncated', status: 'partial', stopReason: 'max_iterations' });
  rig.bus.emit({ type: 'task_notification', taskId: 'c', answer: 'C failed', status: 'failed' });
  assert.equal(rig.host.state.queued.length, 1, 'exactly one queued wake for the batch');
  assert.equal(rig.host.state.turns.length, 1, 'no second turn started mid-turn');
  assert.equal(rig.pending.size(), 3, 'all three still buffered');

  rig.host.endTurn();
  assert.equal(rig.host.state.turns.length, 2, 'the queued wake ran at turn end');
  const wake = rig.host.state.turns[1]!;
  assert.equal(wake.drained.length, 3);
  for (const id of ['a', 'b', 'c']) assert.match(wake.text, new RegExp(`task_id="${id}"`));
  assert.equal(rig.host.state.queued.length, 0);
  rig.host.endTurn();
  assert.equal(rig.host.state.turns.length, 2, 'no further wakes');
});

test('notifications arriving DURING the wake turn arm exactly one fresh wake (latch resets on drain)', () => {
  const rig = makeRig();
  rig.host.startTurn('human task');
  rig.bus.emit({ type: 'task_notification', taskId: 'a', answer: 'A', status: 'completed' });
  rig.host.endTurn(); // wake turn 1 drains A and is now running
  assert.equal(rig.host.state.turns.length, 2);
  rig.bus.emit({ type: 'task_notification', taskId: 'b', answer: 'B', status: 'completed' });
  rig.bus.emit({ type: 'task_notification', taskId: 'c', answer: 'C', status: 'partial' });
  assert.equal(rig.host.state.queued.length, 1, 're-armed once, not per notification');
  rig.host.endTurn(); // wake turn 2 drains B + C
  assert.equal(rig.host.state.turns.length, 3);
  assert.equal(rig.host.state.turns[2]!.drained.length, 2);
  assert.equal(rig.host.state.queued.length, 0);
});

test('B1: EVERY terminal status wakes — completed, partial, failed, cancelled, and unset', () => {
  const statuses = ['completed', 'partial', 'failed', 'cancelled', undefined] as const;
  for (const status of statuses) {
    const rig = makeRig();
    rig.bus.emit({
      type: 'task_notification',
      taskId: `s-${status ?? 'unset'}`,
      answer: 'result body',
      ...(status ? { status } : {}),
      ...(status === 'partial' ? { stopReason: 'max_iterations' as const } : {}),
    });
    assert.equal(rig.host.state.turns.length, 1, `status ${status ?? '(unset)'} must wake an idle session`);
    const text = rig.host.state.turns[0]!.text;
    if (status) assert.match(text, new RegExp(`status="${status}"`));
    if (status === 'partial') assert.match(text, /stop_reason="max_iterations"/, 'partial keeps its stop reason visible');
  }
});

test('bg_agent_launched never wakes — launch is bookkeeping, not a terminal notification', () => {
  const rig = makeRig();
  rig.bus.emit({ type: 'bg_agent_launched', taskId: 'l1', prompt: 'do work', subagentType: 'explore' });
  assert.equal(rig.host.state.turns.length, 0);
  assert.equal(rig.host.state.queued.length, 0);
  assert.equal(rig.pending.size(), 0);
  assert.equal((rig.ctx as any)._subAgentTasks.length, 1, 'launch bookkeeping still recorded');
});

test('rate-limited drop preserves the buffer; later notifications retry; visibility fires', () => {
  const rig = makeRig();
  // Saturate the rolling window with unrelated fires (schedule_wakeup traffic).
  for (let i = 0; i < MAX_WAKEUPS_PER_WINDOW; i++) {
    assert.equal(rig.scheduler.tryFire({ ...wakeJob(), id: `fill-${i}` }, () => {}), true);
  }
  rig.bus.emit({ type: 'task_notification', taskId: 'r1', answer: 'first', status: 'completed' });
  assert.equal(rig.host.state.turns.length, 0, 'dropped wake did not start a turn');
  assert.equal(rig.pending.size(), 1, 'buffer intact after the drop');
  assert.equal(rig.limited.length, 1, 'drop surfaced via onRateLimited');
  assert.equal(rig.limited[0]!.reason, 'background task');

  // Latch stayed clear on refusal → the next notification retries (and is dropped again).
  rig.bus.emit({ type: 'task_notification', taskId: 'r2', answer: 'second', status: 'partial' });
  assert.equal(rig.limited.length, 2);
  assert.equal(rig.pending.size(), 2);

  // Window recycles → the next notification wakes and carries EVERYTHING that was dropped.
  rig.clockRef.t += WAKEUP_RATE_WINDOW_MS + 1;
  rig.bus.emit({ type: 'task_notification', taskId: 'r3', answer: 'third', status: 'completed' });
  assert.equal(rig.host.state.turns.length, 1);
  const text = rig.host.state.turns[0]!.text;
  for (const id of ['r1', 'r2', 'r3']) assert.match(text, new RegExp(`task_id="${id}"`), 'no dropped notification was lost');
  assert.equal(rig.pending.size(), 0);
});

test('batch-final notification after the ceiling is reached: coalesced into the queued wake, not lost', () => {
  const rig = makeRig();
  rig.host.startTurn('human task');
  // Leave exactly one slot: the first notification's wake consumes it, the ceiling is now full.
  for (let i = 0; i < MAX_WAKEUPS_PER_WINDOW - 1; i++) {
    rig.scheduler.tryFire({ ...wakeJob(), id: `fill-${i}` }, () => {});
  }
  rig.bus.emit({ type: 'task_notification', taskId: 'a', answer: 'A', status: 'completed' }); // accepted, queued
  rig.bus.emit({ type: 'task_notification', taskId: 'b', answer: 'B', status: 'partial' }); // ceiling full — but coalesced
  assert.equal(rig.host.state.queued.length, 1, 'no second wake queued');
  assert.equal(rig.pending.size(), 2, 'the batch-final notification still buffers');
  assert.equal(rig.limited.length, 0, 'coalesced notifications never attempt a fire — no quota burn, no drop');
  rig.host.endTurn();
  assert.equal(rig.host.state.turns.length, 2);
  assert.equal(rig.host.state.turns[1]!.drained.length, 2, 'the queued wake picked up both');
});

test('latch is set BEFORE the call: a synchronous drain inside the callback does not strand it', () => {
  const bus = new EventBus();
  const ctx = new Context({ contextBudget: 100_000, triggerRatio: 0.75, keepLastTurns: 2 });
  let calls = 0;
  const drained: string[][] = [];
  const pending = attachBgAgentDelivery(bus, ctx, () => {
    calls++;
    drained.push(pending.drain()); // host drains synchronously at turn start
    return true;
  });
  bus.emit({ type: 'task_notification', taskId: 'x1', answer: 'one', status: 'completed' });
  bus.emit({ type: 'task_notification', taskId: 'x2', answer: 'two', status: 'completed' });
  assert.equal(calls, 2, 'each idle notification wakes again — no stuck latch');
  assert.equal(drained[0]!.length, 1);
  assert.match(drained[1]![0]!, /task_id="x2"/, 'second drain carries only the second notification');
});

test('a throwing onTerminal never loses the notification; the latch recovers at the next drain', () => {
  const bus = new EventBus();
  const ctx = new Context({ contextBudget: 100_000, triggerRatio: 0.75, keepLastTurns: 2 });
  let calls = 0;
  let armed = true;
  const pending = attachBgAgentDelivery(bus, ctx, () => {
    calls++;
    if (armed) throw new Error('host fire exploded');
    return true;
  });
  // EventBus.emit swallows listener throws — the emit itself must not throw.
  bus.emit({ type: 'task_notification', taskId: 'e1', answer: 'survivor', status: 'failed' });
  assert.equal(pending.size(), 1, 'buffered before the callback ran');
  bus.emit({ type: 'task_notification', taskId: 'e2', answer: 'also survives', status: 'partial' });
  assert.equal(calls, 1, 'latch conservatively holds after a throw — no double-queue risk');
  assert.equal(pending.size(), 2);
  const drained = pending.drain();
  assert.equal(drained.length, 2, 'drain recovers everything');
  armed = false;
  bus.emit({ type: 'task_notification', taskId: 'e3', answer: 'recovered', status: 'completed' });
  assert.equal(calls, 2, 'latch cleared by drain — waking works again');
});

test('no callback: the original two-arg contract is unchanged (buffer only, never wakes)', () => {
  const bus = new EventBus();
  const ctx = new Context({ contextBudget: 100_000, triggerRatio: 0.75, keepLastTurns: 2 });
  const pending = attachBgAgentDelivery(bus, ctx);
  bus.emit({ type: 'task_notification', taskId: 'old', answer: 'legacy', status: 'completed' });
  assert.equal(pending.size(), 1);
  assert.match(pending.drain()[0]!, /task_id="old"/);
  assert.equal(pending.size(), 0);
});

test('ordering invariant: a mid-tool-window notification + wake never injects into live history', () => {
  const rig = makeRig();
  const toolUse: Message = { role: 'assistant', content: [{ type: 'tool_use', id: 'call-1', name: 'run_shell', input: {} }] } as Message;
  const toolResult: Message = { role: 'user', content: [{ type: 'tool_result', toolCallId: 'call-1', ok: true, content: 'ok' }] };
  rig.ctx.append(toolUse); // tools still running — the longest part of any turn
  rig.host.startTurn('human task'); // running: the wake can only QUEUE
  rig.bus.emit({ type: 'task_notification', taskId: 'bg-9', answer: 'done', status: 'partial' });
  assert.equal(rig.ctx.messages().length, 1, 'nothing appended to the live context');
  assert.equal(rig.host.state.queued.length, 1);
  rig.ctx.append(toolResult); // tool_result lands where it always would
  const msgs = rig.ctx.messages();
  assert.equal(msgs.length, 2);
  assert.equal(msgs[0]!.role, 'assistant');
  assert.equal(msgs[1]!.role, 'user');
  assert.equal((msgs[1]!.content[0] as any).type, 'tool_result', 'tool_use is followed IMMEDIATELY by its result');
  rig.host.endTurn(); // wake turn drains at its start — after the pair is complete
  assert.equal(rig.host.state.turns[1]!.drained.length, 1);
  assert.equal(rig.ctx.messages().length, 2, 'the seam itself never touches the context');
});

test('structural pin: index.ts routes the wake through wakeup.tryFire with a short synthetic line', () => {
  const src = readFileSync(new URL('../src/index.ts', import.meta.url), 'utf8');
  const attach = src.indexOf('attachBgAgentDelivery(bus, context,');
  assert.ok(attach !== -1, 'the attach site passes the onTerminal seam');
  const region = src.slice(attach, src.indexOf(');', attach));
  assert.ok(region.includes('wakeup.tryFire('), 'rate ceiling + onRateLimited reuse is mandatory');
  assert.ok(region.includes('wakeupHandler.fire(task, reason)'), 'fires through the idle-safe host handler');
  assert.ok(region.includes('pick up the task notification(s) and continue'), 'short synthetic wake line');
  assert.ok(!/status\s*===/.test(region), 'no status filtering in the wiring (B1)');
});

test('structural pin: the seam wakes on every task_notification and resets the latch on drain', () => {
  const src = readFileSync(new URL('../src/agent/busListeners.ts', import.meta.url), 'utf8');
  assert.ok(!/status\s*===/.test(src), 'no status filter anywhere in the seam (B1) — envelope attrs are not filters');
  const drainAt = src.indexOf('drain: () =>');
  assert.ok(drainAt !== -1);
  const drainBody = src.slice(drainAt, src.indexOf('},', drainAt));
  assert.ok(drainBody.includes('wakePending = false'), 'drain clears the coalescing latch');
  assert.ok(src.includes('if (!wakePending && onTerminal)'), 'latch gates the wake, not the buffering');
});

// ── G3 (integration review): one-shot headless must not abort its own queued wake ──

test('hasPending tracks scheduled timers: true while outstanding, false after fire/cancel/clear', () => {
  const scheduler = new WakeupScheduler({ now: () => 1_000_000 });
  assert.equal(scheduler.hasPending(), false);
  const fired: string[] = [];
  const job = scheduler.schedule(0, 'bg task', 'continue', (t) => fired.push(t)); // floored to 30s
  assert.equal(scheduler.hasPending(), true);
  assert.equal(scheduler.tryFire(job, (t) => fired.push(t)), true); // direct drive, like the seam
  assert.equal(scheduler.hasPending(), true, 'tryFire does not cancel the outstanding timer');
  assert.equal(scheduler.cancel(job.id), true);
  assert.equal(scheduler.hasPending(), false);
  scheduler.schedule(0, 'r', 't', () => {});
  scheduler.clear();
  assert.equal(scheduler.hasPending(), false);
});

test('G3 behavioral: a wake accepted during the LAST turn runs before the abort-all sweep', async () => {
  // Mirrors the headless finally contract: the grace loop drains accepted wakes BEFORE the
  // teardown sweep aborts controllers. Without the guard, the sweep kills the queued wake.
  const clockRef = { t: 1_000_000 };
  const bus = new EventBus();
  const ctx = new Context({ contextBudget: 100_000, triggerRatio: 0.75, keepLastTurns: 2 });
  const scheduler = new WakeupScheduler({ now: () => clockRef.t });
  let running = false;
  let aborted = 0;
  let queued = false;
  const turns: string[] = [];
  const fire = (task: string, reason: string): void => {
    if (running) { queued = true; return; } // host defers to turn end (buildAndRun queues on the lock)
    running = true;
    const drained = pending.drain();
    turns.push(`${drained.join('\n')}[wakeup: ${reason}] ${task}`);
    // the continuation turn finishes on a later tick, like a real provider turn
    void Promise.resolve().then(() => { running = false; });
  };
  const pending = attachBgAgentDelivery(bus, ctx, () => scheduler.tryFire(wakeJob(), fire));
  running = true; // the one-shot --task turn is in flight
  bus.emit({ type: 'task_notification', taskId: 'last', answer: 'partial work to finish', status: 'partial', stopReason: 'max_iterations' });
  assert.equal(turns.length, 0, 'mid-turn: the wake is accepted but not yet run');
  assert.equal(queued, true);
  assert.equal(pending.size(), 1);
  running = false; // the --task turn ended; dispatch the queued wake (turn-end batch)
  if (queued) { queued = false; fire('pick up the task notification(s) and continue', 'background task'); }
  // the finally-block guard, verbatim contract:
  const graceStart = Date.now();
  while ((scheduler.hasPending() || running) && Date.now() - graceStart < 2_000) {
    await new Promise((r) => setTimeout(r, 5));
  }
  const sweep = (): void => { aborted += 1; }; // stands in for liveControllers.abort()
  sweep();
  assert.equal(turns.length, 1, 'the wake turn RAN before the sweep');
  assert.match(turns[0]!, /partial work to finish/);
  assert.match(turns[0]!, /stop_reason="max_iterations"/);
  assert.equal(pending.size(), 0, 'buffer drained into the wake turn');
  assert.equal(aborted, 1);
  scheduler.clear();
});

test('G3 structural pin: headless finally waits for pending wakes BEFORE the abort sweep', () => {
  const src = readFileSync(new URL('../src/index.ts', import.meta.url), 'utf8');
  const guardAt = src.indexOf('wakeup.hasPending()');
  assert.ok(guardAt !== -1, 'the grace loop consults hasPending');
  const detachAt = src.indexOf('detach();', guardAt);
  const abortAt = src.indexOf('for (const controller of liveControllers) controller.abort();', guardAt);
  const clearAt = src.indexOf('wakeup.clear();', guardAt);
  assert.ok(detachAt !== -1 && abortAt !== -1 && clearAt !== -1);
  assert.ok(guardAt < detachAt && detachAt < abortAt && abortAt < clearAt,
    'order: grace loop → detach → abort-all → wakeup.clear (F04-09 teardown intact)');
  const region = src.slice(guardAt - 400, clearAt);
  assert.ok(region.includes('runLock.state().holder !== null'), 'also waits for an in-flight wake turn');
  assert.ok(/process\.exitCode !== 130/.test(region) && /process\.exitCode !== 143/.test(region),
    'Ctrl-C / SIGTERM still exit immediately');
  assert.ok(/WAKE_GRACE_MS/.test(region), 'the wait is bounded');
});