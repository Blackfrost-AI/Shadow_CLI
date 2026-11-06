// DAP wire protocol client (mission m-10). One pure encoder + one strict decoder + one peer.
//
// Differences from the LSP client (src/agent/lsp/) are deliberate:
//   - LSP resyncs on garbage because a server is a long-lived shared service; DAP sessions
//     are short-lived and the debuggee is a privileged act — a corrupt stream means a broken
//     (or hostile) adapter, so malformed framing ERRORS THE SESSION instead of resyncing.
//   - DAP messages carry a strictly increasing `seq` per direction. The client validates the
//     inbound counter: a replayed or out-of-order message is a protocol violation.
//   - Every client→adapter message is a REQUEST with a response (DAP has no client-side
//     notifications), so every promise settles — by response, by cancel, or by teardown.
//   - The adapter may issue REVERSE requests (e.g. runInTerminal); the peer answers them
//     defensively and never hangs the session waiting on us.
//
// Bounds: a single message body may not exceed MAX_MESSAGE_BYTES and the total buffered
// bytes awaiting framing may not exceed MAX_BUFFERED_BYTES (same posture as lsp/framing.ts).

import { Buffer } from 'node:buffer';

/** Hard cap on one message body (DAP payloads with large variable lists can be big — 1 MiB). */
export const MAX_MESSAGE_BYTES = 1024 * 1024;
/** Hard cap on bytes buffered awaiting a complete frame (lsp/framing.ts parity). */
export const MAX_BUFFERED_BYTES = 4 * 1024 * 1024;

/** The commands this client may issue — the session enforces state policy on top of this. */
export type DapCommand =
  | 'initialize' | 'launch' | 'attach' | 'restart' | 'disconnect' | 'terminate'
  | 'configurationDone' | 'setBreakpoints' | 'setFunctionBreakpoints'
  | 'threads' | 'stackTrace' | 'scopes' | 'variables' | 'evaluate'
  | 'next' | 'stepIn' | 'stepOut' | 'continue' | 'pause';

export interface DapWireError {
  /** Stable machine-readable cause, so callers can branch without string matching. */
  kind: 'framing' | 'json' | 'sequence' | 'type';
  message: string;
}

/** A decoded, still-untrusted DAP message envelope. Bodies are deliberately `unknown`. */
export interface DapEnvelope {
  seq: number;
  type: 'request' | 'response' | 'event';
  command?: unknown;
  event?: unknown;
  request_seq?: unknown;
  success?: unknown;
  message?: unknown;
  body?: unknown;
  /** Reverse-request arguments (runInTerminal etc.), when the adapter sent any. */
  arguments?: unknown;
}

export interface DapPeerHandlers {
  /** Adapter→client event (stopped/terminated/initialized/output/thread/...). */
  onEvent(name: string, body: unknown): void;
  /**
   * Adapter→client (reverse) request. MUST return promptly: resolve with a body, or throw to
   * answer with success:false. The default handler refuses everything — Shadow never
   * launches terminals for an adapter (runInTerminal) and never hands out processes.
   */
  onRequest?(command: string, args: unknown): Promise<unknown>;
  /** Unrecoverable protocol violation. After this the peer is dead and all pending rejects. */
  onProtocolError(error: DapWireError): void;
  /** Transport-level write failure (EPIPE on a dead adapter). */
  onWriteError?(message: string): void;
}

export class DapProtocolError extends Error {
  constructor(readonly kind: DapWireError['kind'], message: string) {
    super(message);
    this.name = 'DapProtocolError';
  }
}

// ── framing ─────────────────────────────────────────────────────────────────────

/**
 * Encode one message as a DAP wire frame. Byte-exact: Content-Length counts UTF-8 bytes
 * (multi-byte characters in launch configs and variable values make bytes ≠ chars).
 */
export function encodeDapFrame(message: unknown): Buffer {
  const body = Buffer.from(JSON.stringify(message), 'utf8');
  return Buffer.concat([Buffer.from(`Content-Length: ${body.length}\r\n\r\n`, 'latin1'), body]);
}

/** Header must be exactly `Content-Length: <digits>\r\n` — DAP permits no other field. */
const HEADER_RE = /^Content-Length: (\d+)\r\n$/;

/**
 * Strict incremental frame decoder. Unlike the LSP decoder it never resyncs: a malformed
 * header, an absurd length, or a buffer overflow is reported as a framing error and the
 * decoder refuses all further input.
 */
export class DapFrameDecoder {
  private buf: Buffer = Buffer.alloc(0);
  private failed = false;

  /** Feed one transport chunk. Returns decoded body texts; `error` is set on violation. */
  push(chunk: string | Buffer): { frames: string[]; error?: DapWireError } {
    if (this.failed) return { frames: [] };
    const data = typeof chunk === 'string' ? Buffer.from(chunk, 'utf8') : chunk;
    this.buf = this.buf.length === 0 ? data : Buffer.concat([this.buf, data]);
    if (this.buf.length > MAX_BUFFERED_BYTES) {
      this.failed = true;
      return { frames: [], error: { kind: 'framing', message: `DAP stream exceeded ${MAX_BUFFERED_BYTES} buffered bytes` } };
    }
    const frames: string[] = [];
    for (;;) {
      const end = this.buf.indexOf('\r\n\r\n', 0, 'latin1');
      if (end === -1) return { frames };
      const headerText = this.buf.subarray(0, end + 2).toString('latin1'); // includes its own \r\n
      const match = HEADER_RE.exec(headerText);
      if (!match) {
        this.failed = true;
        return { frames, error: { kind: 'framing', message: `Malformed DAP header: ${JSON.stringify(headerText)}` } };
      }
      const length = Number(match[1]);
      if (length > MAX_MESSAGE_BYTES) {
        this.failed = true;
        return { frames, error: { kind: 'framing', message: `DAP message of ${length} bytes exceeds the ${MAX_MESSAGE_BYTES}-byte cap` } };
      }
      const bodyStart = end + 4;
      const frameEnd = bodyStart + length;
      if (this.buf.length < frameEnd) return { frames }; // body incomplete — keep buffering
      frames.push(this.buf.subarray(bodyStart, frameEnd).toString('utf8'));
      this.buf = this.buf.subarray(frameEnd);
    }
  }
}

// ── peer ────────────────────────────────────────────────────────────────────────

export interface DapRequestOptions {
  signal?: AbortSignal;
}

interface Pending {
  command: string;
  resolve: (body: unknown) => void;
  reject: (e: Error) => void;
}

export class DapPeer {
  private outSeq = 0;
  private lastInSeq = 0;
  private deadFlag = false;
  private readonly pending = new Map<number, Pending>();
  private readonly decoder = new DapFrameDecoder();

  constructor(
    private readonly writeRaw: (bytes: Buffer) => void,
    private readonly handlers: DapPeerHandlers,
  ) {}

  /** Bytes from the adapter. Protocol violations kill the peer; late responses are dropped. */
  feed(chunk: string | Buffer): void {
    if (this.deadFlag) return;
    const { frames, error } = this.decoder.push(chunk);
    if (error) {
      this.fail(error);
      return;
    }
    for (const frame of frames) {
      let parsed: unknown;
      try {
        parsed = JSON.parse(frame);
      } catch {
        this.fail({ kind: 'json', message: 'DAP message body is not valid JSON' });
        return;
      }
      if (!this.dispatch(parsed)) return;
    }
  }

  dead(): boolean {
    return this.deadFlag;
  }

  pendingCount(): number {
    return this.pending.size;
  }

  /** The commands still awaiting a response (telemetry/tests only — never a policy input). */
  pendingCommands(): string[] {
    return [...this.pending.values()].map((p) => p.command);
  }

  /**
   * Send a request; resolves with the response BODY on success, rejects with a DapProtocolError
   * carrying the adapter's message on success:false. `signal` abort sends a `cancel` request
   * for this sequence (when the adapter declared support) and rejects locally — the promise
   * always settles.
   */
  request(command: DapCommand, args?: unknown, opts: DapRequestOptions = {}): Promise<unknown> {
    if (this.deadFlag) return Promise.reject(new DapProtocolError('framing', 'DAP peer is dead'));
    const seq = ++this.outSeq;
    const p = new Promise<unknown>((resolve, reject) => {
      this.pending.set(seq, { command, resolve, reject });
    });
    if (opts.signal) {
      const signal = opts.signal;
      const onAbort = (): void => {
        const slot = this.pending.get(seq);
        if (!slot) return; // already settled
        this.sendCancel(seq);
        this.pending.delete(seq);
        slot.reject(new DapProtocolError('framing', `DAP request '${command}' was cancelled`));
      };
      signal.addEventListener('abort', onAbort, { once: true });
      void p.finally(() => signal.removeEventListener('abort', onAbort)).catch(() => {});
    }
    this.write(encodeDapFrame({ seq, type: 'request', command, ...(args === undefined ? {} : { arguments: args }) }));
    return p;
  }

  /**
   * Teardown: reject everything in flight. When `cancelSupported` the adapter is told to stop
   * each outstanding request first (disconnect cancels in-flight work); the rejects happen
   * regardless — no pending promise may outlive the session.
   */
  cancelPending(reason: string, cancelSupported = false): void {
    for (const [seq, slot] of [...this.pending]) {
      if (cancelSupported) this.sendCancel(seq);
      this.pending.delete(seq);
      slot.reject(new DapProtocolError('framing', `DAP request '${slot.command}' aborted: ${reason}`));
    }
  }

  /** Mark the peer dead (transport closed / adapter exit). In-flight work rejects. */
  destroy(reason: string): void {
    if (this.deadFlag) return;
    this.fail({ kind: 'framing', message: reason });
  }

  // ── internals ─────────────────────────────────────────────────────────────────

  private sendCancel(targetSeq: number): void {
    if (this.deadFlag) return;
    this.outSeq++;
    // Per the DAP specification the cancel argument is `requestId` — the seq of the
    // targeted request — NOT a `seq` field.
    this.write(encodeDapFrame({ seq: this.outSeq, type: 'request', command: 'cancel', arguments: { requestId: targetSeq } }));
  }

  private write(bytes: Buffer): void {
    try {
      this.writeRaw(bytes);
    } catch (error) {
      this.handlers.onWriteError?.(error instanceof Error ? error.message : String(error));
    }
  }

  private fail(error: DapWireError): void {
    if (this.deadFlag) return;
    this.deadFlag = true;
    this.cancelPending(error.message);
    this.handlers.onProtocolError(error);
  }

  /** Returns false when the peer died on this message (stop feeding afterwards). */
  private dispatch(raw: unknown): boolean {
    if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
      this.fail({ kind: 'json', message: 'DAP message is not a JSON object' });
      return false;
    }
    const env = raw as DapEnvelope;
    const seq = env.seq;
    if (typeof seq !== 'number' || !Number.isInteger(seq) || seq < 1 || seq <= this.lastInSeq) {
      this.fail({
        kind: 'sequence',
        message: `DAP sequence violation: got seq ${String(seq)} after ${this.lastInSeq} (replayed or out of order)`,
      });
      return false;
    }
    this.lastInSeq = seq;

    if (env.type === 'event') {
      const name = typeof env.event === 'string' ? env.event : '';
      if (name === '') {
        this.fail({ kind: 'type', message: 'DAP event without an event name' });
        return false;
      }
      this.handlers.onEvent(name, env.body);
      return true;
    }

    if (env.type === 'response') {
      const requestSeq = env.request_seq;
      const slot = typeof requestSeq === 'number' && Number.isInteger(requestSeq)
        ? this.pending.get(requestSeq as number)
        : undefined;
      if (!slot) return true; // late response to a cancelled/aborted request — drop silently
      this.pending.delete(requestSeq as number);
      if (env.success === true) {
        slot.resolve(env.body);
      } else {
        const adapterMessage = typeof env.message === 'string' && env.message !== ''
          ? env.message
          : (this.errorText(env.body) ?? `DAP request '${slot.command}' failed`);
        slot.reject(new DapProtocolError('type', `Adapter refused '${slot.command}': ${adapterMessage}`));
      }
      return true;
    }

    if (env.type === 'request') {
      void this.answerReverse(env);
      return true;
    }

    this.fail({ kind: 'type', message: `Unknown DAP message type: ${JSON.stringify(env.type)}` });
    return false;
  }

  /** The adapter asked US to do something. Answered always, succeeded never (unless a handler says so). */
  private async answerReverse(env: DapEnvelope): Promise<void> {
    const command = typeof env.command === 'string' ? env.command : '(unnamed)';
    let success = false;
    let message = `Shadow refuses the '${command}' request`;
    let body: unknown = undefined;
    if (this.handlers.onRequest) {
      try {
        body = await this.handlers.onRequest(command, env.arguments ?? env.body);
        success = true;
      } catch (error) {
        message = error instanceof Error ? error.message : String(error);
      }
    }
    if (this.deadFlag) return;
    this.outSeq++;
    this.write(encodeDapFrame({
      seq: this.outSeq,
      type: 'response',
      request_seq: env.seq,
      command,
      success,
      ...(success ? { body } : { message }),
    }));
  }

  private errorText(body: unknown): string | null {
    if (typeof body === 'object' && body !== null && !Array.isArray(body)) {
      const inner = (body as { error?: { format?: unknown; message?: unknown } }).error;
      if (typeof inner?.format === 'string') return inner.format;
      if (typeof inner?.message === 'string') return inner.message;
    }
    return null;
  }
}
