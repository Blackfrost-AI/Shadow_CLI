import test from 'node:test';
import assert from 'node:assert/strict';
import { request } from 'node:http';
import { EventBus } from '../src/agent/events.js';
import { startWebServer, type WebServerHandle } from '../src/web/server.js';

/**
 * `Host` is a forbidden header for `fetch` — undici overwrites it with the real authority,
 * so a rebinding test written with fetch silently tests nothing (it passes for the wrong
 * reason under runtimes that allow it, and fails under Node). Drop to node:http, which
 * sends exactly the headers given.
 */
function rawGet(
  port: number,
  path: string,
  headers: Record<string, string>,
): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const req = request({ host: '127.0.0.1', port, path, method: 'GET', headers }, (res) => {
      let body = '';
      res.on('data', (c) => (body += c));
      res.on('end', () => resolve({ status: res.statusCode ?? 0, body }));
    });
    req.on('error', reject);
    req.end();
  });
}

/** Read SSE frames off a live stream until `want` data lines have arrived. */
async function collect(res: Response, want: number, timeoutMs = 3000): Promise<string[]> {
  const reader = res.body!.getReader();
  const dec = new TextDecoder();
  const out: string[] = [];
  let buf = '';
  const deadline = Date.now() + timeoutMs;
  while (out.length < want && Date.now() < deadline) {
    const { value, done } = await reader.read();
    if (done) break;
    buf += dec.decode(value, { stream: true });
    // Consume only COMPLETE lines. The previous version split the whole buffer each read and
    // pushed the trailing element too — which is the partial tail of a frame still arriving,
    // so any frame larger than one read arrived truncated and failed to JSON.parse. It also
    // re-split a growing buffer on every read, which is quadratic on large frames.
    let idx: number;
    while ((idx = buf.indexOf('\n')) !== -1) {
      const line = buf.slice(0, idx);
      buf = buf.slice(idx + 1);
      if (line.startsWith('data: ')) out.push(line.slice(6));
    }
  }
  await reader.cancel().catch(() => {});
  return out;
}

async function withServer(fn: (h: WebServerHandle, bus: EventBus) => Promise<void>): Promise<void> {
  const bus = new EventBus();
  const h = await startWebServer({ bus });
  try {
    await fn(h, bus);
  } finally {
    await h.close();
  }
}

test('rejects a rebound Host even with a valid token', async () => {
  await withServer(async (h) => {
    // Sanity-check the instrument first: if the client cannot actually set Host, this
    // test proves nothing. The control below must pass with the real authority.
    const control = await rawGet(h.port, `/health?t=${h.token}`, { host: `127.0.0.1:${h.port}` });
    assert.equal(control.status, 200, 'control: a correct Host is accepted');

    const r = await rawGet(h.port, `/health?t=${h.token}`, { host: 'evil.com' });
    assert.equal(r.status, 403, 'a rebound Host is refused despite a valid token');
    assert.equal(JSON.parse(r.body).error, 'bad host');
  });
});

test('rejects a cross-site Origin even with a valid token', async () => {
  await withServer(async (h) => {
    const r = await fetch(`http://127.0.0.1:${h.port}/health?t=${h.token}`, {
      headers: { origin: 'http://evil.com' },
    });
    assert.equal(r.status, 403);
    assert.equal((await r.json()).error, 'bad origin');
  });
});

test('rejects a request with no token', async () => {
  await withServer(async (h) => {
    const r = await fetch(`http://127.0.0.1:${h.port}/health`);
    assert.equal(r.status, 401);
  });
});

test('serves the page to an authorized request', async () => {
  await withServer(async (h) => {
    const r = await fetch(`http://127.0.0.1:${h.port}/?t=${h.token}`);
    assert.equal(r.status, 200);
    assert.match(r.headers.get('content-security-policy') ?? '', /default-src 'none'/);
    assert.equal(r.headers.get('x-frame-options'), 'DENY');
  });
});

test('SSE streams a LoopEvent emitted on the bus', async () => {
  await withServer(async (h, bus) => {
    const res = await fetch(`http://127.0.0.1:${h.port}/events?t=${h.token}`);
    assert.equal(res.status, 200);
    assert.match(res.headers.get('content-type') ?? '', /text\/event-stream/);

    // Wait for the subscriber to register before emitting.
    const deadline = Date.now() + 2000;
    while (h.clients() === 0 && Date.now() < deadline) await new Promise((r) => setTimeout(r, 10));
    assert.equal(h.clients(), 1, 'client registered');

    bus.emit({ type: 'mode', mode: 'thinking' });
    bus.emit({ type: 'text', delta: 'hello' });

    const frames = await collect(res, 2);
    const events = frames.map((f) => JSON.parse(f));
    assert.deepEqual(events[0], { type: 'mode', mode: 'thinking' });
    assert.deepEqual(events[1], { type: 'text', delta: 'hello' });
  });
});

test('shell_output is coalesced instead of one frame per chunk', async () => {
  await withServer(async (h, bus) => {
    const res = await fetch(`http://127.0.0.1:${h.port}/events?t=${h.token}`);
    const deadline = Date.now() + 2000;
    while (h.clients() === 0 && Date.now() < deadline) await new Promise((r) => setTimeout(r, 10));

    for (let i = 0; i < 50; i++) {
      bus.emit({ type: 'shell_output', callId: 'c1', stream: 'stdout', chunk: `line${i}\n` });
    }

    const frames = await collect(res, 1);
    const first = JSON.parse(frames[0]);
    assert.equal(first.type, 'shell_output');
    assert.ok(first.chunk.includes('line0') && first.chunk.includes('line49'), 'chunks merged into one frame');
  });
});

test('a reconnect with Last-Event-ID replays what it missed', async () => {
  await withServer(async (h, bus) => {
    bus.emit({ type: 'mode', mode: 'thinking' });
    bus.emit({ type: 'mode', mode: 'acting' });
    bus.emit({ type: 'mode', mode: 'idle' });

    // Reconnect claiming to have seen only the first event.
    const res = await fetch(`http://127.0.0.1:${h.port}/events?t=${h.token}`, {
      headers: { 'last-event-id': '1' },
    });
    const frames = await collect(res, 2);
    const events = frames.map((f) => JSON.parse(f));
    assert.deepEqual(events, [
      { type: 'mode', mode: 'acting' },
      { type: 'mode', mode: 'idle' },
    ]);
  });
});

test('close() ends the stream and drops subscribers', async () => {
  const bus = new EventBus();
  const h = await startWebServer({ bus });
  const res = await fetch(`http://127.0.0.1:${h.port}/events?t=${h.token}`);
  const deadline = Date.now() + 2000;
  while (h.clients() === 0 && Date.now() < deadline) await new Promise((r) => setTimeout(r, 10));
  assert.equal(h.clients(), 1);
  await h.close();
  assert.equal(h.clients(), 0);
  await res.body?.cancel().catch(() => {});
});

// ── W8: redaction, transcript snapshot, token hygiene ────────────────────────────────────

test('SSE redacts secrets — the live stream must not leak more than the session log', async () => {
  // redact() ran only in SessionLog, so the wire carried tool args, shell output and file
  // contents unscrubbed while the file on disk was clean. Redaction now happens at the
  // bus→wire boundary, which covers every consumer of the stream.
  await withServer(async (h, bus) => {
    const res = await fetch(`http://127.0.0.1:${h.port}/events?t=${h.token}`);
    const deadline = Date.now() + 2000;
    while (h.clients() === 0 && Date.now() < deadline) await new Promise((r) => setTimeout(r, 10));

    bus.emit({ type: 'shell_output', callId: 'c1', stream: 'stdout', chunk: 'export KEY=sk-abcdef0123456789abcdef' });
    bus.emit({ type: 'error', message: 'auth failed for Bearer abcdef0123456789abcdef' });

    const frames = await collect(res, 2);
    const blob = frames.join('\n');
    assert.ok(!blob.includes('sk-abcdef0123456789abcdef'), 'an sk- key must not reach the browser');
    assert.ok(!blob.includes('Bearer abcdef0123456789abcdef'), 'a bearer token must not reach the browser');
  });
});

test('the session token itself is redacted from event payloads', async () => {
  // registerSecret(token) at mint time: the agent runs on the same host and can read its own
  // output back, so an unregistered token would be a self-disclosure path.
  await withServer(async (h, bus) => {
    const res = await fetch(`http://127.0.0.1:${h.port}/events?t=${h.token}`);
    const deadline = Date.now() + 2000;
    while (h.clients() === 0 && Date.now() < deadline) await new Promise((r) => setTimeout(r, 10));

    bus.emit({ type: 'error', message: `leaked the session token: ${h.token}` });
    const frames = await collect(res, 1);
    assert.ok(!frames.join('').includes(h.token), 'the session token must be scrubbed from events');
  });
});

test('GET /api/transcript returns buffered history so a refresh is not a blank page', async () => {
  await withServer(async (h, bus) => {
    bus.emit({ type: 'text', delta: 'first' });
    bus.emit({ type: 'text', delta: 'second' });
    // Let the (non-shell) events flush through synchronously.
    const r = await fetch(`http://127.0.0.1:${h.port}/api/transcript?t=${h.token}`);
    assert.equal(r.status, 200);
    const body = (await r.json()) as { events: { id: number; event: { type: string; delta?: string } }[]; lastEventId: number };
    const deltas = body.events.filter((e) => e.event.type === 'text').map((e) => e.event.delta);
    assert.deepEqual(deltas, ['first', 'second']);
    assert.ok(body.lastEventId >= 2, 'reports the highest event id');
  });
});

test('the coalescer flushes early instead of growing one unbounded frame', async () => {
  // Without a size cap, `yes`-style output accumulates the whole 50ms window into a single
  // frame that is stringified once and retained 500 deep in the replay ring.
  await withServer(async (h, bus) => {
    const res = await fetch(`http://127.0.0.1:${h.port}/events?t=${h.token}`);
    const deadline = Date.now() + 2000;
    while (h.clients() === 0 && Date.now() < deadline) await new Promise((r) => setTimeout(r, 10));

    // 128KB in one tick = exactly two 64KB early flushes. Sized so the reader below consumes
    // the stream completely — cancelling mid-body leaves the server writing into a dead socket
    // and close() then waits on it.
    const chunk = 'x'.repeat(16 * 1024);
    for (let i = 0; i < 8; i++) bus.emit({ type: 'shell_output', callId: 'c1', stream: 'stdout', chunk });

    const frames = await collect(res, 2);
    assert.ok(frames.length >= 2, 'a large burst produces multiple frames, not one giant one');
    for (const f of frames) {
      const ev = JSON.parse(f) as { chunk?: string };
      if (ev.chunk) assert.ok(ev.chunk.length <= 128 * 1024, `frame stayed bounded (${ev.chunk.length})`);
    }
  });
});

test('the launch URL uses fragment handoff so the token never reaches the server', async () => {
  await withServer(async (h) => {
    assert.ok(h.url.includes('#t='), h.url);
    assert.ok(!h.url.includes('?t='), 'no query-string token in the advertised URL');
  });
});

// ── W13: per-server router context + readJsonBody ────────────────────────────────────────

test('an empty POST body is handled, not a post-resolution rejection', async () => {
  // readJsonBody used to resolve(null) on an empty body and then fall through to
  // JSON.parse('') and call reject() on an already-settled promise. Settled promises ignore
  // that, so the bug was invisible — until a route that legitimately accepts an empty body
  // starts being hit. The route must simply see null and answer 400.
  await withServer(async (h) => {
    const r = await fetch(`http://127.0.0.1:${h.port}/api/agents`, {
      method: 'POST',
      headers: { authorization: `Bearer ${h.token}`, 'content-type': 'application/json' },
      body: '',
    });
    assert.equal(r.status, 400, 'empty body is a clean 400');
    assert.match(await r.text(), /invalid body/);
  });
});

test('two servers in one process have independent routers', async () => {
  // Routes used to live in a module-level array populated at import time, so a second server
  // shared (and re-registered into) the first one's table, and route state leaked between
  // tests depending on import order.
  const busA = new EventBus();
  const busB = new EventBus();
  const a = await startWebServer({ bus: busA });
  const b = await startWebServer({ bus: busB });
  try {
    assert.notEqual(a.port, b.port);
    assert.notEqual(a.token, b.token, 'each server mints its own token');

    // Each answers on its own port with its OWN token, and rejects the other's.
    const okA = await rawGet(a.port, '/api/state', { host: `127.0.0.1:${a.port}`, authorization: `Bearer ${a.token}` });
    const okB = await rawGet(b.port, '/api/state', { host: `127.0.0.1:${b.port}`, authorization: `Bearer ${b.token}` });
    assert.equal(okA.status, 200);
    assert.equal(okB.status, 200);

    const crossed = await rawGet(b.port, '/api/state', { host: `127.0.0.1:${b.port}`, authorization: `Bearer ${a.token}` });
    assert.equal(crossed.status, 401, "server B rejects server A's token");
  } finally {
    await a.close();
    await b.close();
  }
});

test('the API acts on the workspace it was given, not process.cwd()', async () => {
  // The workspace is now server context rather than a global read at call time, which is what
  // makes a per-session workspace possible later.
  const bus = new EventBus();
  const h = await startWebServer({ bus, workspaceRoot: '/tmp' });
  try {
    const r = await rawGet(h.port, '/api/state', { host: `127.0.0.1:${h.port}`, authorization: `Bearer ${h.token}` });
    assert.equal(r.status, 200);
    // Built-ins are always present regardless of workspace; the point is it did not throw and
    // resolved agents against the supplied root.
    const snap = JSON.parse(r.body) as { agents: { name: string }[] };
    assert.ok(snap.agents.some((a) => a.name === 'explore'));
  } finally {
    await h.close();
  }
});

// ── C3: session registry, ?session=, normalized path ─────────────────────────────────────

test('GET /api/sessions lists the reserved cli session (origin local when there is no mirror)', async () => {
  await withServer(async (h) => {
    const r = await rawGet(h.port, `/api/sessions?t=${h.token}`, { host: `127.0.0.1:${h.port}` });
    assert.equal(r.status, 200);
    const body = JSON.parse(r.body) as {
      sessions: Array<{ id: string; origin: string; canPrompt: boolean; canInterrupt: boolean }>;
    };
    assert.equal(body.sessions.length, 1, 'exactly the reserved session');
    assert.equal(body.sessions[0]!.id, 'cli');
    assert.equal(body.sessions[0]!.origin, 'local', 'no mirror opts → inert local placeholder');
    assert.equal(body.sessions[0]!.canPrompt, false, 'the mirror is observed, never driven');
  });
});

test('/events and /api/transcript 404 an unknown ?session= id', async () => {
  await withServer(async (h) => {
    const ev = await rawGet(h.port, `/events?session=nope&t=${h.token}`, { host: `127.0.0.1:${h.port}` });
    assert.equal(ev.status, 404, 'unknown session → 404 before the SSE head is written');
    const tr = await rawGet(h.port, `/api/transcript?session=nope&t=${h.token}`, { host: `127.0.0.1:${h.port}` });
    assert.equal(tr.status, 404);
  });
});

test('a duplicated ?session= takes the first value (split-parse hardening)', async () => {
  await withServer(async (h) => {
    const first = await rawGet(h.port, `/api/transcript?session=cli&session=nope&t=${h.token}`, {
      host: `127.0.0.1:${h.port}`,
    });
    assert.equal(first.status, 200, 'first value cli wins');
    const second = await rawGet(h.port, `/api/transcript?session=nope&session=cli&t=${h.token}`, {
      host: `127.0.0.1:${h.port}`,
    });
    assert.equal(second.status, 404, 'first value nope wins → unknown');
  });
});

test('isPublicPath is computed on the same NORMALIZED path the router dispatches on', async () => {
  // %2e%2e is '..'; new URL collapses /assets/../api/state → /api/state, which is NOT a public
  // asset, so the token is required and the request dispatches to /api/state (not a 404 asset).
  // This equality — auth and dispatch reading one normalized string — is the whole safety property.
  await withServer(async (h) => {
    const noTok = await rawGet(h.port, `/assets/%2e%2e/api/state`, { host: `127.0.0.1:${h.port}` });
    assert.equal(noTok.status, 401, 'traversal normalized to /api/state → token required, not served ungated');
    const withTok = await rawGet(h.port, `/assets/%2e%2e/api/state?t=${h.token}`, { host: `127.0.0.1:${h.port}` });
    assert.equal(withTok.status, 200, 'and with a token it dispatches to /api/state');
  });
});
