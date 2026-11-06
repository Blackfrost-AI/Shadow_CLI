import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  buildProposal,
  commitApprovalDigest,
  executeProposal,
  inspectIndex,
  isCommitProposalError,
  resetCommitApprovalLedger,
  validateTargetPaths,
} from '../src/tools/gitCommitProposal.js';

/** Test-side git driver: argument arrays only, never a shell string. */
function git(root: string, args: string[]): Promise<{ code: number; out: string; err: string }> {
  return new Promise((resolveRun) => {
    execFile('git', args, { cwd: root, maxBuffer: 64 * 1024 * 1024, timeout: 60_000 }, (error, stdout, stderr) => {
      const code = error === null ? 0 : typeof (error as NodeJS.ErrnoException).code === 'number' ? (error as unknown as { code: number }).code : -1;
      resolveRun({ code, out: String(stdout), err: String(stderr) });
    });
  });
}

const PASS_HOOK = '#!/bin/sh\nexit 0\n';
/** Evidence hook: proves it ran during the scoped commit by dropping a marker file. */
const MARKER_HOOK = '#!/bin/sh\nprintf ran > .pre-commit-ran\nexit 0\n';
const REJECT_HOOK = '#!/bin/sh\necho HOOK-REJECT-MARKER-9f2a\necho HOOK-REJECT-STDERR-MARKER >&2\nexit 1\n';

interface Repo {
  root: string;
  cleanup: () => void;
}

/** A real temp git repo with LOCAL identity config only (never global). */
async function makeRepo(): Promise<Repo> {
  const root = mkdtempSync(join(tmpdir(), 'gcp-test-'));
  await git(root, ['init', '-q', '-b', 'main', '.']);
  await git(root, ['config', 'user.email', 'test@example.invalid']);
  await git(root, ['config', 'user.name', 'Commit Proposal Test']);
  return { root, cleanup: () => rmSync(root, { recursive: true, force: true }) };
}

function installHook(repo: Repo, name: string, content: string): void {
  mkdirSync(join(repo.root, '.git', 'hooks'), { recursive: true });
  writeFileSync(join(repo.root, '.git', 'hooks', name), content, { mode: 0o755 });
}

function write(root: string, path: string, content: string): void {
  writeFileSync(join(root, path), content);
}

/** Seed commit: every repo needs real content before git will create a commit. */
async function seedCommit(repo: Repo, files: Array<[string, string]>, message: string): Promise<string> {
  for (const [path, content] of files) write(repo.root, path, content);
  await git(repo.root, ['add', '-A']);
  const res = await git(repo.root, ['commit', '-q', '-m', message]);
  assert.equal(res.code, 0, `seed commit failed: ${res.err}`);
  return headOf(repo);
}

async function headOf(repo: Repo): Promise<string> {
  return (await git(repo.root, ['rev-parse', 'HEAD'])).out.trim();
}

async function indexBlobOf(repo: Repo, path: string): Promise<string | null> {
  const res = await git(repo.root, ['ls-files', '-s', '--', path]);
  const match = /^\d+ ([0-9a-f]{40})/m.exec(res.out);
  return match === null ? null : match[1];
}

async function headTreeNames(repo: Repo): Promise<string[]> {
  const res = await git(repo.root, ['ls-tree', '-r', '--name-only', 'HEAD']);
  return res.out.split('\n').filter((line) => line.length > 0);
}

async function porcelain(repo: Repo): Promise<string[]> {
  const res = await git(repo.root, ['status', '--porcelain=v1']);
  return res.out.split('\n').filter((line) => line.length > 0);
}

async function assertRefusedBy(error: unknown, stage: string, pattern: RegExp): Promise<void> {
  assert.ok(isCommitProposalError(error), `expected CommitProposalError, got: ${String(error)}`);
  assert.equal((error as { stage: string }).stage, stage);
  assert.match((error as Error).message, pattern);
}

test('preview lists exactly the target paths with statuses; a path with no staged change is refused by name', async () => {
  resetCommitApprovalLedger();
  const repo = await makeRepo();
  try {
    const baseHead = await seedCommit(repo, [['base.txt', 'base\n'], ['mod.txt', 'v1\n']], 'base');
    write(repo.root, 'new.txt', 'staged new\n');
    await git(repo.root, ['add', 'new.txt']);
    write(repo.root, 'mod.txt', 'v2\n');
    await git(repo.root, ['add', 'mod.txt']);
    write(repo.root, 'u.txt', 'untracked\n');
    const newBlob = await indexBlobOf(repo, 'new.txt');
    const modBlob = await indexBlobOf(repo, 'mod.txt');
    assert.ok(newBlob !== null && modBlob !== null);

    const proposal = await buildProposal(repo.root, ['new.txt', 'mod.txt'], 'preview msg');
    assert.deepEqual(proposal.targetPaths, ['mod.txt', 'new.txt']);
    assert.deepEqual(proposal.preview, [
      { path: 'mod.txt', status: 'modified', blob: modBlob },
      { path: 'new.txt', status: 'added', blob: newBlob },
    ]);
    assert.match(proposal.treeHash, /^[0-9a-f]{40}$/);
    assert.equal(proposal.approvalDigest, commitApprovalDigest(proposal.treeHash, 'preview msg', ['new.txt', 'mod.txt']));

    // The digest binds the exact tree + message + path set: any substitution differs.
    const other = await buildProposal(repo.root, ['new.txt'], 'other msg');
    assert.notEqual(other.approvalDigest, commitApprovalDigest(proposal.treeHash, 'preview msg', ['new.txt']));

    // An untracked path has no staged change and is refused by name.
    await assert.rejects(
      buildProposal(repo.root, ['u.txt'], 'm'),
      (error: unknown) => {
        assert.ok(isCommitProposalError(error));
        assert.equal((error as { stage: string }).stage, 'not-staged');
        assert.match((error as Error).message, /u\.txt/);
        return true;
      },
    );

    // Previewing committed nothing and left every staged change staged.
    assert.equal(await headOf(repo), baseHead);
    const status = await porcelain(repo);
    assert.ok(status.includes('A  new.txt'), 'staged new file must remain staged');
    assert.ok(status.includes('M  mod.txt'), 'staged modification must remain staged');

    // inspectIndex classifies the same fixture exactly.
    const inspection = await inspectIndex(repo.root);
    assert.equal(inspection.headCommit, baseHead);
    assert.deepEqual(inspection.stagedPaths, ['mod.txt', 'new.txt']);
    assert.deepEqual(inspection.unstagedPaths, []);
    assert.deepEqual(inspection.untrackedPaths, ['u.txt']);
    assert.deepEqual(inspection.hookPresence, { preCommit: false, commitMsg: false });
  } finally {
    repo.cleanup();
  }
});

test('unrelated staged change survives a scoped commit; only the target is committed; the pre-commit hook ran', async () => {
  resetCommitApprovalLedger();
  const repo = await makeRepo();
  try {
    const baseHead = await seedCommit(repo, [['base.txt', 'base\n']], 'base');
    write(repo.root, 'A.txt', 'unrelated staged\n');
    await git(repo.root, ['add', 'A.txt']);
    write(repo.root, 'B.txt', 'target staged\n');
    await git(repo.root, ['add', 'B.txt']);
    const aBlob = await indexBlobOf(repo, 'A.txt');
    const bBlob = await indexBlobOf(repo, 'B.txt');
    assert.ok(aBlob !== null && bBlob !== null);

    installHook(repo, 'pre-commit', MARKER_HOOK);
    rmSync(join(repo.root, '.pre-commit-ran'), { force: true }); // clear any setup residue
    assert.ok(!existsSync(join(repo.root, '.pre-commit-ran')), 'marker must be absent before the scoped commit');

    const proposal = await buildProposal(repo.root, ['B.txt'], 'commit B only');
    assert.equal(proposal.approvalDigest, commitApprovalDigest(proposal.treeHash, 'commit B only', ['B.txt']));
    const result = await executeProposal(repo.root, proposal, proposal.approvalDigest);
    assert.equal(result.ok, true);
    assert.notEqual((result as { commit: string }).commit, baseHead);
    assert.equal((result as { commit: string }).commit, await headOf(repo));

    // New HEAD tree: target committed with the staged blob; unrelated NOT committed.
    const treeNames = await headTreeNames(repo);
    assert.ok(treeNames.includes('B.txt'), 'target must be in the new HEAD tree');
    assert.ok(!treeNames.includes('A.txt'), 'unrelated staged file must NOT be in the new HEAD tree');
    assert.equal(
      (await git(repo.root, ['rev-parse', 'HEAD:B.txt'])).out.trim(),
      bBlob,
      'committed target blob must be the staged blob',
    );

    // Real index: unrelated entry keeps its exact blob and stays staged.
    assert.equal(await indexBlobOf(repo, 'A.txt'), aBlob);
    const status = await porcelain(repo);
    assert.ok(status.includes('A  A.txt'), `unrelated staged change must remain staged: ${status.join(' | ')}`);
    assert.ok(!status.includes('A  B.txt') && !status.includes('M  B.txt'), 'target must be clean against the new HEAD');

    // Hook retention: the pre-commit hook executed during the scoped commit.
    assert.ok(existsSync(join(repo.root, '.pre-commit-ran')), 'pre-commit hook must have run during the scoped commit');
  } finally {
    repo.cleanup();
  }
});

test('a rejecting pre-commit hook aborts the scoped commit with its output surfaced; refs and index untouched', async () => {
  resetCommitApprovalLedger();
  const repo = await makeRepo();
  try {
    const baseHead = await seedCommit(repo, [['base.txt', 'base\n']], 'base');
    write(repo.root, 'A.txt', 'unrelated staged\n');
    await git(repo.root, ['add', 'A.txt']);
    write(repo.root, 'B.txt', 'target staged\n');
    await git(repo.root, ['add', 'B.txt']);
    const aBlob = await indexBlobOf(repo, 'A.txt');
    const bBlob = await indexBlobOf(repo, 'B.txt');

    installHook(repo, 'pre-commit', REJECT_HOOK);
    const proposal = await buildProposal(repo.root, ['B.txt'], 'hook should reject');
    const result = await executeProposal(repo.root, proposal, proposal.approvalDigest);
    assert.equal(result.ok, false);
    assert.equal((result as { stage: string }).stage, 'hook-rejected');
    assert.match((result as { output: string }).output, /HOOK-REJECT-MARKER-9f2a/);
    assert.match((result as { output: string }).output, /HOOK-REJECT-STDERR-MARKER/);

    assert.equal(await headOf(repo), baseHead, 'HEAD must be unchanged after hook rejection');
    assert.equal(await indexBlobOf(repo, 'A.txt'), aBlob, 'unrelated staged blob unchanged');
    assert.equal(await indexBlobOf(repo, 'B.txt'), bBlob, 'target staged blob unchanged');
    const status = await porcelain(repo);
    assert.ok(status.includes('A  A.txt') && status.includes('A  B.txt'), 'both staged changes must remain staged');
  } finally {
    repo.cleanup();
  }
});

test('no replay: the approval is spent after a hook abort; only an explicit fresh approval can retry', async () => {
  resetCommitApprovalLedger();
  const repo = await makeRepo();
  try {
    const baseHead = await seedCommit(repo, [['base.txt', 'base\n']], 'base');
    write(repo.root, 'A.txt', 'unrelated staged\n');
    await git(repo.root, ['add', 'A.txt']);
    write(repo.root, 'B.txt', 'target staged\n');
    await git(repo.root, ['add', 'B.txt']);
    const aBlob = await indexBlobOf(repo, 'A.txt');

    installHook(repo, 'pre-commit', REJECT_HOOK);
    const proposal = await buildProposal(repo.root, ['B.txt'], 'retry flow');
    const first = await executeProposal(repo.root, proposal, proposal.approvalDigest);
    assert.equal((first as { stage: string }).stage, 'hook-rejected');

    // Replay of the same approval after the hook abort: refused.
    const replay = await executeProposal(repo.root, proposal, proposal.approvalDigest);
    assert.equal(replay.ok, false);
    assert.equal((replay as { stage: string }).stage, 'approval-spent');
    assert.equal(await headOf(repo), baseHead);

    // Any other digest is refused: the binding prevents substitutions.
    const wrongDigest = await executeProposal(repo.root, proposal, '0'.repeat(64));
    assert.equal(wrongDigest.ok, false);
    assert.equal((wrongDigest as { stage: string }).stage, 'approval-required');

    // The operator fixes the hook and explicitly rebuilds: a fresh approval works.
    installHook(repo, 'pre-commit', PASS_HOOK);
    const rebuilt = await buildProposal(repo.root, ['B.txt'], 'retry flow');
    assert.equal(rebuilt.approvalDigest, proposal.approvalDigest, 'identical content rebinds to the same digest');
    const retried = await executeProposal(repo.root, rebuilt, rebuilt.approvalDigest);
    assert.equal(retried.ok, true, `unexpected result: ${JSON.stringify(retried)}`);
    assert.notEqual((retried as { commit: string }).commit, baseHead);
    assert.equal(await indexBlobOf(repo, 'A.txt'), aBlob);
    assert.ok((await porcelain(repo)).includes('A  A.txt'), 'unrelated staged change must survive the retry');
    assert.ok(!(await headTreeNames(repo)).includes('A.txt'));
  } finally {
    repo.cleanup();
  }
});

test('a staged deletion commits alone; the unrelated staged change is untouched', async () => {
  resetCommitApprovalLedger();
  const repo = await makeRepo();
  try {
    const baseHead = await seedCommit(repo, [['base.txt', 'base\n'], ['B.txt', 'to be deleted\n']], 'base');
    write(repo.root, 'A.txt', 'unrelated staged\n');
    await git(repo.root, ['add', 'A.txt']);
    const aBlob = await indexBlobOf(repo, 'A.txt');

    // Stage ONLY the deletion of B (the worktree copy stays behind).
    const rm = await git(repo.root, ['rm', '-q', '--cached', 'B.txt']);
    assert.equal(rm.code, 0);

    installHook(repo, 'pre-commit', PASS_HOOK);
    const proposal = await buildProposal(repo.root, ['B.txt'], 'remove B only');
    assert.deepEqual(proposal.preview, [{ path: 'B.txt', status: 'deleted', blob: '' }]);
    const result = await executeProposal(repo.root, proposal, proposal.approvalDigest);
    assert.equal(result.ok, true, `unexpected result: ${JSON.stringify(result)}`);
    assert.notEqual((result as { commit: string }).commit, baseHead);

    const treeNames = await headTreeNames(repo);
    assert.ok(!treeNames.includes('B.txt'), 'deleted target must be gone from HEAD');
    assert.ok(!treeNames.includes('A.txt'), 'unrelated staged file must not be committed');
    assert.equal(await indexBlobOf(repo, 'A.txt'), aBlob, 'unrelated staged blob must be unchanged');
    assert.equal(await indexBlobOf(repo, 'B.txt'), null, 'deleted target must be gone from the index');
    assert.ok((await porcelain(repo)).includes('A  A.txt'), 'unrelated staged change must remain staged');
  } finally {
    repo.cleanup();
  }
});

test('pathspec validation refuses magic, traversal, absolute, empty, and NUL paths', async () => {
  const repo = await makeRepo();
  try {
    const refuse = async (paths: string[], pattern: RegExp): Promise<void> => {
      try {
        validateTargetPaths(repo.root, paths);
        assert.fail(`expected refusal for ${JSON.stringify(paths)}`);
      } catch (error) {
        await assertRefusedBy(error, 'invalid-path', pattern);
      }
    };
    await refuse([], /at least one/);
    await refuse([''], /nonempty/);
    await refuse(['../x'], /traversal/);
    await refuse(['..'], /traversal/);
    await refuse(['a/../b'], /traversal/);
    await refuse(['/abs/x'], /relative/);
    await refuse([':(glob)x'], /pathspec magic/);
    await refuse(['!x'], /pathspec magic/);
    await refuse(['^x'], /pathspec magic/);
    await refuse(['a\0b'], /NUL/);
    await refuse(['./x'], /traversal/);
    await refuse(['x/'], /plain relative/);
    await refuse(['x', 'x'], /Duplicate/);
    // A plain relative path is accepted.
    assert.deepEqual(validateTargetPaths(repo.root, ['src/a.txt', 'b.txt']), ['src/a.txt', 'b.txt']);
  } finally {
    repo.cleanup();
  }
});

test('hook tampering between preview and execution is refused, and recovers once the hook is restored', async () => {
  resetCommitApprovalLedger();
  const repo = await makeRepo();
  try {
    const baseHead = await seedCommit(repo, [['base.txt', 'base\n']], 'base');
    write(repo.root, 'A.txt', 'unrelated staged\n');
    await git(repo.root, ['add', 'A.txt']);
    write(repo.root, 'B.txt', 'target staged\n');
    await git(repo.root, ['add', 'B.txt']);

    installHook(repo, 'pre-commit', PASS_HOOK);
    const proposal = await buildProposal(repo.root, ['B.txt'], 'hook tamper probe');

    // Remove the hook that existed at preview time: gate tampering.
    rmSync(join(repo.root, '.git', 'hooks', 'pre-commit'));
    const refused = await executeProposal(repo.root, proposal, proposal.approvalDigest);
    assert.equal(refused.ok, false);
    assert.equal((refused as { stage: string }).stage, 'hook-missing');
    assert.match((refused as { detail: string }).detail, /pre-commit/);
    assert.equal(await headOf(repo), baseHead);
    assert.ok((await porcelain(repo)).includes('A  B.txt'), 'target must remain staged');

    // Still refused while the gate is missing.
    const again = await executeProposal(repo.root, proposal, proposal.approvalDigest);
    assert.equal((again as { stage: string }).stage, 'hook-missing');

    // Restoring the gate lets the SAME approval proceed — hooks run again.
    installHook(repo, 'pre-commit', PASS_HOOK);
    const result = await executeProposal(repo.root, proposal, proposal.approvalDigest);
    assert.equal(result.ok, true, `unexpected result: ${JSON.stringify(result)}`);
    assert.ok((await porcelain(repo)).includes('A  A.txt'), 'unrelated staged change must survive');
    assert.ok(!(await headTreeNames(repo)).includes('A.txt'));
  } finally {
    repo.cleanup();
  }
});

test('index drift between preview and execution is refused by name and recovers when the index is restored', async () => {
  resetCommitApprovalLedger();
  const repo = await makeRepo();
  try {
    const baseHead = await seedCommit(repo, [['base.txt', 'base\n']], 'base');
    write(repo.root, 'A.txt', 'unrelated staged\n');
    await git(repo.root, ['add', 'A.txt']);
    write(repo.root, 'B.txt', 'target staged\n');
    await git(repo.root, ['add', 'B.txt']);

    installHook(repo, 'pre-commit', PASS_HOOK);
    const proposal = await buildProposal(repo.root, ['B.txt'], 'drift probe');

    // A staged change that appeared after the preview is drift, named and refused.
    write(repo.root, 'C.txt', 'late staged\n');
    await git(repo.root, ['add', 'C.txt']);
    const drift = await executeProposal(repo.root, proposal, proposal.approvalDigest);
    assert.equal(drift.ok, false);
    assert.equal((drift as { stage: string }).stage, 'index-drift');
    assert.match((drift as { detail: string }).detail, /C\.txt/);
    assert.equal(await headOf(repo), baseHead);

    // Removing the late change restores the approved state; the same approval proceeds.
    await git(repo.root, ['restore', '--staged', 'C.txt']);
    const result = await executeProposal(repo.root, proposal, proposal.approvalDigest);
    assert.equal(result.ok, true, `unexpected result: ${JSON.stringify(result)}`);
    assert.ok((await porcelain(repo)).includes('A  A.txt'), 'unrelated staged change must survive');
    assert.ok(!(await headTreeNames(repo)).includes('A.txt'));
    assert.ok((await headTreeNames(repo)).includes('B.txt'));
  } finally {
    repo.cleanup();
  }
});
