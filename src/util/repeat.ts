/**
 * Turn-scoped verbatim-repeat detection for assistant blocks.
 *
 * Weak local models re-emit their whole answer (which may be MULTIPLE blocks) verbatim after a
 * tool step. Local models are Shadow's core audience, so without this the transcript prints
 * every answer twice on exactly the models the product exists for.
 *
 * This lives in src/util (not src/tui) because BOTH renderers need it: the Ink TUI imports it
 * via streamCommit.ts, and the web console imports the browser build of this file emitted by
 * tsconfig.web.json. Keeping one implementation is the whole point — two copies of a dedup
 * heuristic drift, and the drift shows up as duplicated output for the user.
 *
 * It is dependency-free by requirement: anything imported here must also run in a browser.
 */

/**
 * Normalize an assistant block to letters+digits (lowercased) for duplicate detection — so a
 * repeat that differs only by a trailing emoji, punctuation, or whitespace still matches.
 */
export function dupKey(text: string): string {
  return text.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, '');
}

/**
 * `run` is the ordered dupKeys of assistant blocks committed THIS turn; `pos` is the position
 * inside a detected repeat (0 = not in one). Given the next block's dupKey, returns whether to
 * SUPPRESS it and the new (run, pos).
 *
 * Only WHOLE-block exact (normalized) matches count — no prefix fuzz — and the scope is the
 * current turn only, so an identical short answer in a LATER turn ("Done.") still commits. Blocks
 * shorter than 12 normalized chars are never deduped.
 *
 * HONEST LIMITATION: for a single-block answer, "the model restarted its whole answer" and "the
 * user legitimately received the same paragraph twice" are the same observation, and this cannot
 * tell them apart. It suppresses, because on the weak local models Shadow exists for the former is
 * overwhelmingly the common case. The docstring used to claim legitimate content is "never
 * silently dropped"; that was not true, so callers must make a suppression VISIBLE rather than
 * discard the block without trace. The TUI renders a dim collapsed-repeat marker for exactly this
 * reason.
 */
export function repeatStep(
  run: string[],
  pos: number,
  key: string,
): { suppress: boolean; run: string[]; pos: number } {
  if (key.length < 12) return { suppress: false, run: [...run, key], pos: 0 };
  if (pos > 0) {
    if (run[pos] === key) {
      const next = pos + 1;
      return { suppress: true, run, pos: next >= run.length ? 0 : next };
    }
    return { suppress: false, run: [...run, key], pos: 0 }; // repeat broken → real new content
  }
  if (run.length > 0 && run[0] === key) {
    return { suppress: true, run, pos: run.length > 1 ? 1 : 0 }; // the answer is restarting
  }
  return { suppress: false, run: [...run, key], pos: 0 };
}
