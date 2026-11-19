/**
 * Ops-graph Phase 4 — operator surface (§9): /ops command against a REAL store, catalog
 * registration in both renderers, HUD row rendering. No mocks of the graph — the operator
 * path's value is exactly that it drives the same durable state the tools do.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { isolateHome, assertStoreIsolated } from './helpers/isolateHome.js';

const { home } = isolateHome('ops-tui');
const globalStore = await import('../src/state/globalStore.js');
assertStoreIsolated(globalStore.GLOBAL_DIR, home);
const { OpsGraph } = await import('../src/security/ops/graph.js');
const { EngagementStore } = await import('../src/tools/engagementOps.js');
const { runOpsCommand } = await import('../src/security/ops/operator.js');
const { findTerminalCommand, commandHandler, terminalCommandsFor } = await import('../src/tui/commandCatalog.js');
const { opsHudLine } = await import('../src/security/ops/feed.js');
const { OPS_DB_PATH } = await import('../src/security/ops/types.js');
import type { IntentNode, GoalNode } from '../src/security/ops/types.js';

function setup() {
  const ws = mkdtempSync(join(tmpdir(), 'ops-tui-ws-'));
  const engStore = new EngagementStore(ws);
  let engagementId: string;
  try {
    engagementId = engStore.start({ objective: 'operator test', scope: '/srv/app', successCriteria: 'goals met' }).id;
  } finally {
    engStore.close();
  }
  const g = new OpsGraph(ws, { findingStatus: () => 'open' });
  const run = g.startRun({ engagementId, objective: 'operator test' });
  const goal = g.addNode({ runId: run.id, kind: 'goal', payload: { text: 'confirm exposure' }, origin: 'lead' }) as GoalNode;
  const intent = g.addNode({ runId: run.id, kind: 'intent', payload: { prompt: 'recon', archetype: 'recon', targets: [], from: [] }, origin: 'lead' }) as IntentNode;
  const lines: Array<{ text: string; error?: boolean }> = [];
  const io = {
    workspace: ws,
    sessionId: 'sess-operator',
    pushLine: (text: string, opts?: { error?: boolean }) => lines.push({ text, error: opts?.error }),
  };
  return {
    ws, g, run, goal, intent, lines, io, engagementId,
    last: () => lines[lines.length - 1]?.text ?? '',
    close: () => { g.close(); rmSync(ws, { recursive: true, force: true }); },
  };
}

test('catalog: /ops registered for BOTH renderers with a handler', () => {
  const cmd = findTerminalCommand('/ops');
  assert.ok(cmd, '/ops must be in the shared catalog');
  assert.equal(commandHandler(cmd!, 'ink'), 'ops');
  assert.equal(commandHandler(cmd!, 'pi'), 'ops'); // 'pi' = the Snowfall engine
  assert.ok(terminalCommandsFor('ink').some((c) => c.name === '/ops'));
  assert.ok(terminalCommandsFor('pi').some((c) => c.name === '/ops'));
});

test('operator: no DB → helpful note, never creates the store from the UI path', () => {
  const ws = mkdtempSync(join(tmpdir(), 'ops-tui-empty-'));
  try {
    const lines: string[] = [];
    runOpsCommand('status', { workspace: ws, sessionId: 's', pushLine: (t) => lines.push(t) });
    assert.match(lines.join('\n'), /No ops run yet/);
    assert.ok(!existsSync(join(ws, OPS_DB_PATH)), 'UI path must not create the ops DB');
  } finally {
    rmSync(ws, { recursive: true, force: true });
  }
});

test('operator: status shows run, objective, goals and lock state', () => {
  const s = setup();
  try {
    runOpsCommand('', s.io);
    const all = s.lines.map((l) => l.text).join('\n');
    assert.match(all, /ops: /);
    assert.match(all, /objective: operator test/);
    assert.match(all, /goal #\d+ \[open\] confirm exposure/);
    assert.match(all, /dispatcher lock: none held/);
    s.g.acquireLock(s.run.id, 'other-session');
    s.lines.length = 0;
    runOpsCommand('status', s.io);
    assert.match(s.lines.map((l) => l.text).join('\n'), /lock: session other-session/);
  } finally { s.close(); }
});

test('operator: graph prints the overview text', () => {
  const s = setup();
  try {
    runOpsCommand('graph', s.io);
    assert.match(s.last(), new RegExp(`# Ops run ${s.run.id}`));
    assert.match(s.last(), /## Goals/);
  } finally { s.close(); }
});

test('operator: pause → paused; resume re-checks engagement and takes the lock', () => {
  const s = setup();
  try {
    runOpsCommand('pause', s.io);
    assert.equal(s.g.getRun(s.run.id).status, 'paused');
    runOpsCommand('resume', s.io);
    assert.equal(s.g.getRun(s.run.id).status, 'active');
    assert.equal(s.g.getLock(s.run.id)?.sessionId, 'sess-operator');
    assert.match(s.last(), /dispatcher lock held by this session/);
  } finally { s.close(); }
});

test('operator: resume DENIED when the engagement is closed (same predicate as dispatch)', () => {
  const s = setup();
  try {
    runOpsCommand('pause', s.io);
    const eng = new EngagementStore(s.ws);
    try { eng.closeEngagement(s.engagementId, 'aborted'); } finally { eng.close(); }
    runOpsCommand('resume', s.io);
    assert.equal(s.g.getRun(s.run.id).status, 'paused', 'must stay paused');
    assert.match(s.last(), /Resume denied/);
    assert.ok(s.lines[s.lines.length - 1]?.error, 'denial is an error line');
  } finally { s.close(); }
});

test('operator: resume reports a foreign lock honestly instead of claiming success', () => {
  const s = setup();
  try {
    runOpsCommand('pause', s.io);
    s.g.acquireLock(s.run.id, 'other-session');
    runOpsCommand('resume', s.io);
    assert.equal(s.g.getRun(s.run.id).status, 'active');
    assert.match(s.last(), /held by session other-session/);
    assert.ok(s.lines[s.lines.length - 1]?.error);
  } finally { s.close(); }
});

test('operator: stop <intentId> marks stopped with operator provenance; bad ids refused', () => {
  const s = setup();
  try {
    runOpsCommand('stop nonsense', s.io);
    assert.match(s.last(), /Usage: \/ops stop/);
    runOpsCommand(`stop ${s.goal.id}`, s.io); // goal id, not an intent
    assert.match(s.last(), /not an intent/);
    runOpsCommand(`stop ${s.intent.id}`, s.io);
    const after = s.g.getNode(s.intent.id) as IntentNode;
    assert.equal(after.state, 'stopped');
    assert.equal(after.payload.stopped_by, 'operator');
  } finally { s.close(); }
});

test('operator: prove requires a trimmed reason; with reason attests via the operator override', () => {
  const s = setup();
  try {
    runOpsCommand(`prove ${s.goal.id}`, s.io);
    assert.match(s.last(), /--reason/);
    assert.equal((s.g.getNode(s.goal.id) as GoalNode).state, 'open');
    runOpsCommand(`prove ${s.goal.id} --reason    `, s.io); // whitespace-only reason
    assert.match(s.last(), /--reason/);
    assert.equal((s.g.getNode(s.goal.id) as GoalNode).state, 'open');
    runOpsCommand(`prove ${s.goal.id} --reason demonstrated live to the agency`, s.io);
    const after = s.g.getNode(s.goal.id) as GoalNode;
    assert.equal(after.state, 'met');
    assert.equal(after.payload.reason, 'demonstrated live to the agency');
    assert.equal(after.payload.attestedBy, 'operator');
  } finally { s.close(); }
});

test('operator: complete refuses open goals, succeeds after prove; abort always allowed', () => {
  const s = setup();
  try {
    runOpsCommand('complete', s.io);
    assert.equal(s.g.getRun(s.run.id).status, 'active', 'open goal blocks complete');
    assert.match(s.last(), /goal/i);
    runOpsCommand(`prove ${s.goal.id} --reason verified by operator`, s.io);
    // The intent is still live — complete only guards goals per §6; stop it first for tidiness.
    runOpsCommand(`stop ${s.intent.id}`, s.io);
    runOpsCommand('complete', s.io);
    assert.equal(s.g.getRun(s.run.id).status, 'complete');
    assert.equal(s.g.getLock(s.run.id), undefined);
  } finally { s.close(); }
});

test('operator: abort terminates the run and releases the lock', () => {
  const s = setup();
  try {
    s.g.acquireLock(s.run.id, 'sess-operator');
    runOpsCommand('abort', s.io);
    assert.equal(s.g.getRun(s.run.id).status, 'aborted');
    assert.equal(s.g.getLock(s.run.id), undefined);
  } finally { s.close(); }
});

test('operator: recover requeues orphaned claims by job liveness', () => {
  const s = setup();
  try {
    assert.ok(s.g.claimNextIntent(s.run.id, 'tok-orphan'));
    s.g.attachJob(s.intent.id, 'job-dead'); // no JobStore row → dead → requeue
    runOpsCommand('recover', s.io);
    assert.match(s.last(), /1 orphaned claim\(s\) requeued/);
    assert.equal((s.g.getNode(s.intent.id) as IntentNode).state, 'open');
  } finally { s.close(); }
});

test('operator: unknown subcommand prints usage as an error, never throws', () => {
  const s = setup();
  try {
    runOpsCommand('frobnicate', s.io);
    assert.match(s.last(), /Usage: \/ops/);
    assert.ok(s.lines[s.lines.length - 1]?.error);
  } finally { s.close(); }
});

test('hud line: renders from real coverage counters and disappears when no run exists', () => {
  const s = setup();
  try {
    const line = opsHudLine(s.g.activeRun(), s.g.coverage(s.run.id));
    assert.match(line, /^ops: \w+ goals 0\/1 · intents 1 open\/0 run · 0 triggers$/);
    assert.ok(line.length <= 80);
  } finally { s.close(); }
});