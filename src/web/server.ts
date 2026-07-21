import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { randomBytes } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import type { EventBus } from '../agent/events.js';
import type { AutonomyLevel } from '../safety/permissions.js';
import { registerSecret } from '../util/redact.js';
import { authorizeRequest, isPublicPath, SEC_HEADERS } from './security.js';
import { createApiRouter } from './router.js';
import { readAsset, shellPage, contentTypeFor } from './assets.js';
import { createSessionRegistry, CLI_SESSION_ID } from './registry.js';
import { makeAgentBuilder } from './sessionAgent.js';
import { makeTurnRunner } from './runTurn.js';
import { INSTALL_DIR } from '../installDir.js';
import { loadConfig } from '../config.js';

/**
 * Shadow's loopback web server: one process, one port, same origin for assets and the
 * live event stream. Every request passes `authorizeRequest` (Host, then Origin, then
 * token) before it reaches a route — see `security.ts` for why Host comes first.
 *
 * Nothing here reaches the network. The only socket is the loopback listener.
 */

/** Keepalive: a comment frame keeps intermediaries from idling the connection out, and surfaces
 *  a dead peer as a write error rather than silence. Drives every session's stream.ping(). */
const HEARTBEAT_MS = 15_000;

export interface WebServerHandle {
  url: string;
  port: number;
  token: string;
  close: () => Promise<void>;
  /** Live subscriber count — used by tests and by the approval gate's disconnect path. */
  clients: () => number;
}

export interface WebServerOptions {
  /**
   * The live session's bus. STAYS required (every call site and every web-server test passes it),
   * and it becomes the reserved 'cli' session's bus in the registry.
   */
  bus: EventBus;
  /** 0 picks a free port. */
  port?: number;
  /** Serves this as `GET /`. Phase 5 replaces the placeholder with the real UI. */
  page?: (token: string) => string;
  /** Workspace the API acts on. Defaults to process.cwd() — where `shadow web` was run. */
  workspaceRoot?: string;
  /**
   * Present under `shadow --web`: the reserved session is a live TERMINAL mirror. Its model and
   * autonomy are read LIVE (they track /model and always-approval), and getAbort exposes the
   * terminal's turn controller so the browser can interrupt (wired in C5). Absent under
   * standalone `shadow web`, where the reserved session is an inert 'local' placeholder.
   */
  mirror?: {
    model: () => string;
    autonomy: () => AutonomyLevel;
    getAbort?: () => AbortController | null;
  };
}

export function startWebServer(opts: WebServerOptions): Promise<WebServerHandle> {
  const token = randomBytes(24).toString('base64url');
  // The token is a live credential. Register it so redact() scrubs it from anything the
  // agent might read back — tool output, surfaced errors, the session log.
  registerSecret(token);

  const workspaceRoot = opts.workspaceRoot ?? process.cwd();

  // Snapshot the config at boot (§8 Q3): the lazy agent builder uses THIS for mcpServers + model
  // presets, never a fresh disk reload, so a POST /api/mcp between boot and a first prompt cannot
  // inject a spawn command into a web build. The allowlist (resolveJail) is still read fresh.
  const bootConfig = loadConfig(workspaceRoot);

  // The session registry, constructed per server (NOT module-level — two servers in one process
  // must not share it; test/web-server.test.ts:270 guards this). The reserved 'cli' session wraps
  // opts.bus and is seeded below with NO boot-time emit, so the fragile Last-Event-ID replay test
  // (web-server.test.ts:142) — which assumes ids start at 1 — stays green. No route reaches the
  // builder/runTurn until C7 (POST /chat).
  const registry = createSessionRegistry({
    builder: makeAgentBuilder({ bootConfig, installDir: INSTALL_DIR }),
    runTurn: makeTurnRunner(),
  });
  registry.attachReserved({
    bus: opts.bus,
    displayPath: workspaceRoot,
    origin: opts.mirror ? 'mirror' : 'local',
    model: opts.mirror?.model,
    autonomy: opts.mirror?.autonomy,
    getAbort: opts.mirror?.getAbort,
  });

  // One dispatcher per server, holding this server's context — not a module-level array.
  const dispatchApi = createApiRouter({ workspaceRoot, registry });

  // One server-wide heartbeat drives EVERY session's stream.ping(). Never hold the process open for it.
  const heartbeat = setInterval(() => registry.each((s) => s.stream.ping()), HEARTBEAT_MS);
  heartbeat.unref?.();

  // --- routes ----------------------------------------------------------------------
  const handle = async (req: IncomingMessage, res: ServerResponse, port: number): Promise<void> => {
    // Parse with the WHATWG URL rather than split('?')[0] so the path used for auth is the same
    // NORMALIZED string the router dispatches on: `/assets/%2e%2e/api/state` collapses to
    // `/api/state` (→ token required, not a public asset), and `//host/api/state` dispatches
    // instead of 404ing. isPublicPath and every route branch below read this one `path`.
    const url = new URL(req.url ?? '/', 'http://127.0.0.1');
    const path = url.pathname;

    // Host and Origin are enforced on every path; only the inert /assets/* tree skips the
    // token (see AuthOptions.requireToken — module imports cannot carry one).
    const auth = authorizeRequest(
      { headers: req.headers, url: req.url },
      { port, token },
      { requireToken: !isPublicPath(req.method, path) },
    );
    if (!auth.ok) {
      res.writeHead(auth.status, { 'Content-Type': 'application/json', ...SEC_HEADERS });
      res.end(JSON.stringify({ error: auth.error }));
      return;
    }

    // Which session? `?session=<id>` selects one; bare requests resolve to the reserved 'cli'
    // mirror. `.get()` returns the FIRST value, so a split-parsed `?session=a&session=b` takes a.
    const sessionId = url.searchParams.get('session') || CLI_SESSION_ID;

    // The recent transcript, so a fresh page load (or an F5 mid-turn) renders history
    // instead of a blank console. Same buffer the SSE replay ring holds.
    if (req.method === 'GET' && path === '/api/transcript') {
      const session = registry.get(sessionId);
      if (!session) {
        res.writeHead(404, { 'Content-Type': 'application/json', ...SEC_HEADERS });
        res.end(JSON.stringify({ error: 'unknown session' }));
        return;
      }
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', ...SEC_HEADERS });
      res.end(JSON.stringify(session.stream.transcript()));
      return;
    }

    if (req.method === 'GET' && path === '/events') {
      const session = registry.get(sessionId);
      if (!session) {
        res.writeHead(404, { 'Content-Type': 'application/json', ...SEC_HEADERS });
        res.end(JSON.stringify({ error: 'unknown session' }));
        return;
      }
      res.writeHead(200, {
        'Content-Type': 'text/event-stream',
        Connection: 'keep-alive',
        ...SEC_HEADERS,
      });
      // Resume point precedence: the Last-Event-ID header only exists on an EventSource
      // auto-reconnect and is strictly fresher than a client-supplied ?after=. The stream
      // writes the SSE body (retry / ': connected' / replay); the security headers above are
      // ours to own.
      const lastRaw = req.headers['last-event-id'];
      const lastHeader = Number(Array.isArray(lastRaw) ? lastRaw[0] : lastRaw);
      const afterParam = Number(url.searchParams.get('after'));
      const after =
        Number.isFinite(lastHeader) && lastHeader > 0
          ? lastHeader
          : Number.isFinite(afterParam) && afterParam > 0
            ? afterParam
            : undefined;

      const detach = session.stream.attach(res, after);
      req.on('close', detach);
      return;
    }

    // --- API ----------------------------------------------------------------------
    // dispatchApi handles every /api/* path; requests here have already passed auth.
    if (path.startsWith('/api/')) {
      const method = req.method ?? 'GET';
      const resp = await dispatchApi(method, path, req, res);
      if (resp) {
        const headers: Record<string, string> = { ...SEC_HEADERS, ...(resp.headers ?? {}) };
        if (resp.body !== undefined) headers['Content-Type'] = 'application/json; charset=utf-8';
        res.writeHead(resp.status, headers);
        res.end(resp.body === undefined ? '' : JSON.stringify(resp.body));
        return;
      }
      res.writeHead(404, { 'Content-Type': 'application/json', ...SEC_HEADERS });
      res.end(JSON.stringify({ error: 'not found' }));
      return;
    }

    // --- static assets (JS/CSS served from codegen'd map or on-disk dev tree) ----
    if (req.method === 'GET' && path.startsWith('/assets/')) {
      const name = path.slice('/assets/'.length);
      const body = readAsset(name);
      if (body === null) {
        res.writeHead(404, SEC_HEADERS);
        res.end();
        return;
      }
      res.writeHead(200, {
        'Content-Type': contentTypeFor(name),
        'Cache-Control': 'no-cache',
        ...SEC_HEADERS,
      });
      res.end(body);
      return;
    }

    if (req.method === 'GET' && path === '/') {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', ...SEC_HEADERS });
      res.end(opts.page ? opts.page(token) : shellPage());
      return;
    }

    if (req.method === 'GET' && path === '/health') {
      res.writeHead(200, { 'Content-Type': 'application/json', ...SEC_HEADERS });
      res.end(JSON.stringify({ ok: true, clients: registry.totalClients() }));
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
      // handle() is async; a rejected promise must not become an unhandled rejection.
      void handle(req, res, addr?.port ?? 0).catch((e: unknown) => {
        const message = e instanceof Error ? e.message : String(e);
        try {
          res.writeHead(500, { 'Content-Type': 'application/json', ...SEC_HEADERS });
          res.end(JSON.stringify({ error: message }));
        } catch {
          // socket already gone
        }
      });
    });
    server.on('error', onError);
    server.listen(opts.port ?? 0, '127.0.0.1', () => {
      server.off('error', onError);
      const port = (server.address() as AddressInfo).port;
      resolve({
        // Fragment form: `#t=` is never sent to the server, so the token stays out of access
        // logs, and app.js scrubs it from the address bar on boot. `?t=` still works for curl.
        url: `http://127.0.0.1:${port}/#t=${token}`,
        port,
        token,
        clients: () => registry.totalClients(),
        close: () =>
          new Promise<void>((done) => {
            clearInterval(heartbeat);
            void registry.closeAll().then(() => server.close(() => done()));
          }),
      });
    });
  });
}

