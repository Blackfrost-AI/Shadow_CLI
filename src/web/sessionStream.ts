import type { ServerResponse } from 'node:http';
import type { EventBus, LoopEvent } from '../agent/events.js';
import { redact } from '../util/redact.js';

/**
 * One session's SSE wire: the replay ring, the shell_output coalescer, the connected
 * clients, per-client backpressure, and reconnect replay. It owns the bus subscription and
 * a per-stream event-id counter, and NOTHING about agents, security headers, or timers it
 * does not drive itself.
 *
 * Extracted verbatim from server.ts's per-session block so that a registry can hold one of
 * these per WebSession. The security-header policy (res.writeHead + SEC_HEADERS) stays in
 * server.ts — see attach(): this only writes the SSE BODY.
 */

/** Events are buffered so a browser that reconnects doesn't lose the turn in progress. */
const REPLAY_BUFFER = 500;

/**
 * The replay ring is ALSO capped by bytes. A count-based cap alone is not a bound: one
 * coalesced `shell_output` frame from a verbose build can be megabytes, so 500 of them is
 * hundreds of megabytes retained in a CLI process.
 *
 * Note this ring is not a security boundary. A client that can forge `Last-Event-ID: 1`
 * already holds the session token, and the token also grants `GET /api/transcript`, which
 * returns the same buffer. Gating replay would move the disclosure, not close it.
 */
const REPLAY_MAX_BYTES = 2_000_000;

/**
 * `shell_output` arrives per-chunk and can be thousands of events a second. Coalescing on
 * a short timer keeps a long build from starving the stream — without it the SSE writer
 * becomes the bottleneck and the UI falls behind the loop.
 */
const COALESCE_MS = 50;

/**
 * …but coalescing without a size cap is an amplifier, not a fix: `yes | head -c 100M` would
 * accumulate the whole window into a single frame that is then stringified once and retained
 * in the ring. Flush early once a pending blob crosses this.
 */
const COALESCE_MAX_BYTES = 64 * 1024;

/** Per-client outbound buffer. Past this the client is a slow consumer and frames are dropped. */
const CLIENT_QUEUE_MAX_BYTES = 4_000_000;

/** Reconnect backoff advertised to EventSource. */
const SSE_RETRY_MS = 2_000;

export interface TranscriptSnapshot {
  events: Array<{ id: number; event: LoopEvent }>;
  /** Highest id this stream has emitted (0 if none). */
  lastEventId: number;
  /** Counted from an explicit eviction counter, never inferred from replay[0].id. */
  truncated: boolean;
  evicted: number;
}

export interface SessionStreamOptions {
  bus: EventBus;
  /** Server-wide, so a client id is unique in logs across sessions. */
  allocClientId: () => number;
}

export interface SessionStream {
  /**
   * Registers `res` and writes the SSE BODY only (retry / ': connected' / replay).
   * `res.writeHead` with SEC_HEADERS stays in server.ts — the stream must not own
   * security-header policy. `after` is the resolved resume point: the caller applies
   * precedence (Last-Event-ID header beats ?after=, since the header only exists on an
   * auto-reconnect and is strictly fresher). Returns an idempotent detach.
   */
  attach(res: ServerResponse, after?: number): () => void;
  transcript(): TranscriptSnapshot;
  /** Driven by the ONE server-wide heartbeat. Never creates its own timer. */
  ping(): void;
  clientCount(): number;
  /** Unsubscribe bus, clear flush timer, end every client. Idempotent, synchronous. */
  close(): void;
}

interface Client {
  id: number;
  res: ServerResponse;
  /** Bytes handed to res.write() that the socket has not yet flushed. */
  queued: number;
  /** Frames dropped while over the queue cap; surfaced once as a gap marker. */
  dropped: number;
}

export function createSessionStream(opts: SessionStreamOptions): SessionStream {
  const clients = new Map<number, Client>();
  const replay: Array<{ id: number; event: LoopEvent; bytes: number }> = [];
  let replayBytes = 0;
  // Per-stream, starting at 1. Replay is a `>` filter over ids, never an index, so a session
  // switch constructs a fresh EventSource that sends no Last-Event-ID — a stale cross-session
  // cursor cannot be produced, and `truncated` stays correct for free. See §5 of the plan.
  let nextEventId = 1;
  // Explicit eviction counter: `truncated` is the fact that the ring dropped something, not the
  // inference `replay[0].id > 1` (which is wrong the moment ids are ever sparse).
  let evicted = 0;
  let closed = false;

  // --- shell_output coalescing -----------------------------------------------------
  const pending = new Map<string, { callId: string; stream: 'stdout' | 'stderr'; chunk: string }>();
  let flushTimer: ReturnType<typeof setTimeout> | undefined;

  /** Write one frame to one client, respecting its backpressure budget. */
  const writeTo = (c: Client, frame: string): void => {
    if (c.queued > CLIENT_QUEUE_MAX_BYTES) {
      c.dropped++;
      return;
    }
    if (c.dropped > 0) {
      // Tell the client its view has a hole rather than letting it silently diverge.
      const notice = `data: ${JSON.stringify({ type: 'stream_gap', dropped: c.dropped })}\n\n`;
      c.dropped = 0;
      c.queued += notice.length;
      c.res.write(notice, () => {
        c.queued -= notice.length;
      });
    }
    const bytes = Buffer.byteLength(frame);
    c.queued += bytes;
    c.res.write(frame, () => {
      c.queued -= bytes;
    });
  };

  const push = (event: LoopEvent): void => {
    // Redaction happens HERE, at the bus→wire boundary, so it covers every consumer of the
    // stream. Previously redact() ran only in SessionLog, which meant the live stream leaked
    // strictly more than the file on disk — tool args, shell stdout and file contents went to
    // the browser unscrubbed and were retained in the replay ring.
    const safe = redact(event);
    const id = nextEventId++;
    const frame = `id: ${id}\ndata: ${JSON.stringify(safe)}\n\n`;
    const bytes = Buffer.byteLength(frame);

    replay.push({ id, event: safe, bytes });
    replayBytes += bytes;
    while (replay.length > REPLAY_BUFFER || (replayBytes > REPLAY_MAX_BYTES && replay.length > 1)) {
      const dropped = replay.shift();
      if (!dropped) break;
      replayBytes -= dropped.bytes;
      evicted++;
    }

    for (const c of clients.values()) writeTo(c, frame);
  };

  const flush = (): void => {
    if (flushTimer) clearTimeout(flushTimer);
    flushTimer = undefined;
    for (const p of pending.values()) {
      push({ type: 'shell_output', callId: p.callId, stream: p.stream, chunk: p.chunk });
    }
    pending.clear();
  };

  const unsubscribe = opts.bus.on((e) => {
    if (e.type === 'shell_output') {
      const key = `${e.callId}:${e.stream}`;
      const cur = pending.get(key);
      if (cur) cur.chunk += e.chunk;
      else pending.set(key, { callId: e.callId, stream: e.stream, chunk: e.chunk });
      // Early flush keeps one window from becoming an unbounded frame.
      const held = pending.get(key);
      if (held && held.chunk.length >= COALESCE_MAX_BYTES) {
        flush();
        return;
      }
      if (!flushTimer) flushTimer = setTimeout(flush, COALESCE_MS);
      return;
    }
    // Anything else is ordered relative to shell output, so drain first.
    if (pending.size) flush();
    push(e);
  });

  return {
    attach(res: ServerResponse, after?: number): () => void {
      // Tell EventSource how long to wait before reconnecting; the default varies by browser.
      res.write(`retry: ${SSE_RETRY_MS}\n\n`);
      res.write(': connected\n\n');

      // Replay anything missed across a reconnect, so a dropped stream never loses a turn.
      if (after !== undefined && Number.isFinite(after) && after > 0) {
        for (const r of replay) {
          if (r.id > after) res.write(`id: ${r.id}\ndata: ${JSON.stringify(r.event)}\n\n`);
        }
      }

      const id = opts.allocClientId();
      clients.set(id, { id, res, queued: 0, dropped: 0 });
      let detached = false;
      return () => {
        if (detached) return;
        detached = true;
        clients.delete(id);
      };
    },

    transcript(): TranscriptSnapshot {
      return {
        events: replay.map((r) => ({ id: r.id, event: r.event })),
        lastEventId: nextEventId - 1,
        truncated: evicted > 0,
        evicted,
      };
    },

    ping(): void {
      const frame = `: ping ${Date.now()}\n\n`;
      for (const c of clients.values()) writeTo(c, frame);
    },

    clientCount(): number {
      return clients.size;
    },

    close(): void {
      if (closed) return;
      closed = true;
      unsubscribe();
      if (flushTimer) clearTimeout(flushTimer);
      for (const c of clients.values()) c.res.end();
      clients.clear();
    },
  };
}
