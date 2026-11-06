/**
 * m10 — DAP wire protocol: framing, decoder bounds, peer request lifecycle.
 *
 * NO real adapter is spawned. The decoder and peer are exercised at the byte
 * level with hand-built frames — this strictness is the security property.
 *
 * Direction convention: `client` is Shadow's side. Frames the ADAPTER sends
 * (responses/events) are fed into `client.feed()`; frames the client sends
 * are captured from its writer and inspected.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  MAX_MESSAGE_BYTES,
  MAX_BUFFERED_BYTES,
  DapProtocolError,
  encodeDapFrame,
  DapFrameDecoder,
  DapPeer,
} from '../src/agent/dap/protocol.js';

// ── encoder ──────────────────────────────────────────────────────────────────

test('encoder counts UTF-8 bytes, not characters', () => {
  const frame = encodeDapFrame({ program: 'déjà-α.js' });
  const headerEnd = frame.indexOf('\r\n\r\n', 0, 'latin1');
  const header = frame.subarray(0, headerEnd).toString('latin1');
  const body = frame.subarray(headerEnd + 4);
  const declared = Number(/Content-Length: (\d+)/.exec(header)![1]);
  assert.equal(declared, body.length);
  assert.equal(declared, Buffer.from(JSON.stringify({ program: 'déjà-α.js' }), 'utf8').length);
  assert.equal(body.toString('utf8'), JSON.stringify({ program: 'déjà-α.js' }));
});

// ── decoder ─────────────────────────────────────────────────────────────────

test('decoder accepts a valid frame exactly byte-for-byte', () => {
  const dec = new DapFrameDecoder();
  const frame = encodeDapFrame({ command: 'launch', arguments: { program: 'a.js' } });
  const out = dec.push(frame);
  assert.equal(out.error, undefined);
  assert.deepEqual(out.frames, [JSON.stringify({ command: 'launch', arguments: { program: 'a.js' } })]);
});

test('decoder handles chunked delivery across every split point', () => {
  const frame = encodeDapFrame({ command: 'x' });
  for (let split = 1; split < frame.length; split++) {
    const dec = new DapFrameDecoder();
    const first = dec.push(frame.subarray(0, split));
    const second = dec.push(frame.subarray(split));
    assert.equal(second.error, undefined);
    assert.equal(first.frames.length + second.frames.length, 1, `split ${split}`);
    if (second.frames.length === 1) {
      assert.deepEqual(second.frames, [JSON.stringify({ command: 'x' })]);
    }
  }
});

test('decoder refuses malformed headers and never resyncs', () => {
  const dec = new DapFrameDecoder();
  const out = dec.push(Buffer.from('Content-Type: application/json\r\nContent-Length: 2\r\n\r\n{}', 'latin1'));
  assert.equal(out.frames.length, 0);
  assert.match(out.error!.message, /Malformed DAP header/);
  const again = dec.push(encodeDapFrame({ command: 'x' }));
  assert.equal(again.frames.length, 0);
  assert.equal(again.error, undefined); // failed already — refuses silently
});

test('decoder refuses an absurd Content-Length', () => {
  const dec = new DapFrameDecoder();
  const out = dec.push(Buffer.from(`Content-Length: ${MAX_MESSAGE_BYTES + 1}\r\n\r\n`, 'latin1'));
  assert.equal(out.frames.length, 0);
  assert.match(out.error!.message, /exceeds/);
});

test('decoder refuses a stream that exceeds the buffered-bytes cap', () => {
  const dec = new DapFrameDecoder();
  const junk = Buffer.alloc(MAX_BUFFERED_BYTES + 1, 0x61);
  const out = dec.push(junk);
  assert.equal(out.frames.length, 0);
  assert.match(out.error!.message, /exceeded .* buffered bytes/);
});

// ── peer ─────────────────────────────────────────────────────────────────────

/** Shadow-side peer with a captured writer and controllable handler records. */
function makeClient() {
  const written: Buffer[] = [];
  const events: string[] = [];
  const protocolErrors: string[] = [];
  const client = new DapPeer(
    (b) => { written.push(b); return true; },
    {
      onEvent: (name, body) => events.push(`${name}:${JSON.stringify(body)}`),
      onProtocolError: (e) => protocolErrors.push(e.message),
      onRequest: async () => undefined,
    },
  );
  const wireJson = () => written.map((b) => JSON.parse(b.subarray(b.indexOf('\r\n\r\n', 0, 'latin1') + 4).toString('utf8')));
  return { client, written, events, protocolErrors, wireJson };
}

const responseFrame = (requestSeq: number, body?: unknown, message?: string) =>
  encodeDapFrame({
    seq: requestSeq, // same seq is fine — responses echo request_seq ordering
    type: 'response',
    request_seq: requestSeq,
    success: message === undefined,
    ...(message === undefined ? { body: body ?? {} } : { message }),
  });

test('peer round-trip: request → success response resolves with the body', async () => {
  const { client, written } = makeClient();
  const pending = client.request('threads');
  const sent = JSON.parse(written[0].subarray(written[0].indexOf('\r\n\r\n', 0, 'latin1') + 4).toString('utf8'));
  assert.equal(sent.type, 'request');
  assert.equal(sent.command, 'threads');
  assert.equal(sent.seq, 1);
  client.feed(responseFrame(1, { threads: [] }));
  assert.deepEqual(await pending, { threads: [] });
  assert.equal(client.pendingCount(), 0);
});

test('peer refusal: success:false rejects with the adapter message surfaced', async () => {
  const { client } = makeClient();
  const pending = client.request('evaluate');
  client.feed(responseFrame(1, undefined, 'no such frame'));
  await assert.rejects(pending, (e: unknown) => {
    assert.ok(e instanceof DapProtocolError);
    assert.match((e as DapProtocolError).message, /no such frame/);
    return true;
  });
  assert.equal(client.pendingCount(), 0);
});

test('peer sequence enforcement: replayed seq kills the peer, late responses dropped', async () => {
  const { client, protocolErrors } = makeClient();
  const p1 = client.request('threads');
  client.feed(responseFrame(1, {}));
  await p1;
  // Replay seq 1 → violation → dead:
  client.feed(responseFrame(1, {}));
  assert.ok(client.dead());
  assert.equal(protocolErrors.length, 1);
  assert.match(protocolErrors[0], /sequence violation/);
  // A dead peer refuses everything immediately:
  await assert.rejects(() => client.request('threads'), /dead/);
});

test('peer never processes anything after garbage input (poisoned stream, fail-closed)', () => {
  const first = makeClient();
  first.client.feed('not json at all');
  // Garbage alone is buffered (no complete frame) — the peer is not yet dead,
  // but the stream is poisoned: any subsequent request aborts and NOTHING is
  // ever processed. The session layer's handshake timeout covers the silent case.
  const pending = first.client.request('threads');
  first.client.feed(responseFrame(1, { threads: [] }));
  return assert.rejects(pending, /Malformed DAP header/);
});

test('peer rejects non-object JSON arrays without resync', () => {
  const second = makeClient();
  second.client.feed(encodeDapFrame([1, 2, 3]));
  assert.ok(second.client.dead());
  assert.match(second.protocolErrors[0], /not a JSON object/);
});

test('peer rejects unknown message types and unnamed events', () => {
  const first = makeClient();
  first.client.feed(encodeDapFrame({ seq: 1, type: 'nonsense' }));
  assert.ok(first.client.dead());
  const second = makeClient();
  second.client.feed(encodeDapFrame({ seq: 1, type: 'event' }));
  assert.ok(second.client.dead());
  assert.ok(second.protocolErrors[0].includes('event name'));
});

test('peer abort: cancel writes requestId (never seq) and rejects locally', async () => {
  const { client, wireJson } = makeClient();
  const controller = new AbortController();
  const pending = client.request('evaluate', { expression: '1' }, { signal: controller.signal });
  controller.abort();
  await assert.rejects(pending, (e: unknown) => {
    assert.ok(e instanceof DapProtocolError);
    assert.match((e as DapProtocolError).message, /cancelled/);
    return true;
  });
  const wire = wireJson();
  assert.equal(wire[1].command, 'cancel');
  assert.equal(wire[1].arguments.requestId, 1);
  assert.equal('seq' in wire[1].arguments, false);
  assert.equal(client.pendingCount(), 0);
});

test('peer teardown rejects every in-flight request with the given reason', async () => {
  const { client, wireJson } = makeClient();
  const p1 = client.request('threads');
  const p2 = client.request('scopes');
  assert.equal(client.pendingCount(), 2);
  client.cancelPending('session closed');
  await assert.rejects(p1, /session closed/);
  await assert.rejects(p2, /session closed/);
  assert.equal(client.pendingCount(), 0);
  // Without cancelSupported, NO cancel frames are written on teardown:
  assert.equal(wireJson().filter((w) => w.command === 'cancel').length, 0);
});

test('peer teardown WITH cancelSupported tells the adapter about each outstanding request', async () => {
  const { client, wireJson } = makeClient();
  const p1 = client.request('threads');
  client.cancelPending('session closed', true);
  await assert.rejects(p1, /session closed/);
  const wire = wireJson();
  const cancels = wire.filter((w) => w.command === 'cancel');
  assert.equal(cancels.length, 1);
  assert.equal(cancels[0].arguments.requestId, 1);
});
