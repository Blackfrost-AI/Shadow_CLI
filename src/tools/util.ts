// Helpers shared by the built-in tools. Ported from the reference agent's tools/util.ts
// and editFile.ts: output bounding (`clamp`), binary sniffing (`looksBinary`),
// the exact/repair-ladder string editor (`applyStringEdit`), and the
// disambiguation hint (`nearestMatch`). the reference agent's arg-accessor shims
// (reqString/optString/coerceArgs) are intentionally dropped — zod input
// schemas replace them. Adds `atomicWrite`, the shared temp-file+rename writer
// used by writeFile and editFile.

import { writeFileSync, renameSync, mkdirSync, unlinkSync } from 'node:fs';
import { dirname, join, basename } from 'node:path';

/** Clamp text fed back to the model so one tool call cannot blow the context. */
export function clamp(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text;
  const omitted = text.length - maxChars;
  return text.slice(0, maxChars) + `\n… [${omitted} more characters truncated]`;
}

/** Cheap binary-file sniff: a NUL byte in the first chunk. */
export function looksBinary(buf: Buffer): boolean {
  const n = Math.min(buf.length, 4096);
  for (let i = 0; i < n; i++) if (buf[i] === 0) return true;
  return false;
}

/**
 * Atomically write `content` to `absPath`: ensure the parent directories exist,
 * write a sibling temp file, then `rename` it over the target. Rename is atomic
 * on the same filesystem, so a reader never observes a half-written file. The
 * caller is responsible for having sandbox-checked `absPath` first.
 */
export function atomicWrite(absPath: string, content: string): void {
  const dir = dirname(absPath);
  mkdirSync(dir, { recursive: true });
  const tmp = join(dir, `.${basename(absPath)}.${process.pid}.${Date.now()}.tmp`);
  try {
    writeFileSync(tmp, content, 'utf8');
    renameSync(tmp, absPath);
  } catch (e) {
    try {
      unlinkSync(tmp);
    } catch {
      /* temp file may not exist; ignore */
    }
    throw e;
  }
}

/** Word-overlap similarity of two strings, 0..1. */
function lineSimilarity(a: string, b: string): number {
  if (a === b) return 1; // equal (incl. two empty lines) before the empty-guard
  if (!a || !b) return 0;
  const at = new Set(a.split(/\s+/).filter(Boolean));
  const bt = new Set(b.split(/\s+/).filter(Boolean));
  if (at.size === 0 || bt.size === 0) return 0;
  let common = 0;
  for (const t of at) if (bt.has(t)) common++;
  return common / Math.max(at.size, bt.size);
}

/**
 * When an edit's old_string is not found, locate the region of the file most
 * similar to it and return a numbered snippet. Lets a weak model see the real
 * text — and spot its own typo — instead of retrying a hallucinated string.
 */
export function nearestMatch(text: string, oldStr: string): string {
  const fileLines = text.split('\n');
  const probe = (oldStr.split('\n').find((l) => l.trim()) ?? '').trim();
  if (!probe) return '';
  let bestIdx = -1;
  let bestScore = 0;
  for (let i = 0; i < fileLines.length; i++) {
    const score = lineSimilarity(probe, fileLines[i]!.trim());
    if (score > bestScore) {
      bestScore = score;
      bestIdx = i;
    }
  }
  if (bestIdx < 0 || bestScore < 0.4) return '';
  const from = Math.max(0, bestIdx - 3);
  const to = Math.min(fileLines.length, bestIdx + 5);
  return fileLines
    .slice(from, to)
    .map((l, k) => `  ${from + k + 1}| ${l}`)
    .join('\n');
}

// ── Edit-repair ladder ─────────────────────────────────────────────────────
// A byte-exact `old_string` is the right default, but a weak local model often
// gets whitespace, indentation, or a blank line slightly wrong — a near-miss
// that should still apply, not fail and burn a retry. The ladder tries, in
// order: exact substring → trailing-whitespace-tolerant → indentation-tolerant
// → fuzzy most-similar-block. Anything past "exact" is line-based and is gated
// on UNIQUENESS: if two regions match (or two fuzzy candidates tie), we refuse
// and report rather than guess.

export type EditStrategy = 'exact' | 'trailing-ws' | 'indent' | 'fuzzy';

export type EditResult =
  | { ok: true; updated: string; count: number; strategy: EditStrategy }
  | { ok: false; reason: 'not-found' | 'multiple' | 'ambiguous'; count: number };

/** A fuzzy block must score at least this to be considered a match at all. */
const FUZZY_THRESHOLD = 0.85;
/** …and must beat the runner-up by at least this margin to be unique. */
const FUZZY_UNIQUE_MARGIN = 0.1;

function countOccurrences(haystack: string, needle: string): number {
  if (!needle) return 0;
  return haystack.split(needle).length - 1;
}

/** Replace the first occurrence by slicing — avoids String.replace's `$` magic. */
function replaceFirst(text: string, oldStr: string, newStr: string): string {
  const i = text.indexOf(oldStr);
  if (i < 0) return text;
  return text.slice(0, i) + newStr + text.slice(i + oldStr.length);
}

const stripTrailingWs = (l: string): string => l.replace(/[ \t]+$/, '');
const stripIndent = (l: string): string => l.trim();

/** Indices where `oldLines` matches a contiguous run of `fileLines` under `norm`. */
function findBlockMatches(
  fileLines: string[],
  oldLines: string[],
  norm: (l: string) => string,
): number[] {
  const n = oldLines.length;
  if (n === 0) return [];
  const normOld = oldLines.map(norm);
  const starts: number[] = [];
  for (let i = 0; i + n <= fileLines.length; i++) {
    let match = true;
    for (let j = 0; j < n; j++) {
      if (norm(fileLines[i + j]!) !== normOld[j]) {
        match = false;
        break;
      }
    }
    if (match) {
      starts.push(i);
      i += n - 1; // skip the consumed run so matches never overlap (mirrors split/join)
    }
  }
  return starts;
}

/** Leading whitespace (spaces/tabs) of a line. */
function leadingWs(s: string): string {
  return /^[ \t]*/.exec(s)?.[0] ?? '';
}

/** First non-blank line of a block, or the first line if all are blank. */
function firstNonBlank(lines: string[]): string {
  return lines.find((l) => l.trim() !== '') ?? lines[0] ?? '';
}

/**
 * Re-anchor the replacement block's indentation to the matched file region.
 * A weak model often supplies old/new strings with the wrong (or zero) leading
 * indent; a line-based match would otherwise splice that bad indentation back.
 * We rebase every new line by the delta between the model's base indent and the
 * file block's actual base indent, preserving the new block's relative structure.
 */
function reindent(newStr: string, oldLines: string[], fileBlock: string[]): string {
  const oldBase = leadingWs(firstNonBlank(oldLines));
  const fileBase = leadingWs(firstNonBlank(fileBlock));
  if (oldBase === fileBase) return newStr;
  return newStr
    .split('\n')
    .map((line) => {
      if (line.trim() === '') return line;
      const body = line.startsWith(oldBase) ? line.slice(oldBase.length) : line.replace(/^[ \t]*/, '');
      return fileBase + body;
    })
    .join('\n');
}

/**
 * Replace each matched run with newStr, re-indented per match site, rejoining
 * with the file's own line ending so CRLF files stay consistent.
 */
function replaceBlocks(
  fileLines: string[],
  starts: number[],
  oldLines: string[],
  newStr: string,
  eol: string,
): string {
  const blockLen = oldLines.length;
  const out = [...fileLines];
  // Last-to-first so earlier splices don't shift later indices.
  for (const s of [...starts].sort((a, b) => b - a)) {
    const fileBlock = fileLines.slice(s, s + blockLen);
    out.splice(s, blockLen, ...reindent(newStr, oldLines, fileBlock).split('\n'));
  }
  return out.join(eol);
}

/** Character-bigram (Dice) similarity, 0..1 — robust to single-char typos. */
function charSimilarity(a: string, b: string): number {
  if (a === b) return 1;
  if (a.length < 2 || b.length < 2) return 0;
  const bigrams = (s: string): Map<string, number> => {
    const m = new Map<string, number>();
    for (let i = 0; i < s.length - 1; i++) {
      const bg = s.slice(i, i + 2);
      m.set(bg, (m.get(bg) ?? 0) + 1);
    }
    return m;
  };
  const A = bigrams(a);
  const B = bigrams(b);
  let inter = 0;
  let total = 0;
  for (const [bg, ca] of A) {
    total += ca;
    const cb = B.get(bg);
    if (cb) inter += Math.min(ca, cb);
  }
  for (const cb of B.values()) total += cb;
  return total === 0 ? 0 : (2 * inter) / total;
}

/** Most-similar contiguous block, gated on a clear uniqueness margin. */
function findFuzzyBlock(
  fileLines: string[],
  oldLines: string[],
): { kind: 'match'; start: number } | { kind: 'ambiguous' } | { kind: 'none' } {
  const n = oldLines.length;
  if (n === 0 || n > fileLines.length) return { kind: 'none' };
  const normOld = oldLines.map((l) => l.trim());
  let best = -1;
  let bestScore = 0;
  let secondScore = 0;
  for (let i = 0; i + n <= fileLines.length; i++) {
    let sum = 0;
    for (let j = 0; j < n; j++) sum += charSimilarity(fileLines[i + j]!.trim(), normOld[j]!);
    const score = sum / n;
    if (score > bestScore) {
      secondScore = bestScore;
      bestScore = score;
      best = i;
    } else if (score > secondScore) {
      secondScore = score;
    }
  }
  if (best < 0 || bestScore < FUZZY_THRESHOLD) return { kind: 'none' };
  if (bestScore - secondScore < FUZZY_UNIQUE_MARGIN) return { kind: 'ambiguous' };
  return { kind: 'match', start: best };
}

/**
 * Apply a single old→new string edit using the repair ladder. Returns the full
 * updated file text on success, or a structured failure the caller turns into a
 * model-facing hint. Fuzzy matching is disabled for replace_all (it only makes
 * sense for a single, unambiguous target).
 */
export function applyStringEdit(
  text: string,
  oldStr: string,
  newStr: string,
  replaceAll: boolean,
): EditResult {
  // 1. exact substring (the common, safe case)
  const exact = countOccurrences(text, oldStr);
  if (exact > 0) {
    if (exact > 1 && !replaceAll) return { ok: false, reason: 'multiple', count: exact };
    const updated = replaceAll ? text.split(oldStr).join(newStr) : replaceFirst(text, oldStr, newStr);
    return { ok: true, updated, count: replaceAll ? exact : 1, strategy: 'exact' };
  }

  // 2–4. line-based matching. Normalize line endings so a CRLF file and an
  // LF-only old_string still match, and rejoin with the file's own ending.
  const eol = /\r\n/.test(text) ? '\r\n' : '\n';
  const fileLines = text.split(/\r?\n/);
  const oldLines = oldStr.replace(/\r\n/g, '\n').split('\n');
  const newLF = newStr.replace(/\r\n/g, '\n');

  for (const [strategy, norm] of [
    ['trailing-ws', stripTrailingWs],
    ['indent', stripIndent],
  ] as [EditStrategy, (l: string) => string][]) {
    const starts = findBlockMatches(fileLines, oldLines, norm);
    if (starts.length === 0) continue;
    if (starts.length > 1 && !replaceAll) return { ok: false, reason: 'multiple', count: starts.length };
    const updated = replaceBlocks(fileLines, starts, oldLines, newLF, eol);
    return { ok: true, updated, count: starts.length, strategy };
  }

  // 4. fuzzy, single best block, only when uniqueness is clear
  if (!replaceAll) {
    const fuzzy = findFuzzyBlock(fileLines, oldLines);
    if (fuzzy.kind === 'match') {
      const updated = replaceBlocks(fileLines, [fuzzy.start], oldLines, newLF, eol);
      return { ok: true, updated, count: 1, strategy: 'fuzzy' };
    }
    if (fuzzy.kind === 'ambiguous') return { ok: false, reason: 'ambiguous', count: 2 };
  }

  return { ok: false, reason: 'not-found', count: 0 };
}
