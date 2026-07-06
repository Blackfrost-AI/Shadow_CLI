import { execFileSync } from 'node:child_process';
import { mkdirSync, rmSync, existsSync, readdirSync } from 'node:fs';
import { resolve, sep } from 'node:path';
import { z } from 'zod';
import type { Tool } from './types.js';
import { ok, fail } from './types.js';
import { resolveWithin } from '../safety/workspaceJail.js';

export interface WorktreeInfo {
  path: string;
  id: string;
  branch?: string;
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
 * Create a git worktree (or fallback dir) for sub-agent isolation.
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

  if (existsSync(wtPath)) {
    return { path: wtPath, id, branch: undefined };
  }

  try {
    // Prefer real git worktree for full isolation + branch. Pass wtPath as an argv
    // element via execFileSync so it is never shell-parsed — `$(...)` / `;` in a path
    // are inert literals, not command substitution.
    execFileSync('git', ['worktree', 'add', '--detach', wtPath], {
      cwd: baseWorkspace,
      stdio: 'ignore',
      timeout: 10000,
    });
    return { path: wtPath, id, branch: undefined };
  } catch {
    // Fallback for non-git or no git binary: plain dir (still isolated fs scope)
    mkdirSync(wtPath, { recursive: true });
    return { path: wtPath, id, branch: undefined };
  }
}

/** Remove a worktree (git or fallback dir). Force. */
export function removeWorktree(baseWorkspace: string, pathOrId: string): void {
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
  try {
    execFileSync('git', ['worktree', 'remove', '--force', wtPath], {
      cwd: baseWorkspace,
      stdio: 'ignore',
      timeout: 10000,
    });
  } catch {
    // fallback
    if (existsSync(wtPath)) {
      rmSync(wtPath, { recursive: true, force: true });
    }
  }
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
        // we don't store HEAD for now, but parse correctly so state machine works
      }
      // ignore bare/detached/locked/prunable for our purpose
    }
    if (current.path) {
      wts.push(current as WorktreeInfo);
    }
    // only return the ones under our managed .shadow/worktrees subdir
    return wts
      .filter((w) => w.path && w.path.includes('.shadow/worktrees'))
      .map((w) => ({
        path: w.path!,
        id: w.path!.split('/').pop()!,
        branch: w.branch,
      }));
  } catch {
    // fs fallback: list dirs under the worktreesRoot
    try {
      const ids = readdirSync(worktreesRoot, { withFileTypes: true })
        .filter((d: { isDirectory: () => boolean }) => d.isDirectory())
        .map((d: { name: string }) => d.name);
      return ids.map((id: string) => ({ path: resolve(worktreesRoot, id), id }));
    } catch {
      return [];
    }
  }
}

const createSchema = z.object({
  id: z.string().min(1).optional().describe('Short unique id for the worktree (auto if omitted).'),
});

const removeSchema = z.object({
  id: z.string().min(1).describe('Worktree id or relative path under .shadow/worktrees'),
});

const listSchema = z.object({});

export function makeWorktreeCreateTool(): Tool<z.infer<typeof createSchema>, WorktreeInfo> {
  return {
    name: 'worktree_create',
    description: 'Create an isolated git worktree (or fallback dir) for a sub-task or agent. Returns the path to use as workspace.',
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
        removeWorktree(ctx.workspaceRoot, input.id);
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
