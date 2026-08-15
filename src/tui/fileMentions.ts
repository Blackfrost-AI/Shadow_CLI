// @-file references (F08-04) — CC/opencode parity. Type `@` in the composer to fuzzy-pick a
// workspace file; on submit the referenced file's content is inlined (capped) so the model gets it
// without a round-trip. Pure/Ink-free so it unit-tests without React; jailed like the other loaders.
//
// The walk is bounded and cached by the caller (see tui.tsx) — it does NOT re-walk per keystroke.

import { readdirSync, existsSync, lstatSync, openSync, readSync, closeSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { resolveWithin } from '../safety/workspaceJail.js';
import { fuzzyRank } from '../util/fuzzy.js';

// Same skip set as the glob tool, plus a few common build/venv dirs the picker should never surface.
const SKIP_DIRS = new Set([
  'node_modules', '.git', 'dist', 'dist-bin', '.cache', '.shadow', '.next', 'build',
  'coverage', '.venv', 'venv', '__pycache__', '.turbo', '.gradle', 'target',
]);
/** Hard bound on entries examined during the workspace walk (a big monorepo can't freeze it). */
const MAX_SCAN = 20_000;
/** Per-file inline cap and total cap across all @mentions in one message. */
const MAX_FILE_BYTES = 64 * 1024;
const MAX_TOTAL_BYTES = 256 * 1024;

export interface AtToken {
  /** Index of the `@` in the input. */
  start: number;
  /** The text typed after `@`, up to the cursor. */
  partial: string;
}

/**
 * The `@`-mention token being edited at `cursor`, or null. Triggers only when `@` is at the start
 * of the input or preceded by whitespace (so `user@host` never opens the picker) and no whitespace
 * separates it from the cursor.
 */
export function atMentionToken(input: string, cursor: number): AtToken | null {
  let i = cursor - 1;
  while (i >= 0 && input[i] !== '@' && !/\s/.test(input[i]!)) i--;
  if (i < 0 || input[i] !== '@') return null;
  if (i > 0 && !/\s/.test(input[i - 1]!)) return null;
  const partial = input.slice(i + 1, cursor);
  if (/\s/.test(partial)) return null;
  return { start: i, partial };
}

/** Bounded, jail-safe recursive walk → workspace-relative file paths (POSIX separators). */
export function walkWorkspaceFiles(workspaceRoot: string, maxScan = MAX_SCAN): string[] {
  const out: string[] = [];
  let scanned = 0;
  const walk = (dir: string): void => {
    if (scanned >= maxScan) return;
    let entries: import('node:fs').Dirent[];
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const d of entries) {
      if (scanned >= maxScan) return;
      scanned++;
      if (d.name.startsWith('.') && d.name !== '.') {
        // Hidden files/dirs are noise in the picker; skip (a user can still type the path by hand).
        if (d.isDirectory()) continue;
        continue;
      }
      const full = join(dir, d.name);
      if (d.isSymbolicLink()) continue; // never follow a symlink out of the jail
      if (d.isDirectory()) {
        if (!SKIP_DIRS.has(d.name)) walk(full);
      } else if (d.isFile()) {
        out.push(relative(workspaceRoot, full).split(sep).join('/'));
      }
    }
  };
  walk(workspaceRoot);
  return out;
}

/** Fuzzy-rank cached file paths against the `@` partial; basename matches float up. */
export function rankFileCandidates(files: readonly string[], partial: string, limit = 8): string[] {
  if (!partial) return files.slice(0, limit);
  // Rank on the FULL relative path, but boost when the basename itself matches so "foo" finds
  // src/foo.ts ahead of src/unfoo/bar.ts.
  return fuzzyRank(files, partial, (f) => f)
    .map((r) => r.item)
    .sort((a, b) => basenameScore(b, partial) - basenameScore(a, partial))
    .slice(0, limit);
}

function basenameScore(path: string, partial: string): number {
  const base = path.slice(path.lastIndexOf('/') + 1).toLowerCase();
  const p = partial.toLowerCase();
  if (base === p) return 3;
  if (base.startsWith(p)) return 2;
  if (base.includes(p)) return 1;
  return 0;
}

function readCapped(file: string, max: number): string {
  const fd = openSync(file, 'r');
  try {
    const buf = Buffer.alloc(max);
    const n = readSync(fd, buf, 0, max, 0);
    return buf.subarray(0, n).toString('utf8');
  } finally {
    closeSync(fd);
  }
}

/** All `@path` tokens in the text (whitespace-delimited, `@` at start or after whitespace). */
export function findMentions(input: string): Array<{ raw: string; path: string }> {
  const out: Array<{ raw: string; path: string }> = [];
  const re = /(^|\s)@([^\s@]+)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(input)) !== null) {
    const path = m[2]!.replace(/[.,;:)]+$/, ''); // trailing punctuation isn't part of the path
    if (path) out.push({ raw: `@${path}`, path });
  }
  return out;
}

/**
 * On submit, inline the content of every `@path` that resolves to a real in-jail file. The user's
 * original text is preserved verbatim (the model sees the `@path` marker too); referenced files are
 * appended as fenced blocks, capped per-file and in total. A mention that doesn't resolve is left
 * as-is (ordinary text). Returns the original input unchanged when there is nothing to inline.
 */
export function expandFileMentions(input: string, workspaceRoot: string): string {
  const mentions = findMentions(input);
  if (!mentions.length) return input;
  const seen = new Set<string>();
  const blocks: string[] = [];
  let total = 0;
  for (const { path } of mentions) {
    if (seen.has(path)) continue;
    seen.add(path);
    let safe: string;
    try {
      safe = resolveWithin(workspaceRoot, join(workspaceRoot, path));
    } catch {
      continue; // out-of-jail → treat as ordinary text
    }
    try {
      if (!existsSync(safe) || lstatSync(safe).isDirectory() || lstatSync(safe).isSymbolicLink()) continue;
    } catch {
      continue;
    }
    if (total >= MAX_TOTAL_BYTES) {
      blocks.push(`\n[@${path} — omitted, mention size budget reached]`);
      continue;
    }
    let body: string;
    try {
      body = readCapped(safe, MAX_FILE_BYTES);
    } catch {
      continue;
    }
    total += body.length;
    const truncated = body.length >= MAX_FILE_BYTES ? '\n… (truncated)' : '';
    blocks.push(`\n--- @${path} ---\n${body}${truncated}`);
  }
  if (!blocks.length) return input;
  return `${input}\n\nReferenced files:${blocks.join('\n')}`;
}
