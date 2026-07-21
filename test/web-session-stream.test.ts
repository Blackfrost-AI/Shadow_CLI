import test from 'node:test';
import assert from 'node:assert/strict';
import { request } from 'node:http';
import type { ServerResponse } from 'node:http';
import { EventBus } from '../src/agent/events.js';
import { createSessionStream } from '../src/web/sessionStream.js';
import { startWebServer } from '../src/web/server.js';

/**
 * Unit coverage for the C2 extraction: a stream is per-bus and per-id, the eviction counter is
 * explicit (not inferred from replay[0].id), and ?after= resumes exactly like a Last-Event-ID
 * header with the header winning when both are present. The pure move itself is pinned by the
 * 16 unmodified tests in web-server.test.ts.
 */

/** A ServerResponse stand-in that records every written frame. `write`'s callback fires
 *  synchronously unless `holdCbs` is set, in which case it queues them so backpressure can
 *  be driven deterministically. */
function fakeRes(holdCbs = false) {
  const frames: string[] = [];
  const cbs: Array<() => void> = [];
  const res = {
    frames,
    write(s: string, cb?: () => void): boolean {
      frames.push(s);
      if (cb) {
        if (holdCbs) cbs.push(cb);
        else cb();
      }
      return true;
    },
    end(): void {},
    flushCbs(): void {
      cbs.splice(0).forEach((f) => f());
    },
    text(): string {
      return frames.join('');
    },
  };
  return res as typeof res & ServerResponse;
}

let clientSeq = 0;
const allocClientId = () => ++clientSeq;

test('two streams over two buses are isolated — an event on A never reaches B', () => {
  const busA = new EventBus();
  const busB = new EventBus();
  const a = createSessionStream({ bus: busA, allocClientId });
  const b = createSessionStream({ bus: busB, allocClientId });
  const resA = fakeRes();
  const resB = fakeRes();
  a.attach(resA);
  b.attach(resB);

  busA.emit({ type: 'mode', mode: 'acting' });

  assert.ok(resA.text().includes('"mode":"acting"'), 'A saw its own event');
  assert.ok(!resB.text().includes('"mode":"acting"'), 'B never saw A’s event');
  a.close();
  b.close();
});

test('an identical callId on two buses never merges into one frame (per-stream coalescer)', () => {
  const busA = new EventBus();
  const busB = new EventBus();
  const a = createSessionStream({ bus: busA, allocClientId });
  const b = createSessionStream({ bus: busB, allocClientId });
  const resA = fakeRes();
  const resB = fakeRes();
  a.attach(resA);
  b.attach(resB);

  busA.emit({ type: 'shell_output', callId: 'c1', stream: 'stdout', chunk: 'AAA' });
  busB.emit({ type: 'shell_output', callId: 'c1', stream: 'stdout', chunk: 'BBB' });
  // A non-shell event drains the pending coalescer first, deterministically (no 50ms wait).
  busA.emit({ type: 'mode', mode: 'idle' });
  busB.emit({ type: 'mode', mode: 'idle' });

  assert.ok(resA.text().includes('AAA') && !resA.text().includes('BBB'), 'A kept only its own chunk');
  assert.ok(resB.text().includes('BBB') && !resB.text().includes('AAA'), 'B kept only its own chunk');
  a.close();
  b.close();
});

test('truncated is a counted eviction, not the replay[0].id > 1 inference', () => {
  const bus = new EventBus();
  const s = createSessionStream({ bus, allocClientId });

  let snap = s.transcript();
  assert.equal(snap.truncated, false, 'a fresh stream is not truncated');
  assert.equal(snap.evicted, 0);
  assert.equal(snap.lastEventId, 0, 'no events → highest id is 0');

  // REPLAY_BUFFER is 500; emit past it so the ring must evict.
  for (let i = 0; i < 600; i++) bus.emit({ type: 'text', delta: `d${i}` });

  snap = s.transcript();
  assert.equal(snap.lastEventId, 600, 'ids are per-stream and dense');
  assert.ok(snap.evicted >= 100, `evicted counted (${snap.evicted})`);
  assert.equal(snap.truncated, true);
  assert.ok(snap.events.length <= 500, 'ring stays bounded');
  s.close();
});

test('the stream_gap notice carries no id: line, so it cannot clobber the client cursor', () => {
  const bus = new EventBus();
  const s = createSessionStream({ bus, allocClientId });
  const res = fakeRes(true); // hold write callbacks so `queued` accumulates past the cap
  s.attach(res);

  // CLIENT_QUEUE_MAX_BYTES is 4MB. Push ~4.8MB of un-acked frames so later frames are dropped.
  // Separator-rich content (spaces break word runs) keeps redact() linear — a long single-char
  // run is a pathological backtracking input, which real event payloads never are.
  const chunk = 'ab '.repeat(80_000); // ~240KB
  for (let i = 0; i < 20; i++) bus.emit({ type: 'text', delta: chunk });
  // Now let the socket "catch up" so queued drains, then push one more: the gap notice fires.
  res.flushCbs();
  bus.emit({ type: 'mode', mode: 'idle' });

  const gap = res.frames.find((f) => f.includes('stream_gap'));
  assert.ok(gap, 'a gap notice was emitted after frames were dropped');
  assert.ok(!gap!.includes('id:'), 'the gap notice has no id: line');
  assert.match(gap!, /^data: /, 'the gap notice is a bare data frame');
  s.close();
});

// ── HTTP: ?after= resume + Last-Event-ID precedence ──────────────────────────────────────

function rawGet(
  port: number,
  path: string,
  headers: Record<string, string>,
): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    let settled = false;
    const req = request({ host: '127.0.0.1', port, path, method: 'GET', headers }, (res) => {
      let body = '';
      res.on('data', (c) => (body += c));
      // SSE never ends on its own: read the replay burst, then hang up and resolve with it.
      const finish = (): void => {
        if (settled) return;
        settled = true;
        try {
          req.destroy();
        } catch {
          /* already gone */
        }
        resolve({ status: res.statusCode ?? 0, body });
      };
      res.on('end', finish);
      setTimeout(finish, 200);
    });
    // A destroy after the burst surfaces as a request 'error'; ignore it once we've resolved.
    req.on('error', (e) => {
      if (!settled) reject(e);
    });
    req.end();
  });
}

test('?after=N resumes exactly like a Last-Event-ID header, and the header wins when both are set', async () => {
  const bus = new EventBus();
  const h = await startWebServer({ bus });
  try {
    bus.emit({ type: 'mode', mode: 'thinking' }); // id 1
    bus.emit({ type: 'mode', mode: 'acting' }); //   id 2
    bus.emit({ type: 'mode', mode: 'idle' }); //     id 3

    const byParam = await rawGet(h.port, `/events?after=1&t=${h.token}`, { host: `127.0.0.1:${h.port}` });
    const byHeader = await rawGet(h.port, `/events?t=${h.token}`, {
      host: `127.0.0.1:${h.port}`,
      'last-event-id': '1',
    });
    // ?after=1 replays 2 and 3, identical to the header form.
    for (const r of [byParam, byHeader]) {
      assert.ok(r.body.includes('"mode":"acting"'), 'replayed id 2');
      assert.ok(r.body.includes('"mode":"idle"'), 'replayed id 3');
      assert.ok(!r.body.includes('"mode":"thinking"'), 'did not replay id 1');
    }

    // Header (fresher, only present on auto-reconnect) beats ?after=: header 2 wins over after 0,
    // so only id 3 replays.
    const both = await rawGet(h.port, `/events?after=0&t=${h.token}`, {
      host: `127.0.0.1:${h.port}`,
      'last-event-id': '2',
    });
    assert.ok(both.body.includes('"mode":"idle"'), 'header resume replayed id 3');
    assert.ok(!both.body.includes('"mode":"acting"'), 'header 2 beat after=0 — id 2 not replayed');
  } finally {
    await h.close();
  }
});
