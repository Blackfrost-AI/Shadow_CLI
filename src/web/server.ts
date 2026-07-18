import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { randomBytes } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import type { EventBus, LoopEvent } from '../agent/events.js';
import { authorizeRequest, SEC_HEADERS } from './security.js';

/**
 * Shadow's loopback web server: one process, one port, same origin for assets and the
 * live event stream. Every request passes `authorizeRequest` (Host, then Origin, then
 * token) before it reaches a route — see `security.ts` for why Host comes first.
 *
 * Nothing here reaches the network. The only socket is the loopback listener.
 */

/** Events are buffered so a browser that reconnects doesn't lose the turn in progress. */
const REPLAY_BUFFER = 500;

/**
 * `shell_output` arrives per-chunk and can be thousands of events a second. Coalescing on
 * a short timer keeps a long build from starving the stream — without it the SSE writer
 * becomes the bottleneck and the UI falls behind the loop.
 */
const COALESCE_MS = 50;

export interface WebServerHandle {
  url: string;
  port: number;
  token: string;
  close: () => Promise<void>;
  /** Live subscriber count — used by tests and by the approval gate's disconnect path. */
  clients: () => number;
}

export interface WebServerOptions {
  bus: EventBus;
  /** 0 picks a free port. */
  port?: number;
  /** Serves this as `GET /`. Phase 5 replaces the placeholder with the real UI. */
  page?: (token: string) => string;
}

interface Client {
  id: number;
  res: ServerResponse;
}

export function startWebServer(opts: WebServerOptions): Promise<WebServerHandle> {
  const token = randomBytes(24).toString('base64url');
  const clients = new Map<number, Client>();
  const replay: Array<{ id: number; event: LoopEvent }> = [];
  let nextClientId = 1;
  let nextEventId = 1;

  // --- shell_output coalescing -----------------------------------------------------
  const pending = new Map<string, { callId: string; stream: 'stdout' | 'stderr'; chunk: string }>();
  let flushTimer: ReturnType<typeof setTimeout> | undefined;

  const push = (event: LoopEvent): void => {
    const id = nextEventId++;
    replay.push({ id, event });
    if (replay.length > REPLAY_BUFFER) replay.shift();
    const frame = `id: ${id}\ndata: ${JSON.stringify(event)}\n\n`;
    for (const c of clients.values()) c.res.write(frame);
  };

  const flush = (): void => {
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
      if (!flushTimer) flushTimer = setTimeout(flush, COALESCE_MS);
      return;
    }
    // Anything else is ordered relative to shell output, so drain first.
    if (pending.size) {
      if (flushTimer) clearTimeout(flushTimer);
      flush();
    }
    push(e);
  });

  // --- routes ----------------------------------------------------------------------
  const handle = (req: IncomingMessage, res: ServerResponse, port: number): void => {
    const auth = authorizeRequest({ headers: req.headers, url: req.url }, { port, token });
    if (!auth.ok) {
      res.writeHead(auth.status, { 'Content-Type': 'application/json', ...SEC_HEADERS });
      res.end(JSON.stringify({ error: auth.error }));
      return;
    }

    const path = (req.url ?? '/').split('?')[0];

    if (req.method === 'GET' && path === '/events') {
      res.writeHead(200, {
        'Content-Type': 'text/event-stream',
        Connection: 'keep-alive',
        ...SEC_HEADERS,
      });
      res.write(': connected\n\n');

      // Replay anything missed across a reconnect, so a dropped stream never loses a turn.
      const lastRaw = req.headers['last-event-id'];
      const last = Number(Array.isArray(lastRaw) ? lastRaw[0] : lastRaw);
      if (Number.isFinite(last) && last > 0) {
        for (const r of replay) {
          if (r.id > last) res.write(`id: ${r.id}\ndata: ${JSON.stringify(r.event)}\n\n`);
        }
      }

      const id = nextClientId++;
      clients.set(id, { id, res });
      req.on('close', () => clients.delete(id));
      return;
    }

    if (req.method === 'GET' && path === '/') {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', ...SEC_HEADERS });
      res.end((opts.page ?? placeholderPage)(token));
      return;
    }

    if (req.method === 'GET' && path === '/health') {
      res.writeHead(200, { 'Content-Type': 'application/json', ...SEC_HEADERS });
      res.end(JSON.stringify({ ok: true, clients: clients.size }));
      return;
    }

    res.writeHead(404, SEC_HEADERS);
    res.end();
  };

  return new Promise<WebServerHandle>((resolve, reject) => {
    let server: Server;
    const onError = (e: Error): void => reject(e);
    server = createServer((req, res) => {
      const addr = server.address() as AddressInfo | null;
      handle(req, res, addr?.port ?? 0);
    });
    server.on('error', onError);
    server.listen(opts.port ?? 0, '127.0.0.1', () => {
      server.off('error', onError);
      const port = (server.address() as AddressInfo).port;
      resolve({
        url: `http://127.0.0.1:${port}/?t=${token}`,
        port,
        token,
        clients: () => clients.size,
        close: () =>
          new Promise<void>((done) => {
            unsubscribe();
            if (flushTimer) clearTimeout(flushTimer);
            for (const c of clients.values()) c.res.end();
            clients.clear();
            server.close(() => done());
          }),
      });
    });
  });
}

/** Minimal stand-in until phase 5 ships the real UI; proves the stream end to end. */
function placeholderPage(token: string): string {
  return `<!doctype html><meta charset="utf-8"><title>Shadow</title>
<style>body{background:#0b0b0c;color:#d8d8d8;font:13px ui-monospace,monospace;margin:0;padding:16px}
h1{font-size:13px;color:#888;font-weight:normal;margin:0 0 12px}#log{white-space:pre-wrap}</style>
<h1>shadow web — event stream</h1><div id="log"></div>
<script>
var log=document.getElementById('log');
var es=new EventSource('/events?t='+${JSON.stringify(token)});
es.onmessage=function(m){var e=JSON.parse(m.data);
 log.textContent+=e.type+' '+(e.delta||e.text||e.message||'')+'\\n';};
es.onerror=function(){log.textContent+='[stream closed]\\n';};
</script>`;
}
