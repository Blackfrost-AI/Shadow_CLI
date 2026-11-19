import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { isolateHome, assertStoreIsolated } from './helpers/isolateHome.js';
import type { IntentNode, IntentState } from '../src/security/ops/types.js';
import type { FindingStatus } from '../src/security/evidence.js';

const { home } = isolateHome('ops-graph');
const globalStore = await import('../src/state/globalStore.js');
assertStoreIsolated(globalStore.GLOBAL_DIR, home);
const { OpsGraph } = await import('../src/security/ops/graph.js');
const { canTransition, SecretInPayloadError, MAX_PAYLOAD_BYTES } = await import('../src/security/ops/types.js');

function graph(statuses: Record<string, FindingStatus> = {}) {
  const ws = mkdtempSync(join(tmpdir(), 'ops-graph-ws-'));
  const g = new OpsGraph(ws, {
    findingStatus: (id) => {
      const s = statuses[id];
      if (!s) throw new Error(`unknown ledger id ${id}`);
      return s;
    },
  });
  const run = g.startRun({ engagementId: 'eng-1', objective: 'test objective' });
  return {
    g,
    ws,
    run,
    intent: (prompt = 'do work', priority = 0, targets: string[] = []) =>
      g.addNode({ runId: run.id, kind: 'intent', payload: { prompt, archetype: 'recon', targets }, priority, origin: 'lead' }) as IntentNode,
    close: () => {
      g.close();
      rmSync(ws, { recursive: true, force: true });
    },
  };
}

test('CRUD: run + nodes round-trip, list filters, getNode', () => {
  const { g, run, close } = graph();
  try {
    assert.equal(g.getRun(run.id).objective, 'test objective');
    assert.equal(g.activeRun()?.id, run.id);
    const asset = g.addNode({ runId: run.id, kind: 'asset', payload: { path: '/t/login.ts' }, origin: 'lead' });
    const fact = g.addNode({ runId: run.id, kind: 'fact', payload: { text: 'no rate limit' }, origin: 'lead', anchors: [asset.id] });
    assert.equal(g.getNode(fact.id).kind, 'fact');
    assert.deepEqual(g.anchorIds(fact.id), [asset.id]);
    assert.equal(g.listNodes(run.id, { kind: 'asset' }).length, 1);
    assert.equal(g.listNodes(run.id).length, 2);
    assert.throws(() => g.getNode(99999), /Unknown node/);
    assert.throws(() => g.getRun('nope'), /Unknown run/);
  } finally { close(); }
});

test('anchors must exist AND share run_id', () => {
  const { g, run, close } = graph();
  try {
    assert.throws(() => g.addNode({ runId: run.id, kind: 'fact', payload: { text: 'x' }, origin: 'lead', anchors: [4242] }), /Anchor node not found/);
    const other = g.startRun({ engagementId: 'eng-2', objective: 'other' });
    const foreign = g.addNode({ runId: other.id, kind: 'asset', payload: { path: '/other' }, origin: 'lead' });
    assert.throws(() => g.addNode({ runId: run.id, kind: 'fact', payload: { text: 'x' }, origin: 'lead', anchors: [foreign.id] }), /different run/);
  } finally { close(); }
});

test('payload cap + secret gate on addNode', () => {
  const { g, run, close } = graph();
  try {
    assert.throws(() => g.addNode({ runId: run.id, kind: 'fact', payload: { blob: 'x'.repeat(MAX_PAYLOAD_BYTES) }, origin: 'lead' }), /cap/);
    assert.throws(() => g.addNode({ runId: run.id, kind: 'fact', payload: { text: 'key sk-' + 'q'.repeat(20) }, origin: 'lead' }), SecretInPayloadError);
    assert.equal(g.listNodes(run.id).length, 0, 'rejected writes leave no trace');
  } finally { close(); }
});

test('every legal/illegal intent transition via markIntent', () => {
  const legal: Array<[IntentState, IntentState]> = [
    ['open', 'claimed'], ['open', 'stopped'],
    ['claimed', 'running'], ['claimed', 'open'], ['claimed', 'stopped'],
    ['running', 'done'], ['running', 'blocked'], ['running', 'exhausted'], ['running', 'stopped'], ['running', 'open'],
  ];
  for (const [a, b] of legal) assert.ok(canTransition(a, b), `${a}→${b} legal`);
  const illegal: Array<[IntentState, IntentState]> = [
    ['open', 'running'], ['open', 'done'], ['open', 'blocked'], ['open', 'exhausted'], ['open', 'open'],
    ['claimed', 'done'], ['claimed', 'claimed'], ['claimed', 'blocked'], ['claimed', 'exhausted'],
    ['running', 'claimed'], ['running', 'running'],
    ['done', 'open'], ['done', 'running'], ['done', 'stopped'],
    ['blocked', 'open'], ['exhausted', 'open'], ['stopped', 'open'], ['stopped', 'running'],
  ];
  for (const [a, b] of illegal) assert.ok(!canTransition(a, b), `${a}→${b} illegal`);

  const { g, run, intent, close } = graph();
  try {
    const i = intent();
    assert.throws(() => g.markIntent(i.id, 'done'), /Illegal intent transition/);
    g.markIntent(i.id, 'claimed');
    g.markIntent(i.id, 'running');
    assert.throws(() => g.markIntent(i.id, 'blocked'), /blocked_reason/);
    g.markIntent(i.id, 'blocked', { blocked_reason: 'needs credentials' });
    assert.throws(() => g.markIntent(i.id, 'open'), /Illegal intent transition/);
    assert.throws(() => g.markIntent(i.id, 'running'), /Illegal intent transition/);
    const goal = g.addNode({ runId: run.id, kind: 'goal', payload: { text: 'g' }, origin: 'lead' });
    assert.throws(() => g.markIntent(goal.id, 'done'), /not an intent/);
  } finally { close(); }
});

test('claim → attach → done flow; owner_job swaps token for job id; intent_done trigger', () => {
  const { g, run, intent, close } = graph();
  try {
    const i = intent('map auth surface');
    const claimed = g.claimNextIntent(run.id, 'tok-1');
    assert.ok(claimed);
    assert.equal(claimed!.id, i.id);
    assert.equal(claimed!.state, 'claimed');
    assert.equal(claimed!.ownerJob, 'tok-1');
    assert.ok(claimed!.claimedAt);
    g.attachJob(i.id, 'job-42');
    const running = g.getNode(i.id) as IntentNode;
    assert.equal(running.state, 'running');
    assert.equal(running.ownerJob, 'job-42');
    g.markIntent(i.id, 'done', { summary: 'mapped' });
    const done = g.getNode(i.id) as IntentNode;
    assert.equal(done.state, 'done');
    assert.ok(done.completedAt);
    assert.equal(done.ownerJob, null);
    assert.ok(g.pendingTriggers(run.id).some((t) => t.kind === 'intent_done' && t.nodeId === i.id));
    assert.throws(() => g.attachJob(i.id, 'job-43'), /not claimed/);
  } finally { close(); }
});

test('concurrent claim: two claims, one winner (single open intent)', () => {
  const { g, run, intent, close } = graph();
  try {
    intent();
    const a = g.claimNextIntent(run.id, 'tok-A');
    const b = g.claimNextIntent(run.id, 'tok-B');
    assert.ok(a, 'first claim wins');
    assert.equal(b, null, 'second claim gets nothing');
  } finally { close(); }
});

test('claim ordering: priority DESC then FIFO id', () => {
  const { g, run, intent, close } = graph();
  try {
    const low = intent('low', 0);
    const high = intent('high', 5);
    const high2 = intent('high2', 5);
    assert.equal(g.claimNextIntent(run.id, 't1')!.id, high.id);
    assert.equal(g.claimNextIntent(run.id, 't2')!.id, high2.id);
    assert.equal(g.claimNextIntent(run.id, 't3')!.id, low.id);
    assert.equal(g.claimNextIntent(run.id, 't4'), null);
  } finally { close(); }
});

test('claim release on failure: claimed → open immediately; running cannot be released', () => {
  const { g, run, intent, close } = graph();
  try {
    const i = intent();
    g.claimNextIntent(run.id, 'tok');
    g.releaseClaim(i.id);
    const open = g.getNode(i.id) as IntentNode;
    assert.equal(open.state, 'open');
    assert.equal(open.ownerJob, null);
    assert.equal(open.claimedAt, null);
    assert.ok(g.claimNextIntent(run.id, 'tok2'), 'reclaimable');
    g.attachJob(i.id, 'job-1');
    assert.throws(() => g.releaseClaim(i.id), /only claimed/);
  } finally { close(); }
});

test('crash recovery: expired claim token → open; dead running job → open; live job untouched', () => {
  const { g, run, intent, close } = graph();
  try {
    const claimAndRun = (id: number, jobId: string) => {
      let c = g.claimNextIntent(run.id, `tok-${jobId}`);
      while (c && c.id !== id) c = g.claimNextIntent(run.id, `tok-${jobId}`);
      assert.ok(c, 'target intent claimed');
      g.attachJob(id, jobId);
    };
    // Claim-token owners expire purely on claimed_at age.
    const stale = intent('stale claim');
    g.claimNextIntent(run.id, 'tok-stale');
    const fresh = intent('fresh claim');
    g.claimNextIntent(run.id, 'tok-fresh');
    assert.equal(g.recoverOrphans(run.id, () => true, 0), 2, 'ttl=0 expires both claims');
    assert.equal((g.getNode(stale.id) as IntentNode).state, 'open');
    assert.equal((g.getNode(fresh.id) as IntentNode).state, 'open');
    // Default ttl: fresh claims survive.
    g.claimNextIntent(run.id, 'tok-x');
    assert.equal(g.recoverOrphans(run.id, () => true), 0);

    // Running owners recover on liveness only — never on age.
    const dead = intent('dead job');
    claimAndRun(dead.id, 'job-dead');
    const live = intent('live job');
    claimAndRun(live.id, 'job-live');
    const n = g.recoverOrphans(run.id, (jobId) => jobId === 'job-live', 0);
    assert.equal(n, 3, 'dead running job + leftover claimed tokens recovered');
    assert.equal((g.getNode(dead.id) as IntentNode).state, 'open');
    assert.equal((g.getNode(live.id) as IntentNode).state, 'running', 'live job survives ttl=0');
    // Throwing liveness probe → treated alive (fail toward no double-dispatch).
    g.recoverOrphans(run.id, () => { throw new Error('probe down'); }, 0);
    assert.equal((g.getNode(live.id) as IntentNode).state, 'running');
    // Age alone never reclaims a running intent.
    g.recoverOrphans(run.id, () => true, 0);
    assert.equal((g.getNode(live.id) as IntentNode).state, 'running');
  } finally { close(); }
});

test('reopen: terminal → open only via reopenIntent, lead/operator origin, reason recorded', () => {
  const { g, intent, close } = graph();
  try {
    const i = intent();
    g.markIntent(i.id, 'stopped');
    assert.throws(() => g.reopenIntent(i.id, 'retry', 'worker:job-1'), /lead\/operator/);
    g.reopenIntent(i.id, 'operator retry', 'operator');
    const open = g.getNode(i.id) as IntentNode;
    assert.equal(open.state, 'open');
    assert.equal(open.payload.reopenReason, 'operator retry');
    assert.equal(open.completedAt, null);
    assert.throws(() => g.reopenIntent(i.id, 'again', 'lead'), /not reopenable/);
  } finally { close(); }
});

test('triggers: exact §3 kinds; facts/hints emit nothing; consume + restart no double-feed', () => {
  const { g, run, intent } = graph();
  try {
    const asset = g.addNode({ runId: run.id, kind: 'asset', payload: { path: '/t' }, origin: 'lead' });
    g.addNode({ runId: run.id, kind: 'fact', payload: { text: 'f' }, origin: 'lead', anchors: [asset.id] });
    g.addNode({ runId: run.id, kind: 'hint', payload: { text: 'h' }, origin: 'lead' });
    g.addNode({ runId: run.id, kind: 'finding', payload: { title: 'bug', ledgerId: 'L1' }, origin: 'lead' });
    const i = intent();
    g.markIntent(i.id, 'claimed');
    g.markIntent(i.id, 'running');
    g.markIntent(i.id, 'exhausted', { summary: 'no write-back' });
    const kinds = g.pendingTriggers(run.id).map((t) => t.kind).sort();
    assert.deepEqual(kinds, ['asset_new', 'finding_new'], 'only asset_new/finding_new so far; exhausted emits nothing');
    const goal = g.addNode({ runId: run.id, kind: 'goal', payload: { text: 'prove' }, origin: 'lead' });
    g.abandonGoal(goal.id, 'out of scope', 'lead');
    assert.ok(!g.pendingTriggers(run.id).some((t) => t.kind === 'goal_met'), 'abandoned goal emits nothing');
    const pending = g.pendingTriggers(run.id);
    g.consumeTriggers(run.id, pending[pending.length - 1].seq);
    assert.equal(g.pendingTriggers(run.id).length, 0);
    // restart: reopen the DB — consumed flag is durable, no double-feed
    g.close();
    const g2 = new OpsGraph(run ? (g as unknown as { workspace: string }).workspace : '', { findingStatus: () => 'open' });
    assert.equal(g2.pendingTriggers(run.id).length, 0, 'restart does not re-feed consumed triggers');
    g2.close();
  } finally {
    try { rmSync((g as unknown as { workspace: string }).workspace, { recursive: true, force: true }); } catch { /* already closed */ }
  }
});

test('attestGoal: ≥1 verified ledger finding accepted; unverified/unknown rejected; operator-only override', () => {
  const { g, run, close } = graph({ 'L-good': 'verified', 'L-open': 'open' });
  try {
    const good = g.addNode({ runId: run.id, kind: 'finding', payload: { title: 'vuln', ledgerId: 'L-good' }, origin: 'lead' });
    const openF = g.addNode({ runId: run.id, kind: 'finding', payload: { title: 'claim', ledgerId: 'L-open' }, origin: 'lead' });
    const unknown = g.addNode({ runId: run.id, kind: 'finding', payload: { title: 'ghost', ledgerId: 'L-missing' }, origin: 'lead' });
    const goal = g.addNode({ runId: run.id, kind: 'goal', payload: { text: 'prove bypass' }, origin: 'lead' });
    assert.throws(() => g.attestGoal(goal.id, [openF.id], 'lead'), /verified/);
    assert.throws(() => g.attestGoal(goal.id, [unknown.id], 'lead'), /verified/, 'unknown ledger id fails closed');
    assert.throws(() => g.attestGoal(goal.id, [], 'lead'), /verified/);
    assert.throws(() => g.attestGoal(goal.id, [good.id], 'worker:job-1'), /lead\/operator/);
    assert.throws(() => g.attestGoal(goal.id, [], 'lead', 'override'), /operator-only/);
    // ≥1 verified among mixed evidence suffices
    g.attestGoal(goal.id, [openF.id, good.id], 'lead');
    const met = g.getNode(goal.id);
    assert.equal(met.state, 'met');
    assert.ok(g.anchorIds(goal.id).includes(good.id));
    assert.ok(g.pendingTriggers(run.id).some((t) => t.kind === 'goal_met'));
    assert.throws(() => g.attestGoal(goal.id, [good.id], 'lead'), /already met/);
    // operator override with recorded reason, no evidence needed
    const goal2 = g.addNode({ runId: run.id, kind: 'goal', payload: { text: 'accepted risk' }, origin: 'lead' });
    g.attestGoal(goal2.id, [], 'operator', 'risk accepted by operator');
    assert.equal(g.getNode(goal2.id).payload.reason, 'risk accepted by operator');
    // non-finding evidence rejected
    const goal3 = g.addNode({ runId: run.id, kind: 'goal', payload: { text: 'g3' }, origin: 'lead' });
    const fact = g.addNode({ runId: run.id, kind: 'fact', payload: { text: 'not a finding' }, origin: 'lead' });
    assert.throws(() => g.attestGoal(goal3.id, [fact.id], 'lead'), /not a finding/);
  } finally { close(); }
});

test('operator-only paths reject lead/worker origin where required', () => {
  const { g, run, close } = graph();
  try {
    const goal = g.addNode({ runId: run.id, kind: 'goal', payload: { text: 'g' }, origin: 'lead' });
    assert.throws(() => g.abandonGoal(goal.id, 'no', 'worker:j'), /lead\/operator/);
    assert.throws(() => g.setRunStatus(run.id, 'paused', 'worker:j'), /lead\/operator/);
    g.abandonGoal(goal.id, 'dropped', 'lead');
    assert.equal(g.getNode(goal.id).state, 'abandoned');
    assert.throws(() => g.abandonGoal(goal.id, 'again', 'lead'), /cannot be abandoned/);
  } finally { close(); }
});

test('supersede: existing replacement, same run+kind, history kept, old hidden by default', () => {
  const { g, run, close } = graph();
  try {
    const old = g.addNode({ runId: run.id, kind: 'fact', payload: { text: 'initial guess' }, origin: 'lead' });
    const repl = g.addNode({ runId: run.id, kind: 'fact', payload: { text: 'corrected' }, origin: 'lead' });
    g.supersede(old.id, repl.id);
    assert.equal(g.getNode(old.id).state, 'superseded');
    assert.equal(g.getNode(old.id).payload.supersededBy, repl.id);
    assert.equal(g.listNodes(run.id, { kind: 'fact' }).length, 1);
    assert.equal(g.listNodes(run.id, { kind: 'fact', includeSuperseded: true }).length, 2);
    assert.throws(() => g.supersede(old.id, repl.id), /already superseded/);
    const asset = g.addNode({ runId: run.id, kind: 'asset', payload: { path: '/a' }, origin: 'lead' });
    assert.throws(() => g.supersede(asset.id, repl.id), /kind/);
    const goal = g.addNode({ runId: run.id, kind: 'goal', payload: { text: 'g' }, origin: 'lead' });
    assert.throws(() => g.supersede(goal.id, repl.id), /Only data nodes/);
    const other = g.startRun({ engagementId: 'e2', objective: 'o' });
    const foreign = g.addNode({ runId: other.id, kind: 'fact', payload: { text: 'x' }, origin: 'lead' });
    assert.throws(() => g.supersede(repl.id, foreign.id), /different run/);
  } finally { close(); }
});

test('run status: paused blocks new intents; complete requires all goals resolved; terminal locked', () => {
  const { g, run, intent, close } = graph({ 'L-v': 'verified' });
  try {
    const goal = g.addNode({ runId: run.id, kind: 'goal', payload: { text: 'g' }, origin: 'lead' });
    assert.throws(() => g.setRunStatus(run.id, 'complete', 'lead'), /goal\(s\) still open/);
    g.setRunStatus(run.id, 'paused', 'lead');
    assert.throws(() => intent('blocked by pause'), /paused/);
    g.setRunStatus(run.id, 'active', 'operator');
    const finding = g.addNode({ runId: run.id, kind: 'finding', payload: { title: 'v', ledgerId: 'L-v' }, origin: 'lead' });
    g.attestGoal(goal.id, [finding.id], 'lead');
    g.setRunStatus(run.id, 'complete', 'lead');
    assert.equal(g.getRun(run.id).status, 'complete');
    assert.throws(() => g.setRunStatus(run.id, 'active', 'lead'), /already complete/);
    assert.throws(() => intent('after complete'), /complete/);
  } finally { close(); }
});

test('overview: bounded render, coverage facts-only, stale-evidence warning, superseded folded first', () => {
  const { g, run, close } = graph({ 'L-stale': 'open' });
  try {
    const asset = g.addNode({ runId: run.id, kind: 'asset', payload: { path: '/t/app' }, origin: 'lead' });
    g.addNode({ runId: run.id, kind: 'fact', payload: { text: 'explored' }, origin: 'lead', anchors: [asset.id] });
    const asset2 = g.addNode({ runId: run.id, kind: 'asset', payload: { path: '/t/other' }, origin: 'lead' });
    g.addNode({ runId: run.id, kind: 'finding', payload: { title: 'unexplored-anchored', ledgerId: 'L-stale' }, origin: 'lead', anchors: [asset2.id] });
    const cov = g.coverage(run.id);
    assert.equal(cov.assetsTotal, 2);
    assert.equal(cov.assetsWithFact, 1, 'finding anchor does not count as fact coverage');
    const goal = g.addNode({ runId: run.id, kind: 'goal', payload: { text: 'prove' }, origin: 'lead' });
    g.attestGoal(goal.id, [], 'operator', 'override');
    const ov = g.overview(run.id);
    assert.ok(ov.text.includes('no longer verified'), 'stale-evidence warning on met goal anchor');
    assert.ok(ov.text.includes('coverage: 1/2'));
    // node cap
    for (let i = 0; i < 12; i++) g.addNode({ runId: run.id, kind: 'fact', payload: { text: `fact ${i} with descriptive text` }, origin: 'lead' });
    const capped = g.overview(run.id, { maxNodes: 4 });
    assert.equal(capped.truncated, true);
    assert.ok(capped.text.includes('truncated'));
    // superseded folded first
    const old = g.addNode({ runId: run.id, kind: 'hint', payload: { text: 'old hint' }, origin: 'lead' });
    const repl = g.addNode({ runId: run.id, kind: 'hint', payload: { text: 'new hint' }, origin: 'lead' });
    g.supersede(old.id, repl.id);
    const folded = g.overview(run.id, { maxNodes: 6 });
    assert.ok(!folded.text.includes('old hint') || folded.text.indexOf('new hint') < folded.text.indexOf('old hint'));
  } finally { close(); }
});

test('run locks: single dispatcher per run, same-session idempotent, release scoped to holder', () => {
  const { g, run, close } = graph();
  try {
    assert.equal(g.acquireLock(run.id, 'session-A'), true);
    assert.equal(g.acquireLock(run.id, 'session-B'), false, 'second session denied');
    assert.equal(g.acquireLock(run.id, 'session-A'), true, 'same session idempotent');
    g.releaseLock(run.id, 'session-B');
    assert.equal(g.getLock(run.id)?.sessionId, 'session-A', 'foreign release is a no-op');
    g.releaseLock(run.id, 'session-A');
    assert.equal(g.getLock(run.id), undefined);
    assert.equal(g.acquireLock(run.id, 'session-B'), true);
  } finally { close(); }
});

test('persistence: reopened store sees runs, nodes, claims, locks', () => {
  const ws = mkdtempSync(join(tmpdir(), 'ops-persist-'));
  try {
    const g1 = new OpsGraph(ws, { findingStatus: () => 'open' });
    const run = g1.startRun({ engagementId: 'eng', objective: 'persist' });
    g1.addNode({ runId: run.id, kind: 'asset', payload: { path: '/t' }, origin: 'lead' });
    const i = g1.addNode({ runId: run.id, kind: 'intent', payload: { prompt: 'p', archetype: 'recon', targets: [] }, origin: 'lead' });
    g1.claimNextIntent(run.id, 'tok-p');
    g1.acquireLock(run.id, 'sess-p');
    g1.close();
    const g2 = new OpsGraph(ws, { findingStatus: () => 'open' });
    assert.equal(g2.listRuns().length, 1);
    assert.equal(g2.listNodes(run.id).length, 2);
    assert.equal((g2.getNode(i.id) as IntentNode).state, 'claimed');
    assert.equal((g2.getNode(i.id) as IntentNode).ownerJob, 'tok-p');
    assert.equal(g2.acquireLock(run.id, 'other'), false, 'lock survives restart');
    g2.close();
  } finally { rmSync(ws, { recursive: true, force: true }); }
});