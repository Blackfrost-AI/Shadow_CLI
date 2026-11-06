import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createMutationJournal } from '../src/tools/mutation.js';
import {
  listInterrupted,
  reconnectReport,
  resolutionMarkerPath,
  resolveKeep,
  resolveRetry,
  retryApprovalHandle,
  resolveRollback,
} from '../src/tools/crashRecovery.js';

/**
 * m-8 crash restore: per-operation reconciliation WITHOUT replaying side effects.
 * Every workspace is a throwaway mkdtemp dir; the journal's own crash fixtures inject a
 * throwing `targetWrite` to simulate dying mid-apply.
 */

function freshRoot(): string {
  return mkdtempSync(join(tmpdir(), 'shadow-crash-recovery-'));
}

/** A journal whose apply dies after N successful target writes — the crash fixture.
 *  dieAfter=N performs N writes and dies BEFORE write N+1 (0 = dies before any write lands). */
function crashedJournal(root: string, dieAfter: number, fileCount: number) {
  const files = Array.from({ length: fileCount }, (_, i) => ({
    path: `f${i}.txt`,
    before: `before-${i}\n`,
    after: `after-${i}\n`,
  }));
  // prepare() binds each file's CURRENT disk state as its precondition: create the
  // before-state first, exactly as a real workspace would have it.
  for (const file of files) writeFileSync(join(root, file.path), file.before);
  let writes = 0;
  const journal = createMutationJournal(root, {
    targetWrite: (path, bytes) => {
      if (writes >= dieAfter) throw new Error('process died mid-apply');
      writes++;
      writeFileSync(path, bytes);
    },
  });
  const prepared = journal.prepare(files);
  journal.approve(prepared.id, prepared.approvalDigest);
  try {
    journal.apply(prepared.id, prepared.approvalDigest);
  } catch {
    /* the crash we asked for */
  }
  return { journal, files, record: journal.get(prepared.id) };
}

test('listInterrupted reports the crash state with per-file truth and NO automatic resolution', () => {
  const root = freshRoot();
  try {
    const { journal, files } = crashedJournal(root, 1, 3); // die after the first write
    // the first file landed, the rest did not — per-file truth must say exactly that
    const listed = listInterrupted(root);
    assert.equal(listed.length, 1);
    assert.equal(listed[0]!.kind, 'mutation');
    assert.equal(listed[0]!.state, 'unknown'); // the journal's own crash state
    assert.deepEqual(
      listed[0]!.files.map((f) => [f.path, f.status]),
      [
        ['f0.txt', 'matches-after'], // this side effect LANDED before the crash
        ['f1.txt', 'matches-before'], // this one did not
        ['f2.txt', 'matches-before'],
      ],
    );
    // the evidence record exists and backs every claim above
    assert.ok(existsSync(listed[0]!.evidence));
    assert.equal(JSON.parse(readFileSync(listed[0]!.evidence, 'utf8')).id, listed[0]!.operationId);
    // NO automatic resolution: the target files are untouched by listing alone
    assert.equal(readFileSync(join(root, 'f0.txt'), 'utf8'), files[0]!.after);
    void journal;
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('resolveRollback restores the exact before-bytes under the recorded digest', () => {
  const root = freshRoot();
  try {
    const { journal, record } = crashedJournal(root, 1, 2);
    assert.equal(readFileSync(join(root, 'f0.txt'), 'utf8'), 'after-0\n');
    // the journal can only roll back a fully APPLIED mutation; an interrupted one cannot be
    // rolled back — the crash left the record in `unknown`, so this must refuse.
    assert.throws(() => resolveRollback(journal, record.id, record.approvalDigest), /Only an applied mutation can be rolled back/);

    // A fully applied operation CAN be rolled back under its recorded digest, restoring the
    // exact before-bytes (and deleting files that did not exist before).
    const cleanRoot = freshRoot();
    try {
      writeFileSync(join(cleanRoot, 'keep.txt'), 'original-bytes\n');
      const files = [
        { path: 'keep.txt', before: 'original-bytes\n', after: 'mutated-bytes\n' },
        { path: 'new.txt', before: null, after: 'created-by-mutation\n' },
      ];
      const journal2 = createMutationJournal(cleanRoot);
      const prepared = journal2.prepare(files);
      journal2.approve(prepared.id, prepared.approvalDigest);
      journal2.apply(prepared.id, prepared.approvalDigest);
      assert.equal(readFileSync(join(cleanRoot, 'keep.txt'), 'utf8'), 'mutated-bytes\n');
      assert.ok(existsSync(join(cleanRoot, 'new.txt')));
      const rolled = resolveRollback(journal2, prepared.id, prepared.approvalDigest);
      assert.equal(rolled.state, 'rolled-back');
      assert.equal(readFileSync(join(cleanRoot, 'keep.txt'), 'utf8'), 'original-bytes\n'); // exact bytes
      assert.ok(!existsSync(join(cleanRoot, 'new.txt'))); // the created file is gone
      // the spent approval can never be reused — the journal refuses the replay
      assert.throws(() => resolveRollback(journal2, prepared.id, prepared.approvalDigest), /rolled back/);
    } finally {
      rmSync(cleanRoot, { recursive: true, force: true });
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('resolveKeep flags the operation without changing any state', () => {
  const root = freshRoot();
  try {
    const { journal, record } = crashedJournal(root, 1, 2);
    const beforeBytes = readFileSync(join(root, 'f0.txt'), 'utf8');
    const verdict = resolveKeep(root, record.id);
    assert.deepEqual(verdict, { operationId: record.id, resolution: 'keep' });
    // the on-disk state is UNCHANGED by the keep decision
    assert.equal(readFileSync(join(root, 'f0.txt'), 'utf8'), beforeBytes);
    assert.equal(journal.get(record.id).state, 'unknown'); // journal record untouched
    // the operation is no longer listed as unresolved, but the report still flags it
    assert.equal(listInterrupted(root).length, 0);
    const report = reconnectReport(root);
    assert.equal(report.operations.length, 1);
    assert.equal(report.operations[0]!.resolution.type, 'keep');
    assert.match(report.operations[0]!.recommendedAction, /kept by operator decision/);
    assert.equal(report.counts.kept, 1);
    assert.equal(report.counts.unresolved, 0);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('resolveRetry: the OLD approval digest is refused; only a fresh handle works', () => {
  const root = freshRoot();
  try {
    const { journal, record } = crashedJournal(root, 1, 2);
    // the old approval digest is never accepted — not as the retry digest…
    assert.throws(() => resolveRetry(root, record.id, record.approvalDigest), /old approval digest is spent/);
    // …and not via the fresh-handle shape either (it is bound to this op's content, so a
    // stranger's digest is refused).
    assert.throws(() => resolveRetry(root, record.id, 'f'.repeat(64)), /approval does not match request/);
    // the fresh handle is the ONLY admissible approval, and it is bound to THIS operation
    const freshHandle = retryApprovalHandle(record.id, record.approvalDigest);
    assert.notEqual(freshHandle, record.approvalDigest);
    // the interrupted files are back at their before-state on disk (the crash undid the
    // partial apply for f1; f0 landed). A retry revalidates every precondition against
    // current disk state — the landed f0 no longer matches its recorded precondition, so the
    // retry is refused by the journal's own revalidation: no replay ever happens.
    assert.throws(
      () => resolveRetry(root, record.id, freshHandle),
      /Recorded precondition does not match the file/,
    );
    // the first file's landed effect was NOT replayed or reverted by the refused retry
    assert.equal(readFileSync(join(root, 'f0.txt'), 'utf8'), 'after-0\n');
    void journal;
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('resolveRetry succeeds under a fresh approval when preconditions hold', () => {
  const root = freshRoot();
  try {
    const { journal, record } = crashedJournal(root, 0, 2); // die before ANY write lands
    // nothing landed: both files are still at their before-state
    assert.equal(readFileSync(join(root, 'f0.txt'), 'utf8'), 'before-0\n');
    const freshHandle = retryApprovalHandle(record.id, record.approvalDigest);
    const retried = resolveRetry(root, record.id, freshHandle);
    // a NEW journal operation id — never a reuse of the old one
    assert.notEqual(retried.operationId, record.id);
    assert.equal(retried.supersededOperationId, record.id);
    assert.equal(retried.state, 'applied');
    assert.equal(readFileSync(join(root, 'f0.txt'), 'utf8'), 'after-0\n'); // the retried effect landed
    assert.equal(readFileSync(join(root, 'f1.txt'), 'utf8'), 'after-1\n');
    // the old operation is flagged superseded and no longer listed as unresolved
    const report = reconnectReport(root);
    const old = report.operations.find((o) => o.operationId === record.id);
    assert.equal(old!.resolution.type, 'superseded');
    assert.equal(old!.resolution.retryOperationId, retried.operationId);
    assert.equal(listInterrupted(root).length, 0);
    // the old approval digest still cannot be re-presented for a second retry
    assert.throws(() => resolveRetry(root, record.id, record.approvalDigest), /old approval digest is spent/);
    void journal;
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('resolveRollback refuses an approval minted for a different operation', () => {
  const root = freshRoot();
  try {
    // two fully-applied operations: A's digest must not roll back B
    writeFileSync(join(root, 'a.txt'), 'a-before\n');
    writeFileSync(join(root, 'b.txt'), 'b-before\n');
    const filesA = [{ path: 'a.txt', before: 'a-before\n', after: 'a-after\n' }];
    const filesB = [{ path: 'b.txt', before: 'b-before\n', after: 'b-after\n' }];
    const journal = createMutationJournal(root);
    const prepA = journal.prepare(filesA);
    journal.approve(prepA.id, prepA.approvalDigest);
    journal.apply(prepA.id, prepA.approvalDigest);
    const prepB = journal.prepare(filesB);
    journal.approve(prepB.id, prepB.approvalDigest);
    journal.apply(prepB.id, prepB.approvalDigest);
    // A's digest under B's id → OUR gate refuses the cross-binding first (the journal's own
    // digest assertion would fire only if the gate passed; the mission-pinned message wins).
    assert.throws(() => resolveRollback(journal, prepB.id, prepA.approvalDigest), /approval does not match request/);
    // the marker path is deterministic and id-validated
    assert.throws(() => resolutionMarkerPath(root, '../escape'), /invalid operation id/);
    assert.throws(() => resolveKeep(root, 'not-a-uuid'), /invalid operation id/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('reconnectReport lists incomplete effects without replaying', () => {
  const root = freshRoot();
  try {
    const { files } = crashedJournal(root, 1, 3);
    const report = reconnectReport(root);
    assert.equal(report.replayed, false);
    assert.equal(report.counts.total, 1);
    assert.equal(report.counts.unresolved, 1);
    assert.equal(report.operations[0]!.state, 'unknown');
    // per-file truth is present so the operator can decide per operation
    assert.deepEqual(
      report.operations[0]!.files.map((f) => f.status),
      ['matches-after', 'matches-before', 'matches-before'],
    );
    assert.match(report.operations[0]!.recommendedAction, /partial effect landed/);
    // producing the report wrote NOTHING: the landed effect is still there, the un-landed
    // files are still at their before-state
    assert.equal(readFileSync(join(root, 'f0.txt'), 'utf8'), files[0]!.after);
    assert.equal(readFileSync(join(root, 'f1.txt'), 'utf8'), files[1]!.before);
    assert.equal(readFileSync(join(root, 'f2.txt'), 'utf8'), files[2]!.before);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('a corrupted journal record is surfaced as a visible problem, never hidden', () => {
  const root = freshRoot();
  try {
    crashedJournal(root, 0, 2); // die before ANY write: a genuinely interrupted operation
    const listed = listInterrupted(root);
    assert.equal(listed.length, 1);
    // corrupt the record so reconcile() cannot decode it — the listing must surface the
    // problem rather than hiding the operation
    writeFileSync(listed[0]!.evidence, 'this is not JSON');
    const reListed = listInterrupted(root);
    assert.equal(reListed.length, 1);
    assert.equal(reListed[0]!.state, 'unknown');
    assert.ok(reListed[0]!.problem && /Invalid mutation journal record/.test(reListed[0]!.problem));
    assert.deepEqual(reListed[0]!.files, []);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
