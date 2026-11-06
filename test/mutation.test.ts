import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync, readFileSync, chmodSync, existsSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createMutationJournal, mutationDigest } from '../src/tools/mutation.js';

function workspace(): string {
  const root = mkdtempSync(join(tmpdir(), 'shadow-mutation-'));
  mkdirSync(join(root, 'src'));
  writeFileSync(join(root, 'src/a.txt'), 'old\n');
  return root;
}

test('prepare binds exact bytes and refuses drifted preconditions', () => {
  const root = workspace();
  try {
    const journal = createMutationJournal(root);
    assert.throws(() => journal.prepare([{ path: 'src/a.txt', before: 'wrong', after: 'new' }]), /precondition/i);
    assert.throws(() => journal.prepare([{ path: 'src/a.txt', before: 'old\n', after: 'new' }, { path: 'src/a.txt', before: 'old\n', after: 'x' }]), /unique/i);
    assert.throws(() => journal.prepare([{ path: '../outside.txt', before: null, after: 'x' }]), /inside the workspace/);
    assert.throws(() => journal.prepare([{ path: '/etc/hosts', before: null, after: 'x' }]), /relative/);
    assert.throws(() => journal.prepare([]), /nonempty/i);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('approval is bound to exact content and state', () => {
  const root = workspace();
  try {
    const journal = createMutationJournal(root);
    const record = journal.prepare([{ path: 'src/a.txt', before: 'old\n', after: 'new\n' }]);
    assert.equal(record.state, 'prepared');
    const digest = record.approvalDigest;
    assert.equal(digest, mutationDigest(record.files));
    assert.throws(() => journal.approve(record.id, '0'.repeat(64)), /does not bind/i);
    const approved = journal.approve(record.id, digest);
    assert.equal(approved.state, 'approved');
    assert.throws(() => journal.approve(record.id, digest), /Only a prepared/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('apply refuses wrong digest, then writes and refuses re-apply (no replay)', () => {
  const root = workspace();
  try {
    const journal = createMutationJournal(root);
    const record = journal.prepare([{ path: 'src/a.txt', before: 'old\n', after: 'new\n' }]);
    const approved = journal.approve(record.id, record.approvalDigest);
    assert.throws(() => journal.apply(record.id, 'f'.repeat(64)), /does not bind/i);
    journal.apply(approved.id, approved.approvalDigest);
    assert.equal(readFileSync(join(root, 'src/a.txt'), 'utf8'), 'new\n');
    assert.throws(() => journal.apply(approved.id, approved.approvalDigest), /Only an approved/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('apply marks unknown on injected write failure and never replays', () => {
  const root = workspace();
  try {
    let calls = 0;
    const journal = createMutationJournal(root, {
      targetWrite: (path, bytes) => {
        calls++;
        if (calls === 2) throw new Error('disk full');
        // Call 1 must really write: this is a PARTIAL application.
        writeFileSync(path, bytes);
      },
    });
    const record = journal.prepare([
      { path: 'src/a.txt', before: 'old\n', after: 'a2\n' },
      { path: 'src/b.txt', before: null, after: 'b2\n' },
    ]);
    journal.approve(record.id, record.approvalDigest);
    assert.throws(() => journal.apply(record.id, record.approvalDigest), /disk full/);
    const records = journal.reconcile();
    assert.equal(records.length, 1);
    assert.equal(records[0].state, 'unknown');
    const statuses = new Map(records[0].files.map((f) => [f.path, f.status]));
    assert.equal(statuses.get('src/a.txt'), 'matches-after');
    assert.equal(statuses.get('src/b.txt'), 'missing');
    assert.equal(calls, 2);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('rollback refuses wrong digest, restores exact bytes, deletes created files', () => {
  const root = workspace();
  try {
    const journal = createMutationJournal(root);
    const record = journal.prepare([
      { path: 'src/a.txt', before: 'old\n', after: 'new\n' },
      { path: 'src/created.txt', before: null, after: 'made\n' },
    ]);
    const approved = journal.approve(record.id, record.approvalDigest);
    journal.apply(approved.id, approved.approvalDigest);
    assert.throws(() => journal.rollBack(approved.id, 'a'.repeat(64)), /does not bind/i);
    const rolled = journal.rollBack(approved.id, approved.approvalDigest);
    assert.equal(rolled.state, 'rolled-back');
    assert.equal(readFileSync(join(root, 'src/a.txt'), 'utf8'), 'old\n');
    assert.equal(existsSync(join(root, 'src/created.txt')), false);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('rollback marks unknown on injected failure and reports per-file truth', () => {
  const root = workspace();
  try {
    let phase = 'apply';
    const journal = createMutationJournal(root, {
      targetWrite: (path, bytes) => { writeFileSync(path, bytes); },
      // File 2 was CREATED by apply, so its rollback is an unlink: fail there.
      // That is the realistic partial-rollback point.
      targetUnlink: () => {
        if (phase === 'rollback') throw new Error('rollback failed');
      },
    });
    const record = journal.prepare([
      { path: 'src/a.txt', before: 'old\n', after: 'new\n' },
      { path: 'src/c.txt', before: null, after: 'made\n' },
    ]);
    journal.approve(record.id, record.approvalDigest);
    journal.apply(record.id, record.approvalDigest);
    phase = 'rollback';
    assert.throws(() => journal.rollBack(record.id, record.approvalDigest), /rollback failed/);
    const records = journal.reconcile();
    assert.equal(records.length, 1);
    assert.equal(records[0].state, 'unknown');
    const statuses = new Map(records[0].files.map((f) => [f.path, f.status]));
    // File 1 WAS rolled back before the failure; file 2 still holds the applied content.
    assert.equal(statuses.get('src/a.txt'), 'matches-before');
    assert.equal(statuses.get('src/c.txt'), 'matches-after');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('applying marker is visible to reconcile before writes complete', () => {
  const root = workspace();
  try {
    // Realistic crash: the applying marker IS durably written, then the process
    // dies before the first target write lands. Reconcile must surface it with
    // per-file truth — and never replay it.
    const journal = createMutationJournal(root, {
      targetWrite: () => { throw new Error('process died mid-apply'); },
    });
    const record = journal.prepare([{ path: 'src/a.txt', before: 'old\n', after: 'new\n' }]);
    journal.approve(record.id, record.approvalDigest);
    assert.throws(() => journal.apply(record.id, record.approvalDigest), /process died mid-apply/);
    const records = journal.reconcile();
    assert.equal(records.length, 1);
    assert.equal(records[0].state, 'unknown');
    assert.equal(records[0].files[0].status, 'matches-before');
    // No replay: applying again is refused because the state is no longer approved.
    assert.throws(() => journal.apply(record.id, record.approvalDigest), /Only an approved/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('a live lock holder blocks apply; a provably dead holder is reclaimed once', async () => {
  const root = workspace();
  let child: ReturnType<typeof spawn> | undefined;
  try {
    // A genuinely live holder: a real child process. (Assuming some pid like 2
    // is alive is wrong on macOS — ESRCH made the journal correctly reclaim.)
    child = spawn('sleep', ['30']);
    await new Promise((resolve) => setTimeout(resolve, 200));
    const journal = createMutationJournal(root);
    const record = journal.prepare([{ path: 'src/a.txt', before: 'old\n', after: 'new\n' }]);
    journal.approve(record.id, record.approvalDigest);
    writeFileSync(
      join(root, '.shadow', 'mutations', `${record.id}.lock`),
      JSON.stringify({ pid: child.pid, at: '2026-01-01T00:00:00.000Z' }),
    );
    // Live holder: fail closed.
    assert.throws(() => journal.apply(record.id, record.approvalDigest), /in progress/);
    // Holder dies and is reaped: signal 0 now returns ESRCH, reclaiming once.
    child.kill('SIGKILL');
    await new Promise((resolve) => child!.on('exit', resolve));
    await new Promise((resolve) => setTimeout(resolve, 100));
    journal.apply(record.id, record.approvalDigest);
    assert.equal(readFileSync(join(root, 'src/a.txt'), 'utf8'), 'new\n');
    // Re-apply is refused: the operation already ran — no replay.
    assert.throws(() => journal.apply(record.id, record.approvalDigest), /Only an approved/);
  } finally {
    child?.kill('SIGKILL');
    rmSync(root, { recursive: true, force: true });
  }
});

test('tampered journal records are reported per record without hiding others', () => {
  const root = workspace();
  try {
    const journal = createMutationJournal(root);
    const good = journal.prepare([{ path: 'src/a.txt', before: 'old\n', after: 'new\n' }]);
    journal.approve(good.id, good.approvalDigest);
    // Forge a second record with a mismatched digest.
    const forged = {
      version: 2, id: '00000000-0000-4000-8000-000000000002', state: 'applying',
      approvalDigest: '0'.repeat(64), createdAt: '2026-01-01T00:00:00.000Z',
      files: [{ path: 'src/x.txt', beforeB64: null, afterB64: Buffer.from('evil').toString('base64') }],
    };
    writeFileSync(join(root, '.shadow', 'mutations', '00000000-0000-4000-8000-000000000002.json'), JSON.stringify(forged));
    const records = journal.reconcile();
    assert.equal(records.length, 1);
    assert.equal(records[0].id, '00000000-0000-4000-8000-000000000002');
    assert.ok(records[0].recordProblem, 'forged record must be flagged, not trusted');
    // The real prepared-but-not-serialized record must NOT appear as interrupted.
    assert.ok(!records.some((r) => r.id === good.id));
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('symlinked targets and journal records are rejected', () => {
  const root = workspace();
  try {
    const journal = createMutationJournal(root);
    writeFileSync(join(root, 'src/real.txt'), 'r');
    symlinkSync('real.txt', join(root, 'src/link.txt'));
    assert.throws(() => journal.prepare([{ path: 'src/link.txt', before: 'r', after: 'x' }]), /Symbolic-link/);
    // Prepare once first so the journal directory exists; journal records are then
    // reachable as targets and must be rejected.
    const existing = journal.prepare([{ path: 'src/a.txt', before: 'old\n', after: 'new\n' }]);
    assert.ok(existing.id);
    assert.throws(() => journal.prepare([{ path: `.shadow/mutations/${existing.id}.json`, before: null, after: 'x' }]), /Journal files/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

class MutationCrash extends Error {
  constructor(public readonly record: unknown) { super('simulated crash during journal write'); }
}
