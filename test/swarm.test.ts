import { test } from 'node:test';
import assert from 'node:assert/strict';
import { validateSwarmTasks, runSwarm, type SwarmTask } from '../src/agent/swarm.js';
import { makeSwarmTool } from '../src/tools/swarmTool.js';
import { ok } from '../src/tools/types.js';
import { findTerminalCommand, commandHandler } from '../src/tui/commandCatalog.js';

const task = (id: string, dependsOn: string[] = [], isolation: 'none' | 'worktree' = 'none'): SwarmTask => ({
  id, prompt: `Investigate ${id}`, dependsOn, isolation,
});

test('DAG validation rejects unknown dependencies and cycles', () => {
  assert.match(validateSwarmTasks([task('a', ['missing'])]) ?? '', /unknown dependency/i);
  assert.match(validateSwarmTasks([task('a', ['b']), task('b', ['a'])]) ?? '', /cycle/i);
});

test('DAG validation rejects nested fan-out and excessive width', () => {
  assert.match(validateSwarmTasks([{ ...task('a'), maxAgents: 4 } as SwarmTask]) ?? '', /nested|maxAgents/i);
  assert.match(validateSwarmTasks(Array.from({ length: 17 }, (_, i) => task(`s-${i}`))) ?? '', /16/);
});

test('all independent ready tasks start together within the caller limit', async () => {
  let active = 0;
  let maximum = 0;
  const launched: string[] = [];
  const result = await runSwarm({ tasks: [task('a'), task('b'), task('c')], concurrency: 3 },
    async (node) => {
      launched.push(node.id);
      active++; maximum = Math.max(maximum, active);
      await new Promise((resolve) => setTimeout(resolve, 5));
      active--;
      return { status: 'completed', jobId: `job-${node.id}` };
    });
  assert.equal(result.ok, true);
  assert.equal(maximum, 3);
  assert.deepEqual(launched.sort(), ['a', 'b', 'c']);
});

test('dependent read-only tasks run after prerequisites; dependent writers await integration', async () => {
  const launched: string[] = [];
  const result = await runSwarm({ tasks: [task('a'), task('b', ['a']), task('c', ['a'], 'worktree')] }, async (node) => {
    launched.push(node.id); return { status: 'completed' };
  });
  assert.deepEqual(launched, ['a', 'b']);
  assert.equal(result.nodes.find((n) => n.id === 'b')?.status, 'completed');
  assert.equal(result.nodes.find((n) => n.id === 'c')?.status, 'blocked');
  assert.equal(result.ok, false);
});

test('synchronous worker exceptions become failed nodes', async () => {
  const result = await runSwarm({ tasks: [task('a')] }, () => { throw new Error('sync failure'); });
  assert.equal(result.ok, false);
  assert.equal(result.nodes[0]!.status, 'failed');
  assert.match(result.nodes[0]!.result?.error ?? '', /sync failure/);
});

test('a failed prerequisite blocks descendants but independent work continues', async () => {
  const launched: string[] = [];
  const result = await runSwarm({ tasks: [task('a'), task('b', ['a']), task('c')] }, async (node) => {
    launched.push(node.id);
    return node.id === 'a' ? { status: 'failed', error: 'provider failed' } : { status: 'completed' };
  });
  assert.equal(result.ok, false);
  assert.deepEqual(launched.sort(), ['a', 'c']);
  assert.equal(result.nodes.find((n) => n.id === 'b')?.status, 'blocked');
  assert.equal(result.nodes.find((n) => n.id === 'c')?.status, 'completed');
});

test('native swarm tool refuses nested execution and passes parent context', async () => {
  const tool = makeSwarmTool(async (_input, ctx) => ok('agent', 'exec', 0, 'done', { status: 'completed', answer: ctx.workspaceRoot, taskId: 'job-a' }), 2);
  const ctx = { workspaceRoot: '/workspace', signal: new AbortController().signal, log: () => {}, dryRun: false, nestedAgent: true };
  const nested = await tool.run({ tasks: [{ id: 'a', prompt: 'read only', isolation: 'none' }] }, ctx);
  assert.match(nested.summary, /Nested/);
  const lead = await tool.run({ tasks: [{ id: 'a', prompt: 'read only', isolation: 'none' }] }, { ...ctx, nestedAgent: false });
  assert.match(lead.summary, /job-a/);
  assert.equal(lead.ok, true);
  const failed = await tool.run({ tasks: [{ id: 'a', prompt: 'read only', isolation: 'none' }] },
    { ...ctx, nestedAgent: false, signal: AbortSignal.abort() });
  assert.equal(failed.ok, false);
});

test('/swarm is a native command in both renderers', () => {
  const command = findTerminalCommand('/swarm');
  assert.ok(command);
  assert.equal(commandHandler(command, 'ink'), 'swarm');
  assert.equal(commandHandler(command, 'pi'), 'swarm');
});

test('cancellation stops queued work and preserves running results as cancelled', async () => {
  const controller = new AbortController();
  const result = await runSwarm({ tasks: [task('a'), task('b', ['a'])], signal: controller.signal }, async () => {
    controller.abort();
    return { status: 'cancelled' };
  });
  assert.equal(result.ok, false);
  assert.equal(result.nodes.find((n) => n.id === 'a')?.status, 'cancelled');
  assert.equal(result.nodes.find((n) => n.id === 'b')?.status, 'blocked');
});
