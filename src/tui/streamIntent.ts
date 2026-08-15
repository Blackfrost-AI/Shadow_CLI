// Pure streaming-intent helpers for the TUI transcript.
// Extracted from tui.tsx so unit tests and the Ink shell share ONE implementation without
// booting React, and so the streaming hot path can be BOUNDED (P1A-11) without touching the
// component-layer flush/teardown sites.

import { findTextualToolIntentStart } from '../provider/textToolCalls.js';
import { matchFence, closesFence } from '../util/markdown.js';

/**
 * Cap on the held tool-intent suffix, in bytes (P1A-11).
 *
 * The held suffix is the tail of a stream that MIGHT still resolve into a textual tool envelope
 * (an unclosed `*** Begin Patch`, a dangling `<tool_call>` / `call:NAME{` / JSON tool_calls
 * wrapper, or an unbalanced bare/json fence or `{`). It is intentionally withheld from the paint
 * path until it either resolves or is safely discarded. The hazard: a malformed local model can
 * emit an envelope marker and then never close it, so the held suffix grows forever, and the
 * intent split re-parses that ever-growing suffix on EVERY token — quadratic, TUI-frozen.
 *
 * The cap bounds that: once the held suffix exceeds this many bytes without resolving, the OLDEST
 * bytes are released back to the visible/paint path (bounded memory and constant per-token work),
 * and only the most-recent tail stays held. Releasing mid-envelope just renders as ordinary text —
 * it is a display guard, not a parser (the same stance as the existing held-tail comment at the
 * call site) — and a turn that DOES resolve will have resolved well under this budget.
 */
export const MAX_HELD_BYTES = 64 * 1024;

/** Earliest still-ambiguous JSON/fence prefix that could become a textual tool envelope. */
function ambiguousToolPrefixStart(text: string): number | null {
  // Hold an unmatched bare/JSON code fence. Once it closes without tool syntax it is released as
  // ordinary visible code; until then committing its opener would make a later tool payload
  // impossible to erase from Ink's Static scrollback.
  // Fence open/close classification is the SINGLE shared implementation from markdown.ts so this
  // intent-hold logic cannot drift from how the renderer/committer treat the same lines.
  let open: { char: '`' | '~'; width: number; start: number; candidate: boolean } | null = null;
  let lineStart = 0;
  for (const line of text.split('\n')) {
    if (open !== null) {
      if (closesFence(line, open)) open = null;
    } else {
      const m = matchFence(line);
      if (m) {
        const lang = m.lang.toLowerCase();
        open = { char: m.char, width: m.width, start: lineStart, candidate: lang === '' || lang === 'json' };
      }
    }
    lineStart += line.length + 1;
  }
  const openFence = open?.candidate ? open.start : null;

  // Hold a line-start object while its braces are unbalanced. This covers incremental pretty JSON
  // where one delta is just "{\n" and the later delta reveals the `tool_calls` key.
  let objectStart: number | null = null;
  const objectRe = /(^|\n)[ \t]*\{/g;
  let object: RegExpExecArray | null;
  while ((object = objectRe.exec(text)) !== null) {
    const start = object.index + (object[1] ? 1 : 0);
    let depth = 0;
    let quote = '';
    let escaped = false;
    for (let i = text.indexOf('{', start); i < text.length; i++) {
      const ch = text[i]!;
      if (escaped) {
        escaped = false;
      } else if (quote) {
        if (ch === '\\') escaped = true;
        else if (ch === quote) quote = '';
      } else if (ch === '"' || ch === "'") {
        quote = ch;
      } else if (ch === '{') {
        depth += 1;
      } else if (ch === '}') {
        depth -= 1;
        if (depth === 0) break;
      }
    }
    if (depth > 0) {
      objectStart = start;
      break;
    }
  }

  const starts = [openFence, objectStart].filter((n): n is number => n !== null);
  return starts.length ? Math.min(...starts) : null;
}

/** Hold a possible tool-call suffix live until it can be parsed or the turn is safely discarded. */
export function splitStreamToolIntent(text: string): { visible: string; held: string } {
  const textual = findTextualToolIntentStart(text);
  const patch = text.indexOf('*** Begin Patch');
  const ambiguous = ambiguousToolPrefixStart(text);
  const starts = [textual, patch >= 0 ? patch : null, ambiguous].filter((n): n is number => n !== null);
  if (starts.length === 0) return { visible: text, held: '' };
  const start = Math.min(...starts);
  return { visible: text.slice(0, start), held: text.slice(start) };
}

/**
 * BOUNDED intent split (P1A-11). Like {@link splitStreamToolIntent}, but the held suffix is capped
 * at `maxHeld` bytes: when the ambiguous tail would exceed the cap without resolving, the oldest
 * overflow is released back into `visible` so the caller's per-token rescan stays O(visible + cap)
 * instead of growing with pathological output. `visible` is always fully returned, so released
 * overflow is never dropped — it flows to the paint/commit path as ordinary text.
 */
export function splitStreamToolIntentCapped(
  text: string,
  maxHeld: number = MAX_HELD_BYTES,
): { visible: string; held: string } {
  const split = splitStreamToolIntent(text);
  if (split.held.length <= maxHeld) return split;
  const overflow = split.held.length - maxHeld;
  return {
    visible: split.visible + split.held.slice(0, overflow),
    held: split.held.slice(overflow),
  };
}

// NOTE (P1A-11 close-out, 2026-08-09): an incremental stateful splitter class briefly lived here,
// built but never wired. It was REMOVED rather than wired: it owned only the ambiguous held
// suffix, so it could not bound the actual quadratic case (a never-closing NON-tool fence such as
// ```python passes through it as visible and accumulates in the caller's `rest`), and wiring a
// per-turn stateful instance would have added reset obligations to every stream-teardown site —
// the exact stranded-state bug class the input items fight. The bound is achieved statelessly
// instead: this module's held-suffix cap + streamCommit.clampLiveRest's retained-remainder cap
// keep the per-delta rescan O(constant) with no instance state to strand.
