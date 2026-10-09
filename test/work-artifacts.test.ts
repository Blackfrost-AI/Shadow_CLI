import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createWorktree } from '../src/tools/worktree.js';
import {
  applyWorkArtifact, createWorkArtifact, discardWorkArtifact, finishWorkArtifact,
  getWorkArtifact, inspectWorkArtifact, keepWorkArtifact, listWorkArtifacts, recoverWorkArtifact,
} from '../src/state/workArtifacts.js';
import { makeAgentTool } from '../src/tools/agentTool.js';
import { EventBus, type LoopEvent } from '../src/agent/events.js';
import { Budget } from '../src/agent/budget.js';
import { Context } from '../src/agent/context.js';
import { ToolRegistry } from '../src/tools/registry.js';
import { registerBuiltinTools } from '../src/tools/index.js';
import { ScriptedApprovalGate } from '../src/agent/approval.js';
import { MockProvider } from '../src/provider/mock.js';
import type { Provider, ProviderEvent } from '../src/provider/provider.js';
import { JobStore } from '../src/state/jobStore.js';

function git(ws: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd: ws, encoding: 'utf8', stdio: 'pipe' });
}
function fixture() {
  const ws = mkdtempSync(join(tmpdir(), 'shadow-artifact-'));
  git(ws, 'init', '-q');
  // These fixtures assert exact bytes after Git applies an archived patch.
  git(ws, 'config', '--local', 'core.autocrlf', 'false');
  writeFileSync(join(ws, 'a.txt'), 'original\n');
  git(ws, 'add', 'a.txt');
  git(ws, '-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.test', 'commit', '-qm', 'initial');
  const wt = createWorktree(ws, 'worker');
  const record = createWorkArtifact(ws, 'task-one', wt);
  return { ws, wt, record, close: () => rmSync(ws, { recursive: true, force: true }) };
}

test('failed worker output survives reopen, includes all Git states and binary data, and preserves its index', () => {
  const h = fixture();
  try {
    writeFileSync(join(h.wt.path, 'a.txt'), 'committed edit\n');
    git(h.wt.path, 'add', 'a.txt');
    git(h.wt.path, '-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.test', 'commit', '-qm', 'worker edit');
    writeFileSync(join(h.wt.path, 'a.txt'), 'staged edit\n');
    git(h.wt.path, 'add', 'a.txt');
    writeFileSync(join(h.wt.path, 'a.txt'), 'final unstaged edit\n');
    writeFileSync(join(h.wt.path, 'binary.bin'), Buffer.from([0, 255, 128, 7]));
    const indexBefore = git(h.wt.path, 'diff', '--cached');
    const result = finishWorkArtifact(h.ws, h.record.id, { status: 'failed', stopReason: 'provider_error', answer: 'Endpoint disconnected' });
    assert.equal(result.state, 'ready');
    assert.equal(result.error, undefined);
    assert.ok(existsSync(h.wt.path));
    assert.equal(git(h.wt.path, 'diff', '--cached'), indexBefore);
    assert.equal(listWorkArtifacts(h.ws)[0]?.outcome, 'failed');
    const reopened = inspectWorkArtifact(h.ws, h.record.id);
    assert.match(reopened.patch, /final unstaged edit/);
    assert.match(reopened.patch, /GIT binary patch/);
    assert.deepEqual(reopened.artifact.changedFiles, ['a.txt', 'binary.bin']);
    assert.equal(reopened.artifact.verification, 'unverified');
    const applied = applyWorkArtifact(h.ws, h.record.id);
    assert.equal(applied.state, 'applied');
    assert.equal(readFileSync(join(h.ws, 'a.txt'), 'utf8'), 'final unstaged edit\n');
    assert.deepEqual(readFileSync(join(h.ws, 'binary.bin')), Buffer.from([0, 255, 128, 7]));
    assert.ok(existsSync(h.wt.path), 'applying retains the review checkout');
    assert.throws(() => applyWorkArtifact(h.ws, h.record.id), /already applied/);
  } finally { h.close(); }
});

test('dirty destination and a committed conflict both refuse apply without overwriting work', () => {
  const h = fixture();
  try {
    writeFileSync(join(h.wt.path, 'a.txt'), 'worker change\n');
    finishWorkArtifact(h.ws, h.record.id, { status: 'completed' });
    writeFileSync(join(h.ws, 'a.txt'), 'user change\n');
    assert.throws(() => applyWorkArtifact(h.ws, h.record.id), /Workspace has staged/);
    assert.equal(readFileSync(join(h.ws, 'a.txt'), 'utf8'), 'user change\n');
    git(h.ws, 'add', 'a.txt');
    git(h.ws, '-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.test', 'commit', '-qm', 'user edit');
    assert.throws(() => applyWorkArtifact(h.ws, h.record.id), /patch failed|does not apply/);
    assert.equal(readFileSync(join(h.ws, 'a.txt'), 'utf8'), 'user change\n');
    assert.equal(getWorkArtifact(h.ws, h.record.id).state, 'ready');
  } finally { h.close(); }
});

test('keep retains checkout; explicit discard preserves a patch that can be applied after reopen', () => {
  const h = fixture();
  try {
    writeFileSync(join(h.wt.path, 'new.txt'), 'saved result\n');
    finishWorkArtifact(h.ws, h.record.id, { status: 'cancelled', stopReason: 'interrupted' });
    assert.equal(keepWorkArtifact(h.ws, h.record.id).state, 'kept');
    assert.equal(discardWorkArtifact(h.ws, h.record.id).state, 'discarded');
    assert.equal(existsSync(h.wt.path), false);
    assert.match(inspectWorkArtifact(h.ws, h.record.id).patch, /saved result/);
    assert.equal(applyWorkArtifact(h.ws, h.record.id).state, 'applied');
    assert.equal(readFileSync(join(h.ws, 'new.txt'), 'utf8'), 'saved result\n');
  } finally { h.close(); }
});

test('interrupted active artifact is recoverable explicitly without restarting a worker', () => {
  const h = fixture();
  try {
    writeFileSync(join(h.wt.path, 'new.txt'), 'before crash\n');
    assert.equal(listWorkArtifacts(h.ws)[0]?.state, 'active');
    assert.throws(() => discardWorkArtifact(h.ws, h.record.id), /worker is active/);
    assert.equal(recoverWorkArtifact(h.ws, h.record.id).outcome, 'partial');
    assert.match(inspectWorkArtifact(h.ws, h.record.id).patch, /before crash/);
  } finally { h.close(); }
});

test('artifact recovery and discard refuse a live owner or descendant in another store connection', () => {
  const h = fixture(); const store = new JobStore(h.ws);
  try {
    const owner = store.createJob({ prompt: 'fixture' }, { id: 'owner' });
    const attempt = store.claimAttempt(owner.id, { attemptId: h.record.taskId });
    writeFileSync(join(h.wt.path, 'result.txt'), 'work');
    assert.throws(() => recoverWorkArtifact(h.ws, h.record.id), /live owning worker/);
    finishWorkArtifact(h.ws, h.record.id, { status: 'completed' });
    store.finishAttempt(owner.id, attempt.ownerToken, { status: 'completed' });
    store.createJob({ prompt: 'child' }, { id: 'child', parentId: owner.id });
    const child = store.claimAttempt('child');
    assert.throws(() => discardWorkArtifact(h.ws, h.record.id), /live owning worker/);
    store.finishAttempt('child', child.ownerToken, { status: 'cancelled' });
    assert.equal(discardWorkArtifact(h.ws, h.record.id).state, 'discarded');
  } finally { store.close(); h.close(); }
});

test('ignored outputs retain their checkout and cannot be silently discarded outside the saved patch', () => {
  const h = fixture();
  try {
    writeFileSync(join(h.wt.path, '.gitignore'), 'generated.txt\n');
    writeFileSync(join(h.wt.path, 'generated.txt'), 'valuable generated result\n');
    const artifact = finishWorkArtifact(h.ws, h.record.id, { status: 'completed' });
    assert.equal(artifact.state, 'ready');
    assert.deepEqual(artifact.ignoredFiles, ['generated.txt']);
    assert.throws(() => discardWorkArtifact(h.ws, artifact.id), /ignored files/);
    assert.equal(readFileSync(join(h.wt.path, 'generated.txt'), 'utf8'), 'valuable generated result\n');
  } finally { h.close(); }
});

test('an empty worker output can be cleaned; a snapshot failure preserves the checkout', () => {
  const h = fixture();
  try {
    const empty = finishWorkArtifact(h.ws, h.record.id, { status: 'completed' });
    assert.equal(empty.state, 'empty');
    assert.equal(existsSync(h.wt.path), false);
    const wt = createWorktree(h.ws, 'broken');
    const artifact = createWorkArtifact(h.ws, 'broken-task', wt);
    writeFileSync(join(wt.path, 'new.txt'), 'save this');
    const metaPath = join(h.ws, '.shadow/artifacts', artifact.id, 'artifact.json');
    writeFileSync(metaPath, JSON.stringify({ ...artifact, baseCommit: 'invalid-commit' }));
    const failed = finishWorkArtifact(h.ws, artifact.id, { status: 'failed' });
    assert.equal(failed.state, 'ready');
    assert.ok(failed.error);
    assert.ok(existsSync(join(wt.path, 'new.txt')));
  } finally { h.close(); }
});

for (const background of [false, true]) {
  for (const outcome of ['completed', 'failed', 'cancelled'] as const) {
    test(`${background ? 'background' : 'foreground'} ${outcome} agent returns a retained artifact and precise lifecycle event`, async () => {
      const h = fixture();
      const controller = new AbortController();
      try {
        // This fixture's pre-created checkout is separate from the agent's actual checkout.
        const events: LoopEvent[] = [];
        const bus = new EventBus();
        bus.on((event) => events.push(event));
        let turn = 0;
        const provider: Provider = {
          name: 'artifact-fixture', estimateTokens: () => 1,
          async *send(): AsyncIterable<ProviderEvent> {
            turn++;
            if (turn === 1) {
              yield { type: 'tool_call', call: { id: 'write', name: 'write_file', input: { path: 'new.txt', content: 'retained work\n' } } };
              yield { type: 'done', stopReason: 'tool_use' };
            } else if (outcome === 'cancelled') {
              controller.abort();
              yield { type: 'done', stopReason: 'end_turn' };
            } else if (outcome === 'failed') {
              yield { type: 'error', code: 'fixture_failure', message: 'Fixture endpoint failed', recoverable: false };
            } else {
              yield { type: 'text', delta: 'Saved the requested file.' };
              yield { type: 'done', stopReason: 'end_turn' };
            }
          },
        };
        const registry = new ToolRegistry();
        registerBuiltinTools(registry);
        const tool = makeAgentTool({
          makeLoopDeps: () => ({ provider, registry, gate: new ScriptedApprovalGate([], 'approve'), bus,
            budget: new Budget({ maxIterations: 5 }, 'mock', {}, Date.now()), context: new Context({ contextBudget: 100_000, triggerRatio: 0.75, keepLastTurns: 2 }),
            signal: controller.signal, model: 'mock', system: 'fixture', maxOutputTokens: 1024,
            workspaceRoot: h.ws, dryRun: false, maxToolResultChars: 1000, contextBudget: 100_000 }),
          getAutonomy: () => 'full', contextBudget: 100_000, triggerRatio: 0.75, keepLastTurns: 2, maxIterations: 5, priceTable: {},
        });
        const result = await tool.run({ prompt: 'write a benign fixture', isolation: 'worktree', run_in_background: background }, {
          workspaceRoot: h.ws, signal: controller.signal, log: () => {}, dryRun: false,
        });
        for (let i = 0; !events.some((event) => event.type === 'subagent_end') && i < 100; i++) await new Promise((resolve) => setTimeout(resolve, 10));
        const end = events.find((event) => event.type === 'subagent_end');
        assert.ok(end?.type === 'subagent_end');
        assert.equal(end.status, outcome);
        assert.equal(end.artifactIds?.length, 1);
        assert.match(end.answer ?? '', /Retained artifact/);
        const id = end.artifactIds![0]!;
        assert.deepEqual(result.data?.artifactIds, [id]);
        const inspected = inspectWorkArtifact(h.ws, id);
        assert.equal(inspected.artifact.outcome, outcome);
        assert.match(inspected.patch, /retained work/);
        assert.ok(inspected.worktreeExists);
        assert.equal(existsSync(join(h.ws, 'new.txt')), false, 'isolated edits do not touch the main workspace');
      } finally { controller.abort(); h.close(); }
    });
  }
}

test('agent isolation failure is a structured error and never calls the provider', async () => {
  const ws = mkdtempSync(join(tmpdir(), 'shadow-artifact-no-git-'));
  try {
    let calls = 0;
    const provider = new MockProvider([() => { calls++; return [{ type: 'done', stopReason: 'end_turn' }]; }]);
    const registry = new ToolRegistry();
    const controller = new AbortController();
    const tool = makeAgentTool({
      makeLoopDeps: () => ({ provider, registry, gate: new ScriptedApprovalGate([], 'approve'), bus: new EventBus(),
        budget: new Budget({ maxIterations: 2 }, 'mock', {}, Date.now()), context: new Context({ contextBudget: 1000, triggerRatio: 0.75, keepLastTurns: 2 }),
        signal: controller.signal, model: 'mock', system: 'fixture', maxOutputTokens: 1024,
        workspaceRoot: ws, dryRun: false, maxToolResultChars: 1000, contextBudget: 1000 }),
      getAutonomy: () => 'full', contextBudget: 1000, triggerRatio: 0.75, keepLastTurns: 2, maxIterations: 2, priceTable: {},
    });
    const result = await tool.run({ prompt: 'fixture', isolation: 'worktree' }, { workspaceRoot: ws, signal: controller.signal, log: () => {}, dryRun: false });
    assert.equal(result.ok, false);
    assert.equal(result.error?.code, 'worktree_failed');
    assert.equal(calls, 0);
  } finally { rmSync(ws, { recursive: true, force: true }); }
});
