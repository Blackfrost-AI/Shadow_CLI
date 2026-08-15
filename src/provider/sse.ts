/**
 * SSE event reassembly (P2-03 / F01-08).
 *
 * The WHATWG SSE spec lets one event's `data` field span MULTIPLE consecutive `data:` lines;
 * they join with '\n' and dispatch as a single payload on the blank line that ends the event.
 * A server pretty-printing a JSON frame (or splitting one around a flush boundary) is
 * spec-entitled to send:
 *
 *   data: {"choices":[{"delta":
 *   data: {"content":"hi"}}]}
 *   (blank)
 *
 * Every Shadow parser used to treat each `data:` line as a self-contained document, so such a
 * frame failed JSON.parse twice and silently vanished. This module reassembles those frames and
 * hands parsers whole payloads.
 *
 * Dispatch timing — EAGER. The moment the accumulated parts parse as one complete JSON
 * document, the event ships; the assembler does not wait for the terminating blank line.
 * Spec-conformant streams get identical events (delivered a few milliseconds earlier), and
 * NON-conforming servers that skip blank separators entirely keep the pre-P2-03 incremental,
 * line-by-line delivery instead of buffering the whole stream until EOF.
 *
 * Defensive fallback: when one dispatched payload came from >1 line and the joined blob fails
 * to parse, `parseSseData` retries each constituent line on its own — the pre-P2-03 behavior —
 * so packed streams whose frames do not individually complete keep working too.
 *
 * Disclosed deviations from the letter of WHATWG:
 *  - A non-`data` field line (`event:`, `id:`, `retry:`, `:` comment) terminates the
 *    accumulating data field early instead of waiting for the blank line. Real servers never
 *    interleave field lines inside one multi-line data payload; Shadow consumes no field but
 *    `data`.
 *  - CR-only line splits are not supported (lines split on '\n'); the CR half of CRLF is
 *    dropped.
 *  - `parseSseData` yields JSON OBJECTS only: `data: null` keepalives and bare primitives are
 *    filtered centrally so no parser can crash property-accessing them (all four used to).
 *
 * Bounds: eager parsing is attempted only inside a small window (few parts, ≤256 KB); an
 * unparseable accumulation is force-dispatched at ~1 MB so a garbage stream cannot grow the
 * accumulator without bound. `sseEvents` flushes in a `finally`, so a mid-stream error
 * (connection reset, watchdog abort) surrenders whatever is buffered instead of eating it.
 */

/** One assembled SSE event: a joined data payload, or any non-data line passed through. */
export type SseEvent =
  | { kind: 'data'; data: string; parts: string[] }
  | { kind: 'other'; line: string };

/** Eager-parse window: frames bigger/more-split than this hold until a boundary (still parsed). */
const EAGER_MAX_PARTS = 8;
const EAGER_MAX_BYTES = 256 * 1024;
/** Hard bound on unparseable accumulation before a force-dispatch degrades to the per-line path. */
const ACC_CAP_BYTES = 1024 * 1024;

function parses(s: string): boolean {
  try {
    JSON.parse(s);
    return true;
  } catch {
    return false;
  }
}

/**
 * Stateful line-fed assembler. `feed()` one raw line at a time, then `flush()` at end of stream
 * (a cleanly terminated SSE stream ends with a blank line, so flush is usually a no-op — it
 * covers servers that omit the final delimiter).
 */
export class SseAssembler {
  private acc: string[] = [];
  private accBytes = 0;

  /** Emit the accumulating data field as one event and reset. */
  private dispatch(): SseEvent[] {
    const parts = this.acc;
    this.acc = [];
    this.accBytes = 0;
    return [{ kind: 'data', data: parts.join('\n'), parts }];
  }

  feed(rawLine: string): SseEvent[] {
    // Spec says field lines start at column 0, but trim anyway (the pre-P2-03 parsers all
    // trimmed — a sloppy server that indents field lines must keep working) and drop the CR
    // half of CRLF line ends.
    const line = rawLine.endsWith('\r') ? rawLine.slice(0, -1) : rawLine;
    const trimmed = line.trimStart();
    if (trimmed.startsWith('data:')) {
      // Spec: exactly ONE leading space after the colon, when present, is part of the syntax.
      let value = trimmed.slice(5);
      if (value.startsWith(' ')) value = value.slice(1);
      this.acc.push(value);
      this.accBytes += value.length + 1;
      // Eager dispatch: ship the moment the accumulation is one complete JSON document.
      if (this.acc.length <= EAGER_MAX_PARTS && this.accBytes <= EAGER_MAX_BYTES) {
        if (parses(this.acc.join('\n'))) return this.dispatch();
        return [];
      }
      // Unparseable accumulation past the cap: force-dispatch what we have (parseSseData's
      // per-line fallback salvages it) and bound memory instead of buffering forever.
      if (this.accBytes > ACC_CAP_BYTES) return this.dispatch();
      return [];
    }
    const out: SseEvent[] = [];
    if (this.acc.length > 0) out.push(...this.dispatch());
    out.push({ kind: 'other', line: trimmed });
    return out;
  }

  /** End of stream: emit any data field still accumulating (server omitted the final blank). */
  flush(): SseEvent[] {
    if (this.acc.length === 0) return [];
    return this.dispatch();
  }
}

/** Async wrapper over a line stream — what the provider parsers consume. */
export async function* sseEvents(lines: AsyncIterable<string>): AsyncIterable<SseEvent> {
  const asm = new SseAssembler();
  try {
    for await (const line of lines) yield* asm.feed(line);
  } finally {
    // A mid-stream throw must not eat whatever the assembler holds: flush it so parsers
    // salvage the tail before the error propagates.
    yield* asm.flush();
  }
}

/**
 * Parse an assembled data payload into JSON objects.
 *
 * 1. Parse the joined payload (the spec-compliant multi-line case — one JSON document split
 *    across `data:` lines parses once '\n'-joined). A trimmed second attempt covers gateways
 *    that prefix a BOM (U+FEFF): JSON.parse rejects it, but String.prototype.trim strips it —
 *    parity with the pre-P2-03 line-trimming parsers.
 * 2. If that fails and the event came from >1 line, parse each line alone (non-conforming
 *    servers that pack several events without blank separators).
 *
 * Only JSON OBJECTS are returned: `data: null` keepalives and bare primitives are dropped here
 * so no consumer can crash on them (callers that skipped primitives observe no change). Empty
 * result for keepalives, `[DONE]` remnants, and malformed frames — callers skip, as they
 * always did.
 */
export function parseSseData(data: string, parts: string[]): unknown[] {
  const out: unknown[] = [];
  const tryPush = (s: string): boolean => {
    try {
      const v: unknown = JSON.parse(s);
      if (v !== null && typeof v === 'object') out.push(v);
      return true;
    } catch {
      return false;
    }
  };
  if (tryPush(data)) return out;
  const trimmedData = data.trim();
  if (trimmedData !== data && tryPush(trimmedData)) return out;
  if (parts.length > 1) {
    for (const p of parts) {
      const t = p.trim();
      if (!t) continue;
      tryPush(t);
    }
  }
  return out;
}

/** Drop empty/whitespace-only parts before reassembly checks (`data:` with no value, blanks). */
export function nonEmptyParts(parts: string[]): string[] {
  return parts.filter((p) => p.trim().length > 0);
}
