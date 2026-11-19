import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { isolateHome, assertStoreIsolated } from './helpers/isolateHome.js';

const { home } = isolateHome('ops-enrich-net');
const globalStore = await import('../src/state/globalStore.js');
assertStoreIsolated(globalStore.GLOBAL_DIR, home);
const { makeOsvEnricher, NETWORK_ENRICHERS, LOCAL_ENRICHERS, EnricherPool } = await import('../src/security/ops/enrich.js');
const { OpsGraph } = await import('../src/security/ops/graph.js');
import type { shadowFetch } from '../src/safety/egress.js';

type FetchFn = typeof shadowFetch;
type RecordedCall = { url: string; body: unknown; meta: unknown };

/** Fetch double: records every call (url, body, broker meta) and replays a canned Response. */
function fetchDouble(opts: { status?: number; body?: string }): { calls: RecordedCall[]; fetch: FetchFn } {
  const calls: RecordedCall[] = [];
  const fetch = (async (url: string, init?: RequestInit, meta?: unknown) => {
    calls.push({ url, body: typeof init?.body === 'string' ? JSON.parse(init.body) : undefined, meta });
    return new Response(opts.body ?? '{}', { status: opts.status ?? 200, headers: { 'Content-Type': 'application/json' } });
  }) as unknown as FetchFn;
  return { calls, fetch };
}

function setup() {
  const ws = mkdtempSync(join(tmpdir(), 'ops-enrich-net-ws-'));
  const g = new OpsGraph(ws, { findingStatus: () => 'open' });
  const run = g.startRun({ engagementId: 'eng-net', objective: 'network enricher test' });
  return { ws, g, run, close: () => { g.close(); rmSync(ws, { recursive: true, force: true }); } };
}

function writeManifest(ws: string, pkg: Record<string, unknown>, name = 'package.json'): string {
  const f = join(ws, name);
  writeFileSync(f, JSON.stringify(pkg));
  return f;
}

test('osv-lookup: fail-closed without allow-network — no egress attempted', async () => {
  const { ws, close } = setup();
  try {
    const { calls, fetch } = fetchDouble({ body: JSON.stringify({ vulns: [{ id: 'GHSA-xxxx-xxxx-xxxx' }] }) });
    const enricher = makeOsvEnricher(fetch);
    const f = writeManifest(ws, { name: 'lodash', version: '4.17.20' });
    const r = await enricher(f, { engagementId: 'eng-net', networkAllowed: false });
    assert.equal(r.ok, false);
    assert.match(r.reason, /allow-network/);
    assert.equal(calls.length, 0, 'no egress may be attempted when gated off');
  } finally { close(); }
});

test('osv-lookup: sends package identity only, through the ops-enrich purpose', async () => {
  const { ws, close } = setup();
  try {
    const { calls, fetch } = fetchDouble({ body: JSON.stringify({ vulns: [{ id: 'GHSA-aaaa-bbbb-cccc' }, { id: 'CVE-2025-99999' }] }) });
    const enricher = makeOsvEnricher(fetch);
    const f = writeManifest(ws, { name: 'lodash', version: '4.17.20', description: 'leak candidate' });
    const r = await enricher(f, { engagementId: 'eng-net', networkAllowed: true });
    assert.ok(r.ok, r.ok ? '' : r.reason);
    assert.equal(calls.length, 1);
    assert.equal(calls[0].url, 'https://api.osv.dev/v1/query');
    assert.deepEqual(calls[0].body, { package: { ecosystem: 'npm', name: 'lodash' }, version: '4.17.20' });
    assert.equal((calls[0].meta as { purpose: string }).purpose, 'ops-enrich');
    assert.equal((calls[0].meta as { origin: string }).origin, 'user');
    assert.match(r.payload.text as string, /GHSA-aaaa-bbbb-cccc/);
    assert.match(r.payload.text as string, /lodash@4\.17\.20/);
    assert.ok(!/leak candidate/.test(r.payload.text as string), 'manifest description leaked into the fact');
  } finally { close(); }
});

test('osv-lookup: versionless manifest queries by name only', async () => {
  const { ws, close } = setup();
  try {
    const { calls, fetch } = fetchDouble({ body: JSON.stringify({ vulns: [] }) });
    const enricher = makeOsvEnricher(fetch);
    const f = writeManifest(ws, { name: 'noversion' });
    const r = await enricher(f, { engagementId: 'eng-net', networkAllowed: true });
    assert.ok(r.ok, r.ok ? '' : r.reason);
    assert.deepEqual(calls[0].body, { package: { ecosystem: 'npm', name: 'noversion' } });
    assert.match(r.payload.text as string, /No known OSV advisories/);
  } finally { close(); }
});

test('osv-lookup: non-package.json, unnamed, and malformed manifests are honest misses', async () => {
  const { ws, close } = setup();
  try {
    const { calls, fetch } = fetchDouble({});
    const enricher = makeOsvEnricher(fetch);
    const txt = join(ws, 'notes.txt');
    writeFileSync(txt, 'not a manifest');
    const r1 = await enricher(txt, { engagementId: 'eng-net', networkAllowed: true });
    assert.equal(r1.ok, false);
    assert.match(r1.reason, /package\.json/);
    const f = writeManifest(ws, { version: '1.0.0' }); // no name
    const r2 = await enricher(f, { engagementId: 'eng-net', networkAllowed: true });
    assert.equal(r2.ok, false);
    assert.match(r2.reason, /package\.json/);
    const broken = join(ws, 'broken.package.json');
    writeFileSync(broken, '{ not json');
    const r3 = await enricher(broken, { engagementId: 'eng-net', networkAllowed: true });
    assert.equal(r3.ok, false);
    assert.equal(calls.length, 0, 'no egress for non-identities');
  } finally { close(); }
});

test('osv-lookup: HTTP error, oversized body, and egress rejection are negative evidence', async () => {
  const { ws, close } = setup();
  try {
    const { fetch: errFetch } = fetchDouble({ status: 503 });
    const enricher = makeOsvEnricher(errFetch);
    const f = writeManifest(ws, { name: 'x', version: '1.0.0' });
    const r = await enricher(f, { engagementId: 'eng-net', networkAllowed: true });
    assert.equal(r.ok, false);
    assert.match(r.reason, /HTTP 503/);

    const fat = (async () => new Response('x'.repeat((1 << 20) + 2), { status: 200 })) as unknown as FetchFn;
    const r2 = await makeOsvEnricher(fat)(f, { engagementId: 'eng-net', networkAllowed: true });
    assert.equal(r2.ok, false);
    assert.match(r2.reason, /1 MiB/);

    const dying = (async () => { throw new Error('egress denied: netguard block'); }) as unknown as FetchFn;
    const r3 = await makeOsvEnricher(dying)(f, { engagementId: 'eng-net', networkAllowed: true });
    assert.equal(r3.ok, false);
    assert.match(r3.reason, /osv-lookup unavailable/);
  } finally { close(); }
});

test('registry: osv-lookup is a network enricher; local auto-enqueue stays local', async () => {
  assert.ok('osv-lookup' in NETWORK_ENRICHERS);
  assert.ok(!('osv-lookup' in LOCAL_ENRICHERS), 'register_asset auto-enqueue must stay local-only');
  assert.deepEqual(Object.keys(LOCAL_ENRICHERS).sort(), ['file-hash', 'git-provenance']);
});

test('pool: default map includes osv-lookup; gated off → hint, never a crash', async () => {
  const { ws, g, run, close } = setup();
  try {
    const f = writeManifest(ws, { name: 'poolgate', version: '1.0.0' });
    const asset = g.addNode({ runId: run.id, kind: 'asset', payload: { path: f }, origin: 'lead' });
    const pool = new EnricherPool(g, ws); // no allowNetwork → deny all
    assert.equal(pool.enqueue({ runId: run.id, assetNodeId: asset.id, enricher: 'osv-lookup' }), 'queued');
    await pool.drain();
    const hints = g.listNodes(run.id, { kind: 'hint' }).filter((n) => n.payload.enricher === 'osv-lookup');
    assert.equal(hints.length, 1);
    assert.match(String(hints[0].payload.negative), /allow-network/);
    assert.equal(g.listNodes(run.id, { kind: 'fact' }).filter((n) => n.payload.enricher === 'osv-lookup').length, 0);
  } finally { close(); }
});

test('pool: allowNetwork resolver is consulted with the run engagement id', async () => {
  const { ws, g, run, close } = setup();
  try {
    const f = writeManifest(ws, { name: 'resolver', version: '1.0.0' });
    const asset = g.addNode({ runId: run.id, kind: 'asset', payload: { path: f }, origin: 'lead' });
    const seen: string[] = [];
    const pool = new EnricherPool(g, ws, { 'osv-lookup': makeOsvEnricher(fetchDouble({}).fetch) }, undefined, {
      allowNetwork: (engagementId) => { seen.push(engagementId); return false; },
    });
    assert.equal(pool.enqueue({ runId: run.id, assetNodeId: asset.id, enricher: 'osv-lookup' }), 'queued');
    await pool.drain();
    assert.deepEqual(seen, ['eng-net']);
    const hints = g.listNodes(run.id, { kind: 'hint' }).filter((n) => n.payload.enricher === 'osv-lookup');
    assert.equal(hints.length, 1);
    assert.match(String(hints[0].payload.negative), /allow-network/);
  } finally { close(); }
});

test('pool: allowed + fetch double → gated fact anchored to the asset, purpose ops-enrich', async () => {
  const { ws, g, run, close } = setup();
  try {
    const { calls, fetch } = fetchDouble({ body: JSON.stringify({ vulns: [{ id: 'GHSA-pool-1' }] }) });
    const pool = new EnricherPool(g, ws, { 'osv-lookup': makeOsvEnricher(fetch) }, undefined, {
      allowNetwork: (engagementId) => engagementId === 'eng-net',
    });
    const f = writeManifest(ws, { name: 'pool-ok', version: '2.0.0' });
    const asset = g.addNode({ runId: run.id, kind: 'asset', payload: { path: f }, origin: 'lead' });
    assert.equal(pool.enqueue({ runId: run.id, assetNodeId: asset.id, enricher: 'osv-lookup' }), 'queued');
    await pool.drain();
    const facts = g.listNodes(run.id, { kind: 'fact' }).filter((n) => n.payload.enricher === 'osv-lookup');
    assert.equal(facts.length, 1);
    assert.match(String(facts[0].payload.text), /GHSA-pool-1/);
    assert.equal(facts[0].payload.source, 'osv.dev');
    assert.equal((calls[0].meta as { purpose: string }).purpose, 'ops-enrich');
    assert.deepEqual(g.anchorIds(facts[0].id), [asset.id]);
  } finally { close(); }
});

test('osv-lookup: deep path and extra manifest fields never leave the machine', async () => {
  const { ws, close } = setup();
  try {
    const { calls, fetch } = fetchDouble({ body: JSON.stringify({ vulns: [] }) });
    mkdirSync(join(ws, 'deep', 'nested'), { recursive: true });
    const f = writeManifest(ws, { name: 'pathy', version: '1.0.0', scripts: { leak: 'secret-value' } }, join('deep', 'nested', 'package.json'));
    const r = await makeOsvEnricher(fetch)(f, { engagementId: 'eng-net', networkAllowed: true });
    assert.ok(r.ok, r.ok ? '' : r.reason);
    const sent = JSON.stringify(calls[0].body);
    assert.deepEqual(calls[0].body, { package: { ecosystem: 'npm', name: 'pathy' }, version: '1.0.0' });
    assert.ok(!/deep|nested|secret-value/.test(sent), `path leaked: ${sent}`);
  } finally { close(); }
});
