// LSP wire framing: `Content-Length: <n>\r\n\r\n<json>` (header may carry extra fields; some
// servers terminate with bare \n). One pure encoder + one incremental decoder, no I/O.
//
// Robustness posture: a garbage-spewing server must never wedge or OOM us. The decoder caps
// buffered bytes and, past that cap (or on an unparseable/oversized frame), RESYNCS — it drops
// everything before the next plausible `Content-Length:` header and keeps going. Byte-exact
// Buffer math throughout: Content-Length counts UTF-8 bytes, and multi-byte characters may
// straddle chunk boundaries (string concatenation would corrupt them).

/** Hard cap on bytes buffered awaiting a complete frame, and on any single frame's declared body. */
export const MAX_BUFFERED_BYTES = 4 * 1024 * 1024;

/**
 * Encode one JSON message as an LSP wire frame. A trailing newline on `jsonText` is stripped
 * first (RpcPeer's writeLine hands us `JSON.stringify(msg) + '\n'`), so the byte count in the
 * header always matches the body actually written.
 */
export function frameMessage(jsonText: string): string {
  const body = jsonText.endsWith('\n') ? jsonText.slice(0, -1) : jsonText;
  return `Content-Length: ${Buffer.byteLength(body, 'utf8')}\r\n\r\n${body}`;
}

const CONTENT_LENGTH_NEEDLE = Buffer.from('Content-Length:', 'latin1');

/**
 * Incremental frame decoder: feed arbitrary string/Buffer chunks, receive the JSON body texts
 * of every complete frame (usually 0 or 1). Never throws; malformed input resyncs instead of
 * stalling the stream.
 */
export class LspDecoder {
  private buf: Buffer = Buffer.alloc(0);

  /** Feed one transport chunk; returns the JSON texts of all frames it completed. */
  push(chunk: string | Buffer): string[] {
    const data = typeof chunk === 'string' ? Buffer.from(chunk, 'utf8') : chunk;
    this.buf = this.buf.length === 0 ? data : Buffer.concat([this.buf, data]);
    const out: string[] = [];
    // Each iteration either returns or strictly shrinks `buf`, so the loop always terminates.
    for (;;) {
      const header = this.locateHeader();
      if (header === null) {
        this.guardBufferSize();
        return out;
      }
      const headerText = this.buf.subarray(0, header.bodyStart).toString('latin1'); // headers are ASCII
      const match = /Content-Length:\s*(\d+)/i.exec(headerText);
      const length = match ? Number(match[1]) : NaN;
      if (!Number.isInteger(length) || length < 0 || length > MAX_BUFFERED_BYTES) {
        // Unparseable or absurdly large frame: drop this header block and resync.
        this.buf = this.buf.subarray(header.bodyStart);
        continue;
      }
      const frameEnd = header.bodyStart + length;
      if (this.buf.length < frameEnd) {
        this.guardBufferSize();
        return out; // body incomplete — wait for more bytes
      }
      out.push(this.buf.subarray(header.bodyStart, frameEnd).toString('utf8'));
      this.buf = this.buf.subarray(frameEnd);
    }
  }

  /** Bytes buffered awaiting a complete frame (test/diagnostic use). */
  buffered(): number {
    return this.buf.length;
  }

  /**
   * Find the end of the header block. LSP spec says `\r\n\r\n`; some servers emit `\n\n`.
   * Returns where the body starts (after the blank line) or null when no complete header yet.
   */
  private locateHeader(): { bodyStart: number } | null {
    const crlf = this.buf.indexOf('\r\n\r\n');
    const lf = this.buf.indexOf('\n\n');
    const candidates: Array<{ at: number; width: number }> = [];
    if (crlf !== -1) candidates.push({ at: crlf, width: 4 });
    if (lf !== -1) candidates.push({ at: lf, width: 2 });
    const first = candidates.sort((a, b) => a.at - b.at)[0];
    if (!first) return null;
    return { bodyStart: first.at + first.width };
  }

  /**
   * Backstop for a stream that never completes a frame: once buffered bytes pass the cap, drop
   * everything before the next plausible `Content-Length:` (all of it when none is in sight).
   */
  private guardBufferSize(): void {
    if (this.buf.length <= MAX_BUFFERED_BYTES) return;
    const next = this.buf.indexOf(CONTENT_LENGTH_NEEDLE);
    this.buf = next > 0 ? this.buf.subarray(next) : Buffer.alloc(0);
  }
}
