import test from 'node:test';
import assert from 'node:assert/strict';
import { request, createServer, type Server } from 'node:http';
import { rmSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { isolateHome, assertStoreIsolated } from './helpers/isolateHome.js';

/**
 * The endpoint-harness API (src/web/api/endpoints.ts). Same isolation discipline as
 * web-models.test.ts: HOME is redirected BEFORE any module that derives GLOBAL_DIR from homedir()
 * is imported, so the store (and the endpoints config it writes) lands in a throwaway home.
 *
 * Every probe target is a local node:http fixture on 127.0.0.1:0 — these tests NEVER touch the real
 * network and NEVER use a private/WireGuard address. The LAN-scan subnet derivation is unit-tested
 * through lanSubnets()'s injectable interface map (no sockets at all).
 *
 * Run with `npm test` (node --import tsx/esm --test). NEVER `bun test` — it ignores process.env.HOME
 * and would point the store at the real ~/.shadow.
 */

const { home: HOME, shadowDir: SHADOW } = isolateHome('web-endpoints');
process.env.PATH = ''; // no keychain backend
delete process.env.SHADOW_VAULT_PASSWORD;

const { EventBus } = await import('../src/agent/events.js');
const { startWebServer } = await import('../src/web/server.js');
const store = await import('../src/state/globalStore.js');
const endpoints = await import('../src/web/api/endpoints.js');
import type { WebServerHandle } from '../src/web/server.js';

assertStoreIsolated(store.GLOBAL_DIR, HOME);

const CONFIG = join(SHADOW, 'config.json');

// ── local fixture server (path-routed; stands in for every kind of endpoint) ──────

let fixture: Server;
let PORT = 0;

function startFixture(): Promise<number> {
  return new Promise((resolve) => {
    const srv = createServer((req, res) => {
      const url = req.url || '/';
      const auth = req.headers['authorization'];
      const json = (obj: unknown, headers: Record<string, string> = {}) => {
        res.writeHead(200, { 'content-type': 'application/json', ...headers });
        res.end(JSON.stringify(obj));
      };
      // Root: a vLLM-style box. owned_by is authoritative even though the HTTP server header is a
      // generic 'uvicorn' — the probe must report 'vllm', not 'uvicorn'.
      if (url === '/v1/models') {
        return json(
          { data: [{ id: 'qwen', owned_by: 'vllm', max_model_len: 262144 }, { id: 'llama3', owned_by: 'vllm' }] },
          { server: 'uvicorn' },
        );
      }
      // /fb: no /v1/models, but a bare /models list (fallback path).
      if (url === '/fb/v1/models') { res.writeHead(404); return res.end(); }
      if (url === '/fb/models') return json({ data: [{ id: 'fallback-model' }] });
      // /ho: only a plain-text /health (reachability with no model list).
      if (url === '/ho/v1/models' || url === '/ho/models') { res.writeHead(404); return res.end(); }
      if (url === '/ho/health') { res.writeHead(200, { 'content-type': 'text/plain' }); return res.end('ok'); }
      // /auth: 401 unless a Bearer token is present.
      if (url.startsWith('/auth/')) {
        if (typeof auth === 'string' && auth.startsWith('Bearer ')) return json({ data: [{ id: 'secure-model', owned_by: 'vllm' }] });
        res.writeHead(401);
        return res.end();
      }
      // /slow: answers after 2s (so a 500ms probe budget times out).
      if (url.startsWith('/slow/')) { setTimeout(() => json({ data: [{ id: 'late' }] }), 2000); return; }
      // /redir: every path 302s — redirects must NOT be followed.
      if (url.startsWith('/redir/')) { res.writeHead(302, { location: '/redir/models' }); return res.end(); }
      res.writeHead(404);
      res.end();
    });
    srv.listen(0, '127.0.0.1', () => {
      const addr = srv.address();
      resolve(typeof addr === 'object' && addr ? addr.port : 0);
    });
    fixture = srv;
  });
}

/** A port guaranteed (for the moment) to have nothing listening. */
async function closedPort(): Promise<number> {
  const s = createServer();
  await new Promise<void>((r) => s.listen(0, '127.0.0.1', () => r()));
  const addr = s.address();
  const p = typeof addr === 'object' && addr ? addr.port : 0;
  await new Promise<void>((r) => s.close(() => r()));
  return p;
}

test.before(async () => {
  PORT = await startFixture();
});

test.after(() => {
  try { fixture?.close(); } catch { /* already closed */ }
  rmSync(HOME, { recursive: true, force: true });
});

// ── HTTP helpers (copied discipline from web-models.test.ts) ──────────────────────

function raw(
  port: number,
  method: string,
  path: string,
  headers: Record<string, string>,
  body?: string,
): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const req = request({ host: '127.0.0.1', port, path, method, headers }, (res) => {
      let b = '';
      res.on('data', (c) => (b += c));
      res.on('end', () => resolve({ status: res.statusCode ?? 0, body: b }));
    });
    req.on('error', reject);
    if (body !== undefined) req.write(body);
    req.end();
  });
}

async function withServer(fn: (h: WebServerHandle) => Promise<void>): Promise<void> {
  const bus = new EventBus();
  const h = await startWebServer({ bus });
  try {
    await fn(h);
  } finally {
    await h.close();
  }
}

const auth = (h: WebServerHandle, contentType?: string): Record<string, string> => {
  const hdrs: Record<string, string> = {
    host: `127.0.0.1:${h.port}`,
    authorization: `Bearer ${h.token}`,
  };
  if (contentType) hdrs['content-type'] = contentType;
  return hdrs;
};

const post = (h: WebServerHandle, path: string, body: unknown) =>
  raw(h.port, 'POST', path, auth(h, 'application/json'), JSON.stringify(body));

function seed(models: unknown[]): void {
  store.saveGlobalConfig({ provider: 'openai', model: 'glm-5.2', models });
}

// ── probe: success + fallbacks + typed failures ──────────────────────────────────

test('probe success reports latency, served models, owned_by backend, and per-model context window', async () => {
  seed([]);
  await withServer(async (h) => {
    const r = await post(h, '/api/endpoints/probe', { baseUrl: `http://127.0.0.1:${PORT}` });
    assert.equal(r.status, 200);
    const b = JSON.parse(r.body);
    assert.equal(b.ok, true);
    assert.equal(b.reached, '/v1/models');
    assert.equal(b.server, 'vllm'); // owned_by, NOT the generic 'uvicorn' header
    assert.equal(b.serverHeader, 'uvicorn');
    assert.deepEqual(b.servedModels, ['qwen', 'llama3']);
    assert.equal(typeof b.latencyMs, 'number');
    const qwen = (b.models as Array<{ id: string; contextWindow?: number }>).find((m) => m.id === 'qwen');
    assert.equal(qwen?.contextWindow, 262144);
  });
});

test('probe falls back to /models when /v1/models is 404', async () => {
  seed([]);
  await withServer(async (h) => {
    const r = await post(h, '/api/endpoints/probe', { baseUrl: `http://127.0.0.1:${PORT}/fb` });
    const b = JSON.parse(r.body);
    assert.equal(b.ok, true);
    assert.equal(b.reached, '/models');
    assert.deepEqual(b.servedModels, ['fallback-model']);
  });
});

test('probe falls back to /health (reachable, no model list)', async () => {
  seed([]);
  await withServer(async (h) => {
    const r = await post(h, '/api/endpoints/probe', { baseUrl: `http://127.0.0.1:${PORT}/ho` });
    const b = JSON.parse(r.body);
    assert.equal(b.ok, true);
    assert.equal(b.reached, '/health');
    assert.deepEqual(b.servedModels, []);
  });
});

test('probe of a closed port is ok:false with a typed error — HTTP 200, no throw', async () => {
  seed([]);
  const dead = await closedPort();
  await withServer(async (h) => {
    const r = await post(h, '/api/endpoints/probe', { baseUrl: `http://127.0.0.1:${dead}/v1` });
    assert.equal(r.status, 200); // a probe ran = data, even on failure
    const b = JSON.parse(r.body);
    assert.equal(b.ok, false);
    assert.equal(b.errorKind, 'refused');
    assert.ok(typeof b.error === 'string' && b.error.length > 0);
  });
});

test('probe honours a short timeout budget (slow fixture → errorKind timeout)', async () => {
  seed([]);
  await withServer(async (h) => {
    const r = await post(h, '/api/endpoints/probe', { baseUrl: `http://127.0.0.1:${PORT}/slow`, timeoutMs: 500 });
    const b = JSON.parse(r.body);
    assert.equal(b.ok, false);
    assert.equal(b.errorKind, 'timeout');
  });
});

test('a silent origin early-outs after ONE candidate path — dead hosts cost one timeout, not three', async () => {
  // The /slow fixture delays every path. Without the cascade early-out this probe would burn
  // 3 × 400ms (one per candidate path); with it, the first timeout proves the origin silent and
  // the probe returns. This is what keeps the LAN scan inside its 8s deadline.
  seed([]);
  await withServer(async (h) => {
    const t0 = Date.now();
    const r = await post(h, '/api/endpoints/probe', { baseUrl: `http://127.0.0.1:${PORT}/slow`, timeoutMs: 400 });
    const elapsed = Date.now() - t0;
    const b = JSON.parse(r.body);
    assert.equal(b.ok, false);
    assert.equal(b.errorKind, 'timeout');
    assert.ok(elapsed < 1000, `expected a single-path early-out (<1000ms), took ${elapsed}ms`);
  });
});

test('probe rejects a non-http(s) scheme with 400', async () => {
  seed([]);
  await withServer(async (h) => {
    for (const bad of ['file:///etc/passwd', 'ftp://127.0.0.1/x', 'not a url']) {
      const r = await post(h, '/api/endpoints/probe', { baseUrl: bad });
      assert.equal(r.status, 400, `expected 400 for ${bad}`);
      assert.equal(JSON.parse(r.body).errorKind, 'invalid-url');
    }
  });
});

test('probe does not follow a redirect', async () => {
  seed([]);
  await withServer(async (h) => {
    const r = await post(h, '/api/endpoints/probe', { baseUrl: `http://127.0.0.1:${PORT}/redir` });
    const b = JSON.parse(r.body);
    assert.equal(b.ok, false);
    assert.equal(b.errorKind, 'redirect');
  });
});

test('probe of an auth-gated endpoint without a key → auth-required', async () => {
  seed([]);
  await withServer(async (h) => {
    const r = await post(h, '/api/endpoints/probe', { baseUrl: `http://127.0.0.1:${PORT}/auth` });
    const b = JSON.parse(r.body);
    assert.equal(b.ok, false);
    assert.equal(b.errorKind, 'auth-required');
    assert.equal(b.status, 401);
  });
});

// ── probe-preset: credential resolved server-side, never serialized ──────────────

test('probe-preset uses an inline key server-side and NEVER leaks it', async () => {
  seed([{ label: 'Secretive', provider: 'openai', model: 'x', baseUrl: `http://127.0.0.1:${PORT}/auth`, apiKey: 'sk-SECRET-bbb' }]);
  await withServer(async (h) => {
    const r = await post(h, '/api/endpoints/probe-preset', { label: 'Secretive' });
    assert.equal(r.status, 200);
    const b = JSON.parse(r.body);
    assert.equal(b.ok, true); // the key authenticated against the fixture
    assert.deepEqual(b.servedModels, ['secure-model']);
    // The whole point: no secret material on the wire.
    assert.doesNotMatch(r.body, /sk-SECRET/);
    assert.doesNotMatch(r.body, /Bearer/);
  });
});

test('probe-preset with a locked-vault credRef probes unauth and flags credential-unavailable', async () => {
  // credRef is a bare vault slot name (config schema: /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,63}$/).
  seed([{ label: 'Locked', provider: 'openai', model: 'x', baseUrl: `http://127.0.0.1:${PORT}`, credRef: 'locked-slot' }]);
  await withServer(async (h) => {
    const r = await post(h, '/api/endpoints/probe-preset', { label: 'Locked' });
    assert.equal(r.status, 200);
    const b = JSON.parse(r.body);
    assert.equal(b.ok, true); // the root fixture needs no auth
    assert.equal(b.note, 'credential-unavailable');
    assert.doesNotMatch(r.body, /locked-slot/); // the slot pointer doesn't cross the wire either
  });
});

test('probe-preset of an unknown label is 404', async () => {
  seed([]);
  await withServer(async (h) => {
    const r = await post(h, '/api/endpoints/probe-preset', { label: 'Ghost' });
    assert.equal(r.status, 404);
  });
});

// ── quickpicks ───────────────────────────────────────────────────────────────────

test('quickpicks lists the curated local servers', async () => {
  seed([]);
  await withServer(async (h) => {
    const r = await raw(h.port, 'GET', '/api/endpoints/quickpicks', auth(h));
    assert.equal(r.status, 200);
    const picks = JSON.parse(r.body).quickpicks as Array<{ name: string; baseUrl: string }>;
    assert.ok(picks.length >= 4);
    const names = picks.map((p) => p.name);
    for (const n of ['Ollama', 'vLLM', 'llama.cpp', 'LM Studio']) assert.ok(names.includes(n), `missing ${n}`);
    assert.ok(picks.every((p) => /^https?:\/\//.test(p.baseUrl)));
  });
});

// ── pinned "known endpoints" (permanent host, discovered port) ─────────────────────

test('pin / list / unpin a known endpoint, persisted to config without clobbering models', async () => {
  seed([{ label: 'Keeper', provider: 'openai', model: 'a' }]);
  await withServer(async (h) => {
    const pin = await post(h, '/api/endpoints/known', { host: '127.0.0.1', label: 'loopback box' });
    assert.equal(pin.status, 201);
    assert.equal(JSON.parse(pin.body).known.length, 1);

    const list = await raw(h.port, 'GET', '/api/endpoints/known', auth(h));
    const known = JSON.parse(list.body).known as Array<{ host: string; label?: string }>;
    assert.equal(known[0].host, '127.0.0.1');
    assert.equal(known[0].label, 'loopback box');

    // Persisted under endpoints.known, and the model preset survived the merge.
    const persisted = JSON.parse(readFileSync(CONFIG, 'utf8'));
    assert.equal(persisted.endpoints.known[0].host, '127.0.0.1');
    assert.equal(persisted.models.length, 1);
    assert.equal(persisted.models[0].label, 'Keeper');

    const unpin = await raw(h.port, 'DELETE', '/api/endpoints/known/127.0.0.1', auth(h));
    assert.equal(unpin.status, 200);
    assert.deepEqual(JSON.parse(unpin.body).known, []);
    assert.deepEqual(JSON.parse(readFileSync(CONFIG, 'utf8')).endpoints.known, []);
  });
});

test('pinning the same host twice is 409', async () => {
  seed([]);
  await withServer(async (h) => {
    await post(h, '/api/endpoints/known', { host: '127.0.0.2' });
    const dup = await post(h, '/api/endpoints/known', { host: '127.0.0.2' });
    assert.equal(dup.status, 409);
    await raw(h.port, 'DELETE', '/api/endpoints/known/127.0.0.2', auth(h));
  });
});

test('resolve (the doctor) finds the live port on a pinned host', async () => {
  seed([]);
  await withServer(async (h) => {
    const r = await post(h, '/api/endpoints/resolve', { host: '127.0.0.1', ports: [PORT] });
    assert.equal(r.status, 200);
    const b = JSON.parse(r.body);
    assert.equal(b.host, '127.0.0.1');
    assert.ok(Array.isArray(b.alive) && b.alive.length >= 1);
    assert.equal(b.alive[0].port, PORT);
    assert.equal(b.alive[0].server, 'vllm');
    assert.ok(b.alive[0].servedModels.includes('qwen'));
  });
});

test('resolve of a host with nothing listening returns empty alive', async () => {
  seed([]);
  const dead = await closedPort();
  await withServer(async (h) => {
    const r = await post(h, '/api/endpoints/resolve', { host: '127.0.0.1', ports: [dead], timeoutMs: 500 });
    const b = JSON.parse(r.body);
    assert.deepEqual(b.alive, []);
    assert.deepEqual(b.tried, [dead]);
  });
});

// ── LAN subnet derivation (hermetic — injected interface map, no sockets) ──────────

test('lanSubnets derives /24s from address octets, incl. a point-to-point /32 tunnel', () => {
  const synthetic = {
    en0: [{ address: '192.168.99.5', family: 'IPv4', internal: false, netmask: '255.255.255.0' }],
    utun0: [{ address: '10.50.60.70', family: 'IPv4', internal: false, netmask: '255.255.255.255' }], // WG /32
    en1: [{ address: '8.8.8.8', family: 'IPv4', internal: false }], // public → skipped
    en2: [{ address: '169.254.1.2', family: 'IPv4', internal: false }], // link-local → skipped
    lo0: [{ address: '127.0.0.1', family: 'IPv4', internal: true }], // internal → skipped
    utun1: [{ address: 'fe80::1', family: 'IPv6', internal: false }], // IPv6 → skipped
  };
  const subs = endpoints.lanSubnets(synthetic as never);
  const bases = subs.map((s) => s.base).sort();
  assert.deepEqual(bases, ['10.50.60', '192.168.99']);
  // The /32 tunnel still yields a full /24 from its octets — the netmask would have given nothing.
  const wg = subs.find((s) => s.base === '10.50.60')!;
  assert.equal(wg.cidr, '10.50.60.0/24');
  assert.equal(wg.ownIp, '10.50.60.70');
});

test('lanSubnets of a machine with no private interfaces is empty (no crash)', () => {
  const subs = endpoints.lanSubnets({
    en0: [{ address: '8.8.8.8', family: 'IPv4', internal: false }],
    lo0: [{ address: '127.0.0.1', family: 'IPv4', internal: true }],
  } as never);
  assert.deepEqual(subs, []);
});

test('interleavedHosts round-robins subnets before the cap, so truncation keeps every subnet covered', () => {
  // Live bug this pins: sequential concatenation let the first /24 eat all 256 cap slots and the
  // box on the second subnet was never probed. Interleaved, a truncated scan still reaches low
  // hosts of BOTH subnets.
  const subs = [
    { cidr: '10.0.0.0/24', base: '10.0.0', ownIp: '10.0.0.1' },
    { cidr: '10.9.9.0/24', base: '10.9.9', ownIp: '10.9.9.9' },
  ] as never;
  const { targets, truncated } = endpoints.interleavedHosts(subs, 8);
  assert.equal(truncated, true); // 253 + 253 candidates » 8
  assert.deepEqual(targets, ['10.0.0.2', '10.9.9.1', '10.0.0.3', '10.9.9.2', '10.0.0.4', '10.9.9.3', '10.0.0.5', '10.9.9.4']);
  // own IPs are excluded everywhere (10.0.0.1 skipped: first candidate is .2; 10.9.9.9 would come
  // at index 9 of its subnet — assert it never appears in a full enumeration).
  const full = endpoints.interleavedHosts(subs, 512);
  assert.equal(full.targets.includes('10.0.0.1'), false);
  assert.equal(full.targets.includes('10.9.9.9'), false);
  assert.equal(full.targets.length, 253 + 253); // .1 excluded on subnet A, .9 on subnet B
});

test('scanLan with zero private subnets is hermetic and empty', async () => {
  const res = await endpoints.scanLan({ ifaces: {} as never });
  assert.deepEqual(res.subnets, []);
  assert.deepEqual(res.results, []);
  assert.equal(res.truncated, false);
});

// ── every endpoint route is still token-gated ────────────────────────────────────

test('endpoint routes require the token', async () => {
  seed([]);
  await withServer(async (h) => {
    const hdrs = { host: `127.0.0.1:${h.port}` }; // no auth
    const ct = { ...hdrs, 'content-type': 'application/json' };
    const qp = await raw(h.port, 'GET', '/api/endpoints/quickpicks', hdrs);
    const known = await raw(h.port, 'GET', '/api/endpoints/known', hdrs);
    const probe = await raw(h.port, 'POST', '/api/endpoints/probe', ct, JSON.stringify({ baseUrl: `http://127.0.0.1:${PORT}` }));
    const scan = await raw(h.port, 'POST', '/api/endpoints/scan', ct, '{}');
    const resolve = await raw(h.port, 'POST', '/api/endpoints/resolve', ct, JSON.stringify({ host: '127.0.0.1' }));
    for (const r of [qp, known, probe, scan, resolve]) assert.equal(r.status, 401);
  });
});
