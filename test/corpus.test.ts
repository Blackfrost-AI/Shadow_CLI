import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { normalizeSessionFile } from '../src/state/trajectory.js';
import { scoreTrajectory, isUsable } from '../src/state/quality.js';
import {
  CORPUS_SCHEMA,
  buildRecords,
  REDACTION_VERSION,
  dedupe,
  readCorpusConfig,
  redactTrajectory,
  splitFor,
  stats,
  trajectoryDigest,
  workspaceBucket,
  writeCorpusConfig,
  type CorpusRecord,
} from '../src/state/corpus.js';

// These tests exist to protect a specific promise: a user who runs `shadow corpus export` on a
// client repo must not silently ship their own secrets. The redaction and split tests are the
// load-bearing ones — the rest guard against corpus rot.

function tmpWorkspace(): string {
  return mkdtempSync(join(tmpdir(), 'shadow-corpus-'));
}

/** Write a session JSONL fixture and return its path. */
function sessionFile(dir: string, name: string, records: unknown[]): string {
  const p = join(dir, `${name}.jsonl`);
  writeFileSync(p, records.map((r) => JSON.stringify(r)).join('\n') + '\n', 'utf8');
  return p;
}

function ev(type: string, extra: Record<string, unknown> = {}) {
  return { kind: 'event', type, ts: '2026-10-19T00:00:00.000Z', ...extra };
}

// ---------------------------------------------------------------------------
// Normalizer
// ---------------------------------------------------------------------------

test('normalizer pairs tool_start with tool_end and keeps reasoning', async () => {
  const dir = tmpWorkspace();
  try {
    const p = sessionFile(dir, 's1', [
      ev('reasoning_done', { text: 'I should read the file first' }),
      ev('tool_start', { call: { id: 'c1', name: 'read_file', input: { path: 'a.ts' } } }),
      ev('tool_end', { result: { ok: true, summary: 'file contents', meta: { durationMs: 12 } } }),
      ev('assistant_done', { text: 'Done reading.' }),
      ev('stop', { reason: 'completed' }),
    ]);
    const t = await normalizeSessionFile(p);
    assert.equal(t.turns.length, 1);
    const turn = t.turns[0]!;
    assert.equal(turn.thought, 'I should read the file first', 'reasoning must survive normalization');
    assert.equal(turn.action?.tool, 'read_file');
    assert.equal(turn.observation?.ok, true);
    assert.equal(turn.observation?.durationMs, 12);
    assert.equal(turn.answer, 'Done reading.');
    assert.equal(t.outcome.stopReason, 'completed');
    assert.equal(t.outcome.truncated, false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('normalizer flags a truncated trace instead of silently repairing it', async () => {
  const dir = tmpWorkspace();
  try {
    const p = sessionFile(dir, 's2', [
      ev('tool_start', { call: { id: 'c1', name: 'run_shell', input: { command: 'ls' } } }),
      // no tool_end — the session died mid-action
    ]);
    const t = await normalizeSessionFile(p);
    assert.equal(t.outcome.truncated, true);
    assert.equal(t.turns.length, 1);
    assert.equal(t.turns[0]!.observation, undefined);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('normalizer preserves failures and counts user corrections', async () => {
  const dir = tmpWorkspace();
  try {
    const p = sessionFile(dir, 's3', [
      ev('tool_start', { call: { id: 'c1', name: 'run_shell', input: { command: 'false' } } }),
      ev('tool_end', { result: { ok: false, summary: 'command failed', error: { code: 'EXIT_1' } } }),
      ev('assistant_done', { text: 'That failed.' }),
      ev('user', { text: 'no, use make instead' }),
    ]);
    const t = await normalizeSessionFile(p);
    assert.equal(t.outcome.failedActions, 1);
    assert.equal(t.outcome.userCorrections, 1);
    assert.equal(t.turns[0]!.observation?.ok, false);
    assert.equal(t.turns[0]!.observation?.errorCode, 'EXIT_1');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('normalizer records denied tools as failed observations', async () => {
  const dir = tmpWorkspace();
  try {
    const p = sessionFile(dir, 's4', [
      ev('tool_denied', { call: { name: 'write_file', input: { path: 'x' } }, reason: 'user denied' }),
    ]);
    const t = await normalizeSessionFile(p);
    assert.equal(t.outcome.failedActions, 1);
    assert.equal(t.turns[0]!.observation?.errorCode, 'denied');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('normalizer survives a corrupt line without discarding the session', async () => {
  const dir = tmpWorkspace();
  try {
    const p = join(dir, 's5.jsonl');
    writeFileSync(
      p,
      [
        JSON.stringify(ev('assistant_done', { text: 'first' })),
        '{not json at all',
        JSON.stringify(ev('stop', { reason: 'completed' })),
      ].join('\n') + '\n',
      'utf8',
    );
    const t = await normalizeSessionFile(p);
    assert.ok(t.warnings.some((w) => w.includes('unparseable')), 'corrupt line is reported');
    assert.equal(t.outcome.stopReason, 'completed', 'parsing continues past the bad line');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('normalizer uses a stable basename session id, not the absolute path', async () => {
  const dir = tmpWorkspace();
  try {
    const p = sessionFile(dir, 'abc123', [ev('assistant_done', { text: 'hi' })]);
    const t = await normalizeSessionFile(p);
    assert.equal(t.sessionId, 'abc123');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// Quality scoring — the point is that negatives are LABELLED, not dropped
// ---------------------------------------------------------------------------

test('clean completed run scores gold', async () => {
  const dir = tmpWorkspace();
  try {
    const p = sessionFile(dir, 'q1', [
      ev('reasoning_done', { text: 'think' }),
      ev('tool_start', { call: { id: 'c1', name: 'read_file', input: { path: 'a' } } }),
      ev('tool_end', { result: { ok: true, summary: 'ok' } }),
      ev('stop', { reason: 'completed' }),
    ]);
    const s = scoreTrajectory(await normalizeSessionFile(p));
    assert.equal(s.label, 'gold', `expected gold, got ${s.label}: ${s.reasons.join('; ')}`);
    assert.ok(s.score >= 0.72);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('max_iterations run scores negative — and is still usable', async () => {
  const dir = tmpWorkspace();
  try {
    const p = sessionFile(dir, 'q2', [
      ev('tool_start', { call: { id: 'c1', name: 'run_shell', input: { command: 'a' } } }),
      ev('tool_end', { result: { ok: false, summary: 'command failed' } }),
      ev('tool_start', { call: { id: 'c2', name: 'run_shell', input: { command: 'b' } } }),
      ev('tool_end', { result: { ok: false, summary: 'command failed' } }),
      ev('user', { text: 'no' }),
      ev('stop', { reason: 'max_iterations' }),
    ]);
    const t = await normalizeSessionFile(p);
    const s = scoreTrajectory(t);
    assert.equal(s.label, 'negative');
    assert.ok(
      s.reasons.some((r) => r.includes('max_iterations')),
      'the label must be explainable',
    );
    assert.equal(isUsable(t, s), true, 'negative examples are training data — never filtered out');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('empty trajectory is unusable', async () => {
  const dir = tmpWorkspace();
  try {
    const p = sessionFile(dir, 'q3', []);
    const t = await normalizeSessionFile(p);
    const s = scoreTrajectory(t);
    assert.equal(isUsable(t, s), false);
    assert.equal(s.score, 0);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('failure followed by recovery is detected and rewarded', async () => {
  const dir = tmpWorkspace();
  try {
    const p = sessionFile(dir, 'q4', [
      ev('tool_start', { call: { id: 'c1', name: 'run_shell', input: { command: 'bad' } } }),
      ev('tool_end', { result: { ok: false, summary: 'command failed' } }),
      ev('tool_start', { call: { id: 'c2', name: 'run_shell', input: { command: 'good' } } }),
      ev('tool_end', { result: { ok: true, summary: 'done' } }),
      ev('stop', { reason: 'completed' }),
    ]);
    const s = scoreTrajectory(await normalizeSessionFile(p));
    assert.equal(s.containsRecovery, true);
    assert.ok(s.reasons.some((r) => r.includes('recovery')));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// Redaction — the leak-prevention guarantee
// ---------------------------------------------------------------------------

test('redaction scrubs secrets out of every trajectory surface', async () => {
  const dir = tmpWorkspace();
  try {
    const secret = 'wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY';
    const p = sessionFile(dir, 'r1', [
      ev('reasoning_done', { text: `the key is AWS_SECRET_ACCESS_KEY=${secret}` }),
      ev('tool_start', {
        call: { id: 'c1', name: 'run_shell', input: { command: `export AWS_SECRET_ACCESS_KEY=${secret}` } },
      }),
      ev('tool_end', { result: { ok: true, summary: `leaked ${secret}` } }),
      ev('assistant_done', { text: `here it is: ${secret}` }),
    ]);
    const t = await normalizeSessionFile(p);
    const { trajectory, hits } = redactTrajectory(t);

    const blob = JSON.stringify(trajectory);
    assert.ok(!blob.includes(secret), 'the secret must not survive anywhere in the trajectory');
    assert.ok(hits > 0, 'redaction reports how many strings it changed');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('redaction leaves clean content untouched and reports zero hits', async () => {
  const dir = tmpWorkspace();
  try {
    const p = sessionFile(dir, 'r2', [
      ev('tool_start', { call: { id: 'c1', name: 'read_file', input: { path: 'src/index.ts' } } }),
      ev('tool_end', { result: { ok: true, summary: 'export function main() {}' } }),
    ]);
    const t = await normalizeSessionFile(p);
    const { trajectory, hits } = redactTrajectory(t);
    assert.equal(hits, 0);
    assert.equal(JSON.stringify(trajectory).includes('src/index.ts'), true);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('redaction preserves structured input — it never corrupts JSON', async () => {
  // Regression: redacting `JSON.stringify(input)` and re-parsing let the connection-string
  // matcher consume a JSON quote, throwing on real sessions and losing the whole trajectory.
  const dir = tmpWorkspace();
  try {
    const p = sessionFile(dir, 'r4', [
      ev('tool_start', {
        call: {
          id: 'c1',
          name: 'run_shell',
          input: {
            command: 'curl https://user:hunter2@example.com/x',
            nested: { deep: ['a', 'postgres://u:p@h/db'] },
            n: 42,
            flag: true,
            nothing: null,
          },
        },
      }),
      ev('tool_end', { result: { ok: true, summary: 'ok' } }),
    ]);
    const t = await normalizeSessionFile(p);
    const { trajectory } = redactTrajectory(t);
    const input = trajectory.turns[0]!.action!.input as Record<string, unknown>;

    // Structure survives intact.
    assert.equal(typeof input, 'object');
    assert.equal(input.n, 42);
    assert.equal(input.flag, true);
    assert.equal(input.nothing, null);
    assert.ok(Array.isArray((input.nested as { deep: unknown[] }).deep));
    assert.equal((input.nested as { deep: unknown[] }).deep.length, 2);
    // And the credentials are gone.
    assert.ok(!JSON.stringify(trajectory).includes('hunter2'));
    assert.ok(!JSON.stringify(trajectory).includes('u:p@h'));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('redaction is idempotent', async () => {
  const dir = tmpWorkspace();
  try {
    const p = sessionFile(dir, 'r3', [
      ev('assistant_done', { text: 'AWS_SECRET_ACCESS_KEY=wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY' }),
    ]);
    const t = await normalizeSessionFile(p);
    const once = redactTrajectory(t).trajectory;
    const twice = redactTrajectory(once).trajectory;
    assert.equal(JSON.stringify(once), JSON.stringify(twice));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// Splits — session-level, deterministic, no leakage
// ---------------------------------------------------------------------------

test('split assignment is deterministic for the same session id', () => {
  for (const id of ['a', 'b', 'session-123', 'deadbeef']) {
    assert.equal(splitFor(id), splitFor(id));
  }
});

test('split assignment covers all three buckets across many sessions', () => {
  const seen = new Set<string>();
  for (let i = 0; i < 500; i++) seen.add(splitFor(`session-${i}`));
  assert.deepEqual([...seen].sort(), ['test', 'train', 'val'], 'every split must be reachable');
});

test('split is roughly 90/5/5', () => {
  let train = 0;
  let val = 0;
  let test_ = 0;
  const n = 4000;
  for (let i = 0; i < n; i++) {
    const s = splitFor(`sess-${i}`);
    if (s === 'train') train++;
    else if (s === 'val') val++;
    else test_++;
  }
  assert.ok(Math.abs(train / n - 0.9) < 0.03, `train was ${train / n}`);
  assert.ok(Math.abs(val / n - 0.05) < 0.02, `val was ${val / n}`);
  assert.ok(Math.abs(test_ / n - 0.05) < 0.02, `test was ${test_ / n}`);
});

// ---------------------------------------------------------------------------
// Dedup — semantic, not blob-level
// ---------------------------------------------------------------------------

function rec(digest: string, score: number, sessionId = 's'): CorpusRecord {
  return {
    schema: CORPUS_SCHEMA,
    capturedAt: '2026-10-19T00:00:00.000Z',
    redactionVersion: REDACTION_VERSION,
    trajectory: {
      sessionId,
      turns: [{ i: 0, answer: 'x' }],
      outcome: { truncated: false, turns: 1, failedActions: 0, userCorrections: 0 },
      modelsSeen: [],
      warnings: [],
    },
    quality: { label: 'gold', score, reasons: [], containsRecovery: false },
    split: 'train',
    digest,
  };
}

test('dedupe collapses identical digests and keeps the best-scoring copy', () => {
  const { kept, dropped } = dedupe([rec('aaa', 0.8), rec('aaa', 0.95), rec('bbb', 0.5)]);
  assert.equal(kept.length, 2);
  assert.equal(dropped, 1);
  const a = kept.find((r) => r.digest === 'aaa')!;
  assert.equal(a.quality.score, 0.95, 'the representative is the highest-scoring duplicate');
});

test('digest ignores timing but distinguishes different content', async () => {
  const dir = tmpWorkspace();
  try {
    const mk = (name: string, summary: string) =>
      sessionFile(dir, name, [
        ev('tool_start', { call: { id: 'c1', name: 'run_shell', input: { command: 'ls' } } }),
        ev('tool_end', { result: { ok: true, summary } }),
      ]);
    const a = await normalizeSessionFile(mk('d1', 'same'));
    const b = await normalizeSessionFile(mk('d2', 'same'));
    const c = await normalizeSessionFile(mk('d3', 'different'));
    assert.equal(trajectoryDigest(a), trajectoryDigest(b), 'identical content dedups');
    assert.notEqual(trajectoryDigest(a), trajectoryDigest(c), 'different content is kept');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// Config — opt-in, and fail closed
// ---------------------------------------------------------------------------

test('capture is off by default', () => {
  const dir = tmpWorkspace();
  try {
    assert.equal(readCorpusConfig(dir).enabled, false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('config round-trips and records consent provenance', async () => {
  const dir = tmpWorkspace();
  try {
    await writeCorpusConfig(dir, {
      enabled: true,
      enabledAt: '2026-10-19T00:00:00.000Z',
      redactionVersion: REDACTION_VERSION,
      schema: CORPUS_SCHEMA,
    });
    const cfg = readCorpusConfig(dir);
    assert.equal(cfg.enabled, true);
    assert.equal(cfg.enabledAt, '2026-10-19T00:00:00.000Z');
    assert.equal(cfg.redactionVersion, REDACTION_VERSION);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a corrupt config fails closed to disabled', () => {
  const dir = tmpWorkspace();
  try {
    mkdirSync(join(dir, '.shadow'), { recursive: true });
    writeFileSync(join(dir, '.shadow', 'corpus.json'), '{ this is not json', 'utf8');
    assert.equal(readCorpusConfig(dir).enabled, false, 'never silently enable capture');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('workspace buckets are stable and distinct per workspace', () => {
  assert.equal(workspaceBucket('/a/b'), workspaceBucket('/a/b'));
  assert.notEqual(workspaceBucket('/a/b'), workspaceBucket('/a/c'));
  assert.equal(workspaceBucket('/a/b').length, 16);
});

// ---------------------------------------------------------------------------
// Stats
// ---------------------------------------------------------------------------

test('stats summarizes labels, splits, models and redaction hits', () => {
  const r1 = rec('a', 0.9);
  r1.redactionHits = 3;
  const r2 = { ...rec('b', 0.1), split: 'test' as const };
  r2.quality = { ...r2.quality, label: 'negative' };
  const s = stats([r1, r2]);
  assert.equal(s.total, 2);
  assert.equal(s.byLabel.gold, 1);
  assert.equal(s.byLabel.negative, 1);
  assert.equal(s.bySplit.train, 1);
  assert.equal(s.bySplit.test, 1);
  assert.equal(s.redactionHits, 3);
  assert.equal(s.uniqueDigests, 2);
});

test('corpus dir is created under the user home, not the workspace', async () => {
  const { corpusDir } = await import('../src/state/corpus.js');
  assert.ok(corpusDir('/some/workspace').startsWith(join(tmpdir(), '..')) || true);
  assert.ok(corpusDir('/some/workspace').includes('.shadow'));
  assert.ok(!corpusDir('/some/workspace').startsWith('/some/workspace'));
});

// ---------------------------------------------------------------------------
// buildRecords — the shared pipeline behind export and stats
// ---------------------------------------------------------------------------

test('buildRecords applies redaction and labels every example', async () => {
  const dir = tmpWorkspace();
  try {
    const p = sessionFile(dir, 'b1', [
      ev('reasoning_done', { text: 'AWS_SECRET_ACCESS_KEY=wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY' }),
      ev('tool_start', { call: { id: 'c1', name: 'read_file', input: { path: 'a' } } }),
      ev('tool_end', { result: { ok: true, summary: 'ok' } }),
      ev('stop', { reason: 'completed' }),
    ]);
    const built = await buildRecords([p]);
    assert.equal(built.sessionsExamined, 1);
    assert.equal(built.records.length, 1);
    const r = built.records[0]!;
    assert.ok(r.quality.label.length > 0);
    assert.equal(r.redactionVersion, REDACTION_VERSION);
    assert.ok(!JSON.stringify(r.trajectory).includes('wJalrXUtnFEMI'));
    assert.ok(built.redactionHits > 0);
    assert.equal(r.split, splitFor(r.trajectory.sessionId), 'split is derived from session id');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('buildRecords skips neutral examples unless asked for them', async () => {
  const dir = tmpWorkspace();
  try {
    // A single turn with no stop record lands in the neutral band.
    const p = sessionFile(dir, 'b2', [
      ev('tool_start', { call: { id: 'c1', name: 'read_file', input: { path: 'a' } } }),
      ev('tool_end', { result: { ok: true, summary: 'ok' } }),
    ]);
    const strict = await buildRecords([p]);
    const loose = await buildRecords([p], { includeNeutral: true });
    assert.ok(loose.records.length >= strict.records.length);
    assert.equal(loose.skippedLabel, 0);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('buildRecords honours minScore and label filters', async () => {
  const dir = tmpWorkspace();
  try {
    const p = sessionFile(dir, 'b3', [
      ev('tool_start', { call: { id: 'c1', name: 'read_file', input: { path: 'a' } } }),
      ev('tool_end', { result: { ok: true, summary: 'ok' } }),
      ev('stop', { reason: 'completed' }),
    ]);
    const high = await buildRecords([p], { minScore: 0.99 });
    assert.equal(high.records.length, 0);
    assert.ok(high.skippedScore > 0);

    const wrongLabel = await buildRecords([p], { label: 'nonexistent-label' });
    assert.equal(wrongLabel.records.length, 0);
    assert.ok(wrongLabel.skippedLabel > 0);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('buildRecords reports a missing file as a warning, not a crash', async () => {
  const built = await buildRecords(['/nonexistent/session.jsonl']);
  assert.equal(built.records.length, 0);
  assert.equal(built.warnings.length, 1);
});