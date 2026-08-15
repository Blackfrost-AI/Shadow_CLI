import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync, appendFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  shadowFetch,
  setOfflineMode,
  isOfflineMode,
  setEgressLogPathForTests,
  flushEgressLogForTests,
  setEgressResolverForTests,
  egressSummary,
  recordEgress,
  readEgressLogAggregate,
  formatEgressReport,
  isCloudMetadataIp,
  pinnedAgent,
  pinnedAgentCacheSizeForTests,
  offlineFetchWall,
  closeAgentsForTests,
} from '../src/safety/egress.js';

const repoRoot = fileURLToPath(new URL('..', import.meta.url));

// Isolate the receipt file BEFORE anything records — tests must never touch the real ~/.shadow/egress.log.
const tmp = mkdtempSync(join(tmpdir(), 'shadow-egress-test-'));
setEgressLogPathForTests(join(tmp, 'egress.log'));

/** A loopback HTTP server — the only real socket these tests open. */
function startLocalServer(handler: (url: string) => string = (u) => `ok:${u}`): Promise<{ port: number }> {
  return new Promise((resolve) => {
    const server: Server = createServer((req, res) => {
      res.writeHead(200, { 'content-type': 'text/plain' });
      res.end(handler(req.url ?? '/'));
    });
    server.listen(0, '127.0.0.1', () => {
      servers.push({ raw: server, close: () => new Promise((r) => server.close(() => r())) });
      resolve({ port: (server.address() as AddressInfo).port });
    });
  });
}

const servers: Array<{ close: () => Promise<void>; raw: Server }> = [];
after(async () => {
  setOfflineMode(false);
  setEgressResolverForTests(null);
  await flushEgressLogForTests();
  // Kill keep-alive sockets BEFORE closing the servers, or server.close() waits on them and
  // the process hangs.
  await closeAgentsForTests();
  for (const s of servers) {
    s.raw.closeAllConnections?.();
    await s.close();
  }
  rmSync(tmp, { recursive: true, force: true });
});

function summaryFor(host: string) {
  return egressSummary().find((r) => r.host === host);
}

// ── Offline wall ──────────────────────────────────────────────────────────────

test('offline mode: shadowFetch denies non-local egress with a readable error and records the deny', async () => {
  setOfflineMode(true);
  try {
    assert.equal(isOfflineMode(), true);
    await assert.rejects(
      // Hermetic: the offline wall fires BEFORE DNS/connect — no packet leaves.
      () => shadowFetch('https://api.anthropic.com/v1/messages', { method: 'POST' }, { purpose: 'provider' }),
      /offline mode: egress to api\.anthropic\.com is blocked/,
    );
    const s = summaryFor('api.anthropic.com');
    assert.ok(s && s.denied >= 1, 'the deny must be recorded in the session aggregate');
    assert.ok(s!.purposes.has('provider'));
  } finally {
    setOfflineMode(false); // try/finally: a failing assertion must never leak offline mode onward
  }
});

test('offline mode: local hosts still pass the broker (a local serve is the point of --offline)', async () => {
  const srv = await startLocalServer();
  setOfflineMode(true);
  try {
    const res = await shadowFetch(`http://127.0.0.1:${srv.port}/ping`, {}, { purpose: 'local-probe' });
    assert.equal(res.status, 200);
    assert.equal(await res.text(), 'ok:/ping');
  } finally {
    setOfflineMode(false);
  }
});

test('offline mode: a "local" hostname is verified AFTER resolution — a spoofed *.local cannot carry traffic to a public IP', async () => {
  const srv = await startLocalServer();
  setOfflineMode(true);
  try {
    // mDNS/DNS spoofing shape: the NAME looks local, the ANSWER is public → deny, closed.
    setEgressResolverForTests(() => Promise.resolve(['203.0.113.7']));
    await assert.rejects(
      () => shadowFetch('http://exfil.attacker.local:8000/v1/messages', { method: 'POST' }, { purpose: 'provider' }),
      /verifiably-local/,
    );
    const s = summaryFor('exfil.attacker.local');
    assert.ok(s && s.denied >= 1, 'the spoofed-local deny must be recorded');

    // Same name, honest answer (loopback) → admitted and PINNED to the verified local set.
    setEgressResolverForTests(() => Promise.resolve(['127.0.0.1']));
    const res = await shadowFetch(`http://honest.local:${srv.port}/ping`, {}, { purpose: 'local-probe' });
    assert.equal(res.status, 200);
    assert.equal(await res.text(), 'ok:/ping');

    // Cloud-metadata answers are refused even where the ULA/local ranges would admit them
    // (fd00:ec2::254 sits inside fc00::/7 — the exact shape AWS IMDSv6 uses).
    setEgressResolverForTests(() => Promise.resolve(['fd00:ec2::254']));
    await assert.rejects(
      () => shadowFetch('http://sneaky.local/', {}, { purpose: 'provider' }),
      /blocked/,
    );
  } finally {
    setEgressResolverForTests(null);
    setOfflineMode(false);
  }
});

test('the Bun-binary fetch wall: offlineFetchWall refuses non-local raw fetch and passes local traffic', async () => {
  // In the Bun-compiled release binary the global fetch never consults undici's dispatcher, so
  // the wall is installed around globalThis.fetch itself. This unit-pins the wrapper semantics
  // under Node (where the dispatcher already covers global fetch).
  const calls: string[] = [];
  const stub = (async (url: string) => {
    calls.push(String(url));
    return new Response('stub');
  }) as unknown as (url: never, init?: never) => Promise<Response>;
  const walled = offlineFetchWall(stub);
  setOfflineMode(true);
  try {
    await assert.rejects(() => walled('https://example.com/x' as never), /offline mode: egress to example\.com/);
    assert.ok((summaryFor('example.com')?.denied ?? 0) >= 1, 'the fetch-wall deny must be journaled');
    assert.equal(calls.length, 0, 'the walled fetch must never reach the transport');
    await walled('http://127.0.0.1:9999/local' as never); // local host passes the wall → hits the stub
    assert.deepEqual(calls, ['http://127.0.0.1:9999/local']);
  } finally {
    setOfflineMode(false);
  }
  await walled('https://public.example/again' as never); // wall disarmed → passes through
  assert.equal(calls.length, 2);
});

test('offline mode: the dispatcher-layer wall catches egress that BYPASSES shadowFetch', async () => {
  setOfflineMode(true);
  try {
    // Raw global fetch — never touches shadowFetch(). The EgressAgent installed as the global
    // undici dispatcher must still refuse it: --offline is a hard invariant, not a per-caller
    // convention. (No packet leaves: the wall fires at dispatch time, before any socket.)
    // fetch wraps dispatcher errors as `TypeError: fetch failed` + cause — match the cause chain.
    await assert.rejects(
      () => fetch('https://example.com/'),
      (e: Error) => /offline mode|blocked/.test(`${e.message} | ${(e as { cause?: Error }).cause?.message ?? ''}`),
    );
    const s = summaryFor('example.com');
    assert.ok(s && s.denied >= 1, 'dispatcher-level denies must land in the aggregate too');
    assert.ok(s!.purposes.has('dispatch'));
  } finally {
    setOfflineMode(false);
  }
});

// ── SSRF policy tiers ─────────────────────────────────────────────────────────

test('cloud-metadata addresses are denied for EVERY origin (user-configured endpoints included)', async () => {
  assert.equal(isCloudMetadataIp('169.254.169.254'), true);
  assert.equal(isCloudMetadataIp('fd00:ec2::254'), true);
  assert.equal(isCloudMetadataIp('8.8.8.8'), false);
  // IP literal → no DNS, no connect; the metadata check fires first.
  await assert.rejects(
    () => shadowFetch('http://169.254.169.254/latest/meta-data/', {}, { purpose: 'provider', origin: 'user' }),
    /cloud-metadata/,
  );
  const s = summaryFor('169.254.169.254');
  assert.ok(s && s.denied >= 1);
});

test('the metadata check matches EVERY IPv6 spelling of the metadata addresses (verified bypass shapes)', async () => {
  // An exact-string compare was a verified bypass: WHATWG URL normalizes
  // http://[::ffff:169.254.169.254]/ to [::ffff:a9fe:a9fe], and resolvers/attackers can serve
  // any of these encodings. All embed 169.254.169.254 or spell fd00:ec2::254.
  for (const enc of [
    '::ffff:169.254.169.254', // v4-mapped, dotted tail
    '::ffff:a9fe:a9fe', // v4-mapped, hex (URL's normalized form)
    '0:0:0:0:0:ffff:a9fe:a9fe', // expanded mapped
    '64:ff9b::a9fe:a9fe', // NAT64
    '2002:a9fe:a9fe::1', // 6to4 carrying 169.254.169.254
    'fd00:ec2:0:0:0:0:0:254', // expanded IMDSv6
    'fd00:ec2::254', // compressed IMDSv6
  ]) {
    assert.equal(isCloudMetadataIp(enc), true, `${enc} must be recognized as metadata`);
  }
  for (const ok of ['::1', '127.0.0.1', '192.168.1.30', 'fd00::1', '2002:808:808::', '64:ff9b::808:808']) {
    assert.equal(isCloudMetadataIp(ok), false, `${ok} must NOT be flagged`);
  }
  // End-to-end: a configured bracketed literal reaches IMDS on dual-stack hosts without any
  // DNS involvement — the broker must refuse it before any socket.
  await assert.rejects(
    () => shadowFetch('http://[::ffff:169.254.169.254]/latest/meta-data/', {}, { purpose: 'provider', origin: 'user' }),
    /cloud-metadata/,
  );
});

test('the metadata tier FAILS CLOSED when resolution returns nothing (no unpinned egress on an unvalidated name)', async () => {
  setEgressResolverForTests(() => Promise.resolve([]));
  try {
    await assert.rejects(
      () => shadowFetch('http://gateway.internal:8080/v1', {}, { purpose: 'provider', origin: 'user' }),
      /could not be resolved|fails closed/,
    );
    const s = summaryFor('gateway.internal');
    assert.ok(s && s.denied >= 1 && s.allowed === 0, 'the fail-closed deny must be recorded, never an allow');
  } finally {
    setEgressResolverForTests(null);
  }
});

test('a poisoned resolver cannot smuggle a metadata address past user-origin egress', async () => {
  setEgressResolverForTests(() => Promise.resolve(['169.254.169.254']));
  try {
    await assert.rejects(
      () => shadowFetch('http://totally-legit.example/', {}, { purpose: 'provider', origin: 'user' }),
      /cloud-metadata/,
    );
  } finally {
    setEgressResolverForTests(null); // a failing assertion must never leave the resolver poisoned
  }
});

test('model-origin egress gets the full netguard: loopback is refused', async () => {
  const srv = await startLocalServer();
  await assert.rejects(
    () => shadowFetch(`http://127.0.0.1:${srv.port}/`, {}, { purpose: 'web', origin: 'model' }),
    /blocked address/,
  );
  const denied = summaryFor('127.0.0.1')?.denied ?? 0;
  assert.ok(denied >= 1, 'the netguard deny must be recorded');
});

// ── DNS pinning ───────────────────────────────────────────────────────────────

test('pinning uses the WHOLE validated IP set: a dead first address fails over to a live one', async () => {
  const srv = await startLocalServer();
  // Nothing listens on 127.0.0.2; the server is on 127.0.0.1. Pinning to ips[0] alone would
  // ECONNREFUSED — the set pin must fail over.
  const res = await shadowFetch(
    `http://127.0.0.1:${srv.port}/failover`,
    {},
    { purpose: 'web', pinnedIps: ['127.0.0.2', '127.0.0.1'] },
  );
  assert.equal(res.status, 200);
  assert.equal(await res.text(), 'ok:/failover');
});

test('pinned agents are cached per IP SET (order-insensitive) so keep-alive pools survive', () => {
  const a = pinnedAgent(['127.0.0.2', '127.0.0.1'], 'cache-probe.example');
  const b = pinnedAgent(['127.0.0.1', '127.0.0.2'], 'cache-probe.example');
  assert.equal(a, b, 'same set in a different order must reuse the same agent');
});

test('cross-host redirects fall back to real DNS instead of dialing the original pins', async () => {
  // Server B listens on all interfaces (any family localhost resolves to) and answers /landed.
  const { createServer: cs } = await import('node:http');
  const target: Server = cs((req, res) => {
    res.writeHead(200, { 'content-type': 'text/plain' });
    res.end(`landed:${req.url}`);
  });
  await new Promise<void>((r) => target.listen(0, () => r()));
  servers.push({ raw: target, close: () => new Promise((r) => target.close(() => r())) });
  const targetPort = (target.address() as AddressInfo).port;
  // Server A answers every path with a 302 to a DIFFERENT hostname (localhost) → different pins.
  const hop = await startLocalServer(() => '');
  const redirector: Server = cs((_req, res) => {
    res.writeHead(302, { location: `http://localhost:${targetPort}/landed` });
    res.end();
  });
  await new Promise<void>((r) => redirector.listen(0, '127.0.0.1', () => r()));
  servers.push({ raw: redirector, close: () => new Promise((r) => redirector.close(() => r())) });
  void hop;
  const redirPort = (redirector.address() as AddressInfo).port;
  // origin:'user' → metadata tier, redirect:'follow' (the rewired provider/MCP/vision shape).
  // Pre-fix this dialed the ORIGINAL host's pins for the redirect target (TLS/SNI mismatch,
  // wrong vhost); the pinned lookup must recognize the host change and resolve for real.
  const res = await shadowFetch(`http://127.0.0.1:${redirPort}/start`, {}, { purpose: 'provider', origin: 'user' });
  assert.equal(res.status, 200);
  assert.equal(await res.text(), 'landed:/landed');
});

test('localhost endpoints bound to ::1 stay reachable (no v4-only pin regression)', async (t) => {
  const { lookup } = await import('node:dns/promises');
  const hasV6 = (await lookup('localhost', { all: true }).catch(() => [])).some((r) => r.family === 6);
  if (!hasV6) {
    t.skip('this host resolves localhost to IPv4 only — no ::1 path to protect');
    return;
  }
  const v6only: Server = createServer((req, res) => {
    res.writeHead(200, { 'content-type': 'text/plain' });
    res.end(`v6:${req.url}`);
  });
  await new Promise<void>((r) => v6only.listen(0, '::1', () => r()));
  servers.push({ raw: v6only, close: () => new Promise((r) => v6only.close(() => r())) });
  const port = (v6only.address() as AddressInfo).port;
  const res = await shadowFetch(`http://localhost:${port}/probe`, {}, { purpose: 'local-probe', origin: 'user' });
  assert.equal(res.status, 200);
  assert.equal(await res.text(), 'v6:/probe');
});

test('the pinned-agent cache is LRU-capped (a browsing session cannot grow it without bound)', () => {
  const before = pinnedAgentCacheSizeForTests();
  for (let i = 0; i < 80; i++) {
    pinnedAgent([`127.0.0.${(i % 250) + 1}`], `lru-${i}.example`);
  }
  assert.ok(pinnedAgentCacheSizeForTests() <= 64, `cache must be capped (saw ${pinnedAgentCacheSizeForTests()})`);
  void before;
});

// ── The receipt ───────────────────────────────────────────────────────────────

test('recordEgress aggregates per host and egressSummary orders most-recent first', async () => {
  recordEgress('agg-old.example', 'web', 'allowed');
  // lastSeen is epoch-ms: give the second host a strictly-later stamp so the ordering is real,
  // not a same-millisecond coin flip.
  await new Promise((r) => setTimeout(r, 5));
  recordEgress('agg-new.example', 'provider', 'allowed');
  recordEgress('agg-new.example', 'provider', 'denied');
  await flushEgressLogForTests();
  const rows = egressSummary();
  const oldIdx = rows.findIndex((r) => r.host === 'agg-old.example');
  const newIdx = rows.findIndex((r) => r.host === 'agg-new.example');
  assert.ok(oldIdx >= 0 && newIdx >= 0);
  assert.ok(newIdx < oldIdx, 'most-recently-seen host sorts first');
  const s = rows[newIdx]!;
  assert.equal(s.allowed, 1);
  assert.equal(s.denied, 1);
  assert.deepEqual([...s.purposes], ['provider']);
});

test('the receipt log is JSON-lines, and readEgressLogAggregate reads it from DISK (fresh-process receipt)', async () => {
  const p = join(tmp, 'disk.log');
  setEgressLogPathForTests(p);
  try {
    recordEgress('disk-a.example', 'update-check', 'allowed');
    recordEgress('disk-b.example', 'oauth', 'denied');
    await flushEgressLogForTests();
    const lines = readFileSync(p, 'utf8').trim().split('\n');
    assert.equal(lines.length, 2);
    const row = JSON.parse(lines[0]!) as { ts: string; host: string; purpose: string; verdict: string };
    assert.equal(row.host, 'disk-a.example');
    assert.equal(row.purpose, 'update-check');
    assert.equal(row.verdict, 'allowed');
    assert.ok(!Number.isNaN(Date.parse(row.ts)));

    // The CLI command reads this from a FRESH process — aggregate straight from the file,
    // tolerating a torn trailing line (crash mid-write must not sink the report).
    appendFileSync(p, '{"ts":"2026-08-13T00:00:00.000Z","host":"disk-a.example","purpose":"web","verdict":"denied"}\n{torn');
    const agg = await readEgressLogAggregate();
    const a = agg.find((r) => r.host === 'disk-a.example')!;
    assert.equal(a.allowed, 1);
    assert.equal(a.denied, 1);
    assert.deepEqual([...a.purposes].sort(), ['update-check', 'web']);
    const b = agg.find((r) => r.host === 'disk-b.example')!;
    assert.equal(b.denied, 1);
  } finally {
    setEgressLogPathForTests(join(tmp, 'egress.log')); // try/finally: an assertion failure must not leak the path onward
  }
});

test('the receipt rotates at 256 KiB and keeps exactly one rotation', async () => {
  const p = join(tmp, 'rotate.log');
  setEgressLogPathForTests(p);
  try {
    writeFileSync(p, 'x'.repeat(257 * 1024)); // already over the cap → the next write rotates
    recordEgress('rotated.example', 'update-binary', 'allowed');
    await flushEgressLogForTests();
    assert.ok(existsSync(p + '.1'), 'the oversize file must be rotated to .1');
    const fresh = readFileSync(p, 'utf8');
    assert.ok(fresh.includes('"host":"rotated.example"'), 'the new file holds only post-rotation lines');
    assert.ok(!fresh.includes('xxx'), 'the padding went to the rotation, not the live file');
    // Aggregate spans BOTH files.
    const agg = await readEgressLogAggregate();
    assert.ok(agg.find((r) => r.host === 'rotated.example'));
  } finally {
    setEgressLogPathForTests(join(tmp, 'egress.log'));
  }
});

test('formatEgressReport renders hosts, verdict counts, purposes, and the receipt path', async () => {
  // Self-contained fixture — this test must not depend on another test's log (it failed when
  // run in isolation before: --test-name-pattern 'formatEgressReport').
  const p = join(tmp, 'report.log');
  writeFileSync(
    p,
    '{"ts":"2026-08-13T00:00:00.000Z","host":"report-a.example","purpose":"web","verdict":"allowed"}\n' +
      '{"ts":"2026-08-13T00:00:01.000Z","host":"report-a.example","purpose":"web","verdict":"denied"}\n',
  );
  setEgressLogPathForTests(p);
  try {
    const agg = await readEgressLogAggregate();
    const report = formatEgressReport(agg, p);
    assert.match(report, /recorded outbound connections/);
    assert.match(report, /report-a\.example/);
    assert.match(report, new RegExp(p.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
    assert.match(formatEgressReport([], '/nowhere/egress.log'), /nothing recorded yet/);
  } finally {
    setEgressLogPathForTests(join(tmp, 'egress.log'));
  }
});

// ── ESLint guard (the "no new raw fetch" rule is itself guarded) ─────────────

test('the ESLint egress guard bans raw fetch()/undici imports outside the broker', async () => {
  const { ESLint } = await import('eslint');
  const eslint = new ESLint({ cwd: repoRoot });
  const probe = "import { fetch as undiciFetch } from 'undici';\nconst r = await fetch('http://x/');\nvoid undiciFetch; void r;\n";

  const outside = await eslint.lintText(probe, { filePath: join(repoRoot, 'src', 'provider', 'zz-guard-probe.ts') });
  const rules = new Set(outside[0]!.messages.map((m) => m.ruleId));
  assert.ok(rules.has('no-restricted-imports'), 'undici import outside the broker must fail lint');
  assert.ok(rules.has('no-restricted-syntax'), 'raw fetch() outside the broker must fail lint');

  const inside = await eslint.lintText(probe, { filePath: join(repoRoot, 'src', 'safety', 'egress.ts') });
  const insideGuard = inside[0]!.messages.filter(
    (m) => m.ruleId === 'no-restricted-imports' || m.ruleId === 'no-restricted-syntax',
  );
  assert.equal(insideGuard.length, 0, 'the broker itself is exempt from the guard');
});

test('the ESLint guard also catches the sneaky shapes (alias, bracket, dynamic import)', async () => {
  const { ESLint } = await import('eslint');
  const eslint = new ESLint({ cwd: repoRoot });
  const fp = join(repoRoot, 'src', 'provider', 'zz-guard-probe.ts');
  const sneaky = [
    "const f = fetch;\nvoid f;\n", // aliasing fetch away
    "const g = globalThis['fetch'];\nvoid g;\n", // bracket access
    "const u = await import('undici');\nvoid u;\n", // dynamic import
  ];
  for (const code of sneaky) {
    const out = await eslint.lintText(code, { filePath: fp });
    assert.ok(
      out[0]!.messages.some((m) => m.ruleId === 'no-restricted-syntax' || m.ruleId === 'no-restricted-imports'),
      `guard must catch: ${code.trim().split('\n')[0]}`,
    );
  }
});

// ── MCP HTTP connector: bounded like every other egress surface ──────────────

test('McpHttpClient honors its per-RPC deadline (a wedged endpoint cannot hold a turn open)', async () => {
  const { McpHttpClient } = await import('../src/mcp/client.js');
  // Accept connections, never answer — the classic wedge.
  const wedged: Server = createServer(() => {
    /* never respond */
  });
  await new Promise<void>((r) => wedged.listen(0, '127.0.0.1', () => r()));
  servers.push({ raw: wedged, close: () => new Promise((r) => wedged.close(() => r())) });
  const port = (wedged.address() as AddressInfo).port;
  const client = new McpHttpClient('wedge', `http://127.0.0.1:${port}/mcp`, {}, 200);
  const start = Date.now();
  const res = await client.callTool('anything', {}, 'read');
  assert.equal(res.ok, false);
  assert.match(res.error?.message ?? res.summary, /abort|timeout|cancel/i);
  assert.ok(Date.now() - start < 5_000, 'the deadline must fire fast, not hang the turn');
});

test('McpHttpClient honors a caller abort signal (ESC reaches MCP HTTP calls)', async () => {
  const { McpHttpClient } = await import('../src/mcp/client.js');
  const wedged: Server = createServer(() => {
    /* never respond */
  });
  await new Promise<void>((r) => wedged.listen(0, '127.0.0.1', () => r()));
  servers.push({ raw: wedged, close: () => new Promise((r) => wedged.close(() => r())) });
  const port = (wedged.address() as AddressInfo).port;
  const client = new McpHttpClient('wedge2', `http://127.0.0.1:${port}/mcp`, {}, 60_000);
  const ac = new AbortController();
  setTimeout(() => ac.abort(), 50);
  const start = Date.now();
  const res = await client.callTool('anything', {}, 'read', ac.signal);
  assert.equal(res.ok, false);
  assert.ok(Date.now() - start < 5_000, 'the caller abort must cut the call short');
});
