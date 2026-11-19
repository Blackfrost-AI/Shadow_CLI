/**
 * Phase 3a — ops_graph / ops_writeback / ops_enrich tool surface (plan §7).
 * Harness-derived origin (§1.4), lead-only graph control, worker write-back gate,
 * secret/size payload gate (§5), scope-validated intents (§4a), dry-run contract.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { isolateHome, assertStoreIsolated } from './helpers/isolateHome.js';

const { home } = isolateHome('ops-tools');
const globalStore = await import('../src/state/globalStore.js');
assertStoreIsolated(globalStore.GLOBAL_DIR, home);
const { OpsGraph } = await import('../src/security/ops/graph.js');
const { OpsRuntime } = await import('../src/security/ops/runtime.js');
const { makeOpsGraphTool, makeOpsWritebackTool, makeOpsEnrichTool, originFromCtx } = await import('../src/tools/opsTools.js');
const { EngagementStore } = await import('../src/tools/engagementOps.js');
const { EvidenceStore } = await import('../src/security/evidence.js');
const { MAX_PAYLOAD_BYTES } = await import('../src/security/ops/types.js');
import type { ToolContext } from '../src/tools/types.js';
import type { IntentNode } from '../src/security/ops/types.js';

function mkCtx(ws: string, over: Partial<ToolContext> = {}): ToolContext {
  return { workspaceRoot: ws, signal: AbortSignal.timeout(30_000), ...over } as ToolContext;
}
const workerCtx = (ws: string, jobId = 'job-1') => mkCtx(ws, { nestedAgent: true, currentWorkId: jobId } as Partial<ToolContext>);

function setup(scope?: string) {
  const ws = mkdtempSync(join(tmpdir(), 'ops-tools-ws-'));
  const g = new OpsGraph(ws, { findingStatus: () => 'open' });
  let engagementId = 'eng-tools';
  if (scope !== undefined) {
    const eng = new EngagementStore(ws);
    try {
      engagementId = eng.start({ objective: 'tool test', scope, successCriteria: 'recorded facts' }).id;
    } finally {
      eng.close();
    }
  }
  const run = g.startRun({ engagementId, objective: 'tool test run' });
  const runtime = new OpsRuntime();
  const deps = runtime.deps();
  const graphTool = makeOpsGraphTool(deps);
  const writeback = makeOpsWritebackTool(deps);
  const enrich = makeOpsEnrichTool(deps);
  return {
    ws, g, run, runtime, deps, graphTool, writeback, enrich,
    close: async () => {
      await runtime.dispose();
      g.close();
      rmSync(ws, { recursive: true, force: true });
    },
  };
}

/** Lead plans an intent, dispatcher-claim it, attach a worker job. */
function runningIntent(s: ReturnType<typeof setup>, jobId = 'job-1'): IntentNode {
  const intent = s.g.addNode({ runId: s.run.id, kind: 'intent', payload: { archetype: 'recon', prompt: 'inventory', targets: [], from: [] }, origin: 'lead' }) as IntentNode;
  const claimed = s.g.claimNextIntent(s.run.id, 'tok-1');
  assert.ok(claimed && claimed.id === intent.id);
  s.g.attachJob(intent.id, jobId);
  return s.g.getNode(intent.id) as IntentNode;
}

// ── origin derivation (§1.4) ──────────────────────────────────────────────────────────────
test('originFromCtx: lead, worker:<jobId>, and fail-closed on missing work id', () => {
  const ws = '/tmp/unused';
  assert.equal(originFromCtx(mkCtx(ws)), 'lead');
  assert.equal(originFromCtx(workerCtx(ws, 'job-9')), 'worker:job-9');
  const bad = originFromCtx(mkCtx(ws, { nestedAgent: true } as Partial<ToolContext>));
  assert.ok(typeof bad === 'object' && 'error' in bad);
});

test('no schema accepts an origin field; tool results never carry operator origin', async () => {
  const s = setup();
  try {
    for (const tool of [s.graphTool, s.writeback, s.enrich]) {
      const schema = JSON.stringify((tool.inputSchema as unknown as { _def: unknown })._def);
      assert.ok(!/"origin"/.test(schema), `${tool.name} schema must not expose origin`);
      assert.equal(tool.deferred, true);
      assert.ok((tool.searchAliases ?? []).length > 0);
    }
  } finally { await s.close(); }
});

// ── ops_graph lead-only + observation ─────────────────────────────────────────────────────
test('ops_graph is lead-only; workers are pointed at ops_writeback', async () => {
  const s = setup();
  try {
    const r = await s.graphTool.run({ action: 'overview' }, workerCtx(s.ws));
    assert.equal(r.ok, false);
    assert.equal(r.error?.code, 'denied');
  } finally { await s.close(); }
});

test('ops_graph observation: overview, runs, list_nodes, node_detail, coverage', async () => {
  const s = setup();
  try {
    const ctx = mkCtx(s.ws);
    const ov = await s.graphTool.run({ action: 'overview' }, ctx);
    assert.equal(ov.ok, true);
    const runs = await s.graphTool.run({ action: 'runs' }, ctx);
    assert.equal(runs.ok, true);
    const fact = s.g.addNode({ runId: s.run.id, kind: 'fact', payload: { note: 'x' }, origin: 'lead' });
    const detail = await s.graphTool.run({ action: 'node_detail', node_id: fact.id }, ctx);
    assert.equal(detail.ok, true);
    const list = await s.graphTool.run({ action: 'list_nodes', kind: 'fact' }, ctx);
    assert.equal(list.ok, true);
    const cov = await s.graphTool.run({ action: 'coverage' }, ctx);
    assert.equal(cov.ok, true);
    const missing = await s.graphTool.run({ action: 'node_detail' }, ctx);
    assert.equal(missing.ok, false);
    assert.equal(missing.error?.code, 'bad_input');
  } finally { await s.close(); }
});

test('ops_graph triggers: intent_done surfaces, consume advances the cursor', async () => {
  const s = setup();
  try {
    const ctx = mkCtx(s.ws);
    const intent = runningIntent(s);
    s.g.addNode({ runId: s.run.id, kind: 'fact', payload: { ok: true }, origin: 'worker:job-1', anchors: [intent.id] });
    s.g.markIntent(intent.id, 'done', { summary: 'inventoried' });
    const pend = await s.graphTool.run({ action: 'pending_triggers' }, ctx);
    assert.equal(pend.ok, true);
    const triggers = (pend.data as { triggers: Array<{ seq: number; kind: string }> }).triggers;
    assert.ok(triggers.some((t) => t.kind === 'intent_done'));
    const lastSeq = triggers[triggers.length - 1]!.seq;
    const consumed = await s.graphTool.run({ action: 'consume_triggers', through_seq: lastSeq }, ctx);
    assert.equal(consumed.ok, true);
    const after = await s.graphTool.run({ action: 'pending_triggers' }, ctx);
    assert.equal((after.data as { triggers: unknown[] }).triggers.length, 0);
    const noSeq = await s.graphTool.run({ action: 'consume_triggers' }, ctx);
    assert.equal(noSeq.ok, false);
  } finally { await s.close(); }
});

// ── plan_intent / set_goal / attest_goal (lead) ───────────────────────────────────────────
test('plan_intent queues a typed intent; weak-model stringified arrays are parsed', async () => {
  const s = setup();
  try {
    const r = await s.graphTool.run({ action: 'plan_intent', archetype: 'recon', prompt: 'map it', from: '[1]' as unknown as number[] }, mkCtx(s.ws));
    // from [1] references a nonexistent anchor only if enforced; anchors to missing nodes are tolerated or denied — either way schema parsed.
    if (r.ok) {
      const id = (r.data as { nodeId: number }).nodeId;
      const node = s.g.getNode(id) as IntentNode;
      assert.equal(node.kind, 'intent');
      assert.equal(node.payload.archetype, 'recon');
      assert.equal(node.origin, 'lead');
    } else {
      assert.notEqual(r.error?.code, 'bad_input'); // must not be a schema failure on the stringified array
    }
    const missing = await s.graphTool.run({ action: 'plan_intent', archetype: 'recon' }, mkCtx(s.ws));
    assert.equal(missing.ok, false);
  } finally { await s.close(); }
});

test('plan_intent validates targets against engagement scope (§4a deny-only)', async () => {
  const s = setup(`${process.cwd()}`); // scope = this repo root (absolute path token)
  try {
    const ctx = mkCtx(s.ws);
    const inScope = await s.graphTool.run({ action: 'plan_intent', archetype: 'recon', prompt: 'audit', targets: [join(process.cwd(), 'src')] }, ctx);
    assert.equal(inScope.ok, true);
    const out = await s.graphTool.run({ action: 'plan_intent', archetype: 'auditor', prompt: 'audit', targets: ['/etc/passwd'] }, ctx);
    assert.equal(out.ok, false);
    assert.equal(out.error?.code, 'denied');
    assert.match(out.error!.message, /out of scope/i);
  } finally { await s.close(); }
});

test('plan_intent with targets but unreadable engagement fails closed', async () => {
  const s = setup(); // no engagement persisted for eng-tools
  try {
    const r = await s.graphTool.run({ action: 'plan_intent', archetype: 'recon', prompt: 'x', targets: ['/etc'] }, mkCtx(s.ws));
    assert.equal(r.ok, false);
    assert.equal(r.error?.code, 'denied');
  } finally { await s.close(); }
});

test('set_goal + attest_goal: unverified evidence cannot attest; workers cannot attest', async () => {
  const s = setup();
  try {
    const ctx = mkCtx(s.ws);
    const goal = await s.graphTool.run({ action: 'set_goal', text: 'inventory complete' }, ctx);
    assert.equal(goal.ok, true);
    const goalId = (goal.data as { nodeId: number }).nodeId;
    const noEvidence = await s.graphTool.run({ action: 'attest_goal', goal_id: goalId }, ctx);
    assert.equal(noEvidence.ok, false);
    assert.equal(noEvidence.error?.code, 'denied');
    // File a finding (ledger status stays 'open' — no live check) and try to attest with it.
    const filed = await s.writeback.run({ action: 'file_finding', finding: { title: 'weak tls', path: 'src/a.ts' } }, workerCtx(s.ws));
    assert.equal(filed.ok, true);
    const findingNodeId = (filed.data as { nodeId: number }).nodeId;
    const unverified = await s.graphTool.run({ action: 'attest_goal', goal_id: goalId, evidence_node_ids: [findingNodeId] }, ctx);
    assert.equal(unverified.ok, false);
    assert.equal(unverified.error?.code, 'denied');
    const workerAttempt = await s.graphTool.run({ action: 'attest_goal', goal_id: goalId, evidence_node_ids: [findingNodeId] }, workerCtx(s.ws));
    assert.equal(workerAttempt.ok, false); // lead-only tool
  } finally { await s.close(); }
});

test('stop_intent / reopen_intent record lead control with reason', async () => {
  const s = setup();
  try {
    const ctx = mkCtx(s.ws);
    const intent = s.g.addNode({ runId: s.run.id, kind: 'intent', payload: { archetype: 'recon', prompt: 'p', targets: [] }, origin: 'lead' }) as IntentNode;
    const stopped = await s.graphTool.run({ action: 'stop_intent', node_id: intent.id }, ctx);
    assert.equal(stopped.ok, true);
    assert.equal((s.g.getNode(intent.id) as IntentNode).state, 'stopped');
    const reopened = await s.graphTool.run({ action: 'reopen_intent', node_id: intent.id, reason: 'new evidence arrived' }, ctx);
    assert.equal(reopened.ok, true);
    assert.equal((s.g.getNode(intent.id) as IntentNode).state, 'open');
    const noReason = await s.graphTool.run({ action: 'reopen_intent', node_id: intent.id }, ctx);
    assert.equal(noReason.ok, false);
  } finally { await s.close(); }
});

// ── ops_writeback ─────────────────────────────────────────────────────────────────────────
test('note_fact / add_note persist worker-attributed nodes with anchors', async () => {
  const s = setup();
  try {
    const asset = s.g.addNode({ runId: s.run.id, kind: 'asset', payload: { path: 'a.bin' }, origin: 'lead' });
    const fact = await s.writeback.run({ action: 'note_fact', payload: { port: 443 }, anchors: [asset.id] }, workerCtx(s.ws, 'job-7'));
    assert.equal(fact.ok, true);
    const node = s.g.getNode((fact.data as { nodeId: number }).nodeId);
    assert.equal(node.kind, 'fact');
    assert.equal(node.origin, 'worker:job-7');
    assert.deepEqual(s.g.anchorIds(node.id), [asset.id]);
    const hint = await s.writeback.run({ action: 'add_note', text: 'looks packed' }, workerCtx(s.ws, 'job-7'));
    assert.equal(hint.ok, true);
    assert.equal(s.g.getNode((hint.data as { nodeId: number }).nodeId).kind, 'hint');
    const empty = await s.writeback.run({ action: 'note_fact' }, workerCtx(s.ws));
    assert.equal(empty.ok, false);
  } finally { await s.close(); }
});

test('file_finding writes ledger + graph atomically and returns both ids', async () => {
  const s = setup();
  try {
    const r = await s.writeback.run({ action: 'file_finding', finding: { title: 'hardcoded key', rule: 'secret/test', path: 'src/x.ts', line: 12, severity: 'error' } }, workerCtx(s.ws));
    assert.equal(r.ok, true);
    const data = r.data as { nodeId: number; ledgerId: string; added: number };
    assert.equal(data.added, 1);
    const node = s.g.getNode(data.nodeId);
    assert.equal(node.kind, 'finding');
    assert.equal(node.payload.ledgerId, data.ledgerId);
    assert.equal(node.origin, 'worker:job-1');
    const ev = new EvidenceStore(s.ws);
    try {
      const ledger = ev.get(data.ledgerId);
      assert.equal(ledger.title, 'hardcoded key');
      assert.equal(ledger.status, 'open'); // a claim until a live check verifies it
      assert.equal(ledger.source, 'worker:job-1');
    } finally { ev.close(); }
    assert.match(r.summary, /claim/i);
  } finally { await s.close(); }
});

test('register_asset queues local enrichment; results land as anchored facts/hints', async () => {
  const s = setup();
  try {
    writeFileSync(join(s.ws, 'sample.bin'), Buffer.from([0x7f, 0x45, 0x4c, 0x46, 1, 2, 3]));
    const r = await s.writeback.run({ action: 'register_asset', payload: { path: 'sample.bin' } }, workerCtx(s.ws));
    assert.equal(r.ok, true);
    const data = r.data as { nodeId: number; enrichmentQueued: string[] };
    assert.ok(data.enrichmentQueued.includes('file-hash'));
    await s.deps.pool(s.ws).drain();
    const nodes = s.g.listNodes(s.run.id);
    const enriched = nodes.filter((n) => n.origin.startsWith('enricher:') && s.g.anchorIds(n.id).includes(data.nodeId));
    assert.ok(enriched.length >= 1, 'enrichment must write back anchored nodes');
    const hashFact = enriched.find((n) => n.kind === 'fact' && n.payload.enricher === 'file-hash');
    assert.ok(hashFact, 'file-hash success must be a fact');
    assert.equal(typeof hashFact!.payload.sha256, 'string');
  } finally { await s.close(); }
});

test('payload gate: secrets and oversized payloads are rejected, nothing persisted', async () => {
  const s = setup();
  try {
    const before = s.g.listNodes(s.run.id).length;
    const secret = await s.writeback.run({ action: 'note_fact', payload: { api_key: 'sk-abcdefghijklmnopqrstuvwxyz0123456789ABCDEFGH' } }, workerCtx(s.ws));
    assert.equal(secret.ok, false);
    const big = await s.writeback.run({ action: 'note_fact', payload: { blob: 'x'.repeat(MAX_PAYLOAD_BYTES + 1) } }, workerCtx(s.ws));
    assert.equal(big.ok, false);
    assert.equal(s.g.listNodes(s.run.id).length, before);
  } finally { await s.close(); }
});

test('finish_intent: zero write-back forces exhausted (never done); a fact unlocks done', async () => {
  const s = setup();
  try {
    const intent = runningIntent(s, 'job-1');
    const wctx = workerCtx(s.ws, 'job-1');
    const empty = await s.writeback.run({ action: 'finish_intent', intent_id: intent.id, outcome: 'done', summary: 'nothing found' }, wctx);
    assert.equal(empty.ok, true); // coerced, not done
    assert.equal((empty.data as { state: string }).state, 'exhausted');
    assert.equal((s.g.getNode(intent.id) as IntentNode).state, 'exhausted');
    assert.match(empty.summary, /no write-back/i);
    // Second intent: write a fact first, then done succeeds.
    const intent2 = runningIntent(s, 'job-1');
    await s.writeback.run({ action: 'note_fact', payload: { observed: 'service banner' }, anchors: [intent2.id] }, wctx);
    const done = await s.writeback.run({ action: 'finish_intent', intent_id: intent2.id, outcome: 'done', summary: 'inventoried' }, wctx);
    assert.equal(done.ok, true);
    assert.equal((s.g.getNode(intent2.id) as IntentNode).state, 'done');
  } finally { await s.close(); }
});

test('finish_intent ownership: a worker cannot finish another job\'s intent', async () => {
  const s = setup();
  try {
    const intent = runningIntent(s, 'job-1');
    const r = await s.writeback.run({ action: 'finish_intent', intent_id: intent.id, outcome: 'done', summary: 'hijack' }, workerCtx(s.ws, 'job-2'));
    assert.equal(r.ok, false);
    assert.equal(r.error?.code, 'denied');
    assert.equal((s.g.getNode(intent.id) as IntentNode).state, 'running');
  } finally { await s.close(); }
});

test('finish_intent blocked requires blocked_reason', async () => {
  const s = setup();
  try {
    const intent = runningIntent(s, 'job-1');
    const wctx = workerCtx(s.ws, 'job-1');
    await s.writeback.run({ action: 'note_fact', payload: { partial: true } }, wctx);
    const noReason = await s.writeback.run({ action: 'finish_intent', intent_id: intent.id, outcome: 'blocked', summary: 'stuck' }, wctx);
    assert.equal(noReason.ok, false);
    const blocked = await s.writeback.run({ action: 'finish_intent', intent_id: intent.id, outcome: 'blocked', summary: 'stuck', blocked_reason: 'target denied twice' }, wctx);
    assert.equal(blocked.ok, true);
    assert.equal((s.g.getNode(intent.id) as IntentNode).state, 'blocked');
  } finally { await s.close(); }
});

test('dry-run short-circuits every mutating action without opening a store', async () => {
  const s = setup();
  try {
    const dry = mkCtx(s.ws, { dryRun: true } as Partial<ToolContext>);
    const before = s.g.listNodes(s.run.id).length;
    const wb = await s.writeback.run({ action: 'note_fact', payload: { x: 1 } }, dry);
    assert.equal(wb.ok, true);
    assert.match(wb.summary, /dry run/i);
    const plan = await s.graphTool.run({ action: 'plan_intent', archetype: 'recon', prompt: 'p' }, dry);
    assert.equal(plan.ok, true);
    const enq = await s.enrich.run({ action: 'enqueue', asset_node_id: 1, enricher: 'file-hash' }, dry);
    assert.equal(enq.ok, true);
    assert.equal(s.g.listNodes(s.run.id).length, before);
    // Observation stays live under dryRun.
    const ov = await s.graphTool.run({ action: 'overview' }, dry);
    assert.equal(ov.ok, true);
  } finally { await s.close(); }
});

// ── ops_enrich ────────────────────────────────────────────────────────────────────────────
test('ops_enrich: enqueue/cooldown/unknown/invalid + status; never throws', async () => {
  const s = setup();
  try {
    const ctx = workerCtx(s.ws);
    writeFileSync(join(s.ws, 'b.bin'), 'data');
    const asset = s.g.addNode({ runId: s.run.id, kind: 'asset', payload: { path: 'b.bin' }, origin: 'lead' });
    const first = await s.enrich.run({ action: 'enqueue', asset_node_id: asset.id, enricher: 'file-hash' }, ctx);
    assert.equal(first.ok, true);
    assert.equal((first.data as { outcome: string }).outcome, 'queued');
    const again = await s.enrich.run({ action: 'enqueue', asset_node_id: asset.id, enricher: 'file-hash' }, ctx);
    assert.equal(again.ok, true);
    assert.equal((again.data as { outcome: string }).outcome, 'cooldown');
    const unknown = await s.enrich.run({ action: 'enqueue', asset_node_id: asset.id, enricher: 'port-scan' }, ctx);
    assert.equal(unknown.ok, false);
    assert.equal(unknown.error?.code, 'bad_input');
    const fact = s.g.addNode({ runId: s.run.id, kind: 'fact', payload: { path: 'b.bin' }, origin: 'lead' });
    const invalid = await s.enrich.run({ action: 'enqueue', asset_node_id: fact.id, enricher: 'file-hash' }, ctx);
    assert.equal(invalid.ok, false);
    const status = await s.enrich.run({ action: 'status' }, ctx);
    assert.equal(status.ok, true);
    await s.deps.pool(s.ws).drain();
  } finally { await s.close(); }
});

test('ops_enrich failure is negative evidence, not an exception', async () => {
  const s = setup();
  try {
    const asset = s.g.addNode({ runId: s.run.id, kind: 'asset', payload: { path: 'missing.bin' }, origin: 'lead' });
    const r = await s.enrich.run({ action: 'enqueue', asset_node_id: asset.id, enricher: 'file-hash' }, workerCtx(s.ws));
    assert.equal(r.ok, true);
    await s.deps.pool(s.ws).drain();
    const hints = s.g.listNodes(s.run.id).filter((n) => n.kind === 'hint' && n.origin === 'enricher:file-hash');
    assert.ok(hints.length >= 1);
    assert.ok(s.g.anchorIds(hints[0]!.id).includes(asset.id));
  } finally { await s.close(); }
});

test('no active run: write-back and enrich fail closed with not_found', async () => {
  const ws = mkdtempSync(join(tmpdir(), 'ops-tools-norun-'));
  const runtime = new OpsRuntime();
  try {
    const deps = runtime.deps();
    const wb = makeOpsWritebackTool(deps);
    const r = await wb.run({ action: 'note_fact', payload: { x: 1 } }, mkCtx(ws, { nestedAgent: true, currentWorkId: 'j' } as Partial<ToolContext>));
    assert.equal(r.ok, false);
    assert.equal(r.error?.code, 'not_found');
  } finally {
    await runtime.dispose();
    rmSync(ws, { recursive: true, force: true });
  }
});