/**
 * Compact line diff for the chat canvas — so an edit shows real +/- lines instead
 * of a one-line "edited N occurrences" summary. LCS-based, with a few lines of
 * context around each change and a hard cap so a huge edit can't flood the
 * transcript. UI-only: the diff rides on `ToolResult.meta` and is never serialized
 * back to the model. Pure + synchronous → easy to test.
 */

export interface DiffLine {
  tag: '+' | '-' | ' ';
  text: string;
}

const MAX_LCS_CELLS = 2_000_000; // guard: skip O(n·m) diff for very large files

/** Unified-ish line diff of `oldText` → `newText`. Empty when nothing changed. */
export function diffLines(
  oldText: string,
  newText: string,
  opts: { context?: number; maxLines?: number } = {},
): DiffLine[] {
  if (oldText === newText) return [];
  const context = opts.context ?? 3;
  const maxLines = opts.maxLines ?? 60;
  const a = oldText.split('\n');
  const b = newText.split('\n');

  if (a.length * b.length > MAX_LCS_CELLS) {
    return [{ tag: ' ', text: `(diff too large to display — ${a.length} → ${b.length} lines)` }];
  }

  const full = lcsDiff(a, b);
  const trimmed = collapse(full, context);
  if (trimmed.length > maxLines) {
    return [...trimmed.slice(0, maxLines), { tag: ' ', text: `… (${trimmed.length - maxLines} more diff lines)` }];
  }
  return trimmed;
}

function lcsDiff(a: string[], b: string[]): DiffLine[] {
  const n = a.length;
  const m = b.length;
  // dp[i][j] = LCS length of a[i:] and b[j:]
  const dp: number[][] = Array.from({ length: n + 1 }, () => new Array<number>(m + 1).fill(0));
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      dp[i]![j] = a[i] === b[j] ? dp[i + 1]![j + 1]! + 1 : Math.max(dp[i + 1]![j]!, dp[i]![j + 1]!);
    }
  }
  const out: DiffLine[] = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (a[i] === b[j]) {
      out.push({ tag: ' ', text: a[i]! });
      i++;
      j++;
    } else if (dp[i + 1]![j]! >= dp[i]![j + 1]!) {
      out.push({ tag: '-', text: a[i]! });
      i++;
    } else {
      out.push({ tag: '+', text: b[j]! });
      j++;
    }
  }
  while (i < n) out.push({ tag: '-', text: a[i++]! });
  while (j < m) out.push({ tag: '+', text: b[j++]! });
  return out;
}

/** Keep changed lines + `context` lines around them; collapse long unchanged runs to a "…". */
function collapse(lines: DiffLine[], context: number): DiffLine[] {
  if (!lines.some((l) => l.tag !== ' ')) return [];
  const keep = new Array<boolean>(lines.length).fill(false);
  for (let i = 0; i < lines.length; i++) {
    if (lines[i]!.tag !== ' ') {
      for (let k = Math.max(0, i - context); k <= Math.min(lines.length - 1, i + context); k++) keep[k] = true;
    }
  }
  const out: DiffLine[] = [];
  let gap = false;
  for (let i = 0; i < lines.length; i++) {
    if (keep[i]) {
      out.push(lines[i]!);
      gap = false;
    } else if (!gap) {
      out.push({ tag: ' ', text: '…' });
      gap = true;
    }
  }
  return out;
}
