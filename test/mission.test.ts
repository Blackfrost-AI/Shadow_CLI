// MissionState + mission/plan tools (Sprint 3 item 3.2, Package 6) — pure state
// machine, persistence tail-scan, and the two tool seams. No loop wiring here.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MissionState, MISSION_TASK_LIMIT, readMissionSnapshot } from '../src/agent/mission.js';
import { PlanModeState } from '../src/agent/planMode.js';
import { makePlanWriteTool, makeMissionUpdateTool } from '../src/tools/index.js';
import type { ToolContext } from '../src/tools/types.js';

function tmpWorkspace(): string {
  return mkdtempSync(join(tmpdir(), 'mission-'));
}

function ctx(ws: string, nestedAgent = false): ToolContext {
  return {
    workspaceRoot: ws,
    signal: new AbortController().signal,
    log: () => {},
    dryRun: false,
    nestedAgent,
  };
}

test('begin starts a planning-phase mission', () => {
  const m = new MissionState();
  const snap = m.begin('ship the retry fix');
  assert.equal(snap.active, true);
  assert.equal(snap.mission, 'ship the retry fix');
  assert.equal(snap.phase, 'planning');
  assert.deepEqual(snap.tasks, []);
  assert.ok(!snap.planPath);
});

test('clear deactivates and block() goes empty', () => {
  const m = new MissionState();
  m.begin('ship it');
  assert.ok(m.block().includes('## Mission'));
  m.clear();
  assert.equal(m.active, false);
  assert.equal(m.block(), '');
});

test('block() is empty before any mission', () => {
  assert.equal(new MissionState().block(), '');
});

test('onPlanApproved seeds tasks and moves to executing', () => {
  const m = new MissionState();
  m.begin('add feature X');
  const snap = m.onPlanApproved({ title: 'X plan', path: '/w/plans/x.md', tasks: ['write tests', 'implement', 'document'] });
  assert.equal(snap.phase, 'executing');
  assert.equal(snap.planPath, '/w/plans/x.md');
  assert.deepEqual(
    snap.tasks.map((t) => [t.id, t.subject, t.status]),
    [
      ['m-1', 'write tests', 'pending'],
      ['m-2', 'implement', 'pending'],
      ['m-3', 'document', 'pending'],
    ],
  );
});

test('onPlanApproved is inert without an active mission', () => {
  const m = new MissionState();
  const snap = m.onPlanApproved({ tasks: ['a'] });
  assert.equal(snap.active, false);
  assert.deepEqual(snap.tasks, []);
});

test('onPlanApproved with no tasks is a phase-only mission', () => {
  const m = new MissionState();
  m.begin('fix the flake');
  const snap = m.onPlanApproved({ path: '/w/plans/f.md' });
  assert.equal(snap.phase, 'executing');
  assert.deepEqual(snap.tasks, []);
  assert.ok(m.block().includes('phase-only'));
});

test('onPlanApproved caps tasks at MISSION_TASK_LIMIT', () => {
  const m = new MissionState();
  m.begin('big');
  const snap = m.onPlanApproved({ tasks: Array.from({ length: 40 }, (_, i) => `t${i + 1}`) });
  assert.equal(snap.tasks.length, MISSION_TASK_LIMIT);
  assert.equal(snap.tasks[MISSION_TASK_LIMIT - 1]!.subject, `t${MISSION_TASK_LIMIT}`);
});

test('updateTasks applies patches, keeps detail fresh, ignores unknown ids', () => {
  const m = new MissionState();
  m.begin('x');
  m.onPlanApproved({ tasks: ['a', 'b'] });
  m.updateTasks([
    { id: 'm-1', status: 'done', detail: 'tests green' },
    { id: 'm-9', status: 'done' }, // unknown — ignored
  ]);
  let snap = m.snapshot();
  assert.equal(snap.tasks[0]!.status, 'done');
  assert.equal(snap.tasks[0]!.detail, 'tests green');
  assert.equal(snap.tasks[1]!.status, 'pending');

  // a later status change without detail drops the stale evidence line
  m.updateTasks([{ id: 'm-1', status: 'in_progress' }]);
  snap = m.snapshot();
  assert.equal(snap.tasks[0]!.status, 'in_progress');
  assert.ok(!snap.tasks[0]!.detail);

  // invalid status values are dropped at the state seam
  m.updateTasks([{ id: 'm-2', status: 'bogus' as never }]);
  assert.equal(m.snapshot().tasks[1]!.status, 'pending');
});

test('setPhase advances forward but never re-enters planning', () => {
  const m = new MissionState();
  m.begin('x');
  m.onPlanApproved({ tasks: ['a'] });
  assert.equal(m.setPhase('verifying').phase, 'verifying');
  assert.equal(m.setPhase('done').phase, 'done');
  assert.equal(m.setPhase('planning').phase, 'done'); // refused
  const idle = new MissionState();
  assert.equal(idle.setPhase('executing').active, false); // inert when inactive
});

test('block() carries phase-specific instructions', () => {
  const m = new MissionState();
  m.begin('ship the retry fix');
  const planning = m.block();
  assert.ok(planning.includes('plan_write'));
  assert.ok(planning.includes('PLANNING'));
  m.onPlanApproved({ tasks: ['a', 'b'] });
  assert.ok(m.block().includes('EXECUTING'));
  m.setPhase('verifying');
  assert.ok(m.block().includes('VERIFYING'));
  m.setPhase('done');
  const doneBlock = m.block();
  assert.ok(doneBlock.includes('DONE'));
  assert.ok(doneBlock.includes('honestly'));
});

test('block() truncates long missions and caps rendered tasks at 12', () => {
  const m = new MissionState();
  m.begin('x'.repeat(1_000));
  m.onPlanApproved({ tasks: Array.from({ length: 16 }, (_, i) => `task ${i + 1}`) });
  const block = m.block();
  assert.ok(!block.includes('x'.repeat(500))); // truncated well below the raw text
  assert.ok(block.includes('task 12'));
  assert.ok(!block.includes('task 13'));
  assert.ok(block.includes('(+4 more'));
});

test('listeners fire on mutation and unsubscribe cleanly', () => {
  const m = new MissionState();
  let count = 0;
  const off = m.onUpdate(() => count++);
  m.begin('x');
  m.setPhase('executing');
  off();
  m.clear();
  assert.equal(count, 2);
});

// ── readMissionSnapshot (JSONL tail scan) ─────────────────────────────────────

test('readMissionSnapshot returns the LAST mission record', () => {
  const ws = tmpWorkspace();
  const log = join(ws, 's.jsonl');
  writeFileSync(
    log,
    [
      JSON.stringify({ ts: 't1', kind: 'event', type: 'mission', mission: { active: true, mission: 'old goal', phase: 'planning', tasks: [] } }),
      JSON.stringify({ ts: 't2', kind: 'event', type: 'text', delta: 'noise' }),
      JSON.stringify({ ts: 't3', kind: 'event', type: 'mission', mission: { active: true, mission: 'new goal', phase: 'executing', tasks: [{ id: 'm-1', subject: 'a', status: 'done' }], planPath: '/w/plans/n.md' } }),
      '',
    ].join('\n'),
  );
  const snap = readMissionSnapshot(log);
  assert.ok(snap);
  assert.equal(snap.mission, 'new goal');
  assert.equal(snap.phase, 'executing');
  assert.equal(snap.tasks.length, 1);
  assert.equal(snap.planPath, '/w/plans/n.md');
  rmSync(ws, { recursive: true, force: true });
});

test('readMissionSnapshot: absent file, malformed lines, and cleared missions all yield null', () => {
  const ws = tmpWorkspace();
  assert.equal(readMissionSnapshot(join(ws, 'nope.jsonl')), null);

  const torn = join(ws, 'torn.jsonl');
  writeFileSync(torn, ['{"ts":"t1","kind":"eve', JSON.stringify({ ts: 't2', kind: 'event', type: 'mission', mission: 'not-an-object' }), ''].join('\n'));
  assert.equal(readMissionSnapshot(torn), null);

  const cleared = join(ws, 'cleared.jsonl');
  writeFileSync(
    cleared,
    [
      JSON.stringify({ ts: 't1', kind: 'event', type: 'mission', mission: { active: true, mission: 'g', phase: 'executing', tasks: [] } }),
      JSON.stringify({ ts: 't2', kind: 'event', type: 'mission', mission: { active: false, mission: '', phase: 'planning', tasks: [] } }),
      '',
    ].join('\n'),
  );
  assert.equal(readMissionSnapshot(cleared), null); // the clear wins — no stale rehydrate
  rmSync(ws, { recursive: true, force: true });
});

test('readMissionSnapshot scans only the tail — a mission older than 64 KiB of later records is gone', () => {
  const ws = tmpWorkspace();
  const log = join(ws, 'big.jsonl');
  const missionLine = JSON.stringify({ ts: 't1', kind: 'event', type: 'mission', mission: { active: true, mission: 'ancient', phase: 'executing', tasks: [] } });
  const filler = JSON.stringify({ ts: 't2', kind: 'event', type: 'text', delta: 'x'.repeat(2_000) });
  const fillers = Math.ceil((70 * 1024) / filler.length);
  writeFileSync(log, [missionLine, ...Array.from({ length: fillers }, () => filler), ''].join('\n'));
  assert.equal(readMissionSnapshot(log), null);
  rmSync(ws, { recursive: true, force: true });
});

// ── plan_write tasks + mission_update tool ────────────────────────────────────

test('plan_write stores tasks in the snapshot and renders checkboxes into the file', async () => {
  const ws = tmpWorkspace();
  const planMode = new PlanModeState(true);
  const tool = makePlanWriteTool(planMode);
  const res = await tool.run(
    { title: 'Retry Hardening', body: 'Wrap retries.', tasks: ['add backoff test', 'add jitter'] },
    ctx(ws),
  );
  assert.ok(res.ok);
  const snap = planMode.snapshot();
  assert.deepEqual(snap.tasks, ['add backoff test', 'add jitter']);
  const { readFileSync } = await import('node:fs');
  const body = readFileSync(join(ws, 'plans', 'retry-hardening.md'), 'utf8');
  assert.ok(body.includes('# Retry Hardening'));
  assert.ok(body.includes('- [ ] add backoff test'));
  assert.ok(body.includes('Wrap retries.'));
  void res;
  rmSync(ws, { recursive: true, force: true });
});

test('mission_update applies task + phase patches and reports the count', async () => {
  const ws = tmpWorkspace();
  const mission = new MissionState();
  mission.begin('ship it');
  mission.onPlanApproved({ tasks: ['a', 'b', 'c'] });
  const tool = makeMissionUpdateTool(mission);
  const res = await tool.run({ tasks: [{ id: 'm-1', status: 'done', detail: 'green' }, { id: 'm-2', status: 'in_progress' }], phase: 'verifying' }, ctx(ws));
  assert.ok(res.ok);
  assert.ok(res.ok && res.summary.includes('1/3 done'));
  assert.equal(mission.snapshot().phase, 'verifying');
  rmSync(ws, { recursive: true, force: true });
});

test('mission_update is inert for sub-agents and without an active mission', async () => {
  const ws = tmpWorkspace();
  const mission = new MissionState();
  const tool = makeMissionUpdateTool(mission);

  const inactive = await tool.run({ phase: 'done' }, ctx(ws));
  assert.ok(inactive.ok);
  assert.ok(inactive.ok && inactive.summary.includes('No active mission'));

  mission.begin('x');
  mission.onPlanApproved({ tasks: ['a'] });
  const nested = await tool.run({ tasks: [{ id: 'm-1', status: 'done' }] }, ctx(ws, true));
  assert.ok(nested.ok);
  assert.ok(nested.ok && nested.summary.includes('inert'));
  assert.equal(mission.snapshot().tasks[0]!.status, 'pending'); // untouched
  rmSync(ws, { recursive: true, force: true });
});

test('plan_write without tasks keeps PlanSnapshot.tasks absent', async () => {
  const ws = tmpWorkspace();
  mkdirSync(join(ws, 'plans'), { recursive: true });
  const planMode = new PlanModeState(true);
  await makePlanWriteTool(planMode).run({ title: 'Plain', body: 'b' }, ctx(ws));
  assert.ok(!planMode.snapshot().tasks);
  rmSync(ws, { recursive: true, force: true });
});
