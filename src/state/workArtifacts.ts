import { execFileSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { atomicWrite } from '../tools/util.js';
import { listWorktrees, removeWorktree, sameWorktreePath, type WorktreeInfo } from '../tools/worktree.js';
import { resolveWithin } from '../safety/workspaceJail.js';
import { JobStore } from './jobStore.js';

export type WorkArtifactState = 'active' | 'ready' | 'kept' | 'applied' | 'discarded' | 'empty';
export interface WorkArtifact {
  version: 1;
  id: string;
  taskId: string;
  workspaceRoot: string;
  worktreePath: string;
  baseCommit: string;
  state: WorkArtifactState;
  createdAt: number;
  updatedAt: number;
  outcome?: 'completed' | 'partial' | 'failed' | 'cancelled';
  stopReason?: string;
  answer?: string;
  /** Always explicit: a produced diff is not proof that it was verified. */
  verification: 'unverified';
  changedFiles: string[];
  /** Ignored outputs stay in the checkout; they are not silently deleted or
   * claimed as part of a Git patch (build caches can be arbitrarily large). */
  ignoredFiles?: string[];
  diffStat: string;
  patchHash?: string;
  error?: string;
  appliedAt?: number;
  appliedToCommit?: string;
}

const MAX_PATCH_BYTES = 64 * 1024 * 1024;
const ID = /^[A-Za-z0-9._-]{1,128}$/;
const CONTENT_PATHS = ['.', ':(exclude).shadow'];

function artifactDir(workspaceRoot: string, id: string): string {
  if (!ID.test(id) || id === '.' || id === '..') throw new Error('Invalid artifact id');
  const root = resolveWithin(workspaceRoot, '.shadow/artifacts');
  mkdirSync(root, { recursive: true, mode: 0o700 });
  return resolveWithin(root, id);
}

function git(cwd: string, args: string[], options: { env?: NodeJS.ProcessEnv; input?: string } = {}): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8', timeout: 30_000, maxBuffer: MAX_PATCH_BYTES,
    stdio: ['pipe', 'pipe', 'pipe'], ...options });
}

function persist(artifact: WorkArtifact): WorkArtifact {
  const dir = artifactDir(artifact.workspaceRoot, artifact.id);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  artifact.updatedAt = Date.now();
  atomicWrite(join(dir, 'artifact.json'), JSON.stringify(artifact, null, 2) + '\n', 0o600);
  return artifact;
}

/** Register before a worker runs, so an abrupt application exit cannot hide its checkout. */
export function createWorkArtifact(workspaceRoot: string, taskId: string, worktree: WorktreeInfo): WorkArtifact {
  const root = resolve(workspaceRoot);
  const managed = listWorktrees(root).find((entry) => sameWorktreePath(entry.path, worktree.path));
  if (!managed) throw new Error('Artifact requires a registered managed Git worktree');
  const now = Date.now();
  return persist({ version: 1, id: taskId, taskId, workspaceRoot: root, worktreePath: managed.path,
    baseCommit: worktree.baseCommit ?? managed.baseCommit ?? git(managed.path, ['rev-parse', 'HEAD']).trim(),
    state: 'active', createdAt: now, updatedAt: now, verification: 'unverified', changedFiles: [], diffStat: '' });
}

export function getWorkArtifact(workspaceRoot: string, id: string): WorkArtifact {
  const artifact = JSON.parse(readFileSync(join(artifactDir(workspaceRoot, id), 'artifact.json'), 'utf8')) as WorkArtifact;
  if (artifact.version !== 1 || artifact.id !== id || !sameWorktreePath(artifact.workspaceRoot, workspaceRoot)) {
    throw new Error('Artifact metadata does not belong to this workspace');
  }
  // Workspace identity was checked physically above. Use the persisted spelling
  // here so Windows short/long aliases do not disagree inside the lexical jail.
  resolveWithin(resolve(artifact.workspaceRoot, '.shadow/worktrees'), artifact.worktreePath);
  return artifact;
}

export function listWorkArtifacts(workspaceRoot: string): WorkArtifact[] {
  const root = resolve(workspaceRoot, '.shadow/artifacts');
  if (!existsSync(root)) return [];
  return readdirSync(root, { withFileTypes: true }).filter((entry) => entry.isDirectory()).flatMap((entry) => {
    try { return [getWorkArtifact(workspaceRoot, entry.name)]; } catch { return []; }
  }).sort((a, b) => b.createdAt - a.createdAt);
}

/** Snapshot without changing the worker's real Git index. Includes committed, staged,
 * unstaged, deleted, new and binary files; excludes Shadow's own runtime directory. */
function capture(artifact: WorkArtifact): WorkArtifact {
  if (!listWorktrees(artifact.workspaceRoot).some((entry) => sameWorktreePath(entry.path, artifact.worktreePath))) {
    throw new Error(`Artifact checkout is unavailable: ${artifact.worktreePath}. The previous saved patch is preserved.`);
  }
  const dir = artifactDir(artifact.workspaceRoot, artifact.id);
  const indexPath = join(dir, `index-${randomUUID()}`);
  const env = { ...process.env, GIT_INDEX_FILE: indexPath };
  try {
    git(artifact.worktreePath, ['read-tree', artifact.baseCommit], { env });
    git(artifact.worktreePath, ['add', '--all', '--', ...CONTENT_PATHS], { env });
    const tree = git(artifact.worktreePath, ['write-tree'], { env }).trim();
    const patch = git(artifact.worktreePath, ['diff', '--binary', '--full-index', '--no-ext-diff', '--no-textconv', artifact.baseCommit, tree, '--', ...CONTENT_PATHS]);
    artifact.changedFiles = git(artifact.worktreePath, ['diff', '--name-only', '-z', artifact.baseCommit, tree, '--', ...CONTENT_PATHS]).split('\0').filter(Boolean);
    artifact.ignoredFiles = git(artifact.worktreePath, ['ls-files', '--others', '--ignored', '--exclude-standard', '-z', '--', ...CONTENT_PATHS]).split('\0').filter(Boolean);
    artifact.diffStat = git(artifact.worktreePath, ['diff', '--stat', artifact.baseCommit, tree, '--', ...CONTENT_PATHS]).trim();
    // Metadata never points at an incomplete patch: patch first, atomic metadata second.
    atomicWrite(join(dir, 'changes.patch'), patch, 0o600);
    artifact.patchHash = createHash('sha256').update(patch).digest('hex');
    delete artifact.error;
    return artifact;
  } finally {
    rmSync(indexPath, { force: true });
    rmSync(`${indexPath}.lock`, { force: true });
  }
}

export function finishWorkArtifact(workspaceRoot: string, id: string, outcome: {
  status: NonNullable<WorkArtifact['outcome']>; stopReason?: string; answer?: string; retainEmpty?: boolean;
}): WorkArtifact {
  let artifact = getWorkArtifact(workspaceRoot, id);
  artifact.outcome = outcome.status;
  artifact.stopReason = outcome.stopReason;
  artifact.answer = outcome.answer;
  try {
    artifact = capture(artifact);
    artifact.state = artifact.changedFiles.length || artifact.ignoredFiles?.length || outcome.retainEmpty ? 'ready' : 'empty';
    persist(artifact);
    // Only a proven empty output is automatically cleaned. On any uncertainty the
    // directory survives and its diagnostic is persisted for inspection/recovery.
    if (artifact.state === 'empty') removeWorktree(workspaceRoot, artifact.worktreePath);
  } catch (error) {
    artifact.state = 'ready';
    artifact.error = error instanceof Error ? error.message : String(error);
  }
  return persist(artifact);
}

/** Safe after restart: inspect never launches or replays a worker. A lost active
 * worker can be explicitly recovered into a saved diff with recoverWorkArtifact. */
export function inspectWorkArtifact(workspaceRoot: string, id: string): { artifact: WorkArtifact; patch: string; worktreeExists: boolean } {
  const artifact = getWorkArtifact(workspaceRoot, id);
  const patchPath = join(artifactDir(workspaceRoot, id), 'changes.patch');
  const patch = existsSync(patchPath) ? readFileSync(patchPath, 'utf8') : '';
  if (artifact.patchHash && createHash('sha256').update(patch).digest('hex') !== artifact.patchHash) {
    throw new Error('Saved artifact patch failed its integrity check; checkout was not modified');
  }
  return { artifact, patch, worktreeExists: existsSync(artifact.worktreePath) };
}

/** Call only after confirming the owning worker is no longer running. */
export function recoverWorkArtifact(workspaceRoot: string, id: string): WorkArtifact {
  const artifact = getWorkArtifact(workspaceRoot, id);
  if (artifact.state !== 'active') return artifact;
  assertNoRunningOwner(workspaceRoot, artifact);
  return finishWorkArtifact(workspaceRoot, id, { status: 'partial', stopReason: 'interrupted',
    answer: 'Recovered checkout from an interrupted worker. Its output has not been verified.' });
}

/** A second Shadow process may own this checkout or a descendant still using it.
 * The local terminal's registry alone cannot authorize recovery or deletion. */
function assertNoRunningOwner(workspaceRoot: string, artifact: WorkArtifact): void {
  const store = new JobStore(workspaceRoot);
  try {
    store.recoverOrphans();
    const owner = store.findByAttempt(artifact.taskId);
    if (!owner) return;
    const related = new Set([owner.id]); const jobs = store.list();
    for (let changed = true; changed;) {
      changed = false;
      for (const job of jobs) if (job.parentId && related.has(job.parentId) && !related.has(job.id)) { related.add(job.id); changed = true; }
    }
    if (jobs.some((job) => (related.has(job.id) || job.sourceArtifactIds?.includes(artifact.id)) && job.status === 'running')) {
      throw new Error('This checkout still has a live owning worker or descendant. Cancel or finish that work before recovering or changing its artifact.');
    }
  } finally { store.close(); }
}

function settled(workspaceRoot: string, id: string): WorkArtifact {
  const artifact = getWorkArtifact(workspaceRoot, id);
  if (artifact.state === 'active') throw new Error('The worker is active or was interrupted; stop or recover it before changing its artifact');
  assertNoRunningOwner(workspaceRoot, artifact);
  return artifact;
}

export function keepWorkArtifact(workspaceRoot: string, id: string): WorkArtifact {
  let artifact = settled(workspaceRoot, id);
  if (!existsSync(artifact.worktreePath)) throw new Error('Checkout no longer exists; its saved patch can still be inspected or applied');
  artifact = capture(artifact);
  artifact.state = 'kept';
  return persist(artifact);
}

/** The source checkout and patch survive application. Git checks the entire patch
 * before writing and refuses collisions. A clean destination prevents overwriting
 * the user's staged, unstaged or untracked work; Shadow metadata is excluded. */
export function applyWorkArtifact(workspaceRoot: string, id: string): WorkArtifact {
  let artifact = settled(workspaceRoot, id);
  if (artifact.state === 'applied') throw new Error('Artifact was already applied');
  if (existsSync(artifact.worktreePath)) artifact = persist(capture(artifact));
  const { patch } = inspectWorkArtifact(workspaceRoot, id);
  if (!patch.trim()) throw new Error('Artifact contains no saved changes');
  const dirty = git(workspaceRoot, ['status', '--porcelain', '--untracked-files=all', '--', ...CONTENT_PATHS]).trim();
  if (dirty) throw new Error('Workspace has staged, unstaged or untracked changes. Commit or stash them before applying an artifact.');
  const head = git(workspaceRoot, ['rev-parse', 'HEAD']).trim();
  git(workspaceRoot, ['apply', '--check', '--binary', '-'], { input: patch });
  git(workspaceRoot, ['apply', '--binary', '-'], { input: patch });
  artifact.state = 'applied';
  artifact.appliedAt = Date.now();
  artifact.appliedToCommit = head;
  return persist(artifact);
}

/** Explicit discard archives the latest complete binary patch before removing the
 * checkout. The archived patch remains inspectable/applicable after app restart. */
export function discardWorkArtifact(workspaceRoot: string, id: string): WorkArtifact {
  let artifact = settled(workspaceRoot, id);
  if (existsSync(artifact.worktreePath)) {
    artifact = persist(capture(artifact));
    if (artifact.ignoredFiles?.length) {
      throw new Error('Checkout has ignored files that are not in the saved patch. Keep or move those files before discarding the checkout.');
    }
    removeWorktree(workspaceRoot, artifact.worktreePath, { discardChanges: true });
  }
  artifact.state = 'discarded';
  return persist(artifact);
}
