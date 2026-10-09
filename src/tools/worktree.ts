import { execFileSync } from 'node:child_process';
import { mkdirSync, existsSync, realpathSync } from 'node:fs';
import { basename, relative, resolve, sep, win32, posix } from 'node:path';
import { z } from 'zod';
import type { Tool } from './types.js';
import { ok, fail } from './types.js';
import { resolveWithin } from '../safety/workspaceJail.js';

export interface WorktreeInfo {
  path: string;
  id: string;
  branch?: string;
  baseCommit?: string;
}

/** Compare canonical filesystem paths using platform path rules, not string
 * prefixes. Git for Windows uses forward slashes and may spell the drive letter
 * differently from fs.realpathSync. Callers still apply the workspace jail. */
export function relativeManagedWorktreePath(root: string, candidate: string, platform: 'win32' | 'posix' = process.platform === 'win32' ? 'win32' : 'posix'): string | null {
  const paths = platform === 'win32' ? win32 : posix;
  const rel = paths.relative(root, candidate);
  return rel !== '' && rel !== '..' && !rel.startsWith(`..${paths.sep}`) && !paths.isAbsolute(rel) ? rel : null;
}

/** Existing directories are compared after realpath so root aliases (including
 * macOS /var and Windows long/short paths) name the same registered checkout. */
export function sameWorktreePath(left: string, right: string): boolean {
  const canonical = (path: string): string => resolve(existsSync(path) ? realpathSync.native(path) : path);
  return relative(canonical(left), canonical(right)) === '';
}

/**
 * Worktree ids are model-controlled, so they are validated at the tool boundary
 * before they ever reach a path or a git argv. Only a single path segment of safe
 * characters is allowed — no separators, no shell metacharacters, no '.'/'..' — so
 * `$(...)` command substitution and `../../` traversal are rejected outright.
 */
const WORKTREE_ID_PATTERN = /^[A-Za-z0-9._-]{1,64}$/;

function isSafeWorktreeId(id: string): boolean {
  return typeof id === 'string' && WORKTREE_ID_PATTERN.test(id) && id !== '.' && id !== '..';
}

/**
 * Create a real git worktree for sub-agent isolation. Failure is explicit: an
 * empty directory is not a checkout and must never masquerade as one.
 * Returns the absolute path to use as the sub-agent's workspaceRoot.
 * Idempotent create.
 */
export function createWorktree(baseWorkspace: string, id: string): WorktreeInfo {
  const worktreesRoot = resolve(baseWorkspace, '.shadow/worktrees');
  mkdirSync(worktreesRoot, { recursive: true });
  // Containment gate: id must resolve INSIDE worktreesRoot. resolveWithin throws on
  // any '..' / absolute escape (even for not-yet-existing paths), so a malicious id
  // cannot land the worktree outside the managed dir.
  const wtPath = resolveWithin(worktreesRoot, id);
  if (!isSafeWorktreeId(id)) throw new Error('Invalid worktree id');

  if (existsSync(wtPath)) {
    const existing = listWorktrees(baseWorkspace).find((w) => sameWorktreePath(w.path, wtPath));
    if (!existing) throw new Error(`Worktree path already exists but is not a registered Git worktree: ${wtPath}`);
    return existing;
  }

  try {
    // Use a real git worktree for full isolation. Pass wtPath as an argv
    // element via execFileSync so it is never shell-parsed — `$(...)` / `;` in a path
    // are inert literals, not command substitution.
    execFileSync('git', ['worktree', 'add', '--detach', wtPath], {
      cwd: baseWorkspace,
      stdio: 'ignore',
      timeout: 10000,
    });
    const baseCommit = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: wtPath, encoding: 'utf8', timeout: 5000 }).trim();
    return { path: wtPath, id, baseCommit };
  } catch (error) {
    throw new Error(`Could not create an isolated Git worktree. Use a repository with a committed HEAD. No fallback directory was created. ${error instanceof Error ? error.message : String(error)}`);
  }
}

/** Remove a registered worktree. Dirty work requires an explicit discard decision. */
export function removeWorktree(baseWorkspace: string, pathOrId: string, options: { discardChanges?: boolean } = {}): void {
  const worktreesRoot = resolve(baseWorkspace, '.shadow/worktrees');
  // An absolute path is accepted only when it sits strictly INSIDE worktreesRoot —
  // require a separator boundary so a sibling like ".shadow/worktrees-evil" can't
  // slip past a bare startsWith; otherwise treat the input as a bare id under the
  // managed dir. resolveWithin is the authoritative gate: it throws on any '..' /
  // absolute escape, so an attacker-supplied path cannot delete arbitrary dirs.
  const candidate =
    pathOrId === worktreesRoot || pathOrId.startsWith(worktreesRoot + sep)
      ? pathOrId
      : resolve(worktreesRoot, pathOrId);
  const wtPath = resolveWithin(worktreesRoot, candidate);
  if (wtPath === worktreesRoot) throw new Error('Cannot remove the managed worktree root');
  if (!existsSync(wtPath)) return;
  if (!listWorktrees(baseWorkspace).some((worktree) => sameWorktreePath(worktree.path, wtPath))) {
    throw new Error('Refusing to remove a directory that is not a registered managed Git worktree');
  }
  execFileSync('git', ['worktree', 'remove', ...(options.discardChanges ? ['--force'] : []), wtPath], {
    cwd: baseWorkspace,
    stdio: 'pipe',
    timeout: 10000,
  });
}

/** List current worktrees under .shadow/worktrees */
export function listWorktrees(baseWorkspace: string): WorktreeInfo[] {
  const worktreesRoot = resolve(baseWorkspace, '.shadow/worktrees');
  if (!existsSync(worktreesRoot)) return [];
  try {
    const out = execFileSync('git', ['worktree', 'list', '--porcelain'], { cwd: baseWorkspace, encoding: 'utf8', timeout: 5000 });
    // Robust porcelain parser: format repeats blocks starting with 'worktree '
    // Keys: worktree <path>, HEAD <sha>, branch <ref>, bare, detached, locked, prunable
    const lines = out.split('\n');
    const wts: WorktreeInfo[] = [];
    let current: Partial<WorktreeInfo> = {};
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      if (trimmed.startsWith('worktree ')) {
        if (current.path) {
          wts.push(current as WorktreeInfo);
        }
        current = { path: trimmed.slice(9).trim() };
      } else if (trimmed.startsWith('branch ')) {
        current.branch = trimmed.slice(7).trim();
      } else if (trimmed.startsWith('HEAD ')) {
        current.baseCommit = trimmed.slice(5).trim();
      }
      // ignore bare/detached/locked/prunable for our purpose
    }
    if (current.path) {
      wts.push(current as WorktreeInfo);
    }
    // only return the ones under our managed .shadow/worktrees subdir
    const canonicalRoot = realpathSync.native(worktreesRoot);
    return wts.flatMap((worktree) => {
      if (!worktree.path || !existsSync(worktree.path)) return [];
      const rel = relativeManagedWorktreePath(canonicalRoot, realpathSync.native(worktree.path));
      if (rel === null) return [];
      // Rebase onto the caller's root spelling before applying the jail. Native
      // realpath expands Windows DOS aliases (RUNNER~1), whereas Git may report
      // the corresponding long path. This preserves the same physical root.
      const path = resolveWithin(worktreesRoot, rel);
      return [{ path, id: basename(path), branch: worktree.branch, baseCommit: worktree.baseCommit }];
    });
  } catch {
    return [];
  }
}

const createSchema = z.object({
  id: z.string().min(1).optional().describe('Short unique id for the worktree (auto if omitted).'),
});

const removeSchema = z.object({
  id: z.string().min(1).describe('Worktree id or relative path under .shadow/worktrees'),
  discardChanges: z.boolean().optional().describe('Explicitly discard uncommitted work. Prefer artifact discard so a recoverable patch is retained.'),
});

const listSchema = z.object({});

export function makeWorktreeCreateTool(): Tool<z.infer<typeof createSchema>, WorktreeInfo> {
  return {
    name: 'worktree_create',
    description: 'Create an isolated Git checkout for a sub-task or agent. Requires a Git repository with a committed HEAD; returns an explicit error if isolation fails.',
    risk: 'write',
    inputSchema: createSchema,
    async run(input, ctx) {
      const start = Date.now();
      const id = input.id || `wt-${Date.now()}-${Math.random().toString(36).slice(2,8)}`;
      if (!isSafeWorktreeId(id)) {
        return fail('worktree_create', 'write', Date.now()-start, 'invalid_id', `invalid worktree id "${id}": must match ${WORKTREE_ID_PATTERN} and not be '.' or '..'`);
      }
      try {
        const info = createWorktree(ctx.workspaceRoot, id);
        return ok('worktree_create', 'write', Date.now()-start, `Worktree created at ${info.path}`, info);
      } catch (e) {
        return fail('worktree_create', 'write', Date.now()-start, 'worktree_failed', (e as Error).message);
      }
    },
  };
}

export function makeWorktreeRemoveTool(): Tool<z.infer<typeof removeSchema>, { removed: string }> {
  return {
    name: 'worktree_remove',
    description: 'Remove a worktree created by worktree_create (or agent isolation).',
    risk: 'write',
    inputSchema: removeSchema,
    async run(input, ctx) {
      const start = Date.now();
      if (!isSafeWorktreeId(input.id)) {
        return fail('worktree_remove', 'write', Date.now()-start, 'invalid_id', `invalid worktree id "${input.id}": must match ${WORKTREE_ID_PATTERN} and not be '.' or '..'`);
      }
      try {
        removeWorktree(ctx.workspaceRoot, input.id, { discardChanges: input.discardChanges });
        return ok('worktree_remove', 'write', Date.now()-start, `Worktree ${input.id} removed (or cleaned).`, { removed: input.id });
      } catch (e) {
        return fail('worktree_remove', 'write', Date.now()-start, 'worktree_failed', (e as Error).message);
      }
    },
  };
}

export function makeWorktreeListTool(): Tool<z.infer<typeof listSchema>, { worktrees: WorktreeInfo[] }> {
  return {
    name: 'worktree_list',
    description: 'List active worktrees under this workspace (for isolation management).',
    risk: 'read',
    inputSchema: listSchema,
    async run(_input, ctx) {
      const start = Date.now();
      const list = listWorktrees(ctx.workspaceRoot);
      return ok('worktree_list', 'read', Date.now()-start, `Found ${list.length} worktrees.`, { worktrees: list });
    },
  };
}
