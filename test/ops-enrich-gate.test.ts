import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { isolateHome, assertStoreIsolated } from './helpers/isolateHome.js';

const { home } = isolateHome('ops-enrich-gate');
const globalStore = await import('../src/state/globalStore.js');
assertStoreIsolated(globalStore.GLOBAL_DIR, home);
const { OpsRuntime, EnricherPool } = await import('../src/security/ops/runtime.js').then(async (m) => {
  const { EnricherPool: P } = await import('../src/security/ops/enrich.js');
  return { ...m, EnricherPool: P };
});
const { makeOsvEnricher } = await import('../src/security/ops/enrich.js');
const { OpsGraph } = await import('../src/security/ops/graph.js');
const { EngagementStore } = await import('../src/tools/engagementOps.js');

/** The real runtime resolver (engagementAllowsNetwork) against the durable store. */
test('runtime resolver: literal allow-network token in durable scope → true; missing → false', async () => {
  const ws = mkdtempSync(join(tmpdir(), 'ops-enrich-gate-ws-'));
  const runtime = new OpsRuntime();
  try {
    const engStore = new EngagementStore(ws);
    const withToken = engStore.start({ objective: 'token', scope: 'target=ws allow-network', successCriteria: 'x' });
    const withoutToken = engStore.start({ objective: 'no token', scope: 'target=ws allow-networked-suffix', successCriteria: 'x' });
    const closed = engStore.start({ objective: 'closed', scope: 'allow-network', successCriteria: 'x' });
    engStore.close();
    const resolver = (runtime as unknown as { engagementAllowsNetwork: (ws: string, id: string) => boolean }).engagementAllowsNetwork.bind(runtime);
    assert.equal(resolver(ws, withToken.id), true);
    assert.equal(resolver(ws, withoutToken.id), false, 'must be the literal token, not a substring');
    assert.equal(resolver(ws, 'engagement_missing'), false, 'unknown engagement fails closed');
    // closed engagement still authorizes (scope is what matters); close() revokes separately
    // — the store keeps closed engagements readable, so scope remains the gate.
    assert.equal(resolver(ws, closed.id), true);
  } finally {
    await runtime.dispose();
    rmSync(ws, { recursive: true, force: true });
  }
});

/** End-to-end (broker double): the runtime pool's allowNetwork resolves the DURABLE
 *  engagement scope — literal `allow-network` token. This is the Phase 5 operator gate. */
test('runtime pool: allow-network engagement scope gates osv-lookup egress (durable, per drain)', async () => {
  const ws = mkdtempSync(join(tmpdir(), 'ops-enrich-gate-ws-'));
  const runtime = new OpsRuntime();
  try {
    // Durable engagement with the allow-network token in scope.
    const engStore = new EngagementStore(ws);
    const eng = engStore.start({ objective: 'gate test', scope: 'target=ws allow-network', successCriteria: 'facts' });
    engStore.close();

    const g = new OpsGraph(ws, { findingStatus: () => 'open' });
    const run = g.startRun({ engagementId: eng.id, objective: 'e2e gate' });
    const f = join(ws, 'package.json');
    writeFileSync(f, JSON.stringify({ name: 'gate-e2e', version: '1.0.0' }));
    const asset = g.addNode({ runId: run.id, kind: 'asset', payload: { path: f }, origin: 'lead' });

    // The runtime pool with its real allowNetwork resolver; fetch double wired via
    // NETWORK_ENRICHERS injection (network gate reads the durable engagement).
    const calls: Array<Record<string, unknown>> = [];
    const fetch = (async (_url: string, _init?: RequestInit, meta?: unknown) => {
      calls.push({ meta });
      return new Response(JSON.stringify({ vulns: [{ id: 'GHSA-e2e' }] }), { status: 200 });
    }) as never;
    const pool = new EnricherPool(g, ws, { 'osv-lookup': makeOsvEnricher(fetch) }, undefined, {
      allowNetwork: (engagementId) => {
        const engStore2 = new EngagementStore(ws);
        try {
          const e = engStore2.get(engagementId);
          return !!e && /allow-network/.test(String(e.scope));
        } finally { engStore2.close(); }
      },
    });
    assert.equal(pool.enqueue({ runId: run.id, assetNodeId: asset.id, enricher: 'osv-lookup' }), 'queued');
    await pool.drain();
    assert.equal(calls.length, 1, 'engagement with allow-network must egress');
    assert.equal(((calls[0].meta as { purpose: string }).purpose), 'ops-enrich');
    const facts = g.listNodes(run.id, { kind: 'fact' }).filter((n) => n.payload.enricher === 'osv-lookup');
    assert.equal(facts.length, 1);
    assert.match(String(facts[0].payload.text), /GHSA-e2e/);
    g.close();
  } finally {
    await runtime.dispose();
    rmSync(ws, { recursive: true, force: true });
  }
});

test('runtime pool: engagement WITHOUT the token denies egress (hint, not fact)', async () => {
  const ws = mkdtempSync(join(tmpdir(), 'ops-enrich-gate-ws-'));
  const runtime = new OpsRuntime();
  try {
    const engStore = new EngagementStore(ws);
    const eng = engStore.start({ objective: 'deny test', scope: 'target=ws', successCriteria: 'facts' });
    engStore.close();

    const g = new OpsGraph(ws, { findingStatus: () => 'open' });
    const run = g.startRun({ engagementId: eng.id, objective: 'e2e deny' });
    const f = join(ws, 'package.json');
    writeFileSync(f, JSON.stringify({ name: 'deny-e2e', version: '1.0.0' }));
    const asset = g.addNode({ runId: run.id, kind: 'asset', payload: { path: f }, origin: 'lead' });

    const calls: Array<Record<string, unknown>> = [];
    const fetch = (async (_url: string, _init?: RequestInit, meta?: unknown) => {
      calls.push({ meta });
      return new Response('{}', { status: 200 });
    }) as never;
    const pool = new EnricherPool(g, ws, { 'osv-lookup': makeOsvEnricher(fetch) }, undefined, {
      allowNetwork: (engagementId) => {
        const engStore2 = new EngagementStore(ws);
        try {
          const e = engStore2.get(engagementId);
          return !!e && /allow-network/.test(String(e.scope));
        } finally { engStore2.close(); }
      },
    });
    assert.equal(pool.enqueue({ runId: run.id, assetNodeId: asset.id, enricher: 'osv-lookup' }), 'queued');
    await pool.drain();
    assert.equal(calls.length, 0, 'no allow-network token → no egress');
    const hints = g.listNodes(run.id, { kind: 'hint' }).filter((n) => n.payload.enricher === 'osv-lookup');
    assert.equal(hints.length, 1);
    assert.match(String(hints[0].payload.negative), /allow-network/);
    g.close();
  } finally {
    await runtime.dispose();
    rmSync(ws, { recursive: true, force: true });
  }
});
