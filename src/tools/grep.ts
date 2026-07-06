import { readdirSync, statSync, lstatSync, readFileSync } from 'node:fs';
import { spawn, spawnSync } from 'node:child_process';
import { join, relative, sep, basename } from 'node:path';
import { z } from 'zod';
import type { Tool, ToolResult } from './types.js';
import { ok, fail } from './types.js';
import { resolveWithin } from '../safety/workspaceJail.js';
import { looksBinary, clamp } from './util.js';
import { globToRegExp } from './glob.js';

const SKIP_DIRS = new Set(['node_modules', '.git', 'dist', '.cache', '.shadow']);
const MAX_FILE_BYTES = 1_000_000;
const LINE_CLAMP = 400;

const inputSchema = z.object({
  pattern: z.string().min(1).describe('Regular expression to search for.'),
  path: z.string().optional().describe('Directory (or file) to search under. Defaults to the workspace root.'),
  glob: z.string().optional().describe('Only search files whose path matches this glob, e.g. "**/*.ts".'),
  max_results: z.number().int().positive().optional().describe('Cap on matches returned. Default 200.'),
});

type GrepInput = z.infer<typeof inputSchema>;

export interface GrepMatch {
  file: string;
  line: number;
  column: number;
  text: string;
}

export interface GrepData {
  matches: GrepMatch[];
  truncated: boolean;
  engine: 'ripgrep' | 'node';
}

/**
 * Probe for a REAL ripgrep binary, once. We spawn it directly (no shell), so a
 * shell *function* or alias named `rg` is NOT picked up — on this machine `rg`
 * is exactly that, so the probe correctly reports false and we use the Node
 * fallback. Result is cached for the process.
 */
let rgAvailable: boolean | null = null;
function hasRipgrep(): boolean {
  if (rgAvailable !== null) return rgAvailable;
  try {
    const probe = spawnSync('rg', ['--version'], { timeout: 3000, windowsHide: true });
    rgAvailable = !probe.error && probe.status === 0;
  } catch {
    rgAvailable = false;
  }
  return rgAvailable;
}

export const grep: Tool<GrepInput, GrepData> = {
  name: 'grep',
  description:
    'Search file contents for a regular-expression pattern under a directory. Returns matches as ' +
    'file/line/column/text. Uses ripgrep when a real rg binary is installed (fast, .gitignore-aware) ' +
    'and otherwise falls back to a built-in scan. Restrict the file set with the optional glob filter ' +
    '(e.g. "**/*.ts"). Use glob to find files by name instead of content.',
  risk: 'read',
  inputSchema,
  async run(input, ctx): Promise<ToolResult<GrepData>> {
    const start = Date.now();
    let root: string;
    try {
      root = resolveWithin([ctx.workspaceRoot, ...(ctx.additionalRoots ?? [])], input.path ?? '.');
    } catch (e) {
      return fail('grep', 'read', Date.now() - start, 'outside_workspace', (e as Error).message);
    }

    const maxResults = Math.max(1, Math.min(2000, input.max_results ?? 200));

    // Validate the regex up front (used by the Node fallback; also a good guard
    // before handing it to ripgrep).
    let re: RegExp;
    try {
      re = new RegExp(input.pattern);
    } catch (e) {
      return fail('grep', 'read', Date.now() - start, 'invalid_regex', `invalid regular expression: ${(e as Error).message}`);
    }

    let targetStat;
    try {
      targetStat = statSync(root);
    } catch (e) {
      return fail('grep', 'read', Date.now() - start, 'stat_failed', `grep failed: ${(e as Error).message}`);
    }
    // Grep a single FILE directly when given a file path — models (and people)
    // naturally do `grep pattern file.txt`. (Previously this returned not_a_directory.)
    if (targetStat.isFile()) {
      return finish(grepSingleFile(re, root, maxResults), 'node', start);
    }

    // Prefer ripgrep when a real binary exists; fall back on any trouble.
    if (hasRipgrep()) {
      const viaRg = await ripgrep(input.pattern, root, input.glob, maxResults, ctx.signal);
      if (viaRg) return finish(viaRg, 'ripgrep', start);
    }

    const globRe = input.glob ? globToRegExp(input.glob) : null;
    const res = nodeGrep(re, root, globRe, maxResults);
    return finish(res, 'node', start);
  },
};

function finish(
  res: { matches: GrepMatch[]; truncated: boolean },
  engine: 'ripgrep' | 'node',
  start: number,
): ToolResult<GrepData> {
  const summary =
    res.matches.length === 0
      ? `No matches (${engine}).`
      : `${res.matches.length} match(es)${res.truncated ? ' (truncated)' : ''} (${engine}).`;
  const result = ok('grep', 'read', Date.now() - start, summary, { ...res, engine });
  if (res.matches.length > 0) {
    const preview = res.matches.slice(0, 20);
    const body =
      preview.map((m) => `${m.file}:${m.line}:${m.column} ${m.text}`).join('\n') +
      (res.matches.length > preview.length ? `\n…(+${res.matches.length - preview.length} more)` : '');
    result.meta.findings = [
      {
        title: `grep: ${res.matches.length} match(es)${res.truncated ? ' (truncated)' : ''}`,
        body,
        severity: 'info',
      },
    ];
  }
  return result;
}

/**
 * Search with ripgrep's JSON output. Resolves to matches when rg ran (even with
 * zero matches), or null when rg failed to run so the caller can fall back.
 */
function ripgrep(
  pattern: string,
  root: string,
  glob: string | undefined,
  maxResults: number,
  signal: AbortSignal,
): Promise<{ matches: GrepMatch[]; truncated: boolean } | null> {
  return new Promise((resolve) => {
    const args = ['--json', '--max-filesize', '1M', '-g', '!.shadow/**'];
    if (glob) args.push('-g', glob);
    args.push('-e', pattern, '.');
    const child = spawn('rg', args, { cwd: root, signal, windowsHide: true });
    let out = '';
    let errored = false;
    child.stdout.on('data', (d) => {
      out += d.toString();
    });
    child.on('error', () => {
      errored = true;
      resolve(null);
    });
    child.on('close', (code) => {
      if (errored) return;
      // rg exit codes: 0 = matches, 1 = no matches, 2 = error.
      if (code === 2) return resolve(null);
      const matches: GrepMatch[] = [];
      let truncated = false;
      for (const raw of out.split('\n')) {
        if (!raw.trim()) continue;
        if (matches.length >= maxResults) {
          truncated = true;
          break;
        }
        let ev: unknown;
        try {
          ev = JSON.parse(raw);
        } catch {
          continue;
        }
        const m = ev as { type?: string; data?: RgMatchData };
        if (m.type !== 'match' || !m.data) continue;
        const file = m.data.path?.text ?? '';
        const lineNo = m.data.line_number ?? 0;
        const lineText = (m.data.lines?.text ?? '').replace(/\r?\n$/, '');
        const sub = m.data.submatches?.[0];
        const column = (sub?.start ?? 0) + 1;
        matches.push({ file, line: lineNo, column, text: clamp(lineText, LINE_CLAMP) });
      }
      resolve({ matches, truncated });
    });
  });
}

interface RgMatchData {
  path?: { text?: string };
  line_number?: number;
  lines?: { text?: string };
  submatches?: { start?: number }[];
}

/** Grep a single file (when `path` points at a file, not a directory). */
function grepSingleFile(re: RegExp, file: string, maxResults: number): { matches: GrepMatch[]; truncated: boolean } {
  const matches: GrepMatch[] = [];
  let truncated = false;
  let buf: Buffer;
  try {
    buf = readFileSync(file);
  } catch {
    return { matches, truncated };
  }
  if (buf.length > MAX_FILE_BYTES || looksBinary(buf)) return { matches, truncated };
  const name = basename(file);
  const lines = buf.toString('utf8').split('\n');
  for (let i = 0; i < lines.length; i++) {
    const hit = re.exec(lines[i]!);
    if (hit) {
      matches.push({ file: name, line: i + 1, column: hit.index + 1, text: clamp(lines[i]!, LINE_CLAMP) });
      if (matches.length >= maxResults) {
        truncated = true;
        break;
      }
    }
  }
  return { matches, truncated };
}

/** Dependency-free recursive scan used when ripgrep is unavailable. */
function nodeGrep(
  re: RegExp,
  root: string,
  globRe: RegExp | null,
  maxResults: number,
): { matches: GrepMatch[]; truncated: boolean } {
  const matches: GrepMatch[] = [];
  let truncated = false;
  let scanned = 0;
  const MAX_SCAN = 100_000; // bound the walk so a huge tree can't hang the fallback

  const walk = (dir: string): void => {
    if (matches.length >= maxResults || scanned >= MAX_SCAN) {
      truncated = true;
      return;
    }
    let names: string[];
    try {
      names = readdirSync(dir);
    } catch {
      return;
    }
    for (const name of names) {
      if (matches.length >= maxResults || scanned >= MAX_SCAN) {
        truncated = true;
        return;
      }
      scanned += 1;
      const full = join(dir, name);
      let st;
      try {
        // lstat (not stat): a symlink is neither isDirectory nor isFile here, so a
        // link pointing OUT of the workspace is skipped — it can't leak files past
        // the jail (matches glob/read_file behavior).
        st = lstatSync(full);
      } catch {
        continue;
      }
      if (st.isDirectory()) {
        if (!SKIP_DIRS.has(name)) walk(full);
        continue;
      }
      if (!st.isFile() || st.size > MAX_FILE_BYTES) continue;
      const rel = relative(root, full).split(sep).join('/') || name;
      if (globRe && !globRe.test(rel)) continue;
      let buf: Buffer;
      try {
        buf = readFileSync(full);
      } catch {
        continue;
      }
      if (looksBinary(buf)) continue;
      const lines = buf.toString('utf8').split('\n');
      for (let i = 0; i < lines.length; i++) {
        const line = lines[i]!;
        const hit = re.exec(line);
        if (hit) {
          matches.push({ file: rel, line: i + 1, column: hit.index + 1, text: clamp(line, LINE_CLAMP) });
          if (matches.length >= maxResults) {
            truncated = true;
            return;
          }
        }
      }
    }
  };

  walk(root);
  return { matches, truncated };
}
