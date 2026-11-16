#!/usr/bin/env node
/**
 * shadow-relay — expose the loopback-only Shadow web console on ONE WireGuard address.
 *
 * Shadow's web server binds 127.0.0.1 and rejects any non-loopback Host header by design
 * (src/web/security.ts). This relay is the narrow, auditable bridge for the phone companion:
 *
 *   phone ──WG──▶ <RELAY_BIND>:<RELAY_PORT> ──▶ 127.0.0.1:<UPSTREAM_PORT>
 *
 * - Binds ONLY the given WireGuard address. Never 0.0.0.0, never a fallback: if the interface
 *   is down the bind throws EADDRNOTAVAIL and the process exits loudly.
 * - Rewrites Host to the literal loopback authority so the server's DNS-rebinding gate passes.
 *   Everything else (Authorization, Last-Event-ID, ?token= for SSE) is forwarded verbatim.
 * - Pipes bodies unbuffered in both directions — SSE frames stream through frame-by-frame.
 * - requestTimeout = 0: Node's 300 s default would guillotine every long-lived /events stream.
 * - No auth logic of its own; the server's bearer-token gate is the only credential check.
 * - Logs method + path (query string STRIPPED — it can carry ?token=) + status. Never headers,
 *   never bodies.
 *
 * Usage:
 *   RELAY_BIND=<your-wg-address> RELAY_PORT=8790 UPSTREAM_PORT=8790 node scripts/shadow-relay.mjs
 * or:
 *   node scripts/shadow-relay.mjs --bind <your-wg-address> --port 8790 --upstream-port 8790
 */
import http from 'node:http';
import { networkInterfaces } from 'node:os';

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--bind') out.bind = argv[++i];
    else if (a === '--port') out.port = argv[++i];
    else if (a === '--upstream-port') out.upstreamPort = argv[++i];
    else if (a === '--upstream-host') out.upstreamHost = argv[++i];
    else throw new Error(`Unknown option: ${a}`);
  }
  return out;
}

const args = parseArgs(process.argv.slice(2));
const BIND = args.bind ?? process.env.RELAY_BIND;
const PORT = Number(args.port ?? process.env.RELAY_PORT ?? 8790);
const UPSTREAM_HOST = args.upstreamHost ?? process.env.UPSTREAM_HOST ?? '127.0.0.1';
const UPSTREAM_PORT = Number(args.upstreamPort ?? process.env.UPSTREAM_PORT ?? PORT);

function die(msg) {
  process.stderr.write(`shadow-relay: ${msg}\n`);
  process.exit(1);
}

if (!BIND) die('RELAY_BIND (or --bind) is required — the WireGuard address to listen on. Refusing to guess.');
if (BIND === '0.0.0.0' || BIND === '::' || BIND === '*') die('refusing to bind a wildcard address; name the WireGuard IP explicitly.');
if (!Number.isInteger(PORT) || PORT < 1 || PORT > 65535) die(`invalid RELAY_PORT: ${PORT}`);
if (!Number.isInteger(UPSTREAM_PORT) || UPSTREAM_PORT < 1 || UPSTREAM_PORT > 65535) die(`invalid UPSTREAM_PORT: ${UPSTREAM_PORT}`);
if (UPSTREAM_HOST !== '127.0.0.1' && UPSTREAM_HOST !== 'localhost' && UPSTREAM_HOST !== '::1') {
  die(`upstream must be loopback (got ${UPSTREAM_HOST}); this relay bridges WG → the local console, nothing else.`);
}

// Fail BEFORE listening if the address is not on this host — a typo must not look like a
// running relay. (The bind itself is still the authoritative check; this just errs earlier.)
const localAddrs = new Set(
  Object.values(networkInterfaces()).flat().filter(Boolean).map((a) => a.address),
);
if (!localAddrs.has(BIND)) {
  die(`${BIND} is not assigned to any local interface. Is the WireGuard tunnel up? (ifconfig | grep ${BIND})`);
}

const upstreamAuthority = `${UPSTREAM_HOST}:${UPSTREAM_PORT}`;

const server = http.createServer((req, res) => {
  const pathOnly = (req.url ?? '/').split('?')[0]; // query may carry ?token= — never log it
  const headers = { ...req.headers, host: upstreamAuthority };
  // A browser Origin would fail the server's origin gate; the native client sends none.
  // Forward what arrived — do not forge.

  const upstream = http.request(
    {
      host: UPSTREAM_HOST,
      port: UPSTREAM_PORT,
      method: req.method,
      path: req.url,
      headers,
    },
    (up) => {
      res.writeHead(up.statusCode ?? 502, up.headers);
      up.pipe(res); // unbuffered: SSE frames flow through as they arrive
      up.on('error', () => res.destroy());
      process.stdout.write(`${req.method} ${pathOnly} → ${up.statusCode}\n`);
    },
  );

  upstream.on('error', (err) => {
    process.stderr.write(`${req.method} ${pathOnly} → upstream error: ${err.code ?? err.message}\n`);
    if (!res.headersSent) {
      res.writeHead(502, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'shadow web upstream unreachable' }));
    } else {
      res.destroy();
    }
  });

  // Client went away (phone locked, app backgrounded): tear down the upstream so the server
  // detaches the SSE client promptly (its approval transport-gone timer depends on this).
  res.on('close', () => upstream.destroy());
  req.on('error', () => upstream.destroy());
  req.pipe(upstream);
});

// Long-lived SSE: no request timeout, no idle socket timeout, no header guillotine mid-stream.
server.requestTimeout = 0;
server.headersTimeout = 0;
server.timeout = 0;
server.keepAliveTimeout = 5_000;
// Streams are cheap file descriptors, not CPU: allow plenty of concurrent sessions.
server.maxRequestsPerSocket = 0;

server.on('error', (err) => {
  die(`listen ${BIND}:${PORT} failed: ${err.code ?? err.message} — no fallback bind, exiting.`);
});

server.listen(PORT, BIND, () => {
  process.stdout.write(`shadow-relay listening on http://${BIND}:${PORT} → http://${upstreamAuthority}\n`);
});

const stop = () => {
  server.close(() => process.exit(0));
  // Destroy open SSE sockets so close() can finish.
  server.closeAllConnections?.();
  setTimeout(() => process.exit(0), 1_500).unref();
};
process.on('SIGINT', stop);
process.on('SIGTERM', stop);