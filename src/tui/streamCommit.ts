// Pure streaming/commit helpers for the TUI transcript.
// Extracted from tui.tsx so unit tests and the Ink shell share one implementation
// without booting React.

import { parseMarkdown, isTableSeparator, FENCE as MD_FENCE, LIST_ITEM as MD_LIST_ITEM, QUOTE as MD_QUOTE } from '../util/markdown.js';
// dupKey/repeatStep moved to src/util/repeat.ts so the web console can share them
// (src/util is the only tree tsconfig.web.json transpiles to browser ESM).
export { dupKey, repeatStep } from '../util/repeat.js';

/**
 * Split an accumulating markdown stream into completed top-level blocks plus the
 * still-incomplete trailing remainder.
 *
 * A block boundary is a blank line at the TOP level; blank lines inside an open
 * ``` code fence are ignored so a fenced block is never split. Completed blocks
 * are returned in order (to be committed to <Static> — the terminal's native
 * scrollback); the trailing partial block — an as-yet-unclosed fence, plus the
 * final line that has no newline after it — is returned as `rest` and kept in the
 * live region. Committing finished blocks as they land is what keeps the live
 * region (and the input composer pinned below it) from growing with the answer.
 */
export function extractCompleteBlocks(buf: string): { blocks: string[]; rest: string } {
  const parts = buf.split('\n');
  const blocks: string[] = [];
  let cur: string[] = [];
  let inFence = false;
  for (let i = 0; i < parts.length; i++) {
    const line = parts[i];
    // The final element has no trailing newline in `buf` — it is still streaming,
    // so it always belongs to the live remainder, never to a committed block.
    if (i === parts.length - 1) {
      cur.push(line);
      break;
    }
    if (/^\s*```/.test(line)) {
      inFence = !inFence;
      cur.push(line);
      continue;
    }
    if (!inFence && line.trim() === '') {
      // Top-level blank line → block boundary. Emit the block and drop the blank
      // separator (TranscriptRow supplies spacing between committed blocks).
      if (cur.length) {
        blocks.push(cur.join('\n'));
        cur = [];
      }
      continue;
    }
    cur.push(line);
  }
  return { blocks, rest: cur.join('\n') };
}

/**
 * Like {@link extractCompleteBlocks} but commits at LINE granularity for the smoothest, most stable
 * composer (the reference clients feel): a completed PROSE / heading / rule line is flushed to
 * native scrollback immediately, so the live region shrinks to just the line currently being typed
 * and the input barely moves. Multi-line constructs that MUST render as a unit — fenced code, lists,
 * blockquotes, and pipe/table runs — are kept grouped and flushed only when the construct ends (a
 * blank line, or a line that breaks the run), exactly as parseMarkdown gathers them, so nothing
 * misrenders. The still-typing final line (and any open construct) stays in `rest` (the live region).
 *
 * Each unit carries `pad` — whether it must render with a gap before it. The rule mirrors the
 * NON-streamed Markdown renderer exactly (which puts one blank between EVERY block pair): a unit is
 * padded when (a) a top-level blank line preceded it, (b) it is itself a distinct block (heading,
 * rule, list, quote, table, fence), or (c) the previous unit was one — only prose-after-prose hugs,
 * because consecutive prose source lines ARE one paragraph (parseMarkdown joins them). This keeps
 * streamed and non-streamed output byte-for-byte identical in rhythm, with no dependence on where
 * the stream happened to be cut. Dropping every separator used to glue ALL blocks into a wall of
 * text — the #1 "cluttered output" complaint.
 * `startPadded` seeds the state from the PREVIOUS delta batch (the caller persists `trailingBlank`
 * across calls in a ref — it covers both a consumed blank AND a committed block at a batch seam).
 * (Only edge case: an inline emphasis span that straddles a hard line break renders literally;
 * vanishingly rare in chat output.)
 */
export interface CommitUnit {
  text: string;
  /** Render with a gap before this unit (blank line in source, or a block boundary). */
  pad: boolean;
}
/** Is this unit a distinct markdown BLOCK (anything but a plain paragraph)? Classified by
 *  parseMarkdown ITSELF — the renderer's parser is the single source of truth, so the streamed
 *  gap rhythm can never drift from the non-streamed render (hand-rolled regex copies did drift:
 *  looser fence opens, trimmed list tests, pipe-prose misread as tables). */
function isBlockUnit(text: string): boolean {
  return parseMarkdown(text).some((b) => b.type !== 'paragraph');
}
/** Strip trailing NEWLINES only — never trimEnd() a committed unit. Trailing spaces are semantic
 *  in markdown ("- " is an empty list item; trimEnd turned it into a stray "-" paragraph). */
export function stripTrailingNewlines(text: string): string {
  return text.replace(/[\r\n]+$/, '');
}
/** Does this text START with a distinct markdown block? Used by the leftover-commit sites
 *  (assistant_done / stop / error teardown) to space a block leftover correctly. */
export function leadsWithBlock(text: string): boolean {
  const first = parseMarkdown(text)[0];
  return first !== undefined && first.type !== 'paragraph';
}
export function extractCommittableUnits(
  buf: string,
  startPadded = false,
): { units: CommitUnit[]; rest: string; trailingBlank: boolean } {
  const lines = buf.split('\n');
  const n = lines.length;
  const units: CommitUnit[] = [];
  let pending: string[] = []; // an open multi-line construct, held until it completes
  let fenceChar: string | null = null; // the marker that OPENED the current fence (``` vs ~~~)
  let padNext = startPadded; // gap owed to the next unit (blank line or block boundary behind us)
  // Line-level grouping policy uses the PARSER'S OWN regexes (imported), so what we hold together
  // is exactly what parseMarkdown renders together. Pipe lines are held so a real table commits
  // whole; if the run turns out to be pipe-bearing PROSE, isBlockUnit classifies it back to a
  // paragraph and it renders tight — no phantom gaps around shell pipelines or type unions.
  const grouped = (line: string): boolean =>
    MD_LIST_ITEM.test(line) || MD_QUOTE.test(line) || line.includes('|');
  const push = (text: string): void => {
    // A distinct block pads itself AND owes a pad to whatever follows it — exactly the
    // marginTop-between-every-block-pair behavior of the non-streamed Markdown render.
    const block = isBlockUnit(text);
    units.push({ text, pad: padNext || block });
    padNext = block;
  };
  const flush = (): void => {
    if (!pending.length) return;
    // A pipe RUN can be pipe-bearing PROSE followed by a real table ("see `a | b` output:" then a
    // table) — one mixed unit would pad the prose half as if it were a block, diverging from the
    // parser (which joins that prose into the surrounding paragraph). Split the run at each table
    // START (a pipe line whose next line is a separator — parseMarkdown's own rule) so every piece
    // classifies as exactly what the parser sees.
    const held = pending;
    pending = [];
    // Split AT MOST ONCE, at the FIRST table start: once a table begins, parseMarkdown consumes
    // every subsequent pipe line as a body row (even separator-looking ones), so splitting again
    // inside the run would fabricate a second table the parser doesn't see.
    let splitAt = -1;
    for (let j = 0; j < held.length - 1; j++) {
      if (held[j]!.includes('|') && isTableSeparator(held[j + 1]!)) {
        splitAt = j;
        break;
      }
    }
    // splitAt === 0 → the run IS the table from its first line: no prose part, never split
    // (later separator-shaped rows are body content of THIS table, not a second header).
    if (splitAt > 0) {
      push(held.slice(0, splitAt).join('\n')); // the pipe-bearing PROSE part → classifies paragraph
      push(held.slice(splitAt).join('\n')); // the table (header + separator + all body rows)
    } else {
      push(held.join('\n'));
    }
  };

  // Every element except the last had a trailing newline in `buf` (a COMPLETE line); the last element
  // is still being typed and always stays live.
  for (let i = 0; i < n - 1; i++) {
    const line = lines[i]!;
    if (fenceChar !== null) {
      pending.push(line);
      // Close ONLY on a full fence line of the SAME marker (parseMarkdown's exact rule): a ``` inside
      // a ~~~ block is literal content, and `inline-code` at line start must not close anything.
      if (MD_FENCE.test(line) && line.trim().startsWith(fenceChar)) {
        fenceChar = null;
        flush(); // fence closed → commit the whole block
      }
      continue;
    }
    const fence = MD_FENCE.exec(line);
    if (fence) {
      flush();
      fenceChar = fence[1]![0]!;
      pending.push(line);
      continue;
    }
    if (line.trim() === '') {
      flush(); // blank line ends a construct; remember it so the NEXT unit renders with a gap
      padNext = true;
      continue;
    }
    if (grouped(line)) {
      pending.push(line);
      continue;
    }
    flush();
    // A standalone line commits right away; isBlockUnit (via parseMarkdown) decides whether it is
    // a heading/rule (block → gaps) or plain prose (paragraph continuation → hugs).
    push(line);
  }

  const tail = lines[n - 1] ?? '';
  // The `pending` lines were COMPLETE (each had a trailing newline in `buf`), so keep that newline
  // before the still-typing tail — otherwise carrying `rest` forward across deltas would glue the next
  // line onto a held construct (merging list items, or breaking a fence's closing ``` onto the code).
  const rest = pending.length ? pending.join('\n') + '\n' + tail : tail;
  // padNext survives to the caller: it covers a consumed blank OR a just-committed block at the batch
  // seam. A pending construct re-parses next call and owns its pad via this same seed.
  return { units, rest, trailingBlank: padNext };
}

/**
 * Bound `src` to its last `maxLines` lines so a still-open block (e.g. a long
 * code fence mid-stream) cannot grow the live region without limit. If the kept
 * tail begins INSIDE an open code fence, re-open the fence (with its language) so
 * the renderer still applies code styling to the dangling lines.
 */
export function clampTail(src: string, maxLines: number): string {
  if (maxLines <= 0) return src;
  const lines = src.split('\n');
  if (lines.length <= maxLines) return src;
  const tail = lines.slice(-maxLines);
  // Only the DROPPED head lines determine whether the tail begins inside an open fence.
  // Scanning the tail too would double-count an opener that is still present in the tail
  // and prepend a spurious second ``` (an empty code block + plain-text code).
  const head = lines.slice(0, lines.length - tail.length);
  let open = false;
  let lang = '';
  for (const line of head) {
    const m = /^\s*```(.*)$/.exec(line);
    if (m) {
      open = !open;
      lang = open ? m[1].trim() : '';
    }
  }
  return open ? '```' + lang + '\n' + tail.join('\n') : tail.join('\n');
}

