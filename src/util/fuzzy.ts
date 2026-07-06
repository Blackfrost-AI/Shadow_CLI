/**
 * Fuzzy matching for pickers/search — a subsequence matcher with scoring, plus a
 * ranker that puts exact-substring hits first (typical "type to filter" UX).
 *
 * Mirrors the reverse-engineered pattern (exact contains → subsequence fuzzy),
 * with bonuses for contiguous matches and word-boundary starts so `app` ranks
 * above `wrap` for the query "app". Pure + dependency-free + unit-testable.
 */

/** True if every char of `query` appears in `text` in order (subsequence). */
export function isSubsequence(text: string, query: string): boolean {
  const t = text.toLowerCase();
  const q = query.toLowerCase();
  let j = 0;
  for (let i = 0; i < t.length && j < q.length; i++) {
    if (t[i] === q[j]) j++;
  }
  return j === q.length;
}

/** Case-insensitive exact-substring test. */
export function containsCI(text: string, query: string): boolean {
  return text.toLowerCase().includes(query.toLowerCase());
}

export interface ScoredItem<T> {
  item: T;
  score: number;
}

/**
 * Score how well `text` matches `query`: higher is better.
 *  - exact substring: high base, bonus for earlier position + word-boundary start
 *  - subsequence only: smaller base, bonus for contiguous run length
 *  - no match: -Infinity
 */
export function fuzzyScore(text: string, query: string): number {
  if (!query) return 1; // empty query: everything matches equally
  const t = text.toLowerCase();
  const q = query.toLowerCase();

  const subIdx = t.indexOf(q);
  if (subIdx >= 0) {
    // Exact substring. Bonus for matching at a word boundary (start, or after a
    // separator) and for being early in the string.
    const atBoundary = subIdx === 0 || /[\s\-_/.]/.test(t[subIdx - 1]!);
    return 1000 - subIdx * 4 + (atBoundary ? 64 : 0) + (q.length === t.length ? 128 : 0);
  }

  // Subsequence match with contiguous-run bonus.
  let score = 0;
  let qi = 0;
  let run = 0;
  let lastMatch = -2;
  for (let ti = 0; ti < t.length && qi < q.length; ti++) {
    if (t[ti] === q[qi]) {
      score += 8;
      run = ti === lastMatch + 1 ? run + 1 : 1;
      lastMatch = ti;
      qi++;
    }
  }
  if (qi < q.length) return -Infinity; // not a subsequence
  score += run * 6; // contiguous matches score higher
  return score;
}

/**
 * Rank items by fuzzy match against `query`, dropping non-matches. Exact-substring
 * matches come first (sorted by position), then subsequence matches by score.
 */
export function fuzzyRank<T>(items: readonly T[], query: string, key: (item: T) => string): ScoredItem<T>[] {
  const scored = items
    .map((item) => ({ item, score: fuzzyScore(key(item), query) }))
    .filter((s) => s.score > -Infinity);
  scored.sort((a, b) => b.score - a.score);
  return scored;
}
