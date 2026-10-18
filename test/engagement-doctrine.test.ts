// Hermetic doctrine tests for the Phase 2 engagement core (F3EAD state machine)
// and the engagement_ops tool. Self-contained: no imports from other test files.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { engagementOps, EngagementStore } from '../src/tools/engagementOps.js';
import type { ToolContext } from '../src/tools/types.js';
import {
  ATTACK_TACTICS,
  F3EAD_PHASES,
  type Engagement,
  advancePhase,
  closeEngagement,
  engagementReport,
  logAction,
  startEngagement,
} from '../src/security/engagement.js';
import { redactString } from '../src/util/redact.js';

function baseSpec() {
  return { objective: 'Crack app paywall', scope: '/Applications/X.app', successCriteria: 'App runs patched' };
}

function fresh(): { root: string; ctx: ToolContext } {
  const root = mkdtempSync(join(tmpdir(), 'shadow-engagement-'));
  return {
    root,
    ctx: { workspaceRoot: root, signal: new AbortController().signal, log: () => {}, dryRun: false },
  };
}

function dataOf<T>(result: { data?: unknown }): T {
  assert.ok(result.data !== undefined, 'tool result must include data');
  return result.data as T;
}

/** Drive an engagement forward through every phase legally. */
function legalLifecycle(spec: ReturnType<typeof baseSpec>): Engagement {
  let e = startEngagement(spec);
  for (const phase of F3EAD_PHASES) {
    e = logAction(e, { phase, title: `do ${phase}`, tactic: 'TA0007', techniques: ['T1082'] });
    if (phase !== F3EAD_PHASES[F3EAD_PHASES.length - 1]) e = advancePhase(e);
  }
  return e;
}

test('start requires objective and success criteria', () => {
  assert.throws(() => startEngagement({ objective: '', successCriteria: '' }), /Objective is required/);
  assert.throws(() => startEngagement({ objective: 'o', successCriteria: '' }), /Success criteria are required/);
  assert.doesNotThrow(() => startEngagement(baseSpec()));
});

test('rejects unknown phases', () => {
  const e = startEngagement(baseSpec());
  assert.throws(
    () => logAction(e, { phase: 'exfiltrate', title: 'x', tactic: 'TA0007', techniques: [] } as never),
    /Unknown F3EAD phase/,
  );
});

test('rejects phase skips', () => {
  const e = startEngagement(baseSpec());
  assert.throws(() => logAction(e, { phase: 'fix', title: 'x', tactic: 'TA0007', techniques: [] }), /no action has been logged in find/);
});

test('rejects backward phase moves', () => {
  const e = legalLifecycle({ ...baseSpec(), successCriteria: 'c' });
  assert.throws(() => logAction(e, { phase: 'find', title: 'back', tactic: 'TA0007', techniques: [] }), /phase_violation|Cannot log a find/);
});

test('rejects unknown and malformed tactics and techniques', () => {
  const e = startEngagement(baseSpec());
  assert.throws(() => logAction(e, { phase: 'find', title: 'x', tactic: 'TA9999', techniques: [] }), /Unknown ATT&CK tactic/);
  assert.throws(() => logAction(e, { phase: 'find', title: 'x', tactic: 'nope', techniques: [] }), /Tactic must be an ATT&CK tactic id/);
  assert.throws(() => logAction(e, { phase: 'find', title: 'x', tactic: 'TA0007', techniques: ['X9999'] }), /Technique must look like/);
});

test('ATT&CK tactic table uses current tactic ids, not a technique mislabeled as a tactic', () => {
  assert.equal(ATTACK_TACTICS.get('ta0042'), 'Resource Development');
  assert.equal(ATTACK_TACTICS.get('ta0040'), 'Impact');
  assert.equal(ATTACK_TACTICS.has('ta0044'), false);
});

test('advance refuses when the current phase has no actions', () => {
  const e = startEngagement(baseSpec());
  assert.throws(() => advancePhase(e), /no action has been logged/);
});

test('advance refuses past the final phase', () => {
  const e = legalLifecycle(baseSpec());
  assert.throws(() => advancePhase(e), /final \(disseminate\) phase/);
});

test('close refuses illegal statuses and re-closing', () => {
  const e = legalLifecycle(baseSpec());
  assert.throws(() => closeEngagement(e, 'bogus' as 'complete'), /Close status must be/);
  const closed = closeEngagement(e, 'complete');
  assert.throws(() => closeEngagement(closed, 'aborted'), /Only an active engagement/);
});

test('actions are rejected after close', () => {
  const closed = closeEngagement(legalLifecycle(baseSpec()), 'complete');
  assert.throws(
    () => logAction(closed, { phase: 'find', title: 'late', tactic: 'TA0007', techniques: [] }),
    /Only an active engagement can accept actions/,
  );
});

test('full legal lifecycle reaches complete and the report shows honest coverage', () => {
  const e = closeEngagement(legalLifecycle(baseSpec()), 'complete');
  assert.equal(e.status, 'complete');
  assert.equal(e.actions.length, F3EAD_PHASES.length);
  const report = engagementReport(e);
  assert.match(report, /Objective: Crack app paywall/);
  assert.match(report, /TA0007/);
  for (const phase of F3EAD_PHASES) assert.ok(report.includes(`- ${phase}: 1 action(s)`));
});

test('report shows zero-action phases as gaps, not achievements', () => {
  const e = startEngagement(baseSpec());
  const report = engagementReport(e);
  assert.ok(report.includes('- find: 0 action(s)'));
  assert.ok(report.includes('- disseminate: 0 action(s)'));
  assert.ok(report.includes('Unexecuted phases are shown as zero'));
});

test('engagement_ops rejects unknown actions: schema layer fails closed, direct call fails closed', async () => {
  const { ctx } = fresh();
  const parsed = engagementOps.inputSchema.safeParse({ action: 'teleport' });
  assert.equal(parsed.success, false);
  const result = await engagementOps.run({ action: 'teleport' } as never, ctx);
  assert.equal(result.ok, false);
});

test('engagement_ops dry run performs no writes for any action, even on a fresh workspace', async () => {
  const { root, ctx } = fresh();
  try {
    for (const action of ['start', 'log', 'advance', 'close', 'status', 'show', 'report'] as const) {
      const dry = await engagementOps.run(
        { action, objective: 'o', successCriteria: 's', id: 'fixture' },
        { ...ctx, dryRun: true },
      );
      assert.equal(dry.ok, true, dry.summary);
      assert.match(dry.summary, /Dry run/);
      assert.deepEqual(readdirSync(root), [], `${action} must not create even a database directory`);
    }
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('dry-run status/show/report leave an existing engagement database and reports unchanged', async () => {
  const { root, ctx } = fresh();
  // Include contents and mtimes, so opening/checkpointing a SQLite file also fails the test.
  const fingerprint = (): unknown => readdirSync(root, { recursive: true }).map((name) => {
    const path = join(root, String(name));
    const st = statSync(path);
    return [name, st.mode, st.mtimeMs, st.isFile() ? readFileSync(path).toString('hex') : null];
  });
  try {
    const started = await engagementOps.run({ action: 'start', ...baseSpec() }, ctx);
    assert.equal(started.ok, true, started.summary);
    const id = dataOf<{ id: string }>(started).id;
    const before = fingerprint();
    for (const action of ['status', 'show', 'report'] as const) {
      const result = await engagementOps.run({ action, id }, { ...ctx, dryRun: true });
      assert.equal(result.ok, true, result.summary);
      assert.deepEqual(fingerprint(), before, `${action} dry run must leave persistence untouched`);
    }
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('engagement_ops full lifecycle with persistence: start → log → advance → close → report', async () => {
  const { root, ctx } = fresh();
  const started = await engagementOps.run(
    { action: 'start', objective: 'Crack app paywall', scope: '/Applications/X.app', successCriteria: 'App runs patched' },
    ctx,
  );
  assert.equal(started.ok, true);
  const id = dataOf<{ id: string }>(started).id;

  const rejected = await engagementOps.run(
    { action: 'log', id, phase: 'fix', title: 'skip', tactic: 'TA0007', techniques: [] },
    ctx,
  );
  assert.equal(rejected.ok, false);

  const logged = await engagementOps.run(
    { action: 'log', id, phase: 'find', title: 'binary recon', tactic: 'TA0007', techniques: ['T1082'] },
    ctx,
  );
  assert.equal(logged.ok, true);
  const advanced = await engagementOps.run({ action: 'advance', id }, ctx);
  assert.equal(advanced.ok, true);
  assert.equal(dataOf<{ phaseIndex: number }>(advanced).phaseIndex, 1);

  const closed = await engagementOps.run({ action: 'close', id, status: 'complete' }, ctx);
  assert.equal(closed.ok, true);
  assert.equal(dataOf<{ status: string }>(closed).status, 'complete');

  const report = await engagementOps.run({ action: 'report', id }, ctx);
  assert.equal(report.ok, true);
  assert.ok(dataOf<{ path: string }>(report).path.includes('.shadow/security/reports/'));

  const listed = await engagementOps.run({ action: 'status' }, ctx);
  const engagements = dataOf<{ engagements: { id: string }[] }>(listed).engagements;
  assert.equal(engagements.length, 1);
  assert.equal(engagements[0]!.id, id);
  rmSync(root, { recursive: true, force: true });
});

test('engagement_ops redacts secrets in all start fields before persistence', async () => {
  const { root, ctx } = fresh();
  const objective = 'Use token ghp_abcdefghijklmnopqrstuvwxyz0123456789';
  const scope = 'Authorization: Bearer abc.def.ghi';
  const successCriteria = 'password=hunter2';
  const started = await engagementOps.run({ action: 'start', objective, scope, successCriteria }, ctx);
  assert.equal(started.ok, true, JSON.stringify(started));
  const id = dataOf<{ id: string }>(started).id;
  const shown = await engagementOps.run({ action: 'show', id }, ctx);
  const record = dataOf<{ objective: string; scope: string; successCriteria: string }>(shown);
  assert.equal(record.objective, redactString(objective));
  assert.equal(record.scope, redactString(scope));
  assert.equal(record.successCriteria, redactString(successCriteria));
  rmSync(root, { recursive: true, force: true });
});

test('engagement store rejects a persisted row whose JSON id does not match its key', async () => {
  const { root, ctx } = fresh();
  const started = await engagementOps.run({ action: 'start', objective: 'o', successCriteria: 's' }, ctx);
  const id = dataOf<{ id: string }>(started).id;
  const db = new DatabaseSync(join(root, '.shadow/security/engagements.sqlite'));
  const row = db.prepare('SELECT data FROM engagements WHERE id=?').get(id) as { data: string };
  const body = JSON.parse(row.data) as { id: string };
  body.id = 'engagement_mismatched';
  db.prepare('UPDATE engagements SET data=? WHERE id=?').run(JSON.stringify(body), id);
  db.close();
  const shown = await engagementOps.run({ action: 'show', id }, ctx);
  assert.equal(shown.ok, false);
  assert.match(shown.summary, /mismatched id/);
  rmSync(root, { recursive: true, force: true });
});

test('closed engagement cannot accept further actions across sessions', async () => {
  const { root, ctx } = fresh();
  const started = await engagementOps.run({ action: 'start', objective: 'o', successCriteria: 's' }, ctx);
  const id = dataOf<{ id: string }>(started).id;
  await engagementOps.run({ action: 'log', id, phase: 'find', title: 'recon', tactic: 'TA0007', techniques: [] }, ctx);
  await engagementOps.run({ action: 'close', id, status: 'complete' }, ctx);

  const reopened = await engagementOps.run(
    { action: 'log', id, phase: 'fix', title: 'x', tactic: 'TA0006', techniques: [] },
    ctx,
  );
  assert.equal(reopened.ok, false);

  const store = new EngagementStore(root);
  assert.equal(store.list().length, 1);
  store.close();
  rmSync(root, { recursive: true, force: true });
});
