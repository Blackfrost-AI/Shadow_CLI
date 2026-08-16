import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { isolateHome, assertStoreIsolated } from './helpers/isolateHome.js';
import { SessionLog } from '../src/state/session.js';
import { planRetention, applyRetention, formatBytes, ARCHIVE_DIRNAME } from '../src/state/retention.js';
import { saveCheckpoint } from '../src/state/checkpoints.js';

// P2-13 retention: opt-in, archive-over-delete. These tests exercise the pure plan, the
// archive sweep (never a delete), the /doctor dry-run, and the global-only config guard.
// ~/.shadow is redirected to a throwaway HOME BEFORE config/doctor are imported (GLOBAL_DIR
// is bound at module load). `npm test` only — never `bun test` (see helpers/isolateHome.ts).
const { home: HOME, shadowDir: SHADOW } = isolateHome('retention');
const { loadConfig } = await import('../src/config.js');
const { GLOBAL_DIR } = await import('../src/state/globalStore.js');
assertStoreIsolated(GLOBAL_DIR, HOME);
const { runDoctor, formatDoctorReport } = await import('../src/doctor.js');

function tmpWs(): string {
  return mkdtempSync(join(tmpdir(), 'shadow-retws-'));
}

/** A minimal session log named with an ISO stamp (list() sorts names newest-first). */
function makeSession(ws: string, stamp: string, ageDays = 0): string {
  const dir = SessionLog.sessionsDir(ws);
  mkdirSync(dir, { recursive: true });
  const p = join(dir, `${stamp}.jsonl`);
  writeFileSync(p, JSON.stringify({ ts: '2026-01-01T00:00:00.000Z', kind: 'user', task: `log ${stamp}` }) + '\n', {
    mode: 0o600,
  });
  if (ageDays > 0) {
    const t = new Date(Date.now() - ageDays * 86_400_000);
    utimesSync(p, t, t);
  }
  return p;
}

test('retention is OFF unless configured — nothing is planned or touched', () => {
  const ws = tmpWs();
  try {
    const old = makeSession(ws, '2026-01-01T00-00-00.000Z', 400);
    assert.deepEqual(planRetention(ws, {}), [], 'no config → no candidates, however old the logs');
    const res = applyRetention(ws, {});
    assert.deepEqual(res.archived, []);
    assert.ok(existsSync(old), 'the log is untouched');
    assert.ok(!existsSync(join(SessionLog.sessionsDir(ws), ARCHIVE_DIRNAME)), 'no archive dir is even created');
  } finally {
    rmSync(ws, { recursive: true, force: true });
  }
});

test('the age rule archives logs older than N days — a MOVE into .archive, never a delete', () => {
  const ws = tmpWs();
  try {
    const old = makeSession(ws, '2026-01-01T00-00-00.000Z', 40);
    const mid = makeSession(ws, '2026-02-01T00-00-00.000Z', 10);
    const fresh = makeSession(ws, '2026-03-01T00-00-00.000Z', 0);
    const cfg = { sessionRetentionDays: 30 };
    const plan = planRetention(ws, cfg);
    assert.deepEqual(plan.map((c) => c.path), [old], 'only the >30d log is a candidate');
    assert.equal(plan[0]!.reason, 'age');

    // Give the old session a checkpoint tree — it must move WITH its log (a /rewind can only
    // use checkpoints alongside the log they were captured for).
    const id = SessionLog.sessionIdFromPath(old);
    const cpFile = join(ws, '.shadow', 'checkpoints', id, '1', 'f.txt');
    mkdirSync(join(ws, '.shadow', 'checkpoints', id, '1'), { recursive: true });
    writeFileSync(cpFile, 'backup');

    const before = readFileSync(old, 'utf8');
    const res = applyRetention(ws, cfg);
    assert.equal(res.archived.length, 1);
    assert.ok(!existsSync(old), 'the original path is gone');
    const to = res.archived[0]!.to;
    assert.ok(existsSync(to), 'the log landed in the archive');
    assert.equal(readFileSync(to, 'utf8'), before, 'content preserved byte-for-byte');
    assert.ok(to.includes(join(res.archiveDir, '')), 'archive target is under sessions/.archive/');
    assert.ok(existsSync(join(res.archiveDir, `checkpoints-${id}`, '1', 'f.txt')), 'checkpoint tree moved along');
    assert.ok(existsSync(mid) && existsSync(fresh), 'young logs untouched');
    // Idempotent: a second sweep finds nothing new.
    assert.deepEqual(applyRetention(ws, cfg).archived, []);
  } finally {
    rmSync(ws, { recursive: true, force: true });
  }
});

// Ten minutes expressed in days — comfortably past the live-fresh guard (now 5 min, widened
// from 60s for C2/S3), young enough that only the COUNT rule (not the age rule) can match.
const TEN_MIN_DAYS = 10 / 1440;

test('the keep rule alone archives everything beyond the newest M', () => {
  const ws = tmpWs();
  try {
    // Backdate all four past the live-fresh guard: a count sweep must be able to archive
    // sessions that ended minutes ago — the guard only protects logs written within 5 min.
    const a = makeSession(ws, '2026-01-01T00-00-00.000Z', TEN_MIN_DAYS);
    const b = makeSession(ws, '2026-02-01T00-00-00.000Z', TEN_MIN_DAYS);
    const c = makeSession(ws, '2026-03-01T00-00-00.000Z', TEN_MIN_DAYS);
    const d = makeSession(ws, '2026-04-01T00-00-00.000Z', TEN_MIN_DAYS);
    const cfg = { sessionRetentionKeep: 2 };
    const plan = planRetention(ws, cfg);
    // Newest-first listing is d,c,b,a — beyond the newest 2 means b and a.
    assert.deepEqual(plan.map((x) => x.path), [b, a]);
    assert.ok(plan.every((x) => x.reason === 'count'));
    applyRetention(ws, cfg);
    assert.ok(existsSync(d) && existsSync(c), 'the newest two survive');
    assert.ok(!existsSync(b) && !existsSync(a), 'the rest are archived');
  } finally {
    rmSync(ws, { recursive: true, force: true });
  }
});

test('the newest M are protected from the age rule too', () => {
  const ws = tmpWs();
  try {
    const a = makeSession(ws, '2026-01-01T00-00-00.000Z', 40);
    const b = makeSession(ws, '2026-02-01T00-00-00.000Z', 40);
    const c = makeSession(ws, '2026-03-01T00-00-00.000Z', 40); // ALL are older than 30d
    const plan = planRetention(ws, { sessionRetentionDays: 30, sessionRetentionKeep: 1 });
    assert.deepEqual(plan.map((x) => x.path), [b, a], 'the newest is kept even though it is old');
    assert.ok(!plan.some((x) => x.path === c), 'the protected newest is never a candidate');
  } finally {
    rmSync(ws, { recursive: true, force: true });
  }
});

test('a sweep never touches a just-written log (possibly live) nor an explicit resume target', () => {
  const ws = tmpWs();
  try {
    // keep=0 protects NOTHING by rank — the two extra guards must still hold.
    const fresh = makeSession(ws, '2026-04-01T00-00-00.000Z'); // written just now → possibly live
    const resumeTarget = makeSession(ws, '2026-03-01T00-00-00.000Z', 40); // old, but --resume'd
    const stale = makeSession(ws, '2026-01-01T00-00-00.000Z', 40);
    const plan = planRetention(
      ws,
      { sessionRetentionKeep: 0 },
      { excludeIds: [SessionLog.sessionIdFromPath(resumeTarget)] },
    );
    assert.deepEqual(
      plan.map((c) => c.path),
      [stale],
      'only the old, non-excluded, non-fresh log is a candidate',
    );
    const res = applyRetention(ws, { sessionRetentionKeep: 0 }, { excludeIds: [SessionLog.sessionIdFromPath(resumeTarget)] });
    assert.equal(res.archived.length, 1);
    assert.ok(existsSync(fresh) && existsSync(resumeTarget), 'the fresh log and the resume target stay put');
  } finally {
    rmSync(ws, { recursive: true, force: true });
  }
});

test('an archive name collision never overwrites an existing archived log', () => {
  const ws = tmpWs();
  try {
    const old = makeSession(ws, '2026-01-01T00-00-00.000Z', 40);
    const archiveDir = join(SessionLog.sessionsDir(ws), ARCHIVE_DIRNAME);
    mkdirSync(archiveDir, { recursive: true });
    writeFileSync(join(archiveDir, '2026-01-01T00-00-00.000Z.jsonl'), 'pre-existing archive entry\n');
    const res = applyRetention(ws, { sessionRetentionDays: 30 });
    assert.equal(res.archived.length, 1);
    assert.equal(readFileSync(join(archiveDir, '2026-01-01T00-00-00.000Z.jsonl'), 'utf8'), 'pre-existing archive entry\n');
    assert.ok(res.archived[0]!.to.endsWith('-1.jsonl'), 'collision resolved with a suffix');
    assert.ok(!existsSync(old));
  } finally {
    rmSync(ws, { recursive: true, force: true });
  }
});

test('a symlinked .archive is REFUSED — nothing ever flows through it (S1)', () => {
  const ws = tmpWs();
  const target = mkdtempSync(join(tmpdir(), 'shadow-retarget-'));
  try {
    const sessionsDir = SessionLog.sessionsDir(ws);
    mkdirSync(sessionsDir, { recursive: true });
    symlinkSync(target, join(sessionsDir, ARCHIVE_DIRNAME)); // plant a symlink where .archive belongs
    writeFileSync(join(target, 'victim.txt'), 'do not touch\n');
    const old = makeSession(ws, '2026-01-01T00-00-00.000Z', 40);
    const res = applyRetention(ws, { sessionRetentionDays: 30 });
    assert.deepEqual(res.archived, [], 'a symlink squatting on .archive archives NOTHING');
    assert.ok(existsSync(old), 'the stale log stays put rather than flowing through the link');
    assert.deepEqual(readdirSync(target), ['victim.txt'], 'the link target is untouched');
  } finally {
    rmSync(ws, { recursive: true, force: true });
    rmSync(target, { recursive: true, force: true });
  }
});

test('a hostile session filename cannot walk the checkpoint move out of its tree (S2)', () => {
  const ws = tmpWs();
  try {
    const sessionsDir = SessionLog.sessionsDir(ws);
    mkdirSync(sessionsDir, { recursive: true });
    // `...jsonl` → sessionIdFromPath() yields `..` — without the id guard the checkpoint move
    // would rename join(checkpoints, '..') = the ENTIRE .shadow tree into the archive.
    const hostile = join(sessionsDir, '...jsonl');
    writeFileSync(hostile, JSON.stringify({ ts: '2026-01-01T00:00:00.000Z', kind: 'user', task: 'hostile' }) + '\n');
    const t = new Date(Date.now() - 40 * 86_400_000);
    utimesSync(hostile, t, t);
    const cpRoot = join(ws, '.shadow', 'checkpoints');
    mkdirSync(cpRoot, { recursive: true });
    writeFileSync(join(cpRoot, 'decoy.txt'), 'keep me\n');

    const res = applyRetention(ws, { sessionRetentionDays: 30 });
    assert.equal(res.archived.length, 1, 'the log itself is archived — basename rename is safe');
    assert.ok(!existsSync(hostile));
    assert.ok(existsSync(join(cpRoot, 'decoy.txt')), 'the checkpoints tree was NOT renamed away');
    assert.deepEqual(readdirSync(cpRoot), ['decoy.txt'], 'nothing else touched inside it');
    assert.ok(!readdirSync(res.archiveDir).includes('checkpoints-..'), 'no traversal target created in the archive');
  } finally {
    rmSync(ws, { recursive: true, force: true });
  }
});

test('checkpoint trees are written PRIVATE: 0700 dirs, 0600 payloads and index (S4)', () => {
  const ws = tmpWs();
  try {
    const abs = saveCheckpoint(ws, 'sess-perms', 3, 'src/a.ts', 'pre-turn file body');
    assert.equal(statSync(abs).mode & 0o777, 0o600, 'the .bak payload is 0600, not umask 0644');
    assert.equal(statSync(dirname(abs)).mode & 0o777, 0o700, 'the turn dir is 0700');
    assert.equal(statSync(join(dirname(abs), 'index.json')).mode & 0o777, 0o600, 'index.json is 0600');
  } finally {
    rmSync(ws, { recursive: true, force: true });
  }
});

test('/doctor shows the retention dry-run BEFORE any pruning, and reports off when unconfigured', () => {
  const ws = tmpWs();
  try {
    // Unconfigured (no global config yet in the isolated home) → "off" line.
    let report = runDoctor(ws);
    let retention = report.checks.find((c) => c.id === 'retention');
    assert.ok(retention, 'the retention check is present');
    assert.equal(retention!.severity, 'info');
    assert.ok(retention!.ok, 'retention is informational, never a hard failure');
    assert.match(retention!.detail, /off/i);

    // Configure via the GLOBAL config, with stale logs present → dry-run counts them and
    // nothing is moved by the doctor run itself.
    writeFileSync(join(SHADOW, 'config.json'), JSON.stringify({ sessionRetentionDays: 30 }));
    const old = makeSession(ws, '2026-01-01T00-00-00.000Z', 40);
    makeSession(ws, '2026-03-01T00-00-00.000Z', 0);
    report = runDoctor(ws);
    retention = report.checks.find((c) => c.id === 'retention');
    assert.match(retention!.detail, /would ARCHIVE/, 'dry-run wording');
    assert.match(retention!.detail, /1 of 2/, 'counts the candidate and the total');
    assert.ok(existsSync(old), 'doctor MOVES nothing — the sweep happens at session start');
    assert.match(formatDoctorReport(report, 'test'), /retention/);
  } finally {
    rmSync(ws, { recursive: true, force: true });
  }
});

test('a project config file cannot set retention keys (global-only, untrusted-repo guard)', () => {
  const ws = tmpWs();
  try {
    // The doctor test above wrote a GLOBAL config with retention keys; remove it so this test
    // isolates the project-file strip (the global file is re-created at the end of the test).
    rmSync(join(SHADOW, 'config.json'), { force: true });
    writeFileSync(
      join(ws, 'shadow.config.json'),
      JSON.stringify({ sessionRetentionDays: 1, sessionRetentionKeep: 0, provider: 'mock' }),
    );
    const cfg = loadConfig(ws);
    assert.equal(cfg.sessionRetentionDays, undefined, 'days key stripped from the project file');
    assert.equal(cfg.sessionRetentionKeep, undefined, 'keep key stripped from the project file');
    // The same keys ARE honored when written to the global file.
    writeFileSync(join(SHADOW, 'config.json'), JSON.stringify({ sessionRetentionDays: 30 }));
    const globalCfg = loadConfig(ws);
    assert.equal(globalCfg.sessionRetentionDays, 30, 'the same key is honored from ~/.shadow/config.json');
  } finally {
    rmSync(ws, { recursive: true, force: true });
  }
});

test('formatBytes renders human-readable sizes', () => {
  assert.equal(formatBytes(512), '512 B');
  assert.equal(formatBytes(2048), '2.0 KB');
  assert.equal(formatBytes(5 * 1024 * 1024), '5.0 MB');
});
