// Shared DAP test fixture (mission m-10): an in-memory FAKE adapter transport.
//
// Hard rules honored here: tests NEVER spawn a real debugger process and NEVER simulate
// adapter availability. This transport stands in for the adapter's STDIO endpoints only —
// it speaks real DAP framing over in-memory byte streams so the protocol layer is
// exercised exactly as it would be on a real pipe, byte-for-byte.
//
// The fake implements the DAP server role the client under test needs:
//   - strict frame decoding of client requests (malformed client frames are ignored),
//   - a programmable per-command script (resolve / refuse / drop),
//   - event injection with real advancing seq counters (or forced seq, for replay tests),
//   - raw-byte injection for corrupt-frame tests.

import { DapFrameDecoder, encodeDapFrame } from '../../src/agent/dap/protocol.js';

/** What the fake adapter does with a request: resolve, refuse, or drop (no response). */
export type FakeAdapterAction =
  | { kind: 'resolve'; body?: unknown }
  | { kind: 'refuse'; message: string }
  | { kind: 'drop' };

/** Program the fake adapter's behavior per command. */
export interface FakeAdapterScript {
  [command: string]: FakeAdapterAction;
}

interface TransportHandlers {
  onData(bytes: Buffer): void;
  onStderr(text: string): void;
  onExit(code: number | null, signal: string | null): void;
  onError(message: string): void;
}

export class FakeAdapter {
  /** Client→adapter request commands, in arrival order (test inspection). */
  readonly receivedCommands: string[] = [];
  /** Client→adapter request arguments, in arrival order (test inspection). */
  readonly receivedArguments: unknown[] = [];
  private seq = 0;
  private script: FakeAdapterScript = {};
  private handlers: TransportHandlers | null = null;
  private alive = true;

  /** Whether close()'s terminate path has killed this fake (asserted by wedge tests). */
  isAlive(): boolean { return this.alive; }

  /** Inject text as if the adapter child printed it on stderr (redaction tests). */
  emitStderr(text: string): void { this.handlers?.onStderr(text); }

  constructor(script: FakeAdapterScript = {}) {
    this.script = script;
  }

  /** Test control: replace the per-command script. */
  setScript(script: FakeAdapterScript): void {
    this.script = script;
  }

  /** The DapTransport the session expects. */
  readonly transport = {
    write: (bytes: Buffer): void => {
      if (!this.alive) return;
      this.consume(bytes);
    },
    attach: (handlers: TransportHandlers): void => {
      this.handlers = handlers;
    },
    terminate: async (): Promise<{ reaped: boolean; code: number | null; signal: string | null }> => {
      // In-memory fake: no child exists. Real-child reaping is tested in dap-gating.test.ts.
      this.alive = false;
      this.handlers = null;
      return { reaped: true, code: null, signal: null };
    },
    pid: (): number | null => null,
  };

  /** Inject an event as if the adapter sent it, with a fresh advancing seq. */
  emit(event: string, body?: unknown): void {
    this.seq++;
    this.deliver({ seq: this.seq, type: 'event', event, ...(body === undefined ? {} : { body }) });
  }

  /** Inject an event with a FORCED seq (replay / out-of-order tests). */
  emitWithSeq(seq: number, event: string, body?: unknown): void {
    this.deliver({ seq, type: 'event', event, ...(body === undefined ? {} : { body }) });
  }

  /** Inject a response to an earlier dropped request (resume sequencing tests). */
  respondTo(requestSeq: number, body?: unknown): void {
    this.seq++;
    this.deliver({ seq: this.seq, type: 'response', request_seq: requestSeq, success: true, ...(body === undefined ? {} : { body }) });
  }

  /** Inject a refusal response to an earlier dropped request. */
  refuseTo(requestSeq: number, message: string): void {
    this.seq++;
    this.deliver({ seq: this.seq, type: 'response', request_seq: requestSeq, success: false, message });
  }

  /** Inject RAW BYTES as if the adapter's stdout produced them (corrupt-frame tests). */
  feedRaw(bytes: string | Buffer): void {
    this.handlers?.onData(typeof bytes === 'string' ? Buffer.from(bytes, 'latin1') : bytes);
  }

  /** The fake's DAP server role: decode client frames and act per the script. */
  private consume(bytes: Buffer): void {
    const decoder = new DapFrameDecoder();
    const { frames } = decoder.push(bytes);
    for (const frame of frames) {
      let parsed: unknown;
      try {
        parsed = JSON.parse(frame);
      } catch {
        return;
      }
      const o = parsed as { seq?: unknown; type?: unknown; command?: unknown; arguments?: unknown };
      if (o.type !== 'request' || typeof o.command !== 'string') return;
      this.receivedCommands.push(o.command);
      this.receivedArguments.push(o.arguments);
      const action = this.script[o.command];
      if (action?.kind === 'resolve') {
        this.seq++;
        this.deliver({
          seq: this.seq,
          type: 'response',
          request_seq: o.seq,
          success: true,
          ...(action.body === undefined ? {} : { body: action.body }),
        });
      } else if (action?.kind === 'refuse') {
        this.seq++;
        this.deliver({
          seq: this.seq,
          type: 'response',
          request_seq: o.seq,
          success: false,
          message: action.message,
        });
      }
      // 'drop' and unscripted commands stay pending — the tests resume them via respondTo().
    }
  }

  private deliver(message: Record<string, unknown>): void {
    if (!this.alive) return;
    this.handlers?.onData(encodeDapFrame(message));
  }
}
