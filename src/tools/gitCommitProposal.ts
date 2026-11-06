import { spawn } from 'node:child_process';
import { createHash, timingSafeEqual } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { isAbsolute, join } from 'node:path';

/**
 * Approval-bound, scope-exact commit proposals.
 *
 * Purpose: let an operator commit EXACTLY the staged changes for a named set
 * of target paths while every unrelated staged change stays staged, and while
 * the repository's Git hooks still run — the two properties a plain
 * `git commit` cannot offer at the same time.
 *
 * Design (mirrors the mutation journal's approval binding):
 * - buildProposal() computes the EXACT tree the commit would create, without
 *   ever touching the real index: a private temp index is seeded from HEAD
 *   (`git read-tree HEAD` under `GIT_INDEX_FILE`), only the target paths'
 *   STAGED states are applied to it via a single batched
 *   `git update-index -z --index-info` (NUL-delimited, so any path bytes are
 *   safe), and `git write-tree` produces the tree hash. The temp index lives
 *   in a 0700 mkdtemp directory and is always removed in `finally`.
 * - The approval digest is sha256(treeHash + '\n' + message + '\n' + sorted
 *   target paths). executeProposal() only runs when the operator supplies a
 *   digest that timingSafeEqual-matches, so an approval binds to the exact
 *   tree, the exact message, and the exact path set — nothing else can match.
 * - executeProposal() re-inspects the real index and refuses on ANY drift:
 *   HEAD moved, a target's staged state changed, or an unrelated staged entry
 *   appearing/disappearing/changing (the drift is named). It then performs the
 *   commit with `git commit` pointed at the prepared temp index via
 *   `GIT_INDEX_FILE`, so pre-commit/commit-msg/post-commit hooks run exactly
 *   as they would for a manual commit — `--no-verify` is never passed, and
 *   the tool refuses if a hook that existed at preview time has been removed
 *   before execution (a gate-tamper attempt).
 * - The real index is never read-modified-written by this module. On success
 *   the target paths' index entries equal the new HEAD, so they read as
 *   clean, while every unrelated staged entry keeps its exact
 *   {path, mode, blob} and remains staged. Both invariants are re-verified
 *   after the commit and a violation is reported as drift.
 * - Approvals are single-use: an in-memory ledger marks the digest spent the
 *   moment a commit attempt starts (success, hook rejection, or native git
 *   failure all spend it). A replay of the same digest is refused; a fresh
 *   explicit buildProposal() + approval is required to retry.
 *
 * Honest limitations (by design, documented for reviewers):
 * - The ledger is per-process memory. A restart forgets spent approvals, and
 *   an approval issued in one process cannot be executed by another.
 * - `git commit` updates the branch ref without a compare-and-swap guard; a
 *   concurrent ref update in the tiny window between the drift check and the
 *   commit is not atomically detected (the post-commit verification still
 *   checks HEAD and the committed tree against the approval).
 * - Hooks inherit `GIT_INDEX_FILE`, so hooks see the scoped temp index: a
 *   hook running `git diff --cached` sees exactly the approved change. Hooks
 *   that expect to operate on the real index will not.
 * - Hook verdicts are classified by git's observed behaviour: hook refusals
 *   surface verbatim on git's stderr with exit code 1, while native failures
 *   use other exit codes (e.g. 128) or keep stderr empty. `prepare-commit-msg`
 *   rejections are swallowed by git entirely (exit 1, no output) and cannot
 *   be distinguished from native failures; pre-commit/commit-msg rejections
 *   ARE captured verbatim.
 * - Paths must be valid UTF-8 (git hands us bytes; we decode as UTF-8).
 *   Non-UTF-8 filenames are unsupported. Backslashes are legal POSIX filename
 *   characters and are not treated as separators.
 * - HEAD tree inspection parses the full recursive tree, which is O(tree
 *   size) for large repositories.
 * - No Windows support: path separators are assumed to be '/'.
 */

export interface CommitProposal {
  targetPaths: string[];
  message: string;
  /** Exact per-path outcome vs HEAD. `blob` is the staged blob for added/modified entries and '' for deletions. */
  preview: Array<{ path: string; status: 'added' | 'modified' | 'deleted'; blob: string }>;
  /** The exact tree the approved commit would create. */
  treeHash: string;
  /** sha256(treeHash + '\n' + message + '\n' + sorted target paths). */
  approvalDigest: string;
}

export type CommitProposalFailureStage =
  | 'invalid-path'
  | 'invalid-message'
  | 'not-staged'
  | 'unborn-head'
  | 'no-op'
  | 'git-failed';

export class CommitProposalError extends Error {
  constructor(
    readonly stage: CommitProposalFailureStage,
    message: string,
  ) {
    super(message);
    this.name = 'CommitProposalError';
  }
}

export function isCommitProposalError(error: unknown): error is CommitProposalError {
  return error instanceof CommitProposalError;
}

export interface IndexInspection {
  headCommit: string | null;
  hookPresence: { preCommit: boolean; commitMsg: boolean };
  /** Paths with a STAGED change (porcelain index-status A/M/D/R/C). */
  stagedPaths: string[];
  /** Paths with worktree-only changes (porcelain worktree-status A/M/D/R/C). */
  unstagedPaths: string[];
  /** Untracked paths (porcelain '??'). */
  untrackedPaths: string[];
}

export type ExecuteFailureStage =
  | 'foreign-proposal'
  | 'approval-required'
  | 'approval-spent'
  | 'index-drift'
  | 'hook-missing'
  | 'hook-rejected'
  | 'commit-failed';

export type ExecuteResult =
  | { ok: true; commit: string }
  | { ok: false; stage: ExecuteFailureStage; output?: string; detail?: string };

/** The exact sha256 binding used for commit approvals (exported so callers and tests can verify it). */
export function commitApprovalDigest(treeHash: string, message: string, targetPaths: string[]): string {
  return createHash('sha256')
    .update(`${treeHash}\n${message}\n${[...targetPaths].sort().join('\n')}`)
    .digest('hex');
}

/** Test hook: forget every issued/spent approval in this process. */
export function resetCommitApprovalLedger(): void {
  approvals.clear();
}

const GIT_TIMEOUT_MS = 180_000;
const MAX_CAPTURE_BYTES = 64 * 1024 * 1024;
const ZERO_OID = '0'.repeat(40);
const OID_RE = /^[0-9a-f]{40}$/;
const DIGEST_RE = /^[0-9a-f]{64}$/;
const MODE_RE = /^(?:100644|100755|120000|160000)$/;
const STAGED_STATUSES = new Set(['A', 'M', 'D', 'R', 'C']);
const TRACKED_HOOKS = ['pre-commit', 'prepare-commit-msg', 'commit-msg', 'post-commit'] as const;
type TrackedHook = (typeof TRACKED_HOOKS)[number];

interface TargetState {
  path: string;
  /** Real-index mode. '0' for staged deletions. */
  mode: string;
  /** Real-index blob for added/modified targets; null for staged deletions. */
  blob: string | null;
}

interface ProposalState {
  headCommit: string;
  targets: Map<string, TargetState>;
  /** Unrelated staged entries that must survive verbatim; blob=ZERO_OID marks staged deletions. */
  baseline: Map<string, { mode: string; blob: string }>;
  hooksAtBuild: Record<TrackedHook, boolean>;
}

/** digest -> 'issued' (approved and not yet attempted) | 'spent' (an attempt started). */
const approvals = new Map<string, 'issued' | 'spent'>();
/** Internal binding state; only real buildProposal() products carry it. */
const proposalStates = new WeakMap<CommitProposal, ProposalState>();

/**
 * Run git with an argument array — never a shell string. `spawn` is used
 * (instead of execFile) because the temp-index update requires byte-precise
 * NUL-delimited stdin, which the promise-based execFile API does not accept.
 */
function runGit(
  root: string,
  args: string[],
  options: { env?: Record<string, string>; stdin?: Buffer } = {},
): Promise<{ code: number; out: Buffer; err: string }> {
  return new Promise((resolveRun) => {
    const child = spawn('git', args, {
      cwd: root,
      env: options.env ? { ...process.env, ...options.env } : process.env,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    const outChunks: Buffer[] = [];
    const errChunks: Buffer[] = [];
    let settled = false;
    const finish = (code: number): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolveRun({
        code,
        out: Buffer.concat(outChunks),
        err: Buffer.concat(errChunks).toString('utf8'),
      });
    };
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
    }, GIT_TIMEOUT_MS);
    const capture = (chunks: Buffer[], chunk: Buffer): void => {
      chunks.push(chunk);
      if (Buffer.concat(chunks).length > MAX_CAPTURE_BYTES) child.kill('SIGKILL');
    };
    child.stdout.on('data', (chunk: Buffer) => capture(outChunks, chunk));
    child.stderr.on('data', (chunk: Buffer) => capture(errChunks, chunk));
    child.on('error', () => finish(-1));
    child.on('close', (code) => finish(code ?? -1));
    child.stdin.on('error', () => {
      /* git may exit before stdin is fully consumed */
    });
    if (options.stdin !== undefined) child.stdin.end(options.stdin);
    else child.stdin.end();
  });
}

/** Split a NUL-terminated byte stream into its raw records. */
function splitNul(buf: Buffer): Buffer[] {
  const parts: Buffer[] = [];
  let start = 0;
  while (start < buf.length) {
    const end = buf.indexOf(0, start);
    if (end === -1) {
      parts.push(buf.subarray(start));
      break;
    }
    parts.push(buf.subarray(start, end));
    start = end + 1;
  }
  return parts;
}

/** Real index entries, path -> {mode, blob}. Read-only; never locks the index. */
async function listIndexEntries(root: string): Promise<Map<string, { mode: string; blob: string }>> {
  const res = await runGit(root, ['--no-optional-locks', 'ls-files', '-s', '-z']);
  if (res.code !== 0) {
    throw new CommitProposalError('git-failed', `git ls-files failed: ${res.err.trim()}`);
  }
  const entries = new Map<string, { mode: string; blob: string }>();
  for (const record of splitNul(res.out)) {
    const tab = record.indexOf(0x09);
    if (tab <= 0) continue;
    const meta = record.subarray(0, tab).toString('utf8').split(' ');
    const path = record.subarray(tab + 1).toString('utf8');
    if (meta.length !== 3 || !MODE_RE.test(meta[0]) || !OID_RE.test(meta[1])) continue;
    entries.set(path, { mode: meta[0], blob: meta[1] });
  }
  return entries;
}

/** All blob entries of a tree, path -> {mode, blob}. Submodules are skipped. */
async function listTreeEntries(
  root: string,
  treeish: string,
): Promise<Map<string, { mode: string; blob: string }>> {
  const res = await runGit(root, ['ls-tree', '-z', '-r', treeish]);
  if (res.code !== 0) {
    throw new CommitProposalError('git-failed', `git ls-tree failed: ${res.err.trim()}`);
  }
  const entries = new Map<string, { mode: string; blob: string }>();
  for (const record of splitNul(res.out)) {
    const tab = record.indexOf(0x09);
    if (tab <= 0) continue;
    const meta = record.subarray(0, tab).toString('utf8').split(' ');
    const path = record.subarray(tab + 1).toString('utf8');
    if (meta.length !== 3 || meta[1] !== 'blob' || !MODE_RE.test(meta[0]) || !OID_RE.test(meta[2])) continue;
    entries.set(path, { mode: meta[0], blob: meta[2] });
  }
  return entries;
}

async function resolveHead(root: string): Promise<string | null> {
  const res = await runGit(root, ['rev-parse', '-q', '--verify', 'HEAD']);
  if (res.code !== 0) return null;
  const head = res.out.toString('utf8').trim();
  return OID_RE.test(head) ? head : null;
}

interface StatusClassification {
  staged: Set<string>;
  unstaged: Set<string>;
  untracked: Set<string>;
}

/**
 * Parse `git status --porcelain=v1 -z`. Rename/copy records span two NUL
 * fields (record + original path); the original path is consumed but the
 * staged path is the first field's path.
 */
async function classifyStatus(root: string): Promise<StatusClassification> {
  const res = await runGit(root, ['--no-optional-locks', 'status', '--porcelain=v1', '-z']);
  if (res.code !== 0) {
    throw new CommitProposalError('git-failed', `git status failed: ${res.err.trim()}`);
  }
  const fields = splitNul(res.out);
  const staged = new Set<string>();
  const unstaged = new Set<string>();
  const untracked = new Set<string>();
  for (let index = 0; index < fields.length; index++) {
    const field = fields[index];
    if (field.length < 4 || field[2] !== 0x20) continue;
    const x = String.fromCharCode(field[0]);
    const y = String.fromCharCode(field[1]);
    const path = field.subarray(3).toString('utf8');
    if (x === 'R' || x === 'C') {
      const original = fields[index + 1]?.toString('utf8');
      index += 1; // consume the original-path field
      // A STAGED rename removes the original name from the index (git mv), so
      // that original path is itself a staged deletion an operator may
      // legitimately want to commit or exclude. A staged COPY keeps the
      // original entry, so copies are not treated as deletions.
      if (x === 'R' && original !== undefined && original !== '') staged.add(original);
    }
    if (STAGED_STATUSES.has(x)) staged.add(path);
    if (STAGED_STATUSES.has(y)) unstaged.add(path);
    if (x === '?' && y === '?') untracked.add(path);
  }
  return { staged, unstaged, untracked };
}

async function hookPresence(root: string): Promise<Record<TrackedHook, boolean>> {
  const result = { 'pre-commit': false, 'prepare-commit-msg': false, 'commit-msg': false, 'post-commit': false } as Record<TrackedHook, boolean>;
  await Promise.all(
    TRACKED_HOOKS.map(async (hook) => {
      const res = await runGit(root, ['hook', 'list', hook]);
      result[hook] = res.code === 0; // git hook list: 0 only when an executable hook exists
    }),
  );
  return result;
}

/**
 * Validate target paths: nonempty plain relative paths inside the repository.
 * Refuses empty input, empty strings, '..'/traversal, absolute paths,
 * pathspec magic (:, !, ^ prefixes), NUL bytes, empty/'.'/'..' segments,
 * and duplicates.
 */
export function validateTargetPaths(root: string, paths: string[]): string[] {
  void root; // validation is location-independent; paths are repository-relative
  if (!Array.isArray(paths) || paths.length === 0) {
    throw new CommitProposalError('invalid-path', 'Commit proposal requires at least one target path');
  }
  const seen = new Set<string>();
  for (const path of paths) {
    if (typeof path !== 'string' || path.length === 0) {
      throw new CommitProposalError('invalid-path', 'Target path must be a nonempty string');
    }
    if (path.includes('\0')) {
      throw new CommitProposalError('invalid-path', `Target path must not contain NUL bytes: ${JSON.stringify(path)}`);
    }
    if (path.startsWith(':') || path.startsWith('!') || path.startsWith('^')) {
      throw new CommitProposalError('invalid-path', `Target path must not use pathspec magic: ${path}`);
    }
    if (isAbsolute(path)) {
      throw new CommitProposalError('invalid-path', `Target path must be relative to the repository root: ${path}`);
    }
    for (const segment of path.split('/')) {
      if (segment === '' || segment === '.' || segment === '..') {
        throw new CommitProposalError(
          'invalid-path',
          `Target path must be a plain relative path without traversal: ${path}`,
        );
      }
    }
    if (seen.has(path)) {
      throw new CommitProposalError('invalid-path', `Duplicate target path: ${path}`);
    }
    seen.add(path);
  }
  return [...paths];
}

/** Inspect the index and hook surface. Read-only; never locks or mutates the index. */
export async function inspectIndex(root: string): Promise<IndexInspection> {
  const [headCommit, classification, hooks] = await Promise.all([
    resolveHead(root),
    classifyStatus(root),
    hookPresence(root),
  ]);
  return {
    headCommit,
    hookPresence: { preCommit: hooks['pre-commit'], commitMsg: hooks['commit-msg'] },
    stagedPaths: [...classification.staged].sort(),
    unstagedPaths: [...classification.unstaged].sort(),
    untrackedPaths: [...classification.untracked].sort(),
  };
}

function targetRecordBytes(state: TargetState): Buffer {
  const mode = state.blob === null ? '0' : state.mode;
  const blob = state.blob === null ? ZERO_OID : state.blob;
  return Buffer.concat([
    Buffer.from(`${mode} ${blob} 0\t`, 'utf8'),
    Buffer.from(state.path, 'utf8'),
    Buffer.from([0]),
  ]);
}

/**
 * Seed a private temp index with HEAD and apply ONLY the given target states.
 * The real index is never opened for writing. `use` runs while the temp
 * index exists; the mkdtemp directory is always removed afterwards.
 */
async function withScopedTempIndex<T>(
  root: string,
  headCommit: string,
  targetStates: Map<string, TargetState>,
  use: (tempIndex: string, env: Record<string, string>) => Promise<T>,
): Promise<T> {
  const tempDir = mkdtempSync(join(tmpdir(), 'shadow-scoped-commit-'));
  try {
    const tempIndex = join(tempDir, 'idx');
    const env = { GIT_INDEX_FILE: tempIndex };
    const read = await runGit(root, ['read-tree', headCommit], { env });
    if (read.code !== 0) {
      throw new CommitProposalError('git-failed', `git read-tree failed: ${read.err.trim()}`);
    }
    // One batched, atomic update: NUL-delimited so any path bytes are safe,
    // and git rejects the whole batch (no partial application) on malformed input.
    const payload = Buffer.concat([...targetStates.values()].map(targetRecordBytes));
    const update = await runGit(root, ['update-index', '-z', '--index-info'], { env, stdin: payload });
    if (update.code !== 0) {
      throw new CommitProposalError('git-failed', `git update-index failed: ${update.err.trim()}`);
    }
    return await use(tempIndex, env);
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
}

function assertSameDigests(actual: string, expected: string): boolean {
  if (!DIGEST_RE.test(actual) || !DIGEST_RE.test(expected)) return false;
  return timingSafeEqual(Buffer.from(actual, 'hex'), Buffer.from(expected, 'hex'));
}

/**
 * Preview the exact commit for the target paths. Every target must have a
 * STAGED change; unrelated staged changes are recorded as an invariant that
 * executeProposal() enforces. The real index is never mutated.
 */
export async function buildProposal(
  root: string,
  targetPaths: string[],
  message: string,
): Promise<CommitProposal> {
  if (typeof message !== 'string' || message.trim().length === 0) {
    throw new CommitProposalError('invalid-message', 'Commit proposal requires a nonempty message');
  }
  const targets = validateTargetPaths(root, targetPaths).sort();
  const headCommit = await resolveHead(root);
  if (headCommit === null) {
    throw new CommitProposalError('unborn-head', 'Commit proposals require a repository with an existing HEAD commit');
  }
  const [indexEntries, classification, headEntries, hooks] = await Promise.all([
    listIndexEntries(root),
    classifyStatus(root),
    listTreeEntries(root, headCommit),
    hookPresence(root),
  ]);

  const targetStates = new Map<string, TargetState>();
  const preview: CommitProposal['preview'] = [];
  for (const path of targets) {
    if (!classification.staged.has(path)) {
      throw new CommitProposalError('not-staged', `Target path has no staged change: ${path}`);
    }
    const indexEntry = indexEntries.get(path);
    if (indexEntry === undefined) {
      // Staged deletion: the path is gone from the real index.
      targetStates.set(path, { path, mode: '0', blob: null });
      preview.push({ path, status: 'deleted', blob: '' });
      continue;
    }
    const headEntry = headEntries.get(path);
    if (
      headEntry !== undefined &&
      headEntry.mode === indexEntry.mode &&
      headEntry.blob === indexEntry.blob
    ) {
      throw new CommitProposalError('no-op', `Target path is staged but identical to HEAD: ${path}`);
    }
    targetStates.set(path, { path, mode: indexEntry.mode, blob: indexEntry.blob });
    preview.push({
      path,
      status: headEntry === undefined ? 'added' : 'modified',
      blob: indexEntry.blob,
    });
  }

  // Invariant baseline: every OTHER staged change, captured exactly.
  const baseline = new Map<string, { mode: string; blob: string }>();
  for (const path of classification.staged) {
    if (targetStates.has(path)) continue;
    const entry = indexEntries.get(path);
    baseline.set(
      path,
      entry === undefined ? { mode: '0', blob: ZERO_OID } : { mode: entry.mode, blob: entry.blob },
    );
  }

  // Exact tree, computed without ever touching the real index.
  const treeHash = await withScopedTempIndex(root, headCommit, targetStates, async (_tempIndex, env) => {
    const written = await runGit(root, ['write-tree'], { env });
    const candidate = written.out.toString('utf8').trim();
    if (written.code !== 0 || !OID_RE.test(candidate)) {
      throw new CommitProposalError('git-failed', `git write-tree failed: ${written.err.trim()}`);
    }
    return candidate;
  });
  const headTree = await runGit(root, ['rev-parse', `${headCommit}^{tree}`]);
  if (headTree.code === 0 && headTree.out.toString('utf8').trim() === treeHash) {
    throw new CommitProposalError('no-op', 'The staged target changes would not alter the repository tree');
  }

  const approvalDigest = commitApprovalDigest(treeHash, message, targets);
  const proposal: CommitProposal = {
    targetPaths: targets,
    message,
    preview: [...preview].sort((left, right) => (left.path < right.path ? -1 : 1)),
    treeHash,
    approvalDigest,
  };
  proposalStates.set(proposal, { headCommit, targets: targetStates, baseline, hooksAtBuild: hooks });
  approvals.set(approvalDigest, 'issued');
  return proposal;
}

/**
 * Execute an approved proposal. Refusals are returned as typed results (the
 * mission contract); preview-time problems throw. Outcomes:
 * - { ok: true, commit } — the scoped commit exists and every invariant held.
 * - { ok: false, stage: 'hook-rejected', output } — a hook refused; git's
 *   captured hook output is surfaced verbatim; refs and index untouched.
 * - { ok: false, stage: ... } — approval/drift/hook-tamper/git failures.
 */
export async function executeProposal(
  root: string,
  proposal: CommitProposal,
  providedDigest: string,
): Promise<ExecuteResult> {
  const state = proposalStates.get(proposal);
  if (state === undefined) {
    return {
      ok: false,
      stage: 'foreign-proposal',
      detail: 'Proposal was not produced by buildProposal() in this process',
    };
  }
  if (typeof providedDigest !== 'string' || !DIGEST_RE.test(providedDigest)) {
    return {
      ok: false,
      stage: 'approval-required',
      detail: 'Approval digest must be a lowercase SHA-256 hex digest',
    };
  }
  const ledgerState = approvals.get(providedDigest);
  if (ledgerState === undefined) {
    return {
      ok: false,
      stage: 'approval-required',
      detail: 'No approval has been issued for this digest',
    };
  }
  if (ledgerState === 'spent') {
    return {
      ok: false,
      stage: 'approval-spent',
      detail: 'This approval was already consumed by a commit attempt; rebuild the proposal for a new approval',
    };
  }
  if (!assertSameDigests(providedDigest, proposal.approvalDigest)) {
    return {
      ok: false,
      stage: 'approval-required',
      detail: 'Approval does not bind to this exact tree, message, and target paths',
    };
  }

  // Drift re-inspection: HEAD, every target's staged state, the unrelated
  // baseline, and the hook surface must all be exactly what was approved.
  const headCommit = await resolveHead(root);
  if (headCommit === null || headCommit !== state.headCommit) {
    return {
      ok: false,
      stage: 'index-drift',
      detail: `HEAD moved since the proposal was built: expected ${state.headCommit.slice(0, 12)}, found ${(headCommit ?? 'unborn').slice(0, 12)}`,
    };
  }
  const [indexEntries, classification, hooks] = await Promise.all([
    listIndexEntries(root),
    classifyStatus(root),
    hookPresence(root),
  ]);
  for (const [path, expected] of state.targets) {
    if (!classification.staged.has(path)) {
      return { ok: false, stage: 'index-drift', detail: `Target path no longer has a staged change: ${path}` };
    }
    const entry = indexEntries.get(path);
    if (expected.blob === null) {
      if (entry !== undefined) {
        return { ok: false, stage: 'index-drift', detail: `Target deletion is no longer staged: ${path}` };
      }
    } else if (entry === undefined || entry.mode !== expected.mode || entry.blob !== expected.blob) {
      return { ok: false, stage: 'index-drift', detail: `Target path drifted from its approved staged state: ${path}` };
    }
  }
  for (const [path, expected] of state.baseline) {
    if (!classification.staged.has(path)) {
      return { ok: false, stage: 'index-drift', detail: `Unrelated staged change disappeared: ${path}` };
    }
    const entry = indexEntries.get(path);
    if (expected.blob === ZERO_OID) {
      if (entry !== undefined) {
        return { ok: false, stage: 'index-drift', detail: `Unrelated staged deletion changed: ${path}` };
      }
    } else if (entry === undefined || entry.mode !== expected.mode || entry.blob !== expected.blob) {
      return { ok: false, stage: 'index-drift', detail: `Unrelated staged change drifted: ${path}` };
    }
  }
  // The staged set must be EXACTLY what was approved: a staged change that
  // appeared after the proposal was built would silently survive the commit
  // without ever having been part of the approved preview.
  for (const path of classification.staged) {
    if (!state.targets.has(path) && !state.baseline.has(path)) {
      return {
        ok: false,
        stage: 'index-drift',
        detail: `A staged change appeared after the proposal was built: ${path}`,
      };
    }
  }
  for (const hook of TRACKED_HOOKS) {
    if (state.hooksAtBuild[hook] && !hooks[hook]) {
      return {
        ok: false,
        stage: 'hook-missing',
        detail: `The ${hook} hook existed when the proposal was built but is gone now; refusing to commit without it`,
      };
    }
  }

  // Single-use from here on: every attempt outcome spends the approval.
  approvals.set(proposal.approvalDigest, 'spent');

  const attempt = await withScopedTempIndex(root, state.headCommit, state.targets, async (_tempIndex, env) => {
    const written = await runGit(root, ['write-tree'], { env });
    const rebuilt = written.out.toString('utf8').trim();
    if (written.code !== 0 || rebuilt !== proposal.treeHash) {
      return { kind: 'tree-mismatch' as const, detail: 'The current index no longer yields the approved tree' };
    }
    // git commit (never --no-verify) so pre-commit/commit-msg/post-commit run;
    // --cleanup=verbatim keeps the committed message byte-identical to the
    // approved one instead of letting git's default cleanup rewrite it.
    const commit = await runGit(root, ['commit', '--cleanup=verbatim', '-m', proposal.message], { env });
    return {
      kind: 'commit' as const,
      code: commit.code,
      out: commit.out.toString('utf8'),
      err: commit.err,
    };
  }).catch((error: unknown) => {
    if (isCommitProposalError(error)) {
      return { kind: 'commit' as const, code: -1, out: '', err: error.message };
    }
    throw error;
  });

  if (attempt.kind === 'tree-mismatch') {
    return { ok: false, stage: 'index-drift', detail: attempt.detail };
  }
  const capturedOutput = `${attempt.err.trim()}\n${attempt.out.trim()}`.trim();
  if (attempt.code !== 0) {
    // Hook refusals surface verbatim on git's stderr with exit code 1;
    // native failures use other exit codes (e.g. 128 for identity/gpg) or
    // keep stderr empty. Never mistake a native failure for a hook verdict.
    if (attempt.code === 1 && attempt.err.trim().length > 0) {
      return { ok: false, stage: 'hook-rejected', output: capturedOutput };
    }
    return {
      ok: false,
      stage: 'commit-failed',
      output: capturedOutput,
      detail: 'git commit refused the scoped commit',
    };
  }

  const newHead = await resolveHead(root);
  if (newHead === null || newHead === state.headCommit) {
    return {
      ok: false,
      stage: 'commit-failed',
      output: capturedOutput,
      detail: 'git commit reported success but HEAD did not advance',
    };
  }
  const newTree = await runGit(root, ['rev-parse', `${newHead}^{tree}`]);
  if (newTree.code !== 0 || newTree.out.toString('utf8').trim() !== proposal.treeHash) {
    return {
      ok: false,
      stage: 'commit-failed',
      output: capturedOutput,
      detail: 'The commit was created but its tree does not match the approved tree',
    };
  }

  // Post-commit invariant verification against the REAL index.
  const [postEntries, postClassification] = await Promise.all([
    listIndexEntries(root),
    classifyStatus(root),
  ]);
  for (const [path, expected] of state.baseline) {
    const entry = postEntries.get(path);
    const intact =
      expected.blob === ZERO_OID
        ? entry === undefined
        : entry !== undefined && entry.mode === expected.mode && entry.blob === expected.blob;
    if (!intact || !postClassification.staged.has(path)) {
      return {
        ok: false,
        stage: 'index-drift',
        output: capturedOutput,
        detail: `Unrelated staged change did not survive the commit: ${path}`,
      };
    }
  }
  for (const [path, expected] of state.targets) {
    if (postClassification.staged.has(path)) {
      return {
        ok: false,
        stage: 'commit-failed',
        output: capturedOutput,
        detail: `Target path is still staged after the commit: ${path}`,
      };
    }
    if (expected.blob !== null) {
      const entry = postEntries.get(path);
      if (entry === undefined || entry.blob !== expected.blob) {
        return {
          ok: false,
          stage: 'index-drift',
          output: capturedOutput,
          detail: `Target index entry changed unexpectedly after the commit: ${path}`,
        };
      }
    }
  }
  return { ok: true, commit: newHead };
}
