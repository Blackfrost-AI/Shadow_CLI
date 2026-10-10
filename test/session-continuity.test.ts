import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync, appendFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Context } from '../src/agent/context.js';
import { MissionState } from '../src/agent/mission.js';
import { PlanModeState } from '../src/agent/planMode.js';
import { TodoList } from '../src/agent/todo.js';
import { WorkCenter } from '../src/app/workCenter.js';
import { SessionLog } from '../src/state/session.js';
import { captureSessionState, restoreSessionState } from '../src/state/sessionState.js';
import { resumeSession, resolveSessionMatches, trustLegacySession } from '../src/state/resume.js';
import { sessionReplay, HISTORICAL_OUTPUT_UNAVAILABLE } from '../src/state/sessionReplay.js';
import { previewRewind, rewindToTurn } from '../src/state/rewind.js';
import { saveCheckpoint, saveCheckpointAbsent } from '../src/state/checkpoints.js';
import type { Message } from '../src/provider/provider.js';

const options = { contextBudget: 10_000, triggerRatio: 0.75, keepLastTurns: 4 };
const owners = () => ({ mission: new MissionState(), planMode: new PlanModeState(), todoList: new TodoList(), workCenter: new WorkCenter() });

test('restart restores one versioned context/mission/plan/task/work bundle and never revives workers', () => {
  const root = mkdtempSync(join(tmpdir(), 'shadow-continuity-'));
  const log = SessionLog.open(root);
  try {
    const source = owners();
    source.mission.begin('Ship fixture');
    source.planMode.recordPlan('Fixture', 'plan.md', ['Implement', 'Verify']);
    source.mission.onPlanApproved(source.planMode.snapshot());
    source.planMode.exit({ approved: true });
    source.mission.updateTasks([{ id: 'm-1', status: 'done', detail: 'fixture changed' }]);
    source.todoList.restore([{ id: 'todo-7', subject: 'Verify', status: 'in_progress' }]);
    source.workCenter.restore({ version: 1, capturedAt: 1, items: [{ id: 'worker-1', type: 'subagent', status: 'running', description: 'Verify', owner: 'todo-7', depth: 1, startedAt: 1, lastActivityAt: 2, activities: [] }] }, false);
    const context = new Context(options);
    context.append({ role: 'user', content: [{ type: 'text', text: 'Continue fixture' }] });
    log.bindSessionState(context, () => captureSessionState(source));
    log.recordSnapshot(context, 0);
    source.mission.setPhase('verifying');
    context.append({ role: 'assistant', content: [{ type: 'text', text: 'Checking' }] });
    log.recordSnapshot(context, 1);
    // A child shares the log but cannot become the main session's latest context.
    const child = new Context(options);
    child.append({ role: 'user', content: [{ type: 'text', text: 'private child prompt' }] });
    log.recordSnapshot(child, 22);
    log.close();
    // A torn latest record leaves the previous coherent bundle recoverable; the explicit legacy
    // receipt authenticates the complete file, including that inert torn tail.
    appendFileSync(log.path, '{"kind":"context_snapshot","data":');
    const bindingsDir = join(root, 'owner-bindings');
    trustLegacySession(log.path, { bindingsDir });
    const resumed = resumeSession(log.path, { ...options, bindingsDir });
    assert.equal(resumed.context.messages().length, 2);
    assert.equal(resumed.meta.turn, 1);
    assert.equal(resumed.state.version, 1);
    const target = owners();
    restoreSessionState(target, resumed.state);
    assert.equal(target.mission.snapshot().phase, 'verifying');
    assert.equal(target.mission.snapshot().tasks[0]?.status, 'done');
    assert.deepEqual(target.planMode.snapshot(), source.planMode.snapshot());
    assert.equal(target.planMode.consumeUnapprovedExit(), null);
    assert.deepEqual(target.todoList.snapshot(), source.todoList.snapshot());
    assert.equal(target.workCenter.get('worker-1')?.owner, 'todo-7');
    assert.equal(target.workCenter.get('worker-1')?.status, 'interrupted');
    assert.equal(SessionLog.countSnapshots(log.path), 2);
    assert.equal(resumed.state.mission.phase, 'verifying');
  } finally { log.close(); rmSync(root, { recursive: true, force: true }); }
});

test('inactive restoration clears the previous session and preserves plan mode without approval', () => {
  const target = owners();
  target.mission.begin('Old mission');
  target.todoList.write([{ subject: 'Old task', status: 'pending' }]);
  target.planMode.recordPlan('Old plan', 'old.md');
  const state = captureSessionState({});
  state.plan = { mode: 'planning', title: 'New plan', path: 'new.md', tasks: ['Read'] };
  restoreSessionState(target, state);
  assert.equal(target.mission.active, false);
  assert.deepEqual(target.todoList.snapshot(), []);
  assert.equal(target.planMode.active, true);
  assert.equal(target.planMode.consumeUnapprovedExit(), null);
  const copy = target.planMode.snapshot();
  copy.tasks?.push('Mutation');
  assert.deepEqual(target.planMode.snapshot().tasks, ['Read']);
});

test('session state carries the immutable harness package identity and digest', () => {
  const harness = {
    foundation: { id: 'shadow-security', version: '1', digest: 'foundation-digest' },
    addons: [{ id: 'incident-response', version: '1.0.0', digest: 'addon-digest' }],
    digest: 'stack-digest',
  };
  const state = captureSessionState({ harness });
  assert.deepEqual(state.harness, harness);
  harness.addons[0]!.id = 'mutated';
  assert.equal(state.harness?.addons[0]?.id, 'incident-response');
});

test('legacy journals recover recorded plan/tasks and respect a later mission clear', () => {
  const root = mkdtempSync(join(tmpdir(), 'shadow-legacy-continuity-'));
  const log = SessionLog.open(root);
  try {
    const mission = new MissionState();
    log.recordEvent({ type: 'mission', mission: mission.begin('Earlier mission') });
    log.recordEvent({ type: 'plan_mode', plan: { mode: 'planning', path: 'old-plan.md', tasks: ['Finish'] } });
    log.recordEvent({ type: 'todo', items: [{ id: 'todo-9', subject: 'Finish', status: 'pending' }] });
    log.recordEvent({ type: 'mission', mission: mission.clear() });
    const context = new Context(options);
    context.append({ role: 'user', content: [{ type: 'text', text: 'Resume' }] });
    log.recordSnapshot(context, 0);
    const bindingsDir = join(root, 'owner-bindings');
    trustLegacySession(log.path, { bindingsDir });
    const resumed = resumeSession(log.path, { ...options, bindingsDir });
    assert.equal(resumed.state.mission.active, false);
    assert.equal(resumed.state.plan.path, 'old-plan.md');
    assert.equal(resumed.state.todos[0]?.id, 'todo-9');
  } finally { log.close(); rmSync(root, { recursive: true, force: true }); }
});

test('resume name matching preserves ambiguity and prefers exact identities/titles', () => {
  const sessions = [
    { id: '2026-a', path: '/sessions/2026-a.jsonl', ts: '', title: 'Tops' },
    { id: '2026-b', path: '/sessions/2026-b.jsonl', ts: '', title: 'Tops' },
    { id: '2026-c', path: '/sessions/2026-c.jsonl', ts: '', title: 'Tops review' },
  ];
  assert.deepEqual(resolveSessionMatches(sessions, 'TOPS').map((item) => item.id), ['2026-a', '2026-b']);
  assert.deepEqual(resolveSessionMatches(sessions, '2026-b'), [sessions[1]]);
  assert.deepEqual(resolveSessionMatches(sessions, 'review'), [sessions[2]]);
  assert.deepEqual(resolveSessionMatches(sessions, 'absent'), []);
});

test('chronological tool replay is bounded, redacted and explicit about unavailable output', () => {
  const messages: Message[] = [
    { role: 'user', content: [{ type: 'text', text: 'Inspect fixture' }] },
    { role: 'assistant', content: [{ type: 'text', text: 'Reading' }, { type: 'tool_use', id: 'r1', name: 'read_file', input: { path: 'file.txt' } }] },
    { role: 'user', content: [{ type: 'tool_result', toolCallId: 'r1', ok: true, content: `API_KEY=fixturesecretvalue\n${'a'.repeat(15_000)}` }, { type: 'text', text: 'model-only result note' }] },
    { role: 'assistant', content: [{ type: 'tool_use', id: 'r2', name: 'read_file', input: {} }] },
    { role: 'user', content: [{ type: 'tool_result', toolCallId: 'r2', ok: true, content: '[Old tool result content cleared]' }] },
    { role: 'assistant', content: [{ type: 'tool_use', id: 'r3', name: 'read_file', input: {} }] },
  ];
  const replay = sessionReplay(messages);
  assert.deepEqual(replay.map((item) => item.kind), ['user', 'assistant', 'tool', 'tool', 'tool']);
  const tools = replay.filter((item) => item.kind === 'tool');
  assert.equal(tools[0]?.call.name, 'read_file');
  assert.ok(!tools[0]?.result.data.stdout.includes('fixturesecretvalue'));
  assert.ok(tools[0]!.result.data.stdout.length < 12_100);
  assert.match(tools[0]!.result.data.stdout, /Historical display truncated/);
  assert.equal(tools[1]?.result.summary, HISTORICAL_OUTPUT_UNAVAILABLE);
  assert.equal(tools[2]?.unavailable, true);
});

test('rewind preview names restore/delete targets without mutating files and returns matching control state', () => {
  const root = mkdtempSync(join(tmpdir(), 'shadow-rewind-preview-'));
  const log = SessionLog.open(root);
  try {
    const source = owners();
    source.planMode.recordPlan('Plan', 'plan.md', ['Read', 'Implement']);
    const context = new Context(options);
    context.append({ role: 'user', content: [{ type: 'text', text: 'First prompt' }] });
    log.bindSessionState(context, () => captureSessionState(source));
    log.recordSnapshot(context, 0);
    const id = SessionLog.sessionIdFromPath(log.path);
    saveCheckpoint(root, id, 0, 'file.txt', 'before');
    saveCheckpointAbsent(root, id, 0, 'new.txt');
    writeFileSync(join(root, 'file.txt'), 'after');
    writeFileSync(join(root, 'new.txt'), 'created');
    const preview = previewRewind(log.path, 0, root);
    assert.deepEqual(preview.paths, [{ path: 'file.txt', action: 'restore' }, { path: 'new.txt', action: 'delete' }]);
    assert.equal(readFileSync(join(root, 'file.txt'), 'utf8'), 'after');
    assert.equal(existsSync(join(root, 'new.txt')), true);
    assert.deepEqual(previewRewind(log.path, 0, root, 'chat').paths, []);
    const result = rewindToTurn(log.path, 0, root, { ...options, scope: 'chat' });
    assert.equal(result.sessionState?.plan.path, 'plan.md');
    assert.equal(existsSync(join(root, 'new.txt')), true);
  } finally { log.close(); rmSync(root, { recursive: true, force: true }); }
});
