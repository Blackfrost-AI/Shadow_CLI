import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { z } from 'zod';
import { JobStore } from '../src/state/jobStore.js';
import { evaluateAcceptance } from '../src/agent/acceptance.js';
import { makeCollaborationTool, collaborationSchema } from '../src/agent/collaboration.js';
import { makeAcceptanceCheckTool } from '../src/tools/projectJobs.js';
import { makeRunShell } from '../src/tools/runShell.js';
import { createWorktree } from '../src/tools/worktree.js';
import { createWorkArtifact, finishWorkArtifact, inspectWorkArtifact } from '../src/state/workArtifacts.js';
import type { AgentToolInput, AgentToolData } from '../src/tools/agentTool.js';
import type { Tool, ToolContext } from '../src/tools/types.js';
import { fail, ok } from '../src/tools/types.js';

test('acceptance never turns absent, malformed, timed-out or unsupported evidence into a pass', () => {
  const ws = mkdtempSync(join(tmpdir(), 'shadow-acceptance-'));
  try {
    assert.equal(evaluateAcceptance(ws, {}, {}).status, 'unverified');
    assert.equal(evaluateAcceptance(ws, { checks: ['test'] }, { checks: [] }).status, 'unverified');
    assert.equal(evaluateAcceptance(ws, { checks: ['test'] }, { checks: [{ command: 'test', exitCode: 0, stdout: '', stderr: '', timedOut: true, aborted: false, recordedAt: Date.now() }] }).status, 'unverified');
    assert.equal(evaluateAcceptance(ws, { artifacts: ['missing.txt'] }, {}).status, 'failed');
    assert.equal(evaluateAcceptance(ws, { resultSchema: { type: 'object' } }, { answer: '{broken' }).status, 'unverified');
    assert.equal(evaluateAcceptance(ws, { resultSchema: { type: 'string', pattern: 'unsupported' } }, { answer: '"anything"' }).status, 'unverified');
  } finally { rmSync(ws, { recursive: true, force: true }); }
});

test('declared checks run in retained worker output, not a passing main checkout', async () => {
  const ws = mkdtempSync(join(tmpdir(), 'shadow-check-output-')); const store = new JobStore(ws);
  try {
    execFileSync('git', ['init', '-q'], { cwd: ws });
    writeFileSync(join(ws, 'check.cjs'), 'process.exit(0);\n');
    execFileSync('git', ['add', 'check.cjs'], { cwd: ws });
    execFileSync('git', ['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.test', 'commit', '-qm', 'fixture'], { cwd: ws });
    const worktree = createWorktree(ws, 'worker');
    // PowerShell -Command otherwise converts a native nonzero exit code to 1.
    const command = process.platform === 'win32' ? 'node check.cjs; exit $LASTEXITCODE' : 'node check.cjs';
    const job = store.createJob({ prompt: 'fixture' }, { id: 'job', acceptance: { checks: [command] } });
    const attempt = store.claimAttempt(job.id, { attemptId: 'worker-attempt' });
    const artifact = createWorkArtifact(ws, attempt.id, worktree);
    writeFileSync(join(worktree.path, 'check.cjs'), 'console.log("retained-worker-check"); process.exit(7);\n');
    finishWorkArtifact(ws, artifact.id, { status: 'completed' });
    store.finishAttempt(job.id, attempt.ownerToken, { status: 'completed', artifactIds: [artifact.id] });
    const tool = makeAcceptanceCheckTool(makeRunShell({ sandbox: 'off' }));
    const result = await tool.run({ jobId: job.id, command }, { workspaceRoot: ws, signal: new AbortController().signal, dryRun: false, log: () => {} });
    assert.equal((result.data as { status: string }).status, 'failed');
    const check = store.get(job.id)!.acceptance.checks[0]!;
    assert.equal(check.exitCode, 7);
    assert.match(check.stdout, /retained-worker-check/);
    assert.equal(readFileSync(join(ws, 'check.cjs'), 'utf8'), 'process.exit(0);\n');
  } finally { store.close(); rmSync(ws, { recursive: true, force: true }); }
});

function fixtureAgent(ws: string, answer: (input: AgentToolInput, call: number, ctx: ToolContext) => string | Promise<string>): Tool<AgentToolInput, AgentToolData> {
  let calls = 0;
  return { name: 'agent', description: 'fixture', risk: 'read', inputSchema: z.any(),
    async run(input, ctx) {
      assert.ok(ctx.parentBudget && ctx.rootBudget, 'every stage uses the shared budget');
      const store = new JobStore(ws); const attempt = store.claimAttempt(input.job_id!);
      try {
        const text = await answer(input, ++calls, ctx);
        const status = ctx.signal.aborted ? 'cancelled' : 'completed';
        ctx.parentBudget.accrueSubagent({ inputTokens: 5, outputTokens: 5, costUSD: 0.01 });
        store.finishAttempt(input.job_id!, attempt.ownerToken, { status, answer: text });
        return ok('agent', 'read', 0, text, { answer: text, taskId: attempt.id, jobId: input.job_id, status });
      } finally { store.close(); }
    } };
}
const ctxFor = (ws: string): ToolContext => ({ workspaceRoot: ws, signal: new AbortController().signal, dryRun: false, log: () => {} });

test('parallel team persists provenance and caps concurrency while reusing the bounded runner', async () => {
  const ws = mkdtempSync(join(tmpdir(), 'shadow-team-')); let active = 0; let peak = 0;
  try {
    const tool = makeCollaborationTool({ agentTool: fixtureAgent(ws, async () => { active++; peak = Math.max(peak, active); await new Promise((resolve) => setTimeout(resolve, 20)); active--; return 'fixture finding'; }) });
    const result = await tool.run(collaborationSchema.parse({ preset: 'parallel-team', prompt: 'inspect fixture', concurrency: 2,
      steps: [{ task: 'a' }, { task: 'b' }, { task: 'c' }] }), ctxFor(ws));
    assert.equal(result.ok, true); assert.equal(peak, 2); assert.equal(result.data?.jobIds.length, 4);
    assert.equal(result.data?.acceptance.status, 'unverified');
    const store = new JobStore(ws);
    try { assert.equal(store.list().length, 5); assert.equal(store.readMessages(result.data!.room, 'lead').length, 4); }
    finally { store.close(); }
  } finally { rmSync(ws, { recursive: true, force: true }); }
});

test('invalid planner/judge output stops the protocol and never records acceptance passed', async () => {
  for (const preset of ['solve', 'debate'] as const) {
    const ws = mkdtempSync(join(tmpdir(), 'shadow-protocol-'));
    try {
      let calls = 0;
      const tool = makeCollaborationTool({ agentTool: fixtureAgent(ws, () => { calls++; return 'not JSON'; }) });
      const result = await tool.run(collaborationSchema.parse({ preset, prompt: 'fixture' }), ctxFor(ws));
      assert.equal(result.ok, false); assert.equal(result.data?.acceptance.status, 'unverified');
      assert.equal(calls, preset === 'solve' ? 1 : 3);
    } finally { rmSync(ws, { recursive: true, force: true }); }
  }
});

for (const code of ['permission_denied', 'profile_failed']) {
  test(`${code} before worker claim records a terminal launch failure without inventing an attempt`, async () => {
    const ws = mkdtempSync(join(tmpdir(), 'shadow-team-rejected-'));
    try {
      const agent: Tool<AgentToolInput, AgentToolData> = { name: 'agent', description: 'fixture', risk: 'read', inputSchema: z.any(),
        async run() { return fail('agent', 'read', 0, code, `fixture ${code}`); } };
      const tool = makeCollaborationTool({ agentTool: agent });
      const result = await tool.run(collaborationSchema.parse({ preset: 'pipeline', prompt: 'fixture', steps: [{ task: 'blocked' }, { task: 'must not start' }] }), ctxFor(ws));
      assert.equal(result.ok, false); assert.equal(result.data?.jobIds.length, 1);
      const store = new JobStore(ws);
      try {
        const child = store.get(result.data!.jobIds[0]!)!;
        assert.equal(child.status, 'failed'); assert.equal(child.attempts.length, 0);
        assert.equal(child.acceptance.status, 'unverified');
        assert.match(child.launchFailures?.[0]?.reason ?? '', new RegExp(code));
        assert.ok(store.list().every((job) => job.status !== 'pending' && job.status !== 'running'));
        assert.equal(store.prepareRetry(child.id).status, 'pending', 'an explicit user retry is still available');
      } finally { store.close(); }
    } finally { rmSync(ws, { recursive: true, force: true }); }
  });
}

test('token stop prevents a hidden synthesis call and records partial findings', async () => {
  const ws = mkdtempSync(join(tmpdir(), 'shadow-team-budget-'));
  try {
    let calls = 0;
    const tool = makeCollaborationTool({ agentTool: fixtureAgent(ws, () => { calls++; return 'retained evidence'; }) });
    const result = await tool.run(collaborationSchema.parse({ preset: 'parallel-team', prompt: 'fixture', concurrency: 1, maxTokens: 10 }), ctxFor(ws));
    assert.equal(result.ok, false); assert.equal(calls, 1);
    assert.match(result.summary, /budget exhausted/);
    assert.equal(result.data?.jobIds.length, 1);
  } finally { rmSync(ws, { recursive: true, force: true }); }
});

test('persistent workflow cancellation stops the current child and does not launch another stage', async () => {
  const ws = mkdtempSync(join(tmpdir(), 'shadow-team-cancel-')); let calls = 0;
  try {
    const tool = makeCollaborationTool({ agentTool: fixtureAgent(ws, async (input, _call, ctx) => {
      calls++;
      const store = new JobStore(ws); const job = store.get(input.job_id!)!; store.requestCancel(job.parentId!); store.close();
      // A real provider request owns a socket/process handle. Keep this fake request
      // alive too: the workflow heartbeat is intentionally unref'ed in production.
      await new Promise<void>((resolve, reject) => {
        const onAbort = (): void => { clearTimeout(guard); resolve(); };
        const guard = setTimeout(() => {
          ctx.signal.removeEventListener('abort', onAbort);
          reject(new Error('Fixture cancellation did not reach the active worker within 5 seconds'));
        }, 5000);
        if (ctx.signal.aborted) onAbort();
        else ctx.signal.addEventListener('abort', onAbort, { once: true });
      });
      return 'partial findings before cancellation';
    }) });
    const result = await tool.run(collaborationSchema.parse({ preset: 'pipeline', prompt: 'fixture', steps: [{ task: 'first' }, { task: 'second' }] }), ctxFor(ws));
    assert.equal(result.ok, false); assert.equal(calls, 1);
    assert.equal(result.data?.status, 'cancelled');
    const store = new JobStore(ws);
    try { assert.ok(store.list().every((job) => job.status !== 'running')); }
    finally { store.close(); }
  } finally { rmSync(ws, { recursive: true, force: true }); }
});

test('implement-review keeps one bounded repair, reruns output checks and refreshes the retained patch', async () => {
  const ws = mkdtempSync(join(tmpdir(), 'shadow-team-repair-')); let calls = 0; let checked = 0;
  try {
    execFileSync('git', ['init', '-q'], { cwd: ws });
    writeFileSync(join(ws, 'check.cjs'), 'process.exit(0);\n');
    execFileSync('git', ['add', 'check.cjs'], { cwd: ws });
    execFileSync('git', ['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.test', 'commit', '-qm', 'fixture'], { cwd: ws });
    const agent: Tool<AgentToolInput, AgentToolData> = { name: 'agent', description: 'fixture', risk: 'read', inputSchema: z.any(),
      async run(input, ctx) {
        const store = new JobStore(ws); const attempt = store.claimAttempt(input.job_id!); calls++;
        try {
          let artifactIds: string[] = [];
          if (calls === 1) {
            const wt = createWorktree(ws, 'implementation'); const artifact = createWorkArtifact(ws, attempt.id, wt);
            writeFileSync(join(wt.path, 'check.cjs'), 'process.exit(7);\n');
            finishWorkArtifact(ws, artifact.id, { status: 'completed' }); artifactIds = [artifact.id];
          } else if (calls === 2) writeFileSync(join(ctx.workspaceRoot, 'check.cjs'), '// repaired\nprocess.exit(0);\n');
          else assert.match(readFileSync(join(ctx.workspaceRoot, 'check.cjs'), 'utf8'), /repaired/);
          ctx.parentBudget?.accrueSubagent({ inputTokens: 2, outputTokens: 2, costUSD: 0 });
          store.finishAttempt(input.job_id!, attempt.ownerToken, { status: 'completed', answer: `stage ${calls}`, artifactIds });
          return ok('agent', 'read', 0, `stage ${calls}`, { status: 'completed', answer: `stage ${calls}`, taskId: attempt.id, jobId: input.job_id, artifactIds });
        } finally { store.close(); }
      } };
    const checkTool = makeAcceptanceCheckTool(makeRunShell({ sandbox: 'off' }));
    const tool = makeCollaborationTool({ agentTool: agent, runCheck: async (input, ctx) => { checked++; return checkTool.run(input, ctx); } });
    const result = await tool.run(collaborationSchema.parse({ preset: 'implement-review', prompt: 'fixture', checks: ['node check.cjs'] }), ctxFor(ws));
    assert.equal(result.ok, true, result.summary); assert.equal(calls, 3); assert.equal(checked, 2);
    assert.equal(result.data?.acceptance.status, 'passed');
    const id = result.data!.artifactIds[0]!;
    assert.match(inspectWorkArtifact(ws, id).patch, /repaired/);
    const store = new JobStore(ws);
    try { assert.deepEqual(store.get(result.data!.jobIds[1]!)?.sourceArtifactIds, [id]); }
    finally { store.close(); }
  } finally { rmSync(ws, { recursive: true, force: true }); }
});
