import test from 'node:test';
import assert from 'node:assert/strict';
import { RpcFailure, RpcPeer } from '../src/acp/jsonrpc.js';

/**
 * The ACP transport peer: NDJSON line framing over an injected writer. A malformed line must
 * produce a -32700 and NEVER kill the stream; unknown response ids are dropped; outbound
 * requests track a pending map that abort + shutdown can drain.
 */

interface Wire {
  peer: RpcPeer;
  lines: string[];
  messages: () => Array<Record<string, unknown>>;
  send: (msg: Record<string, unknown>) => void;
}

function makeWire(handlers?: {
  request?: (method: string, params: unknown) => Promise<unknown>;
  notification?: (method: string, params: unknown) => void;
}): Wire {
  const lines: string[] = [];
  const peer = new RpcPeer(
    (line) => lines.push(line),
    {
      request: handlers?.request ?? (async () => null),
      notification: handlers?.notification ?? (() => {}),
    },
  );
  return {
    peer,
    lines,
    messages: () => lines.map((l) => JSON.parse(l.replace(/\n$/, '')) as Record<string, unknown>),
    send: (msg) => peer.feed(`${JSON.stringify(msg)}\n`),
  };
}

const tick = (): Promise<void> => new Promise((r) => setImmediate(r));

async function until(cond: () => boolean, ms = 2000): Promise<void> {
  const deadline = Date.now() + ms;
  while (!cond() && Date.now() < deadline) await new Promise((r) => setTimeout(r, 2));
  if (!cond()) throw new Error('condition never became true');
}

test('a request line gets a response with the same id', async () => {
  const w = makeWire({ request: async (m) => `pong:${m}` });
  w.send({ jsonrpc: '2.0', id: 7, method: 'ping' });
  await until(() => w.messages().length === 1);
  assert.deepEqual(w.messages()[0], { jsonrpc: '2.0', id: 7, result: 'pong:ping' });
});

test('a frame split across chunks reassembles before dispatch', async () => {
  const w = makeWire({ request: async () => 'ok' });
  const frame = JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'm' });
  w.peer.feed(frame.slice(0, 10));
  await tick();
  assert.equal(w.messages().length, 0, 'no dispatch from a partial frame');
  w.peer.feed(frame.slice(10) + '\n');
  await until(() => w.messages().length === 1);
  assert.equal(w.messages()[0]!.id, 1);
  assert.equal(w.messages()[0]!.result, 'ok');
});

test('multiple messages in one chunk all dispatch; empty lines are skipped', async () => {
  const seen: string[] = [];
  const w = makeWire({ request: async (m) => (seen.push(m), m) });
  const a = JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'a' });
  const b = JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'b' });
  w.peer.feed(`${a}\n\n   \n${b}\n`);
  await until(() => w.messages().length === 2);
  assert.deepEqual(seen, ['a', 'b']);
});

test('CRLF line endings are tolerated', async () => {
  const w = makeWire({ request: async () => 'ok' });
  w.peer.feed(`${JSON.stringify({ jsonrpc: '2.0', id: 3, method: 'm' })}\r\n`);
  await until(() => w.messages().length === 1);
  assert.deepEqual(w.messages()[0], { jsonrpc: '2.0', id: 3, result: 'ok' });
});

test('a malformed line answers -32700 (id null) and the stream survives', async () => {
  const w = makeWire({ request: async () => 'still-alive' });
  w.peer.feed('this is not json\n');
  w.peer.feed(`${JSON.stringify({ jsonrpc: '2.0', id: 9, method: 'm' })}\n`);
  await until(() => w.messages().length === 2);
  const err = w.messages()[0]!.error as { code: number; message: string };
  assert.equal(err.code, -32700);
  assert.equal(w.messages()[0]!.id, null);
  assert.deepEqual(w.messages()[1], { jsonrpc: '2.0', id: 9, result: 'still-alive' });
});

test('a non-object frame answers -32600', async () => {
  const w = makeWire();
  w.peer.feed('[1,2,3]\n');
  w.peer.feed('42\n');
  await until(() => w.messages().length === 2);
  for (const m of w.messages()) assert.equal((m.error as { code: number }).code, -32600);
  assert.equal(w.messages()[0]!.id, null, 'an array has no id to answer');
});

test('a frame without jsonrpc:"2.0" answers -32600 with its id when present', async () => {
  const w = makeWire();
  w.send({ jsonrpc: '1.0', id: 5, method: 'm' });
  await until(() => w.messages().length === 1);
  assert.equal((w.messages()[0]!.error as { code: number }).code, -32600);
  assert.equal(w.messages()[0]!.id, 5);
});

test('notifications dispatch but never produce a response', async () => {
  const noted: Array<[string, unknown]> = [];
  const w = makeWire({ notification: (m, p) => noted.push([m, p]) });
  w.send({ jsonrpc: '2.0', method: 'session/cancel', params: { sessionId: 'x' } });
  await until(() => noted.length === 1);
  assert.equal(w.lines.length, 0, 'notifications never write');
  assert.deepEqual(noted[0], ['session/cancel', { sessionId: 'x' }]);
});

test('a throwing notification is swallowed silently', async () => {
  const w = makeWire({
    notification: () => {
      throw new Error('boom');
    },
  });
  w.send({ jsonrpc: '2.0', method: 'n' });
  await tick();
  assert.equal(w.lines.length, 0);
});

test('RpcFailure keeps its code and data; other throws become -32603', async () => {
  const w = makeWire({
    request: async (m) => {
      if (m === 'typed') throw new RpcFailure(-32602, 'bad params', { field: 'x' });
      throw new Error('plain');
    },
  });
  w.send({ jsonrpc: '2.0', id: 1, method: 'typed' });
  w.send({ jsonrpc: '2.0', id: 2, method: 'plain' });
  await until(() => w.messages().length === 2);
  const typed = w.messages().find((m) => m.id === 1)!.error as Record<string, unknown>;
  assert.equal(typed.code, -32602);
  assert.equal(typed.message, 'bad params');
  assert.deepEqual(typed.data, { field: 'x' });
  const plain = w.messages().find((m) => m.id === 2)!.error as Record<string, unknown>;
  assert.equal(plain.code, -32603);
  assert.equal(plain.message, 'plain');
});

test('outbound requests get sequential ids and resolve/reject from responses', async () => {
  const w = makeWire();
  const ok = w.peer.request('a');
  const fail = w.peer.request('b');
  await until(() => w.messages().length === 2);
  const [m1, m2] = w.messages();
  assert.equal(m1!.id, 1);
  assert.equal(m2!.id, 2);
  w.send({ jsonrpc: '2.0', id: 1, result: { fine: true } });
  w.send({ jsonrpc: '2.0', id: 2, error: { code: -32601, message: 'nope' } });
  assert.deepEqual(await ok, { fine: true });
  await assert.rejects(fail, (e: RpcFailure) => e.code === -32601 && e.message === 'nope');
  assert.equal(w.peer.pendingCount(), 0);
});

test('an unknown response id is dropped without crashing', async () => {
  const w = makeWire();
  w.send({ jsonrpc: '2.0', id: 999, result: 'ghost' });
  w.send({ jsonrpc: '2.0', id: 998, error: { code: -1, message: 'ghost' } });
  await tick();
  assert.equal(w.lines.length, 0);
});

test('signal abort rejects the pending request and a late response is dropped', async () => {
  const w = makeWire();
  const ctrl = new AbortController();
  const p = w.peer.request('slow', undefined, { signal: ctrl.signal });
  const caught = p.catch((e: unknown) => e as RpcFailure);
  ctrl.abort();
  const err = (await caught) as RpcFailure;
  assert.equal(err.code, -32603);
  assert.match(err.message, /aborted/);
  assert.equal(w.peer.pendingCount(), 0);
  const wireId = (w.messages()[0]! as { id: number }).id;
  w.send({ jsonrpc: '2.0', id: wireId, result: 'too late' });
  await tick();
  assert.equal(w.lines.length, 1, 'the late response produces no further writes');
});

test('an already-aborted signal rejects before anything is sent', async () => {
  const w = makeWire();
  const ctrl = new AbortController();
  ctrl.abort();
  await assert.rejects(w.peer.request('x', undefined, { signal: ctrl.signal }), /aborted/);
  assert.equal(w.lines.length, 0);
});

test('cancelPending rejects everything in flight (shutdown)', async () => {
  const w = makeWire();
  const a = w.peer.request('a').catch((e: RpcFailure) => e);
  const b = w.peer.request('b').catch((e: RpcFailure) => e);
  w.peer.cancelPending('going away');
  const [ea, eb] = await Promise.all([a, b]);
  assert.match((ea as RpcFailure).message, /going away/);
  assert.match((eb as RpcFailure).message, /going away/);
  assert.equal(w.peer.pendingCount(), 0);
});

test('every wire write is exactly one JSON object plus a newline', async () => {
  const w = makeWire({ request: async () => 'ok' });
  w.send({ jsonrpc: '2.0', id: 1, method: 'm' });
  await until(() => w.lines.length === 1);
  w.peer.notify('n', { p: 1 });
  await until(() => w.lines.length === 2);
  for (const line of w.lines) {
    assert.ok(line.endsWith('\n'));
    assert.doesNotThrow(() => JSON.parse(line));
    assert.equal(line.split('\n').length, 2, 'no embedded newlines in a frame');
  }
});
