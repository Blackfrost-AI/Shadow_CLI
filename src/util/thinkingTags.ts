/**
 * Split a leading structural reasoning block from a content stream. Once answer
 * text begins, all tags are literal text: examples in prose/code must survive.
 * Structured provider reasoning fields take precedence at the adapter layer.
 *
 * A bare closing tag is accepted only at the start (some chat templates emit it
 * with thinking disabled). Reclassifying already-streamed prose when a later
 * closer arrives is both destructive and dependent on network chunk boundaries.
 */

export interface SplitSpan {
  kind: 'text' | 'thinking';
  text: string;
}

/**
 * Optional XML namespace prefix. The MiniMax-M family emits `<mm:think>` / `</mm:think>`, which
 * matched none of these patterns and so fell straight through to the TEXT channel — a bare
 * `</mm:think>` rendered at the head of the answer AND was persisted into history, replayed to
 * the model on every later turn. The `{0,15}` bound keeps the hold-back in PARTIAL_RE short.
 */
const NS = String.raw`(?:[A-Za-z][\w.-]{0,15}\s*:\s*)?`;

// Whitespace-tolerant, case-insensitive. Openers must NOT match a closer (the `/` guards that).
const OPEN_RE = new RegExp(String.raw`<\s*${NS}think(?:ing)?\s*>`, 'i');
const CLOSE_RE = new RegExp(String.raw`<\s*\/\s*${NS}think(?:ing)?\s*>`, 'i');
/**
 * A trailing run that could still GROW into a tag (no `>` yet) — held back until the next chunk.
 *
 * This one has to be namespace-aware too, and it is the subtle one: without it a stream that
 * splits mid-tag emits `</mm` as visible text and only then recognizes `:think>`, which is a
 * partial leak that reproduces unreliably and is harder to spot than the original bug.
 *
 * Known tradeoff, taken deliberately: an optional leading identifier means a chunk ending in
 * `<div` or `<span` is also held back one chunk. That is a DELAY, never data loss — it flushes on
 * the next chunk or at flush().
 */
const PARTIAL_RE = new RegExp(
  String.raw`<\s*\/?\s*(?:[A-Za-z][\w.-]{0,15}\s*:?\s*)?(?:t(?:h(?:i(?:n(?:k(?:i(?:n(?:g)?)?)?)?)?)?)?)?\s*$`,
  'i',
);

/** Length of the trailing maybe-tag to hold back, or 0. */
function partialTail(s: string): number {
  const lt = s.lastIndexOf('<');
  if (lt < 0) return 0;
  const suffix = s.slice(lt);
  if (suffix.includes('>')) return 0; // already a complete tag-ish token, not a partial
  return PARTIAL_RE.test(suffix) ? s.length - lt : 0;
}

export class ThinkingSplitter {
  private buf = '';
  private state: 'prefix' | 'thinking' | 'text' = 'prefix';

  /** Feed a content delta; returns any complete spans now resolvable. */
  push(chunk: string): SplitSpan[] {
    this.buf += chunk;
    const out: SplitSpan[] = [];
    for (;;) {
      if (this.state === 'prefix') {
        const prefix = this.buf.trimStart();
        const whitespace = this.buf.slice(0, this.buf.length - prefix.length);
        if (prefix && /(?:^|\n)(?: {4}|\t)[^\n]*$/.test(whitespace)) {
          this.state = 'text'; // a leading indented code block is literal content
          continue;
        }
        const open = OPEN_RE.exec(prefix);
        const close = CLOSE_RE.exec(prefix);
        const tag = open?.index === 0 ? open : close?.index === 0 ? close : undefined;
        if (tag) {
          this.buf = prefix.slice(tag[0].length);
          this.state = tag === open ? 'thinking' : 'text';
          continue;
        }
        // Wait only while this can still become a leading tag. The first ordinary
        // character commits to answer text, including every later literal tag.
        if (!prefix || (prefix.startsWith('<') && partialTail(prefix) === prefix.length)) break;
        this.state = 'text';
      }
      if (this.state === 'text') {
        if (this.buf) out.push({ kind: 'text', text: this.buf });
        this.buf = '';
        break;
      }
      const close = CLOSE_RE.exec(this.buf);
      if (close) {
        const before = this.buf.slice(0, close.index);
        if (before) out.push({ kind: 'thinking', text: before });
        this.buf = this.buf.slice(close.index + close[0].length);
        this.state = 'text';
        continue;
      }
      const keep = partialTail(this.buf);
      const emit = this.buf.slice(0, this.buf.length - keep);
      if (emit) out.push({ kind: 'thinking', text: emit });
      this.buf = keep ? this.buf.slice(this.buf.length - keep) : '';
      break;
    }
    return out;
  }

  /** Emit a held-back suffix, preserving incomplete literal tags at EOF. */
  flush(): SplitSpan[] {
    if (!this.buf) return [];
    const span: SplitSpan = { kind: this.state === 'thinking' ? 'thinking' : 'text', text: this.buf };
    this.buf = '';
    return [span];
  }
}
