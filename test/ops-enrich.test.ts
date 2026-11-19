import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { isolateHome, assertStoreIsolated } from './helpers/isolateHome.js';

const { home } = isolateHome('ops-enrich');
const globalStore = await import('../src/state/globalStore.js');
assertStoreIsolated(globalStore.GLOBAL_DIR, home);
const { OpsGraph } = await import('../src/security/ops/graph.js');
const { EnricherPool, fileHashEnricher, gitProvenanceEnricher, ENRICH_CONCURRENCY } = await import('../src/security/ops/enrich.js');
const { scrubEnv } = await import('../src/security/ops/redact.js');

function setup() {
  const ws = mkdtempSync(join(tmpdir(), 'ops-enrich-ws-'));
  const g = new OpsGraph(ws, { findingStatus: () => 'open' });
  const run = g.startRun({ engagementId: 'eng', objective: 'enrich test' });
  return { ws, g, run, close: () => { g.close(); rmSync(ws, { recursive: true, force: true }); } };
}

test('file-hash: sha256 + size + format on a real temp file', async () => {
  const { ws, close } = setup();
  try {
    const f = join(ws, 'sample.bin');
    const content = Buffer.concat([Buffer.from([0x7f, 0x45, 0x4c, 0x46]), Buffer.from('fake elf body')]);
    writeFileSync(f, content);
    const r = await fileHashEnricher(f, { engagementId: 'eng-x', networkAllowed: false });
    assert.ok(r.ok);
    assert.equal(r.payload.sha256, createHash('sha256').update(content).digest('hex'));
    assert.equal(r.payload.sizeBytes, content.length);
    assert.equal(r.payload.format, 'elf');
    const missing = await fileHashEnricher(join(ws, 'nope'), { engagementId: 'eng-x', networkAllowed: false });
    assert.equal(missing.ok, false);
    const dir = await fileHashEnricher(ws, { engagementId: 'eng-x', networkAllowed: false });
    assert.equal(dir.ok, false);
  } finally { close(); }
});

test('git-provenance: real commit read; non-repo → honest negative', async () => {
  const { ws, close } = setup();
  try {
    const repo = join(ws, 'repo');
    mkdirSync(repo);
    const env = { ...scrubEnv(), GIT_AUTHOR_NAME: 'T', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 'T', GIT_COMMITTER_EMAIL: 't@t' };
    execFileSync('git', ['init', '-q'], { cwd: repo, env });
    writeFileSync(join(repo, 'a.txt'), 'hello');
    execFileSync('git', ['add', 'a.txt'], { cwd: repo, env });
    execFileSync('git', ['commit', '-q', '-m', 'initial fixture'], { cwd: repo, env });
    const r = await gitProvenanceEnricher(join(repo, 'a.txt'), { engagementId: 'eng-x', networkAllowed: false });
    assert.ok(r.ok, r.ok ? '' : r.reason);
    assert.match(r.payload.commit as string, /^[0-9a-f]{40}$/);
    assert.equal(r.payload.subject, 'initial fixture');
    const noRepo = await gitProvenanceEnricher(join(ws, 'sample.bin'), { engagementId: 'eng-x', networkAllowed: false });
    assert.equal(noRepo.ok, false);
  } finally { close(); }
});

test('pool: success → gated fact anchored to asset + enrich_done trigger', async () => {
  const { ws, g, run, close } = setup();
  try {
    const f = join(ws, 'x.txt');
    writeFileSync(f, 'data');
    const asset = g.addNode({ runId: run.id, kind: 'asset', payload: { path: f }, origin: 'lead' });
    const pool = new EnricherPool(g, ws);
    assert.equal(pool.enqueue({ runId: run.id, assetNodeId: asset.id, enricher: 'file-hash' }), 'queued');
    await pool.drain();
    const facts = g.listNodes(run.id, { kind: 'fact' });
    assert.equal(facts.length, 1);
    assert.equal(facts[0]!.origin, 'enricher:file-hash');
    assert.deepEqual(g.anchorIds(facts[0]!.id), [asset.id]);
    assert.ok(g.pendingTriggers(run.id).some((t) => t.kind === 'enrich_done' && t.nodeId === asset.id));
    assert.equal(pool.status().completed, 1);
    assert.equal(pool.status().failed, 0);
  } finally { close(); }
});

test('pool: failure → hint negative evidence, never throws; unknown enricher/asset rejected', async () => {
  const { ws, g, run, close } = setup();
  try {
    const asset = g.addNode({ runId: run.id, kind: 'asset', payload: { path: join(ws, 'missing.bin') }, origin: 'lead' });
    const pool = new EnricherPool(g, ws);
    assert.equal(pool.enqueue({ runId: run.id, assetNodeId: asset.id, enricher: 'file-hash' }), 'queued');
    assert.equal(pool.enqueue({ runId: run.id, assetNodeId: asset.id, enricher: 'no-such' }), 'unknown-enricher');
    assert.equal(pool.enqueue({ runId: run.id, assetNodeId: 9999, enricher: 'file-hash' }), 'invalid-asset');
    await pool.drain();
    const hints = g.listNodes(run.id, { kind: 'hint' });
    assert.equal(hints.length, 1);
    assert.ok(String(hints[0]!.payload.negative).includes('file-hash failed'));
    assert.equal(pool.status().failed, 1);
    assert.equal(g.listNodes(run.id, { kind: 'fact' }).length, 0);
  } finally { close(); }
});

test('pool: cooldown dedupe per (asset,enricher); concurrency bounded at 2', async () => {
  const { ws, g, run, close } = setup();
  try {
    const f = join(ws, 'y.txt');
    writeFileSync(f, 'y');
    const asset = g.addNode({ runId: run.id, kind: 'asset', payload: { path: f }, origin: 'lead' });
    let maxConcurrent = 0;
    let current = 0;
    const slow = async () => {
      current++;
      maxConcurrent = Math.max(maxConcurrent, current);
      await new Promise((r) => setTimeout(r, 20));
      current--;
      return { ok: true as const, payload: { done: true } };
    };
    const pool = new EnricherPool(g, ws, { slow }, 60_000);
    // Five distinct assets so cooldown does not dedupe them.
    const ids = [asset.id];
    for (let i = 0; i < 4; i++) ids.push(g.addNode({ runId: run.id, kind: 'asset', payload: { path: f }, origin: 'lead' }).id);
    for (const id of ids) assert.equal(pool.enqueue({ runId: run.id, assetNodeId: id, enricher: 'slow' }), 'queued');
    // Same (asset,enricher) again inside cooldown → skipped.
    assert.equal(pool.enqueue({ runId: run.id, assetNodeId: asset.id, enricher: 'slow' }), 'cooldown');
    await pool.drain();
    assert.ok(maxConcurrent <= ENRICH_CONCURRENCY, `max concurrent ${maxConcurrent}`);
    assert.equal(pool.status().completed, 5);
    assert.equal(pool.status().cooldownSkips, 1);
  } finally { close(); }
});

test('pool: secret-bearing enricher result is gated → hint, not stored', async () => {
  const { ws, g, run, close } = setup();
  try {
    const f = join(ws, 'z.txt');
    writeFileSync(f, 'z');
    const asset = g.addNode({ runId: run.id, kind: 'asset', payload: { path: f }, origin: 'lead' });
    const leaky = () => ({ ok: true as const, payload: { detail: 'key sk-' + 'e'.repeat(24) } });
    const pool = new EnricherPool(g, ws, { leaky });
    pool.enqueue({ runId: run.id, assetNodeId: asset.id, enricher: 'leaky' });
    await pool.drain();
    assert.equal(g.listNodes(run.id, { kind: 'fact' }).length, 0, 'secret payload never lands');
    assert.equal(g.listNodes(run.id, { kind: 'hint' }).length, 1);
    assert.equal(pool.status().failed, 1);
  } finally { close(); }
});