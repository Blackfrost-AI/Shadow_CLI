import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { z } from 'zod';
import { AgentLoop, type LoopDeps } from '../src/agent/loop.js';
import { CompletionGuard, completionAwaitsUser } from '../src/agent/completion.js';
import { Budget } from '../src/agent/budget.js';
import { Context } from '../src/agent/context.js';
import { EventBus, type LoopEvent } from '../src/agent/events.js';
import { TodoList } from '../src/agent/todo.js';
import { AutoApproveGate } from '../src/agent/approval.js';
import { MockProvider } from '../src/provider/mock.js';
import type { ProviderEvent } from '../src/provider/provider.js';
import { ToolRegistry } from '../src/tools/registry.js';
import { makeTodoTool } from '../src/tools/todo.js';
import { makeProjectChecksTool } from '../src/tools/projectChecks.js';
import { makeRunShell } from '../src/tools/runShell.js';
import { ok, type Tool } from '../src/tools/types.js';
import { ProjectCheckStore } from '../src/checks/store.js';
import { shellFixture } from './helpers/shellFixture.js';
import { printFixture } from './helpers/nativeShellFixture.js';

const answer = (text = 'Done.'): ProviderEvent[] => [{ type: 'text', delta: text }, { type: 'done', stopReason: 'end_turn' }];
const call = (name: string, input: unknown, id = 'call'): ProviderEvent[] => [{ type: 'tool_call', call: { name, id, input } }, { type: 'done', stopReason: 'tool_use' }];
const pending = [{ subject: 'Implement the fixture', status: 'in_progress' }];
function fixture(turns: ProviderEvent[][], extra: Partial<LoopDeps> = {}, tools: Tool[] = []) {
  const root = extra.workspaceRoot ?? mkdtempSync(join(tmpdir(), 'shadow-completion-'));
  const todos = extra.todoList ?? new TodoList();
  const registry = new ToolRegistry();
  registry.register(makeTodoTool(todos));
  for (const tool of tools) registry.register(tool);
  const context = new Context({ contextBudget: 100_000, triggerRatio: 0.9, keepLastTurns: 6 });
  context.pinTask({ role: 'user', content: [{ type: 'text', text: 'Implement and verify the fixture.' }] });
  const bus = new EventBus();
  const events: LoopEvent[] = [];
  bus.on((event) => events.push(event));
  const budget = new Budget({ maxIterations: 30 }, 'mock', {}, Date.now());
  const deps: LoopDeps = { provider: new MockProvider(turns), model: 'mock', registry, todoList: todos, gate: new AutoApproveGate(), bus, budget,
    context, workspaceRoot: root, signal: new AbortController().signal, system: 'fixture', maxOutputTokens: 1024,
    dryRun: false, maxToolResultChars: 16_384, contextBudget: 100_000, sleep: async () => {}, ...extra };
  return { root, deps, todos, events, registry, context, loop: new AgentLoop(deps, 'full') };
}

test('unfinished declared task gets one corrective turn and uses completed results once', async () => {
  let edits = 0;
  const edit: Tool = { name: 'fixture_write', description: 'fixture', risk: 'write', inputSchema: z.object({}), run: async () => { edits++; return ok('fixture_write', 'write', 1, 'written'); } };
  const f = fixture([call('todo_write', { todos: pending }), call('fixture_write', {}), answer('I will finish next.'), call('todo_write', { todos: [{ ...pending[0], status: 'completed' }] }), answer('Verified.')], {}, [edit]);
  try {
    const result = await f.loop.run();
    assert.equal(result.finalAnswer, 'Verified.');
    assert.equal(edits, 1);
    assert.equal(f.events.filter((event) => event.type === 'retry' && event.reason.startsWith('completion check:')).length, 1);
    assert.equal(f.events.filter((event) => event.type === 'stop').length, 1);
    assert.match(JSON.stringify(f.context.messages()), /explicit task evidence/);
  } finally { rmSync(f.root, { recursive: true, force: true }); }
});

test('ordinary answers and old todo lists finish without automatic continuation', async () => {
  const todos = new TodoList(); todos.write(pending as Parameters<TodoList['write']>[0]);
  const f = fixture([answer('Two plus two is four.')], { todoList: todos });
  try { assert.equal((await f.loop.run()).finalAnswer, 'Two plus two is four.'); assert.equal(f.events.filter((event) => event.type === 'retry').length, 0); }
  finally { rmSync(f.root, { recursive: true, force: true }); }
});

test('intentional user handoff does not continue an unfinished checklist', async () => {
  const f = fixture([call('todo_write', { todos: pending }), answer('Which fixture should I use?')]);
  try { assert.equal((await f.loop.run()).finalAnswer, 'Which fixture should I use?'); assert.equal(f.events.filter((event) => event.type === 'retry').length, 0); }
  finally { rmSync(f.root, { recursive: true, force: true }); }
  assert.equal(completionAwaitsUser('Please provide the missing file.'), true);
});

test('an explicit background-job task can outlive the main run without polling', async () => {
  const f = fixture([call('todo_write', { todos: [{ ...pending[0], jobId: 'job-123' }] }), answer('The background job is running.')]);
  try { assert.equal((await f.loop.run()).stopReason, 'end_turn'); assert.equal(f.events.filter((event) => event.type === 'retry').length, 0); }
  finally { rmSync(f.root, { recursive: true, force: true }); }
});

test('corrections are bounded at two and share the original iteration ceiling', async () => {
  const f = fixture([call('todo_write', { todos: pending }), answer(), answer(), answer()]);
  try { assert.equal((await f.loop.run()).stopReason, 'end_turn'); assert.equal(f.events.filter((event) => event.type === 'retry').length, 2); assert.ok(f.events.some((event) => event.type === 'finding' && event.title === 'Completion remains unverified')); }
  finally { rmSync(f.root, { recursive: true, force: true }); }
  const limited = fixture([call('todo_write', { todos: pending }), answer()], { budget: new Budget({ maxIterations: 2 }, 'mock', {}, Date.now()) });
  try { await limited.loop.run(); assert.equal(limited.events.filter((event) => event.type === 'retry').length, 0); assert.equal(limited.deps.budget.snapshot(Date.now()).iterations, 2); }
  finally { rmSync(limited.root, { recursive: true, force: true }); }
});

test('permission denial and cancellation cannot trigger a completion correction', async () => {
  const denied = fixture([call('todo_write', { todos: pending }), call('run_shell', { command: 'echo fixture' }), answer('Blocked.')], { permissionRules: [{ tool: 'run_shell', action: 'deny' }] }, [makeRunShell()]);
  try { await denied.loop.run(); assert.equal(denied.events.filter((event) => event.type === 'retry').length, 0); }
  finally { rmSync(denied.root, { recursive: true, force: true }); }
  const abort = new AbortController(); abort.abort();
  const cancelled = fixture([answer()], { signal: abort.signal });
  try { assert.equal((await cancelled.loop.run()).stopReason, 'interrupted'); assert.equal(cancelled.events.filter((event) => event.type === 'retry').length, 0); }
  finally { rmSync(cancelled.root, { recursive: true, force: true }); }
});

test('stop hook veto is bounded, sees attempt metadata, and is not fired twice at final stop', async () => {
  const root = mkdtempSync(join(tmpdir(), 'shadow-completion-hook-'));
  const script = join(root, 'stop.sh');
  const log = join(root, 'calls');
  const shellLog = log.replaceAll('\\', '/');
  writeFileSync(script, `#!/bin/sh\ncat >> '${shellLog}'\necho >> '${shellLog}'\necho '{"decision":"block","reason":"Missing fixture evidence"}'\n`); chmodSync(script, 0o755);
  const f = fixture([answer(), answer(), answer()], { workspaceRoot: root, hooks: { stop: [shellFixture(script)] } as LoopDeps['hooks'] });
  try { await f.loop.run(); assert.equal(f.events.filter((event) => event.type === 'retry').length, 2); const calls = readFileSync(log, 'utf8').trim().split('\n').map((line) => JSON.parse(line)); assert.deepEqual(calls.map((entry) => entry.extra.continuationAttempt), [0, 1, 2]); }
  finally { rmSync(root, { recursive: true, force: true }); }
});

test('crashed stop hooks report failure without requesting more model output', async () => {
  const root = mkdtempSync(join(tmpdir(), 'shadow-completion-hook-'));
  const script = join(root, 'stop.sh'); writeFileSync(script, '#!/bin/sh\nexit 2\n'); chmodSync(script, 0o755);
  const f = fixture([answer()], { workspaceRoot: root, hooks: { stop: [shellFixture(script)] } as LoopDeps['hooks'] });
  try { await f.loop.run(); assert.equal(f.events.filter((event) => event.type === 'retry').length, 0); assert.ok(f.events.some((event) => event.type === 'finding' && event.title === 'Completion hook failed')); }
  finally { rmSync(root, { recursive: true, force: true }); }
});

test('check profiles run through shell rules and actual results become local evidence', async () => {
  const root = mkdtempSync(join(tmpdir(), 'shadow-project-checks-'));
  const store = new ProjectCheckStore(root);
  store.saveProfiles({ version: 1, profiles: [{ id: 'typecheck', title: 'Typecheck fixture', command: printFixture('fixture') }] });
  const f = fixture([], { workspaceRoot: root, checks: store }, [makeProjectChecksTool(store), makeRunShell()]);
  try {
    const result = await f.loop.runToolCall({ id: 'check-1', name: 'project_checks', input: { action: 'run', id: 'typecheck' } });
    assert.equal(result.ok, true); assert.equal(store.snapshot()[0]!.status, 'passed');
    const run = store.history()[0]!; assert.equal(run.stdout, 'fixture'); assert.equal(store.getRun(run.id)?.exitCode, 0);
    assert.ok(f.events.some((event) => event.type === 'tool_start' && event.call.name === 'run_shell' && event.risk === 'exec'));
    f.deps.permissionRules = [{ tool: 'run_shell', action: 'deny' }];
    const blocked = await f.loop.runToolCall({ id: 'check-2', name: 'project_checks', input: { action: 'run', id: 'typecheck' } });
    assert.equal(blocked.ok, false); assert.equal(store.snapshot()[0]!.status, 'blocked');
    assert.equal(f.events.filter((event) => event.type === 'tool_start' && event.call.name === 'run_shell').length, 1);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('failed selected check gets bounded repair and dry run cannot pass it', async () => {
  const root = mkdtempSync(join(tmpdir(), 'shadow-project-checks-'));
  const store = new ProjectCheckStore(root);
  store.saveProfiles({ version: 1, profiles: [{ id: 'test', title: 'Test fixture', command: 'exit 1' }] });
  const f = fixture([call('project_checks', { action: 'run', id: 'test' }), answer('The check failed.'), answer('Waiting for your input.')], { workspaceRoot: root, checks: store }, [makeProjectChecksTool(store), makeRunShell()]);
  try {
    await f.loop.run(); assert.equal(store.snapshot()[0]!.status, 'failed');
    assert.equal(f.events.filter((event) => event.type === 'retry').length, 1);
    assert.equal(f.events.filter((event) => event.type === 'tool_start' && event.call.name === 'run_shell').length, 1, 'correction itself never replays the check');
    f.deps.dryRun = true;
    await f.loop.runToolCall({ id: 'check-dry', name: 'project_checks', input: { action: 'run', id: 'test' } });
    assert.equal(store.snapshot()[0]!.status, 'not_run');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('check declarations reject ambiguity and cannot write through a .shadow symlink', () => {
  const root = mkdtempSync(join(tmpdir(), 'shadow-project-checks-'));
  const outside = mkdtempSync(join(tmpdir(), 'shadow-project-checks-out-'));
  try {
    const store = new ProjectCheckStore(root);
    assert.throws(() => store.saveProfiles({ version: 1, profiles: [{ id: 'a', title: 'A', command: 'true' }, { id: 'a', title: 'B', command: 'false' }] }), /unique/);
    assert.equal(existsSync(join(root, '.shadow')), false);
    symlinkSync(outside, join(root, '.shadow'), process.platform === 'win32' ? 'junction' : 'dir');
    assert.throws(() => store.saveProfiles({ version: 1, profiles: [] }), /outside the workspace/);
    assert.equal(existsSync(join(outside, 'checks.json')), false);
  } finally { rmSync(root, { recursive: true, force: true }); rmSync(outside, { recursive: true, force: true }); }
});

test('subagent denial does not incorrectly block the lead completion guard', () => {
  const guard = new CompletionGuard();
  guard.observe({ type: 'tool_denied', subagent: 'worker', call: { id: 't', name: 'read_file', input: {} }, reason: 'fixture' });
  assert.equal(guard.blocked, false);
});

test('check execution respects capability subtraction and cannot use an unscoped shell', async () => {
  const root = mkdtempSync(join(tmpdir(), 'shadow-project-checks-'));
  const store = new ProjectCheckStore(root);
  store.saveProfiles({ version: 1, profiles: [{ id: 'hidden', title: 'Hidden shell', command: 'touch MUST_NOT_RUN' }] });
  const f = fixture([], { workspaceRoot: root, checks: store }, [makeProjectChecksTool(store), makeRunShell()]);
  f.registry.setDenied(['run_shell']);
  try {
    const result = await f.loop.runToolCall({ id: 'hidden', name: 'project_checks', input: { action: 'run', id: 'hidden' } });
    assert.equal(result.ok, false); assert.equal(store.snapshot()[0]!.status, 'blocked');
    assert.equal(existsSync(join(root, 'MUST_NOT_RUN')), false);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('check wrappers preserve the fatal repeated-command guard', async () => {
  const root = mkdtempSync(join(tmpdir(), 'shadow-project-checks-'));
  const store = new ProjectCheckStore(root);
  store.saveProfiles({ version: 1, profiles: [{ id: 'repeat', title: 'Repeated check', command: 'printf x' }] });
  let runs = 0;
  const shell: Tool = { name: 'run_shell', description: 'fixture shell', risk: 'exec', inputSchema: z.object({ command: z.string() }), run: async () => { runs++; return ok('run_shell', 'exec', 0, 'Passed', { exitCode: 0 }); } };
  const f = fixture(Array.from({ length: 8 }, (_, i) => call('project_checks', { action: 'run', id: 'repeat' }, `c${i}`)), { workspaceRoot: root, checks: store }, [makeProjectChecksTool(store), shell]);
  try {
    assert.equal((await f.loop.run()).stopReason, 'fatal_tool_error');
    assert.equal(runs, 2, 'repeated declarations never reset the actual command loop guard');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('a profile change and a later write invalidate previous passes without deleting evidence', async () => {
  const root = mkdtempSync(join(tmpdir(), 'shadow-project-checks-'));
  const store = new ProjectCheckStore(root);
  const spec = { version: 1, profiles: [{ id: 'lint', title: 'Lint', command: 'true' }] };
  store.saveProfiles(spec);
  try {
    const old = store.record(store.resolve('lint'), ok('run_shell', 'exec', 1, 'Passed', { exitCode: 0 }));
    assert.equal(store.snapshot()[0]!.status, 'passed'); store.invalidate();
    assert.equal(store.snapshot()[0]!.status, 'not_run'); assert.equal(store.getRun(old.id)?.status, 'passed');
    store.saveProfiles({ ...spec, profiles: [{ ...spec.profiles[0], command: 'false' }] });
    assert.equal(store.snapshot()[0]!.latest, undefined);
    assert.equal(store.getRun(old.id)?.command, 'true');
    assert.equal(store.getRun('../not-a-run'), undefined);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
