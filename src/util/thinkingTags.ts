/**
 * Streaming splitter for models that INLINE their reasoning in the text stream as
 * `<think>…</think>` or `<thinking>…</thinking>` (DeepSeek-R1, Qwen, many local
 * models). It routes tagged spans to the reasoning channel and keeps the rest as
 * the visible answer — the same normalization Claude gets from native thinking
 * blocks, so every reasoning-capable model behaves the same in chat.
 *
 * Streaming-safe: tags may be split across chunk boundaries, so a suffix that
 * could be the start of a tag is held back until the next chunk (or flush()).
 * Display-only — these spans carry no signature and are never replayed to the API.
 *
 * Robust to two real-world messes that used to break Qwen and friends:
 *   • WHITESPACE / VARIANT tags — `</think >`, `< / think >`, newlines inside the
 *     tag. The exact-string matcher missed these, so the closer never fired and the
 *     splitter stayed "inside" thinking forever: the answer was swallowed and the
 *     turn appeared to hang on "✻ thinking…". Matching is now whitespace-tolerant.
 *   • BARE CLOSER — Qwen's chat template routinely emits the reasoning WITHOUT an
 *     opening tag, then a lone `</think>`, then the answer. A closer seen before any
 *     opener now means "everything so far was reasoning": we route it to the thinking
 *     channel and strip the tag, instead of leaking reasoning + a raw `</think>` into
 *     the answer.
 */

export interface SplitSpan {
  kind: 'text' | 'thinking';
  text: string;
}

// Whitespace-tolerant, case-insensitive. Openers must NOT match a closer (the `/` guards that).
const OPEN_RE = /<\s*think(?:ing)?\s*>/i;
const CLOSE_RE = /<\s*\/\s*think(?:ing)?\s*>/i;
// A trailing run that could still GROW into a tag (no `>` yet) — held back until the next chunk.
const PARTIAL_RE = /<\s*\/?\s*(?:t(?:h(?:i(?:n(?:k(?:i(?:n(?:g)?)?)?)?)?)?)?)?\s*$/i;

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
  private inThinking = false;

  /** Feed a content delta; returns any complete spans now resolvable. */
  push(chunk: string): SplitSpan[] {
    this.buf += chunk;
    const out: SplitSpan[] = [];
    for (;;) {
      if (this.inThinking) {
        const m = CLOSE_RE.exec(this.buf);
        if (m) {
          const before = this.buf.slice(0, m.index);
          if (before) out.push({ kind: 'thinking', text: before });
          this.buf = this.buf.slice(m.index + m[0].length);
          this.inThinking = false;
          continue;
        }
      } else {
        const o = OPEN_RE.exec(this.buf);
        const c = CLOSE_RE.exec(this.buf);
        // Whichever tag comes first decides. An opener → the text before it is the answer so far.
        if (o && (!c || o.index <= c.index)) {
          const before = this.buf.slice(0, o.index);
          if (before) out.push({ kind: 'text', text: before });
          this.buf = this.buf.slice(o.index + o[0].length);
          this.inThinking = true;
          continue;
        }
        // A BARE closer (before any opener) → everything before it was reasoning; strip the tag.
        if (c) {
          const before = this.buf.slice(0, c.index);
          if (before) out.push({ kind: 'thinking', text: before });
          this.buf = this.buf.slice(c.index + c[0].length);
          this.inThinking = false; // past the reasoning, into the answer
          continue;
        }
      }
      // No full tag left: emit everything except a possible partial-tag tail.
      const keep = partialTail(this.buf);
      const emit = this.buf.slice(0, this.buf.length - keep);
      if (emit) out.push({ kind: this.inThinking ? 'thinking' : 'text', text: emit });
      this.buf = keep ? this.buf.slice(this.buf.length - keep) : '';
      break;
    }
    return out;
  }

  /** Emit whatever remains at end of stream (an unclosed tag's content still surfaces). */
  flush(): SplitSpan[] {
    if (!this.buf) return [];
    const span: SplitSpan = { kind: this.inThinking ? 'thinking' : 'text', text: this.buf };
    this.buf = '';
    return [span];
  }
}
