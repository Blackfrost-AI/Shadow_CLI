import { readdirSync, statSync, lstatSync, readFileSync } from 'node:fs';
import { spawn, spawnSync } from 'node:child_process';
import { join, relative, sep, basename } from 'node:path';
import { z } from 'zod';
import { RE2JS } from 're2js';
import type { Tool, ToolResult } from './types.js';
import { ok, fail } from './types.js';
import { resolveWithin } from '../safety/workspaceJail.js';
import { looksBinary, clamp } from './util.js';
import { globToRegExp } from './glob.js';
import { scrubbedEnv } from '../util/safeEnv.js';

const SKIP_DIRS = new Set(['node_modules', '.git', 'dist', '.cache', '.shadow']);
const MAX_FILE_BYTES = 1_000_000;
const LINE_CLAMP = 400;
const MAX_PATTERN_CHARS = 5000;

const inputSchema = z.object({
  pattern: z.string().min(1).max(MAX_PATTERN_CHARS).describe('RE2 regular expression to search for (no backreferences or lookaround).'),
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
  /**
   * Paths that could not be searched (including unreadable directories). Present so a negative
   * result can be reported as a QUALIFIED negative: without this, a file skipped
   * for looking binary is indistinguishable from a file that was searched and
   * had no match. A NUL byte anywhere in the first 4 KB is enough to classify a
   * file as binary (`looksBinary`), and a NUL inside a string literal is a fully
   * textual source file — so this is a real false-negative path, not a
   * theoretical one.
   */
  skipped?: GrepSkipped;
}

/** Paths a scan could not search, with a capped sample for the summary line. */
export interface GrepSkipped {
  binary: number;
  tooLarge: number;
  unreadable: number;
  sample: string[];
}

const SKIPPED_NAME_CAP = 5;

function tallySkip(target: GrepSkipped, kind: 'binary' | 'tooLarge' | 'unreadable', file: string): void {
  target[kind] += 1;
  if (target.sample.length < SKIPPED_NAME_CAP) target.sample.push(file);
}

function skippedTotal(s: GrepSkipped | undefined): number {
  if (!s) return 0;
  return s.binary + s.tooLarge + s.unreadable;
}

function emptySkipped(): GrepSkipped {
  return { binary: 0, tooLarge: 0, unreadable: 0, sample: [] };
}

/** Human-readable qualification of a negative result; '' when nothing was skipped. */
function skippedNote(s: GrepSkipped | undefined): string {
  const total = skippedTotal(s);
  if (!s || total === 0) return '';
  const parts: string[] = [];
  if (s.binary) parts.push(`${s.binary} binary-looking (NUL byte present — content NOT searched)`);
  if (s.tooLarge) parts.push(`${s.tooLarge} over 1 MB (content NOT searched)`);
  if (s.unreadable) parts.push(`${s.unreadable} unreadable`);
  const names = s.sample.length ? ` [${s.sample.join(', ')}${total > s.sample.length ? `, +${total - s.sample.length} more` : ''}]` : '';
  return `⚠ ${total} path(s) skipped${names}: ${parts.join('; ')}.`;
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
    const probe = spawnSync('rg', ['--version'], { timeout: 3000, windowsHide: true, env: scrubbedEnv() });
    rgAvailable = !probe.error && probe.status === 0;
  } catch {
    rgAvailable = false;
  }
  return rgAvailable;
}

/** Test seam for exercising the fallback deterministically on hosts that have ripgrep installed. */
export function __setRipgrepAvailabilityForTests(value: boolean | null): void {
  rgAvailable = value;
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

    // Both engines must avoid native RegExp's catastrophic backtracking. Time checks
    // around a synchronous exec cannot interrupt it, and shape heuristics are incomplete.
    let re: RE2JS;
    try {
      if (input.pattern.length > MAX_PATTERN_CHARS) throw new Error(`pattern exceeds ${MAX_PATTERN_CHARS} characters`);
      re = RE2JS.compile(input.pattern);
    } catch (e) {
      return fail('grep', 'read', Date.now() - start, 'invalid_regex', `invalid or unsupported RE2 regular expression: ${(e as Error).message}`);
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
      const skipped = emptySkipped();
      return finish(grepSingleFile(re, root, maxResults, skipped), 'node', start, skipped);
    }

    // Prefer ripgrep when a real binary exists; fall back on any trouble.
    if (hasRipgrep()) {
      const viaRg = await ripgrep(input.pattern, root, input.glob, maxResults, ctx.signal);
      if (viaRg) return finish(viaRg, 'ripgrep', start);
    }

    const globRe = input.glob ? globToRegExp(input.glob) : null;
    const skipped = emptySkipped();
    const res = nodeGrep(re, root, globRe, maxResults, ctx.signal, skipped);
    return finish(res, 'node', start, skipped);
  },
};

function finish(
  res: { matches: GrepMatch[]; truncated: boolean },
  engine: 'ripgrep' | 'node',
  start: number,
  skipped?: GrepSkipped,
): ToolResult<GrepData> {
  const note = skippedNote(skipped);
  const base =
    res.matches.length === 0
      ? res.truncated
        ? `No matches before the search limit (${engine}); search INCOMPLETE.`
        : `No matches (${engine}).`
      : `${res.matches.length} match(es)${res.truncated ? ' (truncated)' : ''} (${engine}).`;
  // A bare "No matches" next to a silently-skipped file is the defect this guards:
  // it reads as proof of absence. Say instead that the search was incomplete.
  const summary =
    res.matches.length === 0 && note
      ? `No matches (${engine}) — but the search was INCOMPLETE. ${note}`
      : `${base}${note ? ` ${note}` : ''}`;
  const result = ok('grep', 'read', Date.now() - start, summary, {
    ...res,
    engine,
    ...(note ? { skipped } : {}),
  });
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
    // `--text` makes rg search NUL-bearing source instead of silently classifying it as binary.
    // A wall-clock/output cap below bounds pathological large files without turning them into an
    // unqualified negative result.
    const args = ['--json', '--text', '-g', '!.shadow/**'];
    if (glob) args.push('-g', glob);
    args.push('-e', pattern, '.');
    const child = spawn('rg', args, { cwd: root, signal, windowsHide: true, env: scrubbedEnv() });
    let out = '';
    let errored = false;
    let incomplete = false;
    const OUT_CAP = 16 * 1024 * 1024; // bound the JSON buffer so a huge tree can't balloon memory
    const timer = setTimeout(() => {
      incomplete = true;
      try {
        child.kill();
      } catch {
        /* already gone */
      }
    }, 15_000);
    timer.unref();
    child.stdout.on('data', (d) => {
      const chunk = d.toString();
      if (out.length + chunk.length > OUT_CAP) {
        out += chunk.slice(0, Math.max(0, OUT_CAP - out.length));
        incomplete = true;
        try {
          child.kill();
        } catch {
          /* already gone */
        }
        return;
      }
      out += chunk;
    });
    child.on('error', () => {
      errored = true;
      clearTimeout(timer);
      resolve(null);
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      if (errored) return;
      // rg exit codes: 0 = matches, 1 = no matches, 2 = error.
      if (code === 2 && !incomplete) return resolve(null);
      const matches: GrepMatch[] = [];
      let truncated = incomplete;
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
        const file = decodeRgText(m.data.path);
        const lineNo = m.data.line_number ?? 0;
        const lineText = decodeRgText(m.data.lines).replace(/\r?\n$/, '');
        const sub = m.data.submatches?.[0];
        const column = (sub?.start ?? 0) + 1;
        matches.push({ file, line: lineNo, column, text: clamp(lineText, LINE_CLAMP) });
      }
      resolve({ matches, truncated });
    });
  });
}

interface RgText {
  text?: string;
  /** rg uses base64 when a path or matched line is not valid UTF-8. */
  bytes?: string;
}

function decodeRgText(value: RgText | undefined): string {
  if (typeof value?.text === 'string') return value.text;
  if (typeof value?.bytes === 'string') {
    try {
      return Buffer.from(value.bytes, 'base64').toString('utf8');
    } catch {
      return '';
    }
  }
  return '';
}

interface RgMatchData {
  path?: RgText;
  line_number?: number;
  lines?: RgText;
  submatches?: { start?: number }[];
}

/** Grep a single file (when `path` points at a file, not a directory). */
function grepSingleFile(
  re: RE2JS,
  file: string,
  maxResults: number,
  skipped: GrepSkipped,
): { matches: GrepMatch[]; truncated: boolean } {
  const matches: GrepMatch[] = [];
  let truncated = false;
  let buf: Buffer;
  try {
    buf = readFileSync(file);
  } catch {
    tallySkip(skipped, 'unreadable', basename(file));
    return { matches, truncated };
  }
  // Report WHY nothing was searched. A skipped file must not be reported as a
  // searched-and-empty one — that is the false negative this guards against.
  if (buf.length > MAX_FILE_BYTES) {
    tallySkip(skipped, 'tooLarge', basename(file));
    return { matches, truncated };
  }
  if (looksBinary(buf)) {
    tallySkip(skipped, 'binary', basename(file));
    return { matches, truncated };
  }
  const name = basename(file);
  const lines = buf.toString('utf8').split('\n');
  for (let i = 0; i < lines.length; i++) {
    const matcher = re.matcher(lines[i]!);
    if (matcher.find()) {
      matches.push({ file: name, line: i + 1, column: matcher.start() + 1, text: clamp(lines[i]!, LINE_CLAMP) });
      if (matches.length >= maxResults) {
        truncated = true;
        break;
      }
    }
  }
  return { matches, truncated };
}

/** In-process recursive scan used when ripgrep is unavailable. */
function nodeGrep(
  re: RE2JS,
  root: string,
  globRe: RegExp | null,
  maxResults: number,
  signal: AbortSignal,
  skipped: GrepSkipped,
): { matches: GrepMatch[]; truncated: boolean } {
  const matches: GrepMatch[] = [];
  let truncated = false;
  let scanned = 0;
  const MAX_SCAN = 100_000; // bound the walk so a huge tree can't hang the fallback
  const t0 = Date.now();
  const TIME_LIMIT_MS = 15_000; // wall-clock ceiling so ESC returns control and the scan can't run away

  const walk = (dir: string): void => {
    if (matches.length >= maxResults || scanned >= MAX_SCAN || signal.aborted || Date.now() - t0 > TIME_LIMIT_MS) {
      truncated = true;
      return;
    }
    let names: string[];
    try {
      names = readdirSync(dir);
    } catch {
      tallySkip(skipped, 'unreadable', `${relative(root, dir).split(sep).join('/') || '.'}/`);
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
        tallySkip(skipped, 'unreadable', relative(root, full).split(sep).join('/') || name);
        continue;
      }
      if (st.isDirectory()) {
        if (!SKIP_DIRS.has(name)) walk(full);
        continue;
      }
      if (!st.isFile()) continue;
      const rel = relative(root, full).split(sep).join('/') || name;
      if (globRe && !globRe.test(rel)) continue;
      if (st.size > MAX_FILE_BYTES) {
        tallySkip(skipped, 'tooLarge', rel);
        continue;
      }
      let buf: Buffer;
      try {
        buf = readFileSync(full);
      } catch {
        tallySkip(skipped, 'unreadable', rel);
        continue;
      }
      if (looksBinary(buf)) {
        tallySkip(skipped, 'binary', rel);
        continue;
      }
      const lines = buf.toString('utf8').split('\n');
      for (let i = 0; i < lines.length; i++) {
        if ((i & 1023) === 0 && (signal.aborted || Date.now() - t0 > TIME_LIMIT_MS)) {
          truncated = true;
          return;
        }
        const line = lines[i]!;
        const matcher = re.matcher(line);
        if (matcher.find()) {
          matches.push({ file: rel, line: i + 1, column: matcher.start() + 1, text: clamp(line, LINE_CLAMP) });
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
