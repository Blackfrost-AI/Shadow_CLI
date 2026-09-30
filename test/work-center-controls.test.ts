import test from 'node:test';
import assert from 'node:assert/strict';
import { WorkCenter } from '../src/app/workCenter.js';
import { EventBus } from '../src/agent/events.js';
import { BgRegistry } from '../src/tools/bgShell.js';
import { executeWorkCommand } from '../src/tui/workCommand.js';
import { Semaphore } from '../src/util/semaphore.js';

test('pause/resume, priority, and retry require the safe states and explicit confirmation', () => {
  const center = new WorkCenter();
  const bus = new EventBus();
  const bg = new BgRegistry();
  center.subscribe(bus);
  bus.emit({ type: 'subagent_start', taskId: 'agent-1', subagentType: 'test', background: true, queued: true });
  bus.emit({ type: 'subagent_retryable', taskId: 'agent-1' });

  assert.equal(executeWorkCommand('priority agent-1 high', { workCenter: center, bus, bgRegistry: bg }).kind, 'priority');
  bus.emit({ type: 'subagent_start', taskId: 'agent-1', subagentType: 'test', background: true });
  assert.equal(executeWorkCommand('pause agent-1', { workCenter: center, bus, bgRegistry: bg }).kind, 'pause');
  bus.emit({ type: 'subagent_paused', taskId: 'agent-1' });
  assert.equal(executeWorkCommand('resume agent-1', { workCenter: center, bus, bgRegistry: bg }).kind, 'resume');
  bus.emit({ type: 'subagent_end', taskId: 'agent-1', ok: false });
  assert.match(executeWorkCommand('retry agent-1', { workCenter: center, bus, bgRegistry: bg }).error ?? '', /--confirm/);
  assert.equal(executeWorkCommand('retry agent-1 --confirm', { workCenter: center, bus, bgRegistry: bg }).kind, 'retry');
});

test('historical queries are filtered and remain read-only', () => {
  const center = new WorkCenter();
  const bus = new EventBus();
  const bg = new BgRegistry();
  const historical = [{
    sessionId: 'session-12345678',
    item: {
      id: 'old-agent', type: 'subagent' as const, status: 'completed' as const,
      description: 'historical', depth: 0, startedAt: 1, lastActivityAt: 2,
      activities: [{ timestamp: 2, type: 'tool' as const, tool: 'read_file', text: '/tmp/a.ts' }],
    },
  }];
  const list = executeWorkCommand('--all-sessions --tool read_file --file a.ts', { workCenter: center, bus, bgRegistry: bg, workHistory: () => historical });
  assert.ok(list.lines.some((line) => line.includes('old-agent')));
  const detail = executeWorkCommand('show old-agent --session 12345678', { workCenter: center, bus, bgRegistry: bg, workHistory: () => historical });
  assert.ok(detail.lines.some((line) => line.includes('read-only')));
  assert.equal(executeWorkCommand('cancel old-agent', { workCenter: center, bus, bgRegistry: bg, workHistory: () => historical }).kind, 'error');
});

test('priority semaphore admits high-priority queued work before earlier low-priority work', async () => {
  const sem = new Semaphore(1);
  const release = sem.tryAcquire();
  assert.ok(release);
  const order: string[] = [];
  const low = sem.acquire(undefined, { id: 'low', priority: 'low' }).then((done) => { order.push('low'); done(); });
  const high = sem.acquire(undefined, { id: 'high', priority: 'high' }).then((done) => { order.push('high'); done(); });
  release();
  await Promise.all([low, high]);
  assert.deepEqual(order, ['high', 'low']);
});
