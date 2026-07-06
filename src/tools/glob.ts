import { readdirSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { z } from 'zod';
import type { Tool, ToolResult } from './types.js';
import { ok, fail } from './types.js';
import { resolveWithin } from '../safety/workspaceJail.js';

const SKIP_DIRS = new Set(['node_modules', '.git', 'dist', '.cache', '.shadow']);
const MAX_RESULTS = 1000;
/** Hard bound on directory entries examined — stops a `**` over a huge tree (e.g. $HOME). */
const MAX_SCAN = 100_000;
/** Wall-clock ceiling so glob can never freeze the loop, even if both bounds are far off. */
const TIME_LIMIT_MS = 15_000;
/** Yield to the event loop every N entries so ESC/abort stays responsive during a big walk. */
const YIELD_EVERY = 2_000;

/**
 * Convert a glob pattern to an anchored RegExp. `**` spans directory
 * separators; `*` stays within one path segment; `?` matches a single
 * non-separator character. Ported from the reference agent's glob tool. Exported so grep
 * can reuse it for its `glob` file filter.
 */
export function globToRegExp(glob: string): RegExp {
  // Reject pathological patterns up front — a long run of wildcards compiles to
  // adjacent quantifiers that backtrack catastrophically (ReDoS → frozen agent).
  if (glob.length > 1024 || (glob.match(/\*/g)?.length ?? 0) > 24) {
    throw new Error('glob pattern too complex (too long or too many wildcards)');
  }
  let re = '';
  for (let i = 0; i < glob.length; i++) {
    const ch = glob[i]!;
    if (ch === '*') {
      if (glob[i + 1] === '*') {
        re += '.*'; // ** — any depth, including across directory separators
        i++;
        if (glob[i + 1] === '/') i++;
      } else {
        re += '[^/]*'; // * — within a single path segment
      }
    } else if (ch === '?') {
      re += '[^/]';
    } else if ('.+^${}()|[]\\'.includes(ch)) {
      re += '\\' + ch;
    } else {
      re += ch;
    }
  }
  // Collapse adjacent `.*` runs so the compiled regex can't backtrack exponentially.
  re = re.replace(/(\.\*){2,}/g, '.*');
  return new RegExp('^' + re + '$');
}

const inputSchema = z.object({
  pattern: z
    .string()
    .min(1)
    .describe('Glob to match file paths against: * (within a segment), ** (any depth), ? (one char). e.g. "**/*.ts", "src/*.py".'),
  path: z.string().optional().describe('Directory to search under. Defaults to the workspace root.'),
});

type GlobInput = z.infer<typeof inputSchema>;

export interface GlobEntry {
  path: string;
  size: number;
  mtimeMs: number;
}

export interface GlobData {
  matches: string[];
  entries: GlobEntry[];
  truncated: boolean;
}

export const glob: Tool<GlobInput, GlobData> = {
  name: 'glob',
  description:
    'Find files by name pattern under a directory. Supports glob wildcards: * (within a path segment), ' +
    '** (any depth), ? (one character). Returns matching paths (relative to the search root) with size ' +
    'and mtime. node_modules, .git, dist, .cache and .shadow are skipped. Use grep to search file contents.',
  risk: 'read',
  inputSchema,
  async run(input, ctx): Promise<ToolResult<GlobData>> {
    const start = Date.now();
    let root: string;
    try {
      root = resolveWithin([ctx.workspaceRoot, ...(ctx.additionalRoots ?? [])], input.path ?? '.');
    } catch (e) {
      return fail('glob', 'read', Date.now() - start, 'outside_workspace', (e as Error).message);
    }

    let re: RegExp;
    try {
      re = globToRegExp(input.pattern);
    } catch (e) {
      return fail('glob', 'read', Date.now() - start, 'invalid_pattern', `invalid glob pattern: ${(e as Error).message}`);
    }

    try {
      if (!statSync(root).isDirectory()) {
        return fail('glob', 'read', Date.now() - start, 'not_a_directory', 'path must be a directory for glob.');
      }
    } catch (e) {
      return fail('glob', 'read', Date.now() - start, 'stat_failed', `glob failed: ${(e as Error).message}`);
    }

    const matches: string[] = [];
    const entries: GlobEntry[] = [];
    let truncated = false;
    let limit: 'results' | 'scan' | 'time' | 'aborted' | null = null;
    let scanned = 0;

    // Returns false to abort the whole walk (a bound was hit).
    const walk = async (dir: string): Promise<boolean> => {
      let dirents;
      try {
        dirents = readdirSync(dir, { withFileTypes: true });
      } catch {
        return true; // unreadable dir — skip, keep going
      }
      dirents.sort((a, b) => a.name.localeCompare(b.name));
      for (const d of dirents) {
        if (matches.length >= MAX_RESULTS) return ((truncated = true), (limit = 'results'), false);
        if (scanned >= MAX_SCAN) return ((truncated = true), (limit = 'scan'), false);
        if (ctx.signal.aborted) return ((truncated = true), (limit = 'aborted'), false);
        if (Date.now() - start > TIME_LIMIT_MS) return ((truncated = true), (limit = 'time'), false);
        scanned += 1;
        if (scanned % YIELD_EVERY === 0) await new Promise((r) => setImmediate(r));

        const full = join(dir, d.name);
        if (d.isDirectory()) {
          if (!SKIP_DIRS.has(d.name) && !(await walk(full))) return false;
          continue;
        }
        if (!d.isFile()) continue;
        const rel = relative(root, full).split(sep).join('/');
        if (re.test(rel)) {
          let st;
          try {
            st = statSync(full);
          } catch {
            continue;
          }
          matches.push(rel);
          entries.push({ path: rel, size: st.size, mtimeMs: Math.round(st.mtimeMs) });
        }
      }
      return true;
    };
    await walk(root);

    // Claude parity: newest files first.
    const order = entries
      .map((e, i) => ({ e, i }))
      .sort((a, b) => b.e.mtimeMs - a.e.mtimeMs || a.i - b.i);
    const sortedEntries = order.map((o) => o.e);
    const sortedMatches = order.map((o) => matches[o.i]!);

    const why =
      limit === 'results'
        ? ` (stopped at ${MAX_RESULTS} matches)`
        : limit === 'scan'
          ? ` (stopped after scanning ${MAX_SCAN} entries — narrow the search path or pattern)`
          : limit === 'time'
            ? ` (stopped after ${TIME_LIMIT_MS / 1000}s — narrow the search path or pattern)`
            : limit === 'aborted'
              ? ' (interrupted)'
              : '';
    const summary =
      matches.length === 0
        ? `No files match "${input.pattern}"${why}.`
        : `${matches.length} file(s) match "${input.pattern}"${why}.`;
    return ok('glob', 'read', Date.now() - start, summary, {
      matches: sortedMatches,
      entries: sortedEntries,
      truncated,
    });
  },
};
