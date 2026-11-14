/**
 * A minimal JSON-RPC 2.0 peer for NDJSON transports (one JSON object per line — the ACP framing).
 * No dependencies, no assumptions beyond line framing: the ACP server injects stdin/stdout, tests
 * inject string feeds and captured writes.
 *
 * Failure posture: a malformed line NEVER kills the peer — it produces a `-32700` parse-error
 * response (id null) and the stream continues. An unknown request id on a response is dropped.
 * The wire is the only stdout in ACP mode, so this peer writes NOTHING but framed messages.
 */
import {
  E_INTERNAL,
  E_INVALID_REQUEST,
  E_PARSE,
  type RpcErrorBody,
  type RpcId,
  type RpcMessage,
} from './protocol.js';

export class RpcFailure extends Error {
  constructor(
    readonly code: number,
    message: string,
    readonly data?: unknown,
  ) {
    super(message);
    this.name = 'RpcFailure';
  }
}

interface Pending {
  resolve: (result: unknown) => void;
  reject: (e: RpcFailure) => void;
}

export interface RpcHandlers {
  /** A request (has an id). Resolve → result; throw RpcFailure/Error → error response. */
  request(method: string, params: unknown): Promise<unknown>;
  /** A notification (no id). Errors are swallowed — notifications never get a response. */
  notification(method: string, params: unknown): void;
}

export class RpcPeer {
  private buf = '';
  private nextId = 1;
  private readonly pending = new Map<RpcId, Pending>();

  constructor(
    private readonly writeLine: (line: string) => void,
    private readonly handlers: RpcHandlers,
  ) {}

  /** Feed raw transport bytes (already utf8). Splits lines, dispatches complete messages. */
  feed(chunk: string): void {
    this.buf += chunk;
    let nl: number;
    while ((nl = this.buf.indexOf('\n')) !== -1) {
      const raw = this.buf.slice(0, nl);
      this.buf = this.buf.slice(nl + 1);
      const line = raw.endsWith('\r') ? raw.slice(0, -1) : raw;
      if (line.trim() === '') continue;
      let msg: unknown;
      try {
        msg = JSON.parse(line);
      } catch {
        this.reply(null, undefined, { code: E_PARSE, message: 'parse error: line is not valid JSON' });
        continue;
      }
      void this.dispatch(msg);
    }
  }

  /** Send a notification (no id, no response expected). */
  notify(method: string, params?: unknown): void {
    this.send({ jsonrpc: '2.0', method, params });
  }

  /** Send a request; resolves with the peer's result, rejects with RpcFailure on error.
   *  `signal` abort REJECTS the returned promise; a late response for the id is dropped. */
  request(method: string, params?: unknown, opts?: { signal?: AbortSignal }): Promise<unknown> {
    const id = this.nextId++;
    if (opts?.signal?.aborted) {
      return Promise.reject(new RpcFailure(E_INTERNAL, 'request aborted before send'));
    }
    const p = new Promise<unknown>((resolve, reject) => {
      this.pending.set(id, { resolve, reject: reject as (e: RpcFailure) => void });
    });
    if (opts?.signal) {
      const onAbort = (): void => {
        const slot = this.pending.get(id);
        if (!slot) return; // already settled
        this.pending.delete(id);
        slot.reject(new RpcFailure(E_INTERNAL, 'request aborted'));
      };
      opts.signal.addEventListener('abort', onAbort, { once: true });
      // .finally() mirrors p's rejection — swallow it here or every aborted request also
      // produces an unhandled rejection from this cleanup chain.
      void p.finally(() => opts.signal?.removeEventListener('abort', onAbort)).catch(() => {});
    }
    this.send({ jsonrpc: '2.0', id, method, params });
    return p;
  }

  /** Teardown: reject everything still in flight (shutdown — no response will ever arrive). */
  cancelPending(message: string): void {
    for (const [id, slot] of this.pending) {
      this.pending.delete(id);
      slot.reject(new RpcFailure(E_INTERNAL, message));
    }
  }

  pendingCount(): number {
    return this.pending.size;
  }

  private async dispatch(raw: unknown): Promise<void> {
    if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
      this.reply(null, undefined, { code: E_INVALID_REQUEST, message: 'invalid request: expected a JSON object' });
      return;
    }
    const msg = raw as RpcMessage;
    if (msg.jsonrpc !== '2.0') {
      this.reply(typeof msg.id === 'number' || typeof msg.id === 'string' ? msg.id : null, undefined, {
        code: E_INVALID_REQUEST,
        message: 'invalid request: jsonrpc must be "2.0"',
      });
      return;
    }

    if (typeof msg.method === 'string') {
      const hasId = typeof msg.id === 'number' || typeof msg.id === 'string';
      if (!hasId) {
        try {
          this.handlers.notification(msg.method, msg.params);
        } catch {
          /* notifications never receive a response */
        }
        return;
      }
      const id = msg.id as RpcId;
      try {
        const result = await this.handlers.request(msg.method, msg.params);
        this.reply(id, result, undefined);
      } catch (err) {
        if (err instanceof RpcFailure) {
          this.reply(id, undefined, { code: err.code, message: err.message, ...(err.data !== undefined ? { data: err.data } : {}) });
        } else {
          this.reply(id, undefined, {
            code: E_INTERNAL,
            message: err instanceof Error ? err.message : String(err),
          });
        }
      }
      return;
    }

    // A response to one of our requests. Unknown/stale ids are dropped silently.
    if (typeof msg.id === 'number' || typeof msg.id === 'string') {
      const slot = this.pending.get(msg.id);
      if (!slot) return;
      this.pending.delete(msg.id);
      if (msg.error) {
        slot.reject(new RpcFailure(msg.error.code ?? E_INTERNAL, String(msg.error.message ?? 'remote error'), msg.error.data));
      } else {
        slot.resolve(msg.result);
      }
    }
  }

  private reply(id: RpcId | null, result: unknown, error: RpcErrorBody | undefined): void {
    this.send({ jsonrpc: '2.0', id, ...(error ? { error } : { result }) });
  }

  private send(msg: RpcMessage): void {
    this.writeLine(JSON.stringify(msg) + '\n');
  }
}
