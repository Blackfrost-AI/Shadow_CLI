/**
 * Phase A: Work Center core, terminal parity, and bounded completed history
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { WorkCenter } from '../src/app/workCenter.js';
import { EventBus } from '../src/agent/events.js';
import { BgRegistry } from '../src/tools/bgShell.js';
import { executeWorkCommand } from '../src/tui/workCommand.js';
import type { TodoItem } from '../src/agent/todo.js';

test('WorkCenter tracks subagent lifecycle', () => {
  const wc = new WorkCenter(50);
  const bus = new EventBus();
  wc.subscribe(bus);

  bus.emit({ type: 'subagent_start', taskId: 'agent_1', subagentType: 'test', description: 'Test task' });
  const item = wc.get('agent_1');
  assert.ok(item);
  assert.equal(item.type, 'subagent');
  assert.equal(item.status, 'running');

  bus.emit({ type: 'subagent_end', taskId: 'agent_1', ok: true });
  const completed = wc.get('agent_1');
  assert.equal(completed?.status, 'completed');
  assert.ok(completed?.endedAt);
});

test('WorkCenter tracks queued to running transition', () => {
  const wc = new WorkCenter();
  const bus = new EventBus();
  wc.subscribe(bus);

  bus.emit({ type: 'subagent_start', taskId: 'agent_2', subagentType: 'test', queued: true });
  assert.equal(wc.get('agent_2')?.status, 'queued');

  bus.emit({ type: 'subagent_start', taskId: 'agent_2', subagentType: 'test', queued: false });
  assert.equal(wc.get('agent_2')?.status, 'running');
});

test('WorkCenter tracks tool activity with bounded history', () => {
  const wc = new WorkCenter(50);
  const bus = new EventBus();
  wc.subscribe(bus);

  bus.emit({ type: 'subagent_start', taskId: 'agent_3', subagentType: 'test' });

  // Add 60 tool events (limit is 50)
  for (let i = 0; i < 60; i++) {
    bus.emit({
      type: 'tool_start',
      call: { id: `call_${i}`, name: 'test_tool', input: { arg: i } },
      risk: 'read',
      subagent: 'agent_3',
    });
  }

  const item = wc.get('agent_3');
  assert.ok(item);
  assert.ok(item.activities.length <= 50, `Expected ≤50 activities, got ${item.activities.length}`);
  assert.equal(item.toolCalls, 60);
});

test('WorkCenter tracks cancellation', () => {
  const wc = new WorkCenter();
  const bus = new EventBus();
  wc.subscribe(bus);

  bus.emit({ type: 'subagent_start', taskId: 'agent_4', subagentType: 'test' });
  bus.emit({ type: 'cancel_subagent', taskId: 'agent_4' });

  const item = wc.get('agent_4');
  assert.equal(item?.status, 'cancelled');
  assert.ok(item?.endedAt);
});

test('WorkCenter handles wildcard cancellation', () => {
  const wc = new WorkCenter();
  const bus = new EventBus();
  wc.subscribe(bus);

  bus.emit({ type: 'subagent_start', taskId: 'agent_5', subagentType: 'test' });
  bus.emit({ type: 'subagent_start', taskId: 'agent_6', subagentType: 'test' });
  bus.emit({ type: 'cancel_subagent', taskId: '*' });

  assert.equal(wc.get('agent_5')?.status, 'cancelled');
  assert.equal(wc.get('agent_6')?.status, 'cancelled');
});

test('WorkCenter syncs todos as plan work items', () => {
  const wc = new WorkCenter();
  const todos: TodoItem[] = [
    { id: 'todo-1', subject: 'Task 1', status: 'pending' },
    { id: 'todo-2', subject: 'Task 2', status: 'in_progress' },
    { id: 'todo-3', subject: 'Task 3', status: 'completed' },
  ];

  wc.syncTodos(todos);

  assert.equal(wc.get('plan_todo-1')?.status, 'queued');
  assert.equal(wc.get('plan_todo-2')?.status, 'running');
  assert.equal(wc.get('plan_todo-3')?.status, 'completed');
});

test('WorkCenter projects todo bus events on every renderer surface', () => {
  const wc = new WorkCenter();
  const bus = new EventBus();
  wc.subscribe(bus);
  bus.emit({ type: 'todo', items: [{ id: 'web-plan', subject: 'Shared plan', status: 'in_progress' }] });
  assert.equal(wc.get('plan_web-plan')?.status, 'running');
  assert.equal(wc.get('plan_web-plan')?.description, 'Shared plan');
});

test('WorkCenter removes stale plan items', () => {
  const wc = new WorkCenter();
  const todos1: TodoItem[] = [{ id: 'todo-1', subject: 'Task 1', status: 'pending' }];
  wc.syncTodos(todos1);
  assert.ok(wc.get('plan_todo-1'));

  wc.syncTodos([]);
  assert.equal(wc.get('plan_todo-1'), undefined);
});

test('WorkCenter filters by type', () => {
  const wc = new WorkCenter();
  const bus = new EventBus();
  const bgRegistry = new BgRegistry();
  wc.subscribe(bus);
  bgRegistry.attachWorkCenter(wc);

  bus.emit({ type: 'subagent_start', taskId: 'agent_1', subagentType: 'test', background: true });
  bus.emit({ type: 'subagent_end', taskId: 'agent_1', ok: true });
  bus.emit({ type: 'subagent_start', taskId: 'agent_2', subagentType: 'test' });
  wc.syncTodos([{ id: 'todo-1', subject: 'Task', status: 'pending' }]);

  const agents = wc.list({ type: 'subagent' });
  assert.equal(agents.length, 2);
  assert.ok(agents.every((i) => i.type === 'subagent'));
});

test('WorkCenter filters by status', () => {
  const wc = new WorkCenter();
  const bus = new EventBus();
  wc.subscribe(bus);

  bus.emit({ type: 'subagent_start', taskId: 'agent_1', subagentType: 'test' });
  bus.emit({ type: 'subagent_end', taskId: 'agent_1', ok: true });
  bus.emit({ type: 'subagent_start', taskId: 'agent_2', subagentType: 'test' });

  const completed = wc.list({ status: 'completed' });
  assert.ok(completed.length >= 1);
  assert.ok(completed.every((i) => i.status === 'completed'));
});

test('WorkCenter clears all work items', () => {
  const wc = new WorkCenter();
  const bus = new EventBus();
  const bgRegistry = new BgRegistry();
  wc.subscribe(bus);
  bgRegistry.attachWorkCenter(wc);

  bus.emit({ type: 'subagent_start', taskId: 'agent_1', subagentType: 'test' });
  wc.syncTodos([{ id: 'todo-1', subject: 'Task', status: 'pending' }]);

  assert.ok(wc.list().length > 0);
  wc.clear();
  assert.equal(wc.list().length, 0);
});

test('/work command lists work items', () => {
  const wc = new WorkCenter();
  const bus = new EventBus();
  const bgRegistry = new BgRegistry();
  wc.subscribe(bus);
  bgRegistry.attachWorkCenter(wc);

  bus.emit({ type: 'subagent_start', taskId: 'agent_1', subagentType: 'test', description: 'Test work' });
  const result = executeWorkCommand('', { workCenter: wc, bus, bgRegistry });

  assert.equal(result.kind, 'list');
  assert.ok(result.lines.length > 0);
  assert.ok(result.lines.some((l) => l.includes('agent_1')));
});

test('/work command shows detailed work item', () => {
  const wc = new WorkCenter();
  const bus = new EventBus();
  const bgRegistry = new BgRegistry();
  wc.subscribe(bus);
  bgRegistry.attachWorkCenter(wc);

  bus.emit({ type: 'subagent_start', taskId: 'agent_1', subagentType: 'test', description: 'Test work' });
  const result = executeWorkCommand('show agent_1', { workCenter: wc, bus, bgRegistry });

  assert.equal(result.kind, 'detail');
  assert.ok(result.lines.some((l) => l.includes('agent_1')));
  assert.ok(result.lines.some((l) => l.includes('subagent')));
});

test('/work command cancels subagent', () => {
  const wc = new WorkCenter();
  const bus = new EventBus();
  const bgRegistry = new BgRegistry();
  wc.subscribe(bus);
  bgRegistry.attachWorkCenter(wc);

  bus.emit({ type: 'subagent_start', taskId: 'agent_1', subagentType: 'test', background: true });

  let emitted = false;
  bus.on((e) => {
    if (e.type === 'cancel_subagent' && e.taskId === 'agent_1') emitted = true;
  });

  const result = executeWorkCommand('cancel agent_1', { workCenter: wc, bus, bgRegistry });
  assert.equal(result.kind, 'cancel');
  assert.ok(emitted);
});

test('/work refuses individual cancellation for a foreground subagent', () => {
  const wc = new WorkCenter();
  const bus = new EventBus();
  const bgRegistry = new BgRegistry();
  wc.subscribe(bus);
  bus.emit({ type: 'subagent_start', taskId: 'agent_fg', subagentType: 'test', background: false });
  const result = executeWorkCommand('cancel agent_fg', { workCenter: wc, bus, bgRegistry });
  assert.equal(result.kind, 'error');
  assert.match(result.error ?? '', /inspect-only/);
});

test('WorkCenter preserves nested ownership and never retains tool arguments', () => {
  const wc = new WorkCenter();
  const bus = new EventBus();
  wc.subscribe(bus);
  bus.emit({ type: 'subagent_start', taskId: 'parent', subagentType: 'test' });
  bus.emit({ type: 'subagent_start', taskId: 'child', subagentType: 'test', parentId: 'parent', depth: 1 });
  bus.emit({
    type: 'tool_start',
    call: { id: 'secret-call', name: 'run_shell', input: { apiKey: 'must-not-be-retained' } },
    risk: 'exec',
    subagent: 'child',
  });
  const child = wc.get('child');
  assert.equal(child?.owner, 'parent');
  assert.equal(child?.depth, 1);
  assert.equal(child?.activities[0]?.text, undefined);
});

test('/work command filters by type', () => {
  const wc = new WorkCenter();
  const bus = new EventBus();
  const bgRegistry = new BgRegistry();
  wc.subscribe(bus);
  bgRegistry.attachWorkCenter(wc);

  bus.emit({ type: 'subagent_start', taskId: 'agent_1', subagentType: 'test' });

  const result = executeWorkCommand('--type subagent', { workCenter: wc, bus, bgRegistry });
  assert.equal(result.kind, 'list');
  assert.ok(result.lines.some((l) => l.includes('agent_1')));
});

test('/work command returns error for unknown item', () => {
  const wc = new WorkCenter();
  const bus = new EventBus();
  const bgRegistry = new BgRegistry();

  const result = executeWorkCommand('show unknown_id', { workCenter: wc, bus, bgRegistry });
  assert.equal(result.kind, 'error');
  assert.ok(result.error?.includes('No work item found'));
});

test('WorkCenter respects SHADOW_WORK_TRANSCRIPT_LIMIT', () => {
  process.env.SHADOW_WORK_TRANSCRIPT_LIMIT = '10';
  const wc = new WorkCenter();
  const bus = new EventBus();
  wc.subscribe(bus);

  bus.emit({ type: 'subagent_start', taskId: 'agent_1', subagentType: 'test' });

  for (let i = 0; i < 20; i++) {
    bus.emit({
      type: 'tool_start',
      call: { id: `call_${i}`, name: 'test', input: {} },
      risk: 'read',
      subagent: 'agent_1',
    });
  }

  const item = wc.get('agent_1');
  assert.ok(item);
  assert.ok(item.activities.length <= 10);

  delete process.env.SHADOW_WORK_TRANSCRIPT_LIMIT;
});
