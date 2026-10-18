import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { z } from 'zod';
import { AgentLoop, type LoopDeps } from '../src/agent/loop.js';
import { Budget } from '../src/agent/budget.js';
import { Context } from '../src/agent/context.js';
import { EventBus, type LoopEvent } from '../src/agent/events.js';
import { AutoApproveGate } from '../src/agent/approval.js';
import { ProjectCheckStore } from '../src/checks/store.js';
import { currentFindingRetest } from '../src/security/evidence.js';
import { MockProvider } from '../src/provider/mock.js';
import type { Provider, ProviderEvent } from '../src/provider/provider.js';
import { ToolRegistry } from '../src/tools/registry.js';
import { makeAgentTool } from '../src/tools/agentTool.js';
import { makeProjectChecksTool } from '../src/tools/projectChecks.js';
import { makeRunShell } from '../src/tools/runShell.js';
import { fail, ok, type Tool } from '../src/tools/types.js';
import { printFixture, writeFixture } from './helpers/nativeShellFixture.js';

const answer: ProviderEvent[] = [{ type: 'text', delta: 'Done.' }, { type: 'done', stopReason: 'end_turn' }];
const call = (name: string, input: unknown, id = 'fixture'): ProviderEvent[] => [
  { type: 'tool_call', call: { id, name, input } }, { type: 'done', stopReason: 'tool_use' },
];

function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'shadow-check-invalidation-'));
  const checks = new ProjectCheckStore(root);
  checks.saveProfiles({ version: 1, profiles: [
    { id: 'first', title: 'First', command: printFixture('first') },
    { id: 'second', title: 'Second', command: printFixture('second') },
  ] });
  const registry = new ToolRegistry();
  registry.register(makeProjectChecksTool(checks)); registry.register(makeRunShell());
  const bus = new EventBus();
  const events: LoopEvent[] = []; bus.on((event) => events.push(event));
  const context = new Context({ contextBudget: 100_000, triggerRatio: 0.9, keepLastTurns: 6 });
  context.pinTask({ role: 'user', content: [{ type: 'text', text: 'Fixture task.' }] });
  const deps: LoopDeps = { provider: new MockProvider(), model: 'mock', registry, gate: new AutoApproveGate(), bus,
    budget: new Budget({ maxIterations: 20 }, 'mock', {}, Date.now()), context, checks,
    workspaceRoot: root, signal: new AbortController().signal, system: 'Fixture', maxOutputTokens: 1024,
    dryRun: false, maxToolResultChars: 16_384, contextBudget: 100_000, sleep: async () => {} };
  const pass = (id = 'first') => checks.record(checks.resolve(id), ok('run_shell', 'exec', 0, 'Passed fixture', { exitCode: 0 }));
  return { root, checks, registry, bus, events, deps, pass, loop: new AgentLoop(deps, 'full') };
}

test('native check runs retain consecutive passes, ordinary shell edits invalidate both even with a reused inner id', async () => {
  const f = fixture();
  try {
    assert.equal((await f.loop.runToolCall({ id: 'a', name: 'project_checks', input: { action: 'run', id: 'first' } })).ok, true);
    assert.equal((await f.loop.runToolCall({ id: 'b', name: 'project_checks', input: { action: 'run', id: 'second' } })).ok, true);
    assert.deepEqual(f.checks.snapshot().map((item) => item.status), ['passed', 'passed']);
    const evidence = f.checks.snapshot()[0]!.latest!;
    assert.equal(currentFindingRetest(f.checks, evidence.id).passed, true);
    const edit = await f.loop.runToolCall({ id: 'a:check', name: 'run_shell', input: { command: writeFixture('fixture.txt', 'changed') } });
    assert.equal(edit.ok, true); assert.equal(readFileSync(join(f.root, 'fixture.txt'), 'utf8'), 'changed');
    assert.deepEqual(f.checks.snapshot().map((item) => item.status), ['not_run', 'not_run']);
    assert.throws(() => currentFindingRetest(f.checks, evidence.id), /current|invalidated|re-run/i);
    assert.equal(f.checks.getRun(evidence.id)?.status, 'passed', 'historical evidence stays intact');
  } finally { rmSync(f.root, { recursive: true, force: true }); }
});

test('admitted mutation invalidates before execution and again after a partial failure', async () => {
  const f = fixture();
  const mutation: Tool = { name: 'partial_write', description: 'Fixture', risk: 'write', inputSchema: z.object({}), run: async () => {
    assert.equal(f.checks.snapshot()[0]!.status, 'not_run', 'old pass is invalid before mutation starts');
    // Another shared worker can finish a check while this admitted write is still running.
    f.pass();
    writeFileSync(join(f.root, 'partial.txt'), 'partial mutation');
    return fail('partial_write', 'write', 1, 'fixture_failure', 'Changed a file, then failed.');
  } };
  f.registry.register(mutation); f.pass();
  try {
    assert.equal((await f.loop.runToolCall({ id: 'partial', name: 'partial_write', input: {} })).ok, false);
    assert.equal(readFileSync(join(f.root, 'partial.txt'), 'utf8'), 'partial mutation');
    assert.equal(f.checks.snapshot()[0]!.status, 'not_run', 'check taken before write finished is stale');
  } finally { rmSync(f.root, { recursive: true, force: true }); }
});

test('denied, invalid, dry-run and read-only actions do not invalidate checks', async () => {
  const f = fixture(); f.pass();
  f.registry.register({ name: 'read_fixture', description: 'Fixture', risk: 'read', inputSchema: z.object({}), run: async () => ok('read_fixture', 'read', 0, 'Read') });
  try {
    f.deps.permissionRules = [{ tool: 'run_shell', action: 'deny' }];
    assert.equal((await f.loop.runToolCall({ id: 'denied', name: 'run_shell', input: { command: 'printf denied' } })).ok, false);
    f.deps.permissionRules = [];
    assert.equal((await f.loop.runToolCall({ id: 'invalid', name: 'run_shell', input: {} })).ok, false);
    f.deps.dryRun = true;
    assert.equal((await f.loop.runToolCall({ id: 'dry', name: 'run_shell', input: { command: 'printf dry' } })).error?.code, 'dry_run');
    f.deps.dryRun = false;
    assert.equal((await f.loop.runToolCall({ id: 'read', name: 'read_fixture', input: {} })).ok, true);
    assert.equal(f.checks.snapshot()[0]!.status, 'passed');
  } finally { rmSync(f.root, { recursive: true, force: true }); }
});

test('model tool dispatch invalidates a pass after an unsuccessful shell command changes files', async () => {
  const f = fixture(); f.pass();
  f.deps.provider = new MockProvider([call('run_shell', { command: `${writeFixture('partial.txt', 'partial')}; exit 1` }), answer]);
  try {
    await f.loop.run();
    assert.equal(readFileSync(join(f.root, 'partial.txt'), 'utf8'), 'partial');
    assert.equal(f.checks.snapshot()[0]!.status, 'not_run');
  } finally { rmSync(f.root, { recursive: true, force: true }); }
});

test('background shared-workspace worker invalidates live checks after native launcher returns', async () => {
  const f = fixture(); f.pass();
  let release!: () => void;
  const barrier = new Promise<void>((resolve) => { release = resolve; });
  const script = new MockProvider([call('run_shell', { command: writeFixture('worker.txt', 'worker') }), answer]);
  const provider: Provider = { name: 'mock', estimateTokens: () => 1, async *send(req) { await barrier; yield* script.send(req); } };
  f.deps.provider = provider;
  const agent = makeAgentTool({ makeLoopDeps: () => f.deps, getAutonomy: () => 'full', contextBudget: 100_000,
    triggerRatio: 0.9, keepLastTurns: 6, maxIterations: 5, priceTable: {} });
  f.registry.register(agent);
  let finish!: () => void;
  const finished = new Promise<void>((resolve) => { finish = resolve; });
  const unsubscribe = f.bus.on((event) => { if (event.type === 'subagent_end') finish(); });
  try {
    const launched = await f.loop.runToolCall({ id: 'launch', name: 'agent', input: { prompt: 'Fixture write.', run_in_background: true } });
    assert.equal(launched.ok, true); assert.equal(f.checks.snapshot()[0]!.status, 'passed');
    release(); await finished;
    assert.equal(readFileSync(join(f.root, 'worker.txt'), 'utf8'), 'worker');
    assert.equal(f.checks.snapshot()[0]!.status, 'not_run');
    assert.ok(f.events.some((event) => event.type === 'tool_end' && event.subagent && event.call.name === 'run_shell'));
  } finally { release(); await finished; unsubscribe(); rmSync(f.root, { recursive: true, force: true }); }
});

test('isolated worker uses its checked-out check profile and preserves parent passes', async () => {
  const f = fixture();
  try {
    execFileSync('git', ['init', '-q'], { cwd: f.root });
    execFileSync('git', ['add', '.shadow/checks.json'], { cwd: f.root });
    execFileSync('git', ['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.test', 'commit', '-qm', 'Fixture'], { cwd: f.root });
    f.checks.saveProfiles({ version: 1, profiles: [{ id: 'first', title: 'Parent changed', command: printFixture('parent') }] });
    const parentEvidence = f.pass();
    f.deps.provider = new MockProvider([call('project_checks', { action: 'run', id: 'first' }), call('run_shell', { command: writeFixture('worker.txt', 'worker') }), answer]);
    f.registry.register(makeAgentTool({ makeLoopDeps: () => f.deps, getAutonomy: () => 'full', contextBudget: 100_000,
      triggerRatio: 0.9, keepLastTurns: 6, maxIterations: 5, priceTable: {} }));
    const result = await f.loop.runToolCall({ id: 'isolated', name: 'agent', input: { prompt: 'Check isolated fixture.', isolation: 'worktree' } });
    // This fixture's worker ends at its iteration ceiling (partial, not ok); the test pins check
    // isolation, so assert the isolated run happened rather than that it completed.
    assert.notEqual(result.error?.code, 'worktree_failed', result.summary);
    assert.ok((result.data as { status?: string } | undefined)?.status, 'the isolated sub-loop ran');
    const checkEvent = f.events.find((event) => event.type === 'tool_end' && event.subagent && event.call.name === 'project_checks');
    assert.ok(checkEvent?.type === 'tool_end');
    assert.equal((checkEvent.result.data as { check: { stdout: string } }).check.stdout, 'first');
    assert.equal(f.checks.snapshot()[0]!.status, 'passed');
    assert.equal(f.checks.snapshot()[0]!.latest!.id, parentEvidence.id);
  } finally { rmSync(f.root, { recursive: true, force: true }); }
});
