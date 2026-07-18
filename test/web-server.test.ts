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
    for (const line of buf.split('\n')) {
      if (line.startsWith('data: ')) out.push(line.slice(6));
    }
    buf = buf.slice(buf.lastIndexOf('\n') + 1);
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
