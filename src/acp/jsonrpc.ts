/**
 * A minimal JSON-RPC 2.0 peer for NDJSON transports (one JSON object per line — the ACP framing).
 * No dependencies, no assumptions beyond line framing: the ACP server injects stdin/stdout, tests
 * inject string feeds and captured writes.
 *
 * Failure posture: a malformed line NEVER kills the peer — it produces a `-32700` parse-error
 * response (id null, or the line's own id when it can be salvaged) and the stream continues. An
 * unknown request id on a response is dropped. The wire is the only stdout in ACP mode, so this
 * peer writes NOTHING but framed messages.
 *
 * m-7 hardening (bounds are ALWAYS on; gates are policy-gated):
 * - FRAME BOUND: a single frame may not exceed 1 MiB. A frame that does is answered with
 *   `frame too large` and the connection dies — no further input is accepted.
 * - PENDING BOUND: at most 64 inbound operations may be unresolved at once. Past the bound
 *   `feed()` reports `{backpressure: true}` so the caller stops reading, and any request that
 *   still arrives is answered with a typed overload error — it is never executed and never
 *   silently dropped (each frame gets exactly one response; the overload answer is not recorded,
 *   so the request can be retried once the queue drains).
 * - POLICY MODE (an `RpcPolicy` is supplied): the FIRST request must be the handshake method
 *   with an exactly-supported protocol version; a wrong version kills the connection; methods
 *   are classified into capability classes and any class not negotiated at the handshake is
 *   refused; a policy-declared cancel surface force-aborts in-flight operations with a typed
 *   error (a late handler result is discarded).
 * - DEDUPLICATION (always on): every request id is fingerprinted (method + canonical params).
 *   A duplicate id with the same fingerprint is answered with the ORIGINAL outcome record —
 *   never executed twice; the same id with different content is a typed id-reuse refusal.
 */
import { createHash } from 'node:crypto';
import {
  E_ACP_CAPABILITY_NOT_NEGOTIATED,
  E_ACP_FRAME_TOO_LARGE,
  E_ACP_ID_REUSE,
  E_ACP_INITIALIZE_REQUIRED,
  E_ACP_OP_CANCELLED,
  E_ACP_OVERLOAD,
  E_ACP_UNSUPPORTED_VERSION,
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

/** One in-flight INBOUND operation (a request whose handler has not settled). */
interface LiveOp {
  method: string;
  params: unknown;
  fingerprint: string;
  controller: AbortController;
  settled: boolean;
}

/** The settled outcome record for a request id — what a duplicate is answered with. */
interface OutcomeRecord {
  fingerprint: string;
  outcome: { result?: unknown; error?: RpcErrorBody };
}

/** Canonical, key-order-independent JSON — the digest input for fingerprints and seals. */
export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null';
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  const keys = Object.keys(value).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${canonicalJson((value as Record<string, unknown>)[k])}`).join(',')}}`;
}

export function sha256Hex(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex');
}

export interface RpcHandlers {
  /**
   * A request (has an id). Resolve → result; throw RpcFailure/Error → error response.
   * `ctx.signal` aborts when the client cancels the operation (policy mode) or the peer dies.
   */
  request(method: string, params: unknown, ctx: { signal: AbortSignal }): Promise<unknown>;
  /** A notification (no id). Errors are swallowed — notifications never get a response. */
  notification(method: string, params: unknown): void;
}

/**
 * m-7 gate configuration. Supplied ONLY by the ACP production entry point: every other
 * `RpcPeer` user (LSP, MCP, tests) constructs the 2-arg peer and gets bounds without gates.
 */
export interface RpcPolicy {
  /** The only method accepted as the first request (e.g. `initialize`). */
  readonly handshakeMethod: string;
  /** Protocol versions this endpoint speaks; anything else is fatal. */
  readonly supportedVersions: readonly number[];
  /** Capability names this endpoint is willing to negotiate. */
  readonly supportedCapabilities: readonly string[];
  /** The capability class a method belongs to, or null for unclassified (always allowed post-handshake). */
  capabilityOf(method: string): string | null;
  /**
   * Map an inbound notification onto live operations to cancel. `force` operations are aborted
   * AND answered with a typed error (handlers that would never resolve on their own);
   * `signal` operations are aborted only — a cooperative handler resolves normally.
   */
  cancelTargets(
    method: string,
    params: unknown,
    liveOps: Array<{ id: RpcId; method: string; params: unknown }>,
  ): { force: RpcId[]; signal: RpcId[] };
}

export interface RpcPeerOptions {
  policy?: RpcPolicy;
  /** Called exactly once when the connection dies (frame bound, unsupported version, end()). */
  onDead?(reason: string): void;
  /** Called when the in-flight count falls back under the pending bound after backpressure. */
  onDrain?(): void;
}

/** What `feed()` reports back so the caller can stop reading instead of dropping frames. */
export interface FeedResult {
  backpressure: boolean;
  dead: boolean;
}

/** A single frame may not exceed 1 MiB (matches the mutation journal's own MAX_BYTES). */
export const RPC_FRAME_BOUND = 1_048_576;
/** At most this many inbound operations may be unresolved at once. */
export const RPC_PENDING_BOUND = 64;
/** Bounded ledger of settled outcomes (FIFO eviction — the pending bound bounds the live set). */
const OUTCOME_LEDGER_BOUND = 1024;

export class RpcPeer {
  private buf = '';
  private nextId = 1;
  private readonly pending = new Map<RpcId, Pending>();
  private readonly liveOps = new Map<RpcId, LiveOp>();
  private readonly outcomes = new Map<RpcId, OutcomeRecord>();
  private inflight = 0;
  private dead = false;
  private backpressured = false;
  private handshake: 'await-handshake' | 'initialized' = 'await-handshake';
  private negotiated = new Set<string>();

  constructor(
    private readonly writeLine: (line: string) => void,
    private readonly handlers: RpcHandlers,
    private readonly opts: RpcPeerOptions = {},
  ) {}

  /**
   * Feed raw transport bytes (already utf8). Splits lines, dispatches complete messages.
   * The result tells the caller to stop reading (`backpressure`) or that the connection is
   * gone (`dead`); frames already fed are never silently dropped.
   */
  feed(chunk: string): FeedResult {
    if (this.dead) return { backpressure: false, dead: true };
    this.buf += chunk;
    let nl: number;
    while (!this.dead && (nl = this.buf.indexOf('\n')) !== -1) {
      const raw = this.buf.slice(0, nl);
      this.buf = this.buf.slice(nl + 1);
      const line = raw.endsWith('\r') ? raw.slice(0, -1) : raw;
      if (Buffer.byteLength(line, 'utf8') > RPC_FRAME_BOUND) {
        this.die('frame too large', E_ACP_FRAME_TOO_LARGE, salvageId(line));
        break;
      }
      if (line.trim() === '') continue;
      let msg: unknown;
      try {
        msg = JSON.parse(line);
      } catch {
        // The peer survives a bad line; answer the line's own id when it is salvageable so the
        // client can correlate the refusal, null otherwise. The line is never processed.
        this.reply(salvageId(line), undefined, { code: E_PARSE, message: 'parse error: line is not valid JSON' });
        continue;
      }
      void this.dispatch(msg);
    }
    if (!this.dead && Buffer.byteLength(this.buf, 'utf8') > RPC_FRAME_BOUND) {
      // No newline in the remainder: this is one oversized frame in the making.
      this.die('frame too large', E_ACP_FRAME_TOO_LARGE, salvageId(this.buf));
    }
    if (!this.dead && this.inflight >= RPC_PENDING_BOUND) {
      // Latch the overload state so a later settle() fires onDrain exactly once.
      this.backpressured = true;
    }
    return { backpressure: this.inflight >= RPC_PENDING_BOUND, dead: this.dead };
  }

  /** Send a notification (no id, no response expected). */
  notify(method: string, params?: unknown): void {
    if (this.dead) return;
    this.send({ jsonrpc: '2.0', method, params });
  }

  /** Send a request; resolves with the peer's result, rejects with RpcFailure on error.
   *  `signal` abort REJECTS the returned promise; a late response for the id is dropped. */
  request(method: string, params?: unknown, opts?: { signal?: AbortSignal; onSend?: (id: RpcId) => void }): Promise<unknown> {
    if (this.dead) return Promise.reject(new RpcFailure(E_INTERNAL, 'connection is dead'));
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
    opts?.onSend?.(id);
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

  /** Inbound operations that are parsed but not yet processed (the pending-bound counter). */
  inflightCount(): number {
    return this.inflight;
  }

  isDead(): boolean {
    return this.dead;
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
        this.handleNotification(msg.method, msg.params);
        return;
      }
      await this.runRequest(msg.id as RpcId, msg.method, msg.params);
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

  private handleNotification(method: string, params: unknown): void {
    if (this.dead) return;
    if (this.opts.policy && this.handshake === 'await-handshake') {
      // Before the handshake there is no session to notify: drop (notifications cannot be
      // answered, and nothing in them executes).
      return;
    }
    if (this.opts.policy) {
      const targets = this.opts.policy.cancelTargets(method, params, this.liveOpViews());
      for (const id of targets.signal) {
        const op = this.liveOps.get(id);
        if (op && !op.settled) op.controller.abort(); // cooperative: the handler resolves
      }
      for (const id of targets.force) this.forceCancel(id);
    }
    try {
      this.handlers.notification(method, params);
    } catch {
      /* notifications never receive a response */
    }
  }

  private liveOpViews(): Array<{ id: RpcId; method: string; params: unknown }> {
    const views: Array<{ id: RpcId; method: string; params: unknown }> = [];
    for (const [id, op] of this.liveOps) views.push({ id, method: op.method, params: op.params });
    return views;
  }

  /** The gated inbound-request pipeline: handshake → capability → dedup → overload → execute. */
  private async runRequest(id: RpcId, method: string, params: unknown): Promise<void> {
    const policy = this.opts.policy;
    if (policy) {
      if (this.handshake === 'await-handshake') {
        if (method !== policy.handshakeMethod) {
          this.reply(id, undefined, {
            code: E_ACP_INITIALIZE_REQUIRED,
            message: `initialize required: the first request must be ${policy.handshakeMethod}`,
          });
          return;
        }
        const version = (params as { protocolVersion?: unknown } | undefined)?.protocolVersion;
        if (typeof version !== 'number' || !policy.supportedVersions.includes(version)) {
          this.die(
            `unsupported protocol version: ${JSON.stringify(version) ?? 'null'} — this endpoint speaks ${policy.supportedVersions.join(', ')}`,
            E_ACP_UNSUPPORTED_VERSION,
            id,
          );
          return;
        }
        const declared = (params as { capabilities?: unknown } | undefined)?.capabilities;
        this.negotiated = new Set(
          Array.isArray(declared)
            ? declared.filter((c): c is string => typeof c === 'string' && policy.supportedCapabilities.includes(c))
            : [],
        );
        this.handshake = 'initialized';
      } else {
        const capability = policy.capabilityOf(method);
        if (capability !== null && !this.negotiated.has(capability)) {
          this.reply(id, undefined, {
            code: E_ACP_CAPABILITY_NOT_NEGOTIATED,
            message: `capability not negotiated: ${capability}`,
          });
          return;
        }
      }
    }

    const fingerprint = sha256Hex(`${method}\n${canonicalJson(params)}`);
    const live = this.liveOps.get(id);
    if (live) {
      if (live.fingerprint !== fingerprint) {
        this.reply(id, undefined, {
          code: E_ACP_ID_REUSE,
          message: 'request id reuse: this id is already in flight for different content',
        });
        return;
      }
      return; // a re-send of an in-flight request: the ORIGINAL outcome answers every copy
    }
    const prior = this.outcomes.get(id);
    if (prior) {
      if (prior.fingerprint !== fingerprint) {
        this.reply(id, undefined, {
          code: E_ACP_ID_REUSE,
          message: 'request id reuse: this id was already used for different content',
        });
        return;
      }
      // The original outcome record — never a second execution.
      if (prior.outcome.error) this.reply(id, undefined, prior.outcome.error);
      else this.reply(id, prior.outcome.result, undefined);
      return;
    }
    if (this.inflight >= RPC_PENDING_BOUND) {
      // Not executed, not recorded: the caller was told to stop reading; a retry after the
      // queue drains is the correct recovery, so this stays answerable rather than final.
      this.reply(id, undefined, {
        code: E_ACP_OVERLOAD,
        message: `overloaded: ${this.inflight} operations in flight — wait for the queue to drain, then retry`,
      });
      return;
    }

    const controller = new AbortController();
    const op: LiveOp = { method, params, fingerprint, controller, settled: false };
    this.liveOps.set(id, op);
    this.inflight++;
    void this.execute(id, method, params, op);
  }

  private async execute(id: RpcId, method: string, params: unknown, op: LiveOp): Promise<void> {
    let outcome: { result?: unknown; error?: RpcErrorBody };
    try {
      const result = await this.handlers.request(method, params, { signal: op.controller.signal });
      outcome = { result };
    } catch (err) {
      if (err instanceof RpcFailure) {
        outcome = { error: { code: err.code, message: err.message, ...(err.data !== undefined ? { data: err.data } : {}) } };
      } else {
        outcome = { error: { code: E_INTERNAL, message: err instanceof Error ? err.message : String(err) } };
      }
    }
    if (op.settled) return; // cancelled or dead while running: the late result is discarded
    this.settle(id, op, outcome);
  }

  /** Force-cancel: abort, answer with the typed error, and record it as the original outcome. */
  private forceCancel(id: RpcId): void {
    const op = this.liveOps.get(id);
    if (!op || op.settled) return;
    op.controller.abort();
    const outcome = { error: { code: E_ACP_OP_CANCELLED, message: 'operation cancelled by client' } };
    this.settle(id, op, outcome);
  }

  private settle(id: RpcId, op: LiveOp, outcome: { result?: unknown; error?: RpcErrorBody }): void {
    op.settled = true;
    this.liveOps.delete(id);
    this.inflight--;
    this.remember(id, op.fingerprint, outcome);
    if (outcome.error) this.reply(id, undefined, outcome.error);
    else this.reply(id, outcome.result, undefined);
    if (this.backpressured && this.inflight < RPC_PENDING_BOUND) {
      this.backpressured = false;
      this.opts.onDrain?.();
    }
  }

  private remember(id: RpcId, fingerprint: string, outcome: { result?: unknown; error?: RpcErrorBody }): void {
    this.outcomes.set(id, { fingerprint, outcome });
    while (this.outcomes.size > OUTCOME_LEDGER_BOUND) {
      const oldest = this.outcomes.keys().next();
      if (oldest.done) break;
      this.outcomes.delete(oldest.value);
    }
  }

  /**
   * Kill the connection: ONE final error line naming the reason (written directly — the dead
   * guard suppresses every later write), every live op aborted and recorded as dead.
   */
  private die(reason: string, code: number, id: RpcId | null): void {
    if (this.dead) return;
    this.dead = true; // no further input is accepted, no further writes leave
    this.writeLine(
      JSON.stringify({
        jsonrpc: '2.0',
        id,
        error: { code, message: `${reason}: the connection is closed and no further input is accepted` },
      }) + '\n',
    );
    this.teardown(reason);
  }

  /** Clean shutdown (process exit): same teardown, no final error line. */
  end(reason: string): void {
    if (this.dead) return;
    this.dead = true;
    this.teardown(reason);
  }

  private teardown(reason: string): void {
    for (const [id, op] of this.liveOps) {
      op.controller.abort();
      op.settled = true;
      this.remember(id, op.fingerprint, { error: { code: E_INTERNAL, message: `connection dead: ${reason}` } });
    }
    this.liveOps.clear();
    this.inflight = 0;
    this.buf = '';
    this.cancelPending(`connection dead: ${reason}`);
    this.opts.onDead?.(reason);
  }

  private reply(id: RpcId | null, result: unknown, error: RpcErrorBody | undefined): void {
    this.send({ jsonrpc: '2.0', id, ...(error ? { error } : { result }) });
  }

  private send(msg: RpcMessage): void {
    if (this.dead) return;
    this.writeLine(JSON.stringify(msg) + '\n');
  }
}

/** Salvage a request id from an unparseable frame so its error can be correlated. */
function salvageId(line: string): RpcId | null {
  const m = /"id"\s*:\s*(-?\d+(?:\.\d+)?)\b/.exec(line);
  if (m) {
    const n = Number(m[1]);
    if (Number.isSafeInteger(n) && Math.abs(n) <= 2 ** 53) return n;
  }
  const s = /"id"\s*:\s*"((?:[^"\\]|\\.)*)"/.exec(line);
  if (s) {
    try {
      const parsed = JSON.parse(`"${s[1]}"`) as string;
      if (parsed.length <= 256) return parsed;
    } catch {
      /* not even the id literal parses — nothing to salvage */
    }
  }
  return null;
}
