import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ToolResult } from '../src/tools/types.js';
import type { Budget } from '../src/agent/budget.js';
import type { TuiOpts } from '../src/tui.js';
import { isolateHome, assertStoreIsolated } from './helpers/isolateHome.js';

const isolated = isolateHome('project-work-ui');
process.env.SHADOW_ALLOW_IMPORT = '0';
const globals = await import('../src/state/globalStore.js');
assertStoreIsolated(globals.GLOBAL_DIR, isolated.home);
const { ShadowApp } = await import('../src/app/app.js');
const { JobStore } = await import('../src/state/jobStore.js');
const { loadConfig } = await import('../src/config.js');
const { TextViewer } = await import('../src/app/textViewer.js');
const { WorkBrowser } = await import('../src/app/workBrowser.js');
const { WorkCenter } = await import('../src/app/workCenter.js');
const { EventBus } = await import('../src/agent/events.js');
const { TodoList } = await import('../src/agent/todo.js');
const { makeTodoTool } = await import('../src/tools/todo.js');
const { terminalCommandsFor } = await import('../src/tui/commandCatalog.js');
after(() => rmSync(isolated.home, { recursive: true, force: true }));

type Overlay = { handleInput(data: string): void; render(width: number): string[] };
function fixture(t: { after(fn: () => void): void }) {
  const root = mkdtempSync(join(tmpdir(), 'shadow-jobs-ui-'));
  const store = new JobStore(root);
  // Windows cannot unlink the database while SQLite still owns its file handles.
  // TestContext after hooks run in registration order, so keep teardown ordered here.
  t.after(() => { store.close(); rmSync(root, { recursive: true, force: true }); });
  const lines: Array<{ text?: string }> = [];
  let overlay: Overlay;
  let draft = '';
  const calls: Array<{ name: string; input: Record<string, unknown>; signal: AbortSignal; budget: Budget }> = [];
  const app = Object.assign(Object.create(ShadowApp.prototype), {
    opts: { workspaceRoot: root, cfg: loadConfig(root, { provider: 'mock', model: 'mock' }),
      runNativeTool: async (name: string, input: Record<string, unknown>, signal: AbortSignal, budget: Budget): Promise<ToolResult> => {
        calls.push({ name, input, signal, budget });
        const attempt = store.claimAttempt(String(input.job_id));
        store.finishAttempt(String(input.job_id), attempt.ownerToken, { status: 'completed', answer: 'Fixture result' });
        return { ok: true, summary: 'Fixture result', data: { answer: 'Fixture result' } } as ToolResult;
      },
    },
    running: false, compacting: false, modelChecking: false, exiting: false,
    current: { model: 'mock', provider: 'mock' }, gate: { approve: async () => 'allow' },
    editor: { setText: (value: string) => { draft = value; } }, terminal: { rows: 30 },
    tui: { showOverlay: (value: Overlay) => { overlay = value; return { hide() {} }; }, setFocus() {}, requestRender() {} },
    commitBrandLine() {}, startTicker() {}, hudState() { return {}; },
    pushLine: (line: { text?: string }) => lines.push(line),
    endTurn() { app.running = false; },
  }) as { runSlash(raw: string): void; runPreparedJob(id: string): Promise<void>; running: boolean; opts: TuiOpts };
  return { root, store, app, calls, lines, overlay: () => overlay, draft: () => draft };
}

test('persistent job retry is prepared without execution, and explicit start passes exact stored input through native guards', async (t) => {
  const f = fixture(t);
  const job = f.store.createJob({ prompt: 'Fix only fixture.ts', profile: 'Reviewer', subagent_type: 'reviewer', priority: 'low', isolation: 'none' });
  const first = f.store.claimAttempt(job.id);
  f.store.finishAttempt(job.id, first.ownerToken, { status: 'interrupted', answer: 'Partial evidence', stopReason: 'owner_process_exited' });
  f.app.runSlash(`/jobs retry ${job.id} preserve the fixture`);
  assert.equal(f.store.get(job.id)?.status, 'pending');
  assert.equal(f.calls.length, 0, 'preparation and browsing cannot replay work');
  assert.equal(f.store.get(job.id)?.attempts.length, 1);
  assert.match(f.overlay().render(120).join('\n'), /Start prepared attempt/);
  const recorded = f.store.get(job.id)!.input;
  await f.app.runPreparedJob(job.id);
  assert.equal(f.calls.length, 1);
  assert.equal(f.calls[0]!.name, 'agent');
  assert.deepEqual(f.calls[0]!.input, { ...recorded, job_id: job.id });
  assert.ok(f.calls[0]!.signal instanceof AbortSignal);
  assert.ok(f.calls[0]!.budget);
  assert.equal(f.store.get(job.id)?.attempts[1]?.retryOf, first.id);
  assert.equal(f.store.get(job.id)?.acceptance.status, 'unverified', 'model completion is not acceptance');
});

test('blocked job shows dependency evidence and refuses native launch until accepted', async (t) => {
  const f = fixture(t);
  const prerequisite = f.store.createJob({ prompt: 'Prepare fixture' });
  const job = f.store.createJob({ prompt: 'Review fixture' }, { dependencies: [prerequisite.id] });
  f.app.runSlash(`/jobs show ${job.id}`);
  assert.match(f.overlay().render(140).join('\n'), /Inspect dependency blockers/);
  assert.doesNotMatch(f.overlay().render(140).join('\n'), /Start prepared attempt/);
  await f.app.runPreparedJob(job.id);
  assert.equal(f.calls.length, 0);
  assert.match(f.lines.map((line) => line.text).join('\n'), /Job blocked by/);
  assert.equal(f.store.get(job.id)?.status, 'pending');
});

test('consultation retry restores its conversation through followUp and retains the prepared job id', async (t) => {
  const f = fixture(t);
  const job = f.store.createJob({ prompt: 'Review the recorded scope', subagent_type: 'reviewer', profile: 'Review', consultation_id: 'consult_fixture' });
  const followups: unknown[][] = [];
  f.app.opts.consultations = { followUp: async (...args: unknown[]) => { followups.push(args); return { answer: 'Reviewed' }; } } as never;
  await f.app.runPreparedJob(job.id);
  assert.equal(f.calls.length, 0, 'the generic runner cannot bypass consultation ownership');
  assert.equal(followups[0]![0], 'consult_fixture');
  assert.equal(followups[0]![1], job.input.prompt);
  assert.equal((followups[0]![2] as { jobId: string }).jobId, job.id);
});

test('room posts and replies persist locally, respect recipients, and advance unread only explicitly', (t) => {
  const f = fixture(t);
  const first = f.store.postMessage({ room: 'project', from: 'reviewer', to: 'lead', body: 'Please check the fixture.' });
  f.store.postMessage({ room: 'project', from: 'reviewer', to: 'other-worker', body: 'Hidden directed note.' });
  f.app.runSlash('/room unread project');
  assert.match(f.overlay().render(120).join('\n'), /Please check/);
  assert.doesNotMatch(f.overlay().render(120).join('\n'), /Hidden directed/);
  assert.equal(f.store.readMessages('project', 'lead', { unread: true }).length, 1, 'merely opening the picker does not mark unseen bodies read');
  f.app.runSlash(`/room reply project ${first.id} I checked the fixture`);
  const reply = f.store.readMessages('project', 'reviewer').find((message) => message.replyTo === first.id);
  assert.equal(reply?.from, 'lead');
  assert.equal(reply?.to, 'reviewer');
  assert.equal(reply?.body, 'I checked the fixture');
  const rendered = f.overlay().render(120).join('\n');
  assert.match(rendered, /Mark through/);
  // Two visible messages followed by Write, Browse unread, and Mark through.
  f.overlay().handleInput('5'); f.overlay().handleInput('\r');
  assert.equal(f.store.readMessages('project', 'lead', { unread: true }).length, 0);
  f.app.runSlash('/room to project coder please inspect fixture.ts');
  assert.equal(f.store.readMessages('project', 'coder').at(-1)?.body, 'please inspect fixture.ts');
  const reopened = new JobStore(f.root);
  try { assert.ok(reopened.readMessages('project', 'coder').some((message) => message.from === 'lead')); }
  finally { reopened.close(); }
});

test('job cancellation includes pending descendants and recorded evidence display is inert, wrapped, and redacted', (t) => {
  const f = fixture(t);
  const parent = f.store.createJob({ prompt: 'parent' });
  const child = f.store.createJob({ prompt: 'child' }, { parentId: parent.id });
  f.app.runSlash(`/jobs cancel ${parent.id}`);
  assert.equal(f.store.get(parent.id)?.status, 'cancelled');
  assert.equal(f.store.get(child.id)?.status, 'cancelled');
  assert.equal(f.calls.length, 0);
  const viewer = new TextViewer({ title: 'Evidence', text: '\x1b]2;spoof\x07\n' + 'word '.repeat(50), rows: () => 20, close() {}, repaint() {} });
  const display = viewer.render(45).join('\n');
  assert.match(display, /\\x1b/);
  assert.ok(display.split('\n').filter((line) => line.includes('word')).length > 1, 'long evidence wraps instead of disappearing offscreen');
  assert.ok(terminalCommandsFor('pi').some((command) => command.name === '/jobs'));
  assert.ok(terminalCommandsFor('pi').some((command) => command.name === '/room'));
});

test('linked checklist tasks retain job identity across reorder and restart, and expose results without implying completion', async () => {
  const todos = new TodoList();
  const tool = makeTodoTool(todos);
  const bus = new EventBus();
  const work = new WorkCenter(); work.subscribe(bus);
  todos.onUpdate((items) => bus.emit({ type: 'todo', items }));
  await tool.run(tool.inputSchema.parse({ todos: [{ subject: 'Implement fixture', status: 'in_progress', jobId: 'job_fixture' }, { subject: 'Verify fixture', status: 'pending' }] }), {} as never);
  const [implement, verify] = todos.snapshot();
  const reordered = todos.write([{ id: verify!.id, subject: 'Verify fixture', status: 'pending' }, { id: implement!.id, subject: 'Implement revised fixture', status: 'in_progress' }]);
  assert.equal(reordered[1]!.jobId, 'job_fixture');
  assert.equal(reordered[0]!.jobId, undefined);
  bus.emit({ type: 'subagent_start', taskId: 'attempt_fixture', jobId: 'job_fixture', subagentType: 'general-purpose' });
  bus.emit({ type: 'subagent_end', taskId: 'attempt_fixture', jobId: 'job_fixture', ok: true, status: 'completed', answer: 'Implementation ready', artifactIds: ['artifact_fixture'] });
  const plan = work.get(`plan_${implement!.id}`)!;
  assert.equal(plan.status, 'running', 'worker completion cannot mark the checklist complete');
  assert.equal(plan.verification, 'unverified');
  assert.equal(plan.finalOutput, 'Implementation ready');
  assert.deepEqual(plan.artifactIds, ['artifact_fixture']);
  assert.equal(work.get(`plan_${verify!.id}`)?.artifactIds, undefined);
  bus.emit({ type: 'subagent_start', taskId: 'attempt_retry', jobId: 'job_fixture', subagentType: 'general-purpose' });
  work.syncTodos(todos.snapshot());
  assert.equal(plan.finalOutput, undefined, 'a prepared retry cannot retain an earlier attempt result as current evidence');
  assert.equal(plan.verification, 'unverified');
  let openedJob: string | undefined;
  const browser = new WorkBrowser({ items: () => [plan], rows: () => 30, repaint() {}, close() {}, command: () => '', artifacts() {}, job: (id) => { openedJob = id; } });
  browser.handleInput('\r'); browser.handleInput('a'); browser.handleInput('\r');
  assert.equal(openedJob, 'job_fixture');
  const restored = new TodoList(); restored.restore(todos.snapshot());
  assert.equal(restored.snapshot()[1]!.jobId, 'job_fixture');
  const replacement = restored.write([{ subject: 'Unrelated task', status: 'pending' }]);
  assert.notEqual(replacement[0]!.id, implement!.id);
  assert.equal(replacement[0]!.jobId, undefined, 'new tasks never inherit the previous positional ownership');
});
