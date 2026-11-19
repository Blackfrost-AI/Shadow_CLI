/**
 * Phase 3b — ops_dispatch lifecycle + claim-and-spawn + worker gate (plan §7.2, §4b).
 * Lead-only fail-closed lifecycle, engagement authorization precondition, run lock,
 * worker cap, durable denial hints, canonical-archetype assertion, job-liveness
 * recovery, goal-gated completion, and a REAL background worker spawn end-to-end
 * (MockProvider) proving gate binding + write-back + finish_intent.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { isolateHome, assertStoreIsolated } from './helpers/isolateHome.js';

const { home } = isolateHome('ops-dispatch');
const globalStore = await import('../src/state/globalStore.js');
assertStoreIsolated(globalStore.GLOBAL_DIR, home);
const { OpsGraph } = await import('../src/security/ops/graph.js');
const { OpsRuntime } = await import('../src/security/ops/runtime.js');
const { makeOpsDispatchTool } = await import('../src/tools/opsDispatch.js');
const { makeOpsGraphTool, makeOpsWritebackTool } = await import('../src/tools/opsTools.js');
const { EngagementStore } = await import('../src/tools/engagementOps.js');
const { JobStore } = await import('../src/state/jobStore.js');
const { makeOpsWorkerGate } = await import('../src/security/ops/workerGate.js');
const { makeAgentTool } = await import('../src/tools/agentTool.js');
const { ToolRegistry } = await import('../src/tools/registry.js');
const { registerBuiltinTools } = await import('../src/tools/index.js');
const { Budget } = await import('../src/agent/budget.js');
const { Context } = await import('../src/agent/context.js');
const { EventBus } = await import('../src/agent/events.js');
const { ScriptedApprovalGate } = await import('../src/agent/approval.js');
const { MockProvider } = await import('../src/provider/mock.js');
import type { Tool, ToolContext } from '../src/tools/types.js';
import type { IntentNode } from '../src/security/ops/types.js';
import type { LoopDeps } from '../src/agent/loop.js';

const PRICE = { mock: { input: 1, output: 1 } };

function mkCtx(ws: string, over: Partial<ToolContext> = {}): ToolContext {
  return { workspaceRoot: ws, signal: AbortSignal.timeout(30_000), sessionId: 'sess-A', ...over } as ToolContext;
}
const workerCtx = (ws: string, jobId: string) => mkCtx(ws, { nestedAgent: true, currentWorkId: jobId } as Partial<ToolContext>);

function setup(scope = '') {
  const ws = mkdtempSync(join(tmpdir(), 'ops-disp-ws-'));
  const g = new OpsGraph(ws, { findingStatus: () => 'open' });
  const engStore = new EngagementStore(ws);
  let engagementId: string;
  try {
    engagementId = engStore.start({ objective: 'dispatch test', scope, successCriteria: 'recorded facts' }).id;
  } finally {
    engStore.close();
  }
  const runtime = new OpsRuntime();
  const deps = runtime.deps();
  const dispatch = makeOpsDispatchTool(deps);
  const graphTool = makeOpsGraphTool(deps);
  const writeback = makeOpsWritebackTool(deps);
  const ctx = mkCtx(ws);
  return {
    ws, g, engagementId, runtime, deps, dispatch, graphTool, writeback, ctx,
    close: async () => {
      await runtime.dispose();
      g.close();
      rmSync(ws, { recursive: true, force: true });
    },
  };
}

async function startRun(s: ReturnType<typeof setup>) {
  const res = await s.dispatch.run({ action: 'start_run', engagement_id: s.engagementId, objective: 'inventory the app', success_criteria: 'assets recorded' }, s.ctx);
  assert.ok(res.ok, res.error?.message);
  return (res.data as { runId: string; goalId: number });
}

// ── lifecycle: start_run authorization precondition ────────────────────────────────────────
test('start_run denies without engagement/objective and creates run + root goal when authorized', async () => {
  const s = setup('/srv/app');
  try {
    const noEng = await s.dispatch.run({ action: 'start_run', objective: 'x' }, s.ctx);
    assert.equal(noEng.ok, false);
    const noObj = await s.dispatch.run({ action: 'start_run', engagement_id: s.engagementId }, s.ctx);
    assert.equal(noObj.ok, false);
    const badEng = await s.dispatch.run({ action: 'start_run', engagement_id: 'eng-nope', objective: 'x' }, s.ctx);
    assert.equal(badEng.ok, false);
    assert.match(badEng.error!.message, /not found/);
    const { runId, goalId } = await startRun(s);
    const run = s.g.getRun(runId);
    assert.equal(run.status, 'active');
    assert.equal(s.g.getNode(goalId).kind, 'goal');
    assert.ok(s.g.getLock(runId), 'run lock acquired');
    const second = await s.dispatch.run({ action: 'start_run', engagement_id: s.engagementId, objective: 'again' }, s.ctx);
    assert.equal(second.ok, false, 'one active run at a time');
  } finally { await s.close(); }
});

test('start_run denies when the engagement lacks scope or success criteria', async () => {
  const s = setup('');
  try {
    const res = await s.dispatch.run({ action: 'start_run', engagement_id: s.engagementId, objective: 'x' }, s.ctx);
    assert.equal(res.ok, false);
    assert.match(res.error!.message, /objective\/scope\/successCriteria/);
  } finally { await s.close(); }
});

// ── lead-only + dry-run ────────────────────────────────────────────────────────────────────
test('workers cannot use any mutating dispatch action; status stays readable', async () => {
  const s = setup('/srv/app');
  try {
    const { runId } = await startRun(s);
    const wctx = workerCtx(s.ws, 'job-w');
    for (const action of ['start_run', 'claim_and_spawn', 'pause_run', 'resume_run', 'recover', 'stop_intent', 'complete_run', 'abort_run'] as const) {
      const res = await s.dispatch.run({ action, run_id: runId, intent_id: 1, engagement_id: s.engagementId, objective: 'x' } as never, wctx);
      assert.equal(res.ok, false, `${action} must deny workers`);
      assert.match(res.error!.message, /lead-only/);
    }
    const status = await s.dispatch.run({ action: 'status', run_id: runId }, wctx);
    assert.ok(status.ok, 'status is read-only');
  } finally { await s.close(); }
});

test('dry-run reports intent without touching the graph', async () => {
  const s = setup('/srv/app');
  try {
    const res = await s.dispatch.run({ action: 'start_run', engagement_id: s.engagementId, objective: 'x' }, mkCtx(s.ws, { dryRun: true } as Partial<ToolContext>));
    assert.ok(res.ok);
    assert.match(res.summary, /Dry run/);
    assert.equal(s.g.activeRun(), undefined);
  } finally { await s.close(); }
});

// ── claim_and_spawn: denials leave durable hints ───────────────────────────────────────────
test('claim_and_spawn with no launcher fails closed: hint recorded, claim released', async () => {
  const s = setup('/srv/app');
  try {
    const { runId } = await startRun(s);
    const planned = await s.graphTool.run({ action: 'plan_intent', run_id: runId, archetype: 'recon', prompt: 'inventory', targets: ['/srv/app'] }, s.ctx);
    assert.ok(planned.ok, planned.error?.message);
    const intentId = (planned.data as { nodeId: number }).nodeId;
    const res = await s.dispatch.run({ action: 'claim_and_spawn', run_id: runId }, s.ctx);
    assert.equal(res.ok, false);
    assert.match(res.error!.message, /no agent launcher/);
    const intent = s.g.getNode(intentId) as IntentNode;
    assert.equal(intent.state, 'open', 'denied claim is released for a corrected plan');
    const hints = s.g.listNodes(runId, { kind: 'hint' });
    assert.equal(hints.length, 1);
    assert.match(String((hints[0]!.payload as { text: string }).text), /dispatch denied intent/);
    // Re-dispatch after the denial still works (claim was released, not stuck).
    const again = await s.dispatch.run({ action: 'claim_and_spawn', run_id: runId }, s.ctx);
    assert.equal(again.ok, false);
    assert.equal(s.g.listNodes(runId, { kind: 'hint' }).length, 2);
  } finally { await s.close(); }
});

test('out-of-scope intent targets deny at dispatch with a durable hint', async () => {
  const s = setup('/srv/app');
  try {
    const { runId } = await startRun(s);
    // plan_intent itself validates targets against scope; craft the node directly to
    // exercise the DISPATCH gate independently (defense in depth).
    const intent = s.g.addNode({ runId, kind: 'intent', payload: { archetype: 'recon', prompt: 'exfil', targets: ['/etc'], from: [] }, origin: 'lead' }) as IntentNode;
    const res = await s.dispatch.run({ action: 'claim_and_spawn', run_id: runId }, s.ctx);
    assert.equal(res.ok, false);
    const after = s.g.getNode(intent.id) as IntentNode;
    assert.equal(after.state, 'open');
    assert.equal(s.g.listNodes(runId, { kind: 'hint' }).length, 1);
  } finally { await s.close(); }
});

test('unknown archetype denies with hint; worker cap denies before claiming', async () => {
  const s = setup('/srv/app');
  try {
    const { runId } = await startRun(s);
    const bogus = s.g.addNode({ runId, kind: 'intent', payload: { archetype: 'exploiter', prompt: 'x', targets: [], from: [] }, origin: 'lead' }) as IntentNode;
    const res = await s.dispatch.run({ action: 'claim_and_spawn', run_id: runId }, s.ctx);
    assert.equal(res.ok, false);
    assert.match(res.error!.message, /unknown archetype/);
    assert.equal((s.g.getNode(bogus.id) as IntentNode).state, 'open');
    // Fill the cap with directly-claimed intents, then a fresh open intent must not spawn.
    for (let i = 0; i < 3; i++) {
      s.g.addNode({ runId, kind: 'intent', payload: { archetype: 'recon', prompt: `t${i}`, targets: [], from: [] }, origin: 'lead', priority: 10 });
    }
    for (let i = 0; i < 3; i++) assert.ok(s.g.claimNextIntent(runId, `tok-${i}`));
    s.g.addNode({ runId, kind: 'intent', payload: { archetype: 'recon', prompt: 'over-cap', targets: [], from: [] }, origin: 'lead', priority: 0 });
    const capped = await s.dispatch.run({ action: 'claim_and_spawn', run_id: runId }, s.ctx);
    assert.equal(capped.ok, false);
    assert.match(capped.error!.message, /Worker cap reached/);
  } finally { await s.close(); }
});

test('a shadowed archetype def denies dispatch (anti-fail-open §6)', async () => {
  const s = setup('/srv/app');
  try {
    const { runId } = await startRun(s);
    mkdirSync(join(s.ws, '.shadow', 'agents'), { recursive: true });
    writeFileSync(join(s.ws, '.shadow', 'agents', 'recon.md'), '---\nname: recon\ntools: [run_shell, write_file]\n---\nwidened shadow\n');
    await s.graphTool.run({ action: 'plan_intent', run_id: runId, archetype: 'recon', prompt: 'inventory', targets: ['/srv/app'] }, s.ctx);
    const res = await s.dispatch.run({ action: 'claim_and_spawn', run_id: runId }, s.ctx);
    assert.equal(res.ok, false);
    assert.match(res.error!.message, /canonical definition/);
    assert.equal(s.g.listNodes(runId, { kind: 'hint' }).length, 1);
  } finally { await s.close(); }
});

test('claim_and_spawn spawns via the launcher: background, isolation none, archetype, job attached', async () => {
  // auditor carries osv_query — the scope must carry the literal allow-network token (§5 rule 4).
  const s = setup('/srv/app allow-network');
  try {
    const { runId, goalId } = await startRun(s);
    // Root goal is node #1 — plan_intent must exclude it from intent-id assumptions.
    assert.equal(goalId, 1);
    const planned = await s.graphTool.run({ action: 'plan_intent', run_id: runId, archetype: 'auditor', prompt: 'audit auth', targets: ['/srv/app'] }, s.ctx);
    const intentId = (planned.data as { nodeId: number }).nodeId;
    let seen: { input: Record<string, unknown>; ctx: ToolContext } | undefined;
    const fakeAgent: Tool<unknown> = {
      name: 'agent', description: 'fake', risk: 'exec', inputSchema: { parse: (x: unknown) => x } as never,
      async run(input: unknown, ctx: ToolContext) {
        seen = { input: input as Record<string, unknown>, ctx };
        return { ok: true, summary: 'started', data: { jobId: 'job-real-1', taskId: 'job-real-1', status: 'started' }, meta: { tool: 'agent', durationMs: 1, risk: 'exec' } };
      },
    };
    const dispatch = makeOpsDispatchTool(s.deps, () => fakeAgent);
    const res = await dispatch.run({ action: 'claim_and_spawn', run_id: runId }, s.ctx);
    assert.ok(res.ok, res.error?.message);
    assert.deepEqual(res.data, { dispatched: true, intentId, jobId: 'job-real-1' });
    assert.ok(seen);
    assert.equal(seen!.input.run_in_background, true);
    assert.equal(seen!.input.isolation, 'none', 'worktree workers would get a separate checks store');
    assert.equal(seen!.input.subagent_type, 'auditor');
    assert.equal(seen!.ctx, s.ctx, 'ctx forwarded unchanged (gate/autonomy inheritance)');
    assert.match(String(seen!.input.prompt), new RegExp(`intent #${intentId}`));
    const intent = s.g.getNode(intentId) as IntentNode;
    assert.equal(intent.state, 'running');
    assert.equal(intent.ownerJob, 'job-real-1');
    const facts = s.g.listNodes(runId, { kind: 'fact' });
    assert.ok(facts.some((f) => String((f.payload as { text: string }).text).includes('job-real-1')));
    // No open intents left → benign no-op.
    const empty = await dispatch.run({ action: 'claim_and_spawn', run_id: runId }, s.ctx);
    assert.ok(empty.ok);
    assert.equal((empty.data as { dispatched: boolean }).dispatched, false);
  } finally { await s.close(); }
});

test('a failed launcher result releases the claim and records a hint', async () => {
  const s = setup('/srv/app');
  try {
    const { runId } = await startRun(s);
    const planned = await s.graphTool.run({ action: 'plan_intent', run_id: runId, archetype: 'recon', prompt: 'x', targets: ['/srv/app'] }, s.ctx);
    const intentId = (planned.data as { nodeId: number }).nodeId;
    const brokenAgent: Tool<unknown> = {
      name: 'agent', description: 'broken', risk: 'exec', inputSchema: { parse: (x: unknown) => x } as never,
      async run() { return { ok: false, summary: 'nope', error: { code: 'failed', message: 'provider unavailable', recoverable: false }, meta: { tool: 'agent', durationMs: 1, risk: 'exec' } }; },
    };
    const dispatch = makeOpsDispatchTool(s.deps, () => brokenAgent);
    const res = await dispatch.run({ action: 'claim_and_spawn', run_id: runId }, s.ctx);
    assert.equal(res.ok, false);
    assert.match(res.error!.message, /provider unavailable/);
    assert.equal((s.g.getNode(intentId) as IntentNode).state, 'open');
  } finally { await s.close(); }
});

// ── pause / resume / lock / status ─────────────────────────────────────────────────────────
test('pause_run stops the worker gate; resume_run restores it; foreign session lock denies dispatch', async () => {
  const s = setup('/srv/app');
  try {
    const { runId } = await startRun(s);
    const planned = await s.graphTool.run({ action: 'plan_intent', run_id: runId, archetype: 'recon', prompt: 'x', targets: ['/srv/app'] }, s.ctx);
    const intentId = (planned.data as { nodeId: number }).nodeId;
    const claimed = s.g.claimNextIntent(runId, 'tok-p');
    assert.ok(claimed);
    s.g.attachJob(intentId, 'job-paused');
    const gate = makeOpsWorkerGate(s.ws, 'job-paused');
    const before = gate({ name: 'read_file', input: { path: '/srv/app/x' } });
    assert.equal(before.allow, true);
    const paused = await s.dispatch.run({ action: 'pause_run', run_id: runId }, s.ctx);
    assert.ok(paused.ok);
    const during = gate({ name: 'read_file', input: { path: '/srv/app/x' } });
    assert.equal(during.allow, false, 'paused run must deny worker tool calls');
    // resume without run_id must still find the paused run (activeRun() no longer returns it).
    const resumed = await s.dispatch.run({ action: 'resume_run' }, s.ctx);
    assert.ok(resumed.ok, resumed.error?.message);
    assert.equal(gate({ name: 'read_file', input: { path: '/srv/app/x' } }).allow, true);
    // Another session cannot dispatch on the locked run.
    const foreign = await s.dispatch.run({ action: 'claim_and_spawn', run_id: runId }, mkCtx(s.ws, { sessionId: 'sess-B' } as Partial<ToolContext>));
    assert.equal(foreign.ok, false);
    assert.match(foreign.error!.message, /locked by another session/);
    const status = await s.dispatch.run({ action: 'status', run_id: runId }, s.ctx);
    assert.ok(status.ok);
    assert.match(status.summary, /1 running/);
  } finally { await s.close(); }
});

// ── stop_intent ────────────────────────────────────────────────────────────────────────────
test('stop_intent stops an open intent and refuses non-intent nodes', async () => {
  const s = setup('/srv/app');
  try {
    const { runId, goalId } = await startRun(s);
    const planned = await s.graphTool.run({ action: 'plan_intent', run_id: runId, archetype: 'recon', prompt: 'x', targets: ['/srv/app'] }, s.ctx);
    const intentId = (planned.data as { nodeId: number }).nodeId;
    const res = await s.dispatch.run({ action: 'stop_intent', intent_id: intentId, reason: 'operator changed scope' }, s.ctx);
    assert.ok(res.ok);
    const intent = s.g.getNode(intentId) as IntentNode;
    assert.equal(intent.state, 'stopped');
    assert.equal(intent.payload.stopped_by, 'lead');
    assert.equal(intent.payload.reason, 'operator changed scope');
    const bad = await s.dispatch.run({ action: 'stop_intent', intent_id: goalId }, s.ctx);
    assert.equal(bad.ok, false);
  } finally { await s.close(); }
});

// ── recover: job liveness, never age ───────────────────────────────────────────────────────
test('recover requeues claims whose owner job is dead or missing, keeps live ones', async () => {
  const s = setup('/srv/app');
  try {
    const { runId } = await startRun(s);
    const mk = (prompt: string) => s.g.addNode({ runId, kind: 'intent', payload: { archetype: 'recon', prompt, targets: [], from: [] }, origin: 'lead' }) as IntentNode;
    const dead = mk('dead-owner');
    const live = mk('live-owner');
    const ghost = mk('no-job-record');
    const jobs = new JobStore(s.ws);
    let deadJobId: string; let liveJobId: string;
    try {
      deadJobId = jobs.createJob({ prompt: 'dead' }).id;
      liveJobId = jobs.createJob({ prompt: 'live' }).id;
      const attempt = jobs.claimAttempt(deadJobId, { attemptId: 'att-dead' });
      jobs.finishAttempt(deadJobId, attempt.ownerToken, { status: 'failed', stopReason: 'error', answer: 'crashed' });
    } finally { jobs.close(); }
    for (const [intent, jobId] of [[dead, deadJobId!], [live, liveJobId!], [ghost, 'job-ghost']] as const) {
      // Claim each specific intent by priority ordering: claim in creation order.
      const claimed = s.g.claimNextIntent(runId, `tok-${intent.id}`);
      assert.ok(claimed && claimed.id === intent.id);
      s.g.attachJob(intent.id, jobId);
    }
    const res = await s.dispatch.run({ action: 'recover', run_id: runId }, s.ctx);
    assert.ok(res.ok);
    assert.equal((res.data as { requeued: number }).requeued, 2, 'dead job + missing record requeue; pending job survives');
    assert.equal((s.g.getNode(dead.id) as IntentNode).state, 'open');
    assert.equal((s.g.getNode(ghost.id) as IntentNode).state, 'open');
    assert.equal((s.g.getNode(live.id) as IntentNode).state, 'running');
    // Recovery is visible via status; the requeue itself is the durable state change.
    const status = await s.dispatch.run({ action: 'status', run_id: runId }, s.ctx);
    assert.ok(status.ok);
    assert.match(status.summary, /2 open, 1 running/);
  } finally { await s.close(); }
});

// ── complete_run goal gate / abort_run ─────────────────────────────────────────────────────
test('complete_run is goal-gated; abandoned goal unlocks it; abort_run records the reason and frees the lock', async () => {
  const s = setup('/srv/app');
  try {
    const { runId, goalId } = await startRun(s);
    const early = await s.dispatch.run({ action: 'complete_run', run_id: runId }, s.ctx);
    assert.equal(early.ok, false, 'open root goal blocks completion');
    // Goal abandonment is a lead/operator decision (graph API; /ops operator surface in Phase 4).
    s.g.abandonGoal(goalId, 'descoped by operator', 'lead');
    const done = await s.dispatch.run({ action: 'complete_run', run_id: runId }, s.ctx);
    assert.ok(done.ok, done.error?.message);
    assert.equal(s.g.getRun(runId).status, 'complete');
    assert.equal(s.g.getLock(runId), undefined, 'completion releases the run lock');
    // A fresh run can start now; abort it with a reason.
    const second = await startRun(s);
    const aborted = await s.dispatch.run({ action: 'abort_run', run_id: second.runId, reason: 'engagement revoked' }, s.ctx);
    assert.ok(aborted.ok);
    assert.equal(s.g.getRun(second.runId).status, 'aborted');
    const facts = s.g.listNodes(second.runId, { kind: 'fact' });
    assert.ok(facts.some((f) => String((f.payload as { text: string }).text).includes('engagement revoked')));
  } finally { await s.close(); }
});

// ── REAL end-to-end spawn (plan phase-3b gate) ─────────────────────────────────────────────
test('real background recon worker: policy-gated loop, write-back, finish_intent done', async () => {
  const s = setup('');
  try {
    // Scope = the fixture workspace itself (absolute path token).
    const engStore = new EngagementStore(s.ws);
    let engId: string;
    try { engId = engStore.start({ objective: 'e2e', scope: s.ws, successCriteria: 'facts recorded' }).id; } finally { engStore.close(); }
    writeFileSync(join(s.ws, 'app.py'), 'print("hello")\n');
    const started = await s.dispatch.run({ action: 'start_run', engagement_id: engId, objective: 'inventory the fixture', success_criteria: 'assets recorded' }, s.ctx);
    assert.ok(started.ok, started.error?.message);
    const { runId } = started.data as { runId: string };
    const planned = await s.graphTool.run({ action: 'plan_intent', run_id: runId, archetype: 'recon', prompt: 'Read app.py and note a fact about it, then finish your intent.', targets: [s.ws] }, s.ctx);
    assert.ok(planned.ok, planned.error?.message);
    const intentId = (planned.data as { nodeId: number }).nodeId;

    // The worker's scripted turns: read the file, write back a fact, finish the intent.
    // The intent id is interpolated after planning so the script matches the real node.
    const provider = new MockProvider([
      [
        { type: 'tool_call', call: { id: 'r1', name: 'read_file', input: { path: 'app.py' } } },
        { type: 'done', stopReason: 'tool_use' },
      ],
      [
        { type: 'tool_call', call: { id: 'w1', name: 'ops_writeback', input: { action: 'note_fact', payload: { text: 'app.py prints hello' } } } },
        { type: 'done', stopReason: 'tool_use' },
      ],
      [
        { type: 'tool_call', call: { id: 'f1', name: 'ops_writeback', input: { action: 'finish_intent', intent_id: intentId, outcome: 'done', summary: 'inventoried app.py' } } },
        { type: 'done', stopReason: 'tool_use' },
      ],
      [{ type: 'text', delta: 'worker complete' }, { type: 'done', stopReason: 'end_turn' }],
    ]);
    const registry = new ToolRegistry();
    registerBuiltinTools(registry);
    registry.register(s.graphTool);
    registry.register(s.writeback);
    const bus = new EventBus();
    let notification = false;
    bus.on((e: { type: string }) => { if (e.type === 'task_notification') notification = true; });
    const makeLoopDeps = (): LoopDeps => ({
      provider, registry,
      gate: new ScriptedApprovalGate([], 'approve'),
      bus,
      budget: new Budget({ maxIterations: 8 }, 'mock', PRICE, Date.now()),
      context: new Context({ contextBudget: 100_000, triggerRatio: 0.75, keepLastTurns: 4 }),
      signal: AbortSignal.timeout(30_000),
      model: 'mock', system: 'ops-worker-test', maxOutputTokens: 512,
      workspaceRoot: s.ws, dryRun: false, maxToolResultChars: 8_000, contextBudget: 100_000,
    });
    const agent = makeAgentTool({
      makeLoopDeps, getAutonomy: () => 'full', contextBudget: 100_000, triggerRatio: 0.75, keepLastTurns: 4,
      maxIterations: 8, priceTable: PRICE,
      makeOpsGate: (workspace: string, jobId: string) => makeOpsWorkerGate(workspace, jobId),
    });
    const dispatch = makeOpsDispatchTool(s.deps, () => agent);
    const res = await dispatch.run({ action: 'claim_and_spawn', run_id: runId }, s.ctx);
    assert.ok(res.ok, res.error?.message);
    const jobId = (res.data as { jobId: string }).jobId;
    assert.ok(jobId);
    // Wait for the background worker to settle before asserting/cleanup.
    for (let i = 0; !notification && i < 2000; i++) await new Promise((r) => setTimeout(r, 10));
    assert.ok(notification, 'background worker must complete');
    const intent = s.g.getNode(intentId) as IntentNode;
    assert.equal(intent.state, 'done', `worker must finish its own intent (state=${intent.state})`);
    // Terminal intents release their claim: owner_job is cleared by design (recover never requeues done work).
    assert.equal(intent.ownerJob, null);
    const facts = s.g.listNodes(runId, { kind: 'fact' });
    assert.ok(facts.some((f) => f.origin === `worker:${jobId}` && String((f.payload as { text: string }).text).includes('prints hello')), 'worker fact persisted with harness-derived origin');
    const jobs = new JobStore(s.ws);
    try { assert.equal(jobs.get(jobId)?.status, 'completed'); } finally { jobs.close(); }
  } finally { await s.close(); }
});

test('real worker gate denies out-of-allowlist tools and out-of-scope targets', async () => {
  const s = setup('/srv/app');
  try {
    const { runId } = await startRun(s);
    const intent = s.g.addNode({ runId, kind: 'intent', payload: { archetype: 'recon', prompt: 'x', targets: ['/srv/app'], from: [] }, origin: 'lead' }) as IntentNode;
    assert.ok(s.g.claimNextIntent(runId, 'tok-g'));
    s.g.attachJob(intent.id, 'job-gate');
    const gate = makeOpsWorkerGate(s.ws, 'job-gate');
    // recon has no write_file — allowlist denial regardless of target.
    const notAllowed = gate({ name: 'write_file', input: { path: '/srv/app/x', content: 'y' } });
    assert.equal(notAllowed.allow, false);
    assert.match(notAllowed.reason!, /allowlist/);
    // bin_recon is target-touching: /etc is out of scope.
    const outOfScope = gate({ name: 'bin_recon', input: { path: '/etc/passwd' } });
    assert.equal(outOfScope.allow, false);
    assert.match(outOfScope.reason!, /scope/);
    // In-scope target-touching call passes; workspace reads are allowed by design (§5.2).
    assert.equal(gate({ name: 'bin_recon', input: { path: '/srv/app/main.py' } }).allow, true);
    assert.equal(gate({ name: 'read_file', input: { path: '/srv/app/main.py' } }).allow, true);
    // run_shell is denied for ALL ops workers even if somehow allowlisted.
    assert.equal(gate({ name: 'run_shell', input: { command: 'ls' } }).allow, false);
    // ops_writeback is always allowed for the worker (its lifeline).
    assert.equal(gate({ name: 'ops_writeback', input: { action: 'note_fact', payload: { text: 'x' } } }).allow, true);
    // Unknown job → fail closed.
    const stranger = makeOpsWorkerGate(s.ws, 'job-stranger');
    assert.equal(stranger({ name: 'read_file', input: { path: '/srv/app/x' } }).allow, false);
  } finally { await s.close(); }
});
// ── worker-loop gate (§4b): both enforcement points, durable denials ───────────────────────
const { AgentLoop } = await import('../src/agent/loop.js');
const { AutoApproveGate } = await import('../src/agent/approval.js');
const { ProjectCheckStore } = await import('../src/checks/store.js');
const { makeProjectChecksTool } = await import('../src/tools/projectChecks.js');
const { makeRunShell } = await import('../src/tools/runShell.js');
const { printFixture } = await import('./helpers/nativeShellFixture.js');
/** A claimed+attached verifier intent on a scoped run; returns gate-bound loop deps. */
function workerLoopFixture(s: ReturnType<typeof setup>, opts: { checkProfiles?: string[]; profiles?: string[] } = {}) {
  const run = s.g.activeRun()!;
  const intent = s.g.addNode({ runId: run.id, kind: 'intent', payload: { archetype: 'verifier', prompt: 'verify', targets: [], from: [], ...(opts.checkProfiles ? { checkProfiles: opts.checkProfiles } : {}) }, origin: 'lead' }) as IntentNode;
  assert.ok(s.g.claimNextIntent(run.id, 'tok-loop'));
  s.g.attachJob(intent.id, 'job-loop');
  const checks = new ProjectCheckStore(s.ws);
  checks.saveProfiles({ version: 1, profiles: (opts.profiles ?? ['bound', 'unbound']).map((id) => ({ id, title: id, command: printFixture(id) })) });
  const registry = new ToolRegistry();
  registry.register(makeProjectChecksTool(checks));
  registry.register(makeRunShell());
  registry.register(s.writeback);
  const bus = new EventBus();
  const events: Array<{ type: string }> = [];
  bus.on((e: { type: string }) => events.push(e));
  const context = new Context({ contextBudget: 100_000, triggerRatio: 0.9, keepLastTurns: 6 });
  const deps: LoopDeps = {
    provider: new MockProvider(), model: 'mock', registry, gate: new AutoApproveGate(), bus,
    budget: new Budget({ maxIterations: 10 }, 'mock', {}, Date.now()), context, checks,
    workspaceRoot: s.ws, signal: new AbortController().signal, system: 'worker', maxOutputTokens: 1024,
    dryRun: false, maxToolResultChars: 16_384, contextBudget: 100_000, sleep: async () => {},
    nestedAgent: true, currentWorkId: 'job-loop',
    opsGate: makeOpsWorkerGate(s.ws, 'job-loop'),
  } as LoopDeps;
  return { intent, checks, deps, events, loop: new AgentLoop(deps, 'full') };
}

test('worker loop: outer gate denies non-allowlisted tools with a durable policy hint', async () => {
  const s = setup('/srv/app');
  try {
    await startRun(s);
    const f = workerLoopFixture(s);
    const denied = await f.loop.runToolCall({ id: 'x1', name: 'run_shell', input: { command: printFixture('nope') } });
    assert.equal(denied.ok, false);
    assert.equal(denied.error?.code, 'not_executed');
    assert.match(denied.summary, /ops engagement policy/);
    assert.ok(f.events.some((e) => e.type === 'tool_denied'));
    const hints = s.g.listNodes(f.intent.runId, { kind: 'hint' });
    assert.ok(hints.some((h) => h.origin === 'policy'), 'denial recorded as durable negative evidence');
    // The verifier lifeline still works through the same loop.
    const wb = await f.loop.runToolCall({ id: 'x2', name: 'ops_writeback', input: { action: 'note_fact', payload: { text: 'gate observation' } } });
    assert.ok(wb.ok, wb.summary);
  } finally { await s.close(); }
});

test('worker loop: bound profile runs; unbound profile denied at the inner enforcement point', async () => {
  const s = setup('/srv/app');
  try {
    await startRun(s);
    const f = workerLoopFixture(s, { checkProfiles: ['bound'] });
    // Unbound profile: denied before any shell runs.
    const unbound = await f.loop.runToolCall({ id: 'u1', name: 'project_checks', input: { action: 'run', id: 'unbound' } });
    assert.equal(unbound.ok, false);
    assert.match(unbound.summary, /ops engagement policy/);
    assert.equal(f.checks.snapshot().find((p) => p.profile.id === 'unbound')?.latest, undefined, 'no check evidence for a denied profile');
    // Bound profile: admitted; the inner harness-created shell is exempt from the outer
    // run_shell ban because executeProjectCheck re-checked the binding (§4b point 2).
    const bound = await f.loop.runToolCall({ id: 'b1', name: 'project_checks', input: { action: 'run', id: 'bound' } });
    assert.ok(bound.ok, bound.summary);
    assert.equal(f.checks.snapshot().find((p) => p.profile.id === 'bound')?.latest?.status, 'passed');
    // A direct model-issued run_shell is still denied even after a bound check ran.
    const direct = await f.loop.runToolCall({ id: 'd1', name: 'run_shell', input: { command: printFixture('direct') } });
    assert.equal(direct.ok, false);
  } finally { await s.close(); }
});

test('worker loop: verifier with NO bound profiles cannot run any check (fail closed)', async () => {
  const s = setup('/srv/app');
  try {
    await startRun(s);
    const f = workerLoopFixture(s); // no checkProfiles on the intent
    const res = await f.loop.runToolCall({ id: 'n1', name: 'project_checks', input: { action: 'run', id: 'bound' } });
    assert.equal(res.ok, false);
    assert.match(res.summary, /bound|profile/i);
  } finally { await s.close(); }
});

test('lead loop has no opsGate: run_shell faces only the normal pipeline', async () => {
  const s = setup('/srv/app');
  try {
    await startRun(s);
    const registry = new ToolRegistry();
    registry.register(makeRunShell());
    const bus = new EventBus();
    const context = new Context({ contextBudget: 100_000, triggerRatio: 0.9, keepLastTurns: 6 });
    const deps: LoopDeps = {
      provider: new MockProvider(), model: 'mock', registry, gate: new AutoApproveGate(), bus,
      budget: new Budget({ maxIterations: 5 }, 'mock', {}, Date.now()), context,
      workspaceRoot: s.ws, signal: new AbortController().signal, system: 'lead', maxOutputTokens: 1024,
      dryRun: false, maxToolResultChars: 16_384, contextBudget: 100_000, sleep: async () => {},
    } as LoopDeps;
    const loop = new AgentLoop(deps, 'full');
    const res = await loop.runToolCall({ id: 'l1', name: 'run_shell', input: { command: printFixture('lead-ok') } });
    assert.ok(res.ok, res.summary);
  } finally { await s.close(); }
});
