import test from 'node:test';
import assert from 'node:assert/strict';
import { RPC_FRAME_BOUND, RPC_PENDING_BOUND, RpcFailure, RpcPeer, type RpcHandlers } from '../src/acp/jsonrpc.js';
import { ApprovalBinding } from '../src/acp/approvalBinding.js';
import { ACP_CAPABILITIES, acpPolicy } from '../src/acp/policy.js';
import { ACP_PROTOCOL_VERSION } from '../src/acp/protocol.js';

/**
 * m-7 RPC hardening. All streams are fake in-memory sinks — no network, no process.
 *
 * The policy-enabled peer models the production wire (`shadow acp`): the FIRST request must be
 * `initialize` with the exact supported protocol version; capabilities are negotiated there;
 * `tool_cancel` force-aborts in-flight operations; every permission ask is sealed to its own
 * (wire id, exact params) and the response must echo the seal.
 */

interface Wire {
  peer: RpcPeer;
  lines: string[];
  messages: () => Array<Record<string, unknown>>;
  feed: (chunk: string) => { backpressure: boolean; dead: boolean };
  send: (msg: Record<string, unknown>) => void;
  deadReason: () => string | undefined;
  drained: () => number;
}

function makeWire(handlers: RpcHandlers, opts?: { policy?: boolean }): Wire {
  const lines: string[] = [];
  let deadReason: string | undefined;
  let drains = 0;
  const peer = new RpcPeer(
    (line) => lines.push(line),
    handlers,
    {
      ...(opts?.policy ? { policy: acpPolicy() } : {}),
      onDead: (reason) => { deadReason = reason; },
      onDrain: () => { drains++; },
    },
  );
  return {
    peer,
    lines,
    messages: () => lines.map((l) => JSON.parse(l) as Record<string, unknown>),
    feed: (chunk) => peer.feed(chunk),
    send: (msg) => peer.feed(`${JSON.stringify(msg)}\n`),
    deadReason: () => deadReason,
    drained: () => drains,
  };
}

/** A policy-mode peer that has completed the versioned handshake with full capabilities. */
function makeInitializedWire(handlers: RpcHandlers, capabilities: string[] = [...ACP_CAPABILITIES]): Wire {
  const wire = makeWire(handlers, { policy: true });
  wire.send({
    jsonrpc: '2.0', id: 1, method: 'initialize',
    params: { protocolVersion: ACP_PROTOCOL_VERSION, capabilities },
  });
  return wire;
}

function lastMessage(wire: Wire): Record<string, unknown> {
  const msgs = wire.messages();
  assert.ok(msgs.length > 0, 'expected at least one wire message');
  return msgs[msgs.length - 1] as Record<string, unknown>;
}

function errOf(msg: Record<string, unknown>): { code: number; message: string } {
  const error = msg.error as { code: number; message: string } | undefined;
  assert.ok(error, 'expected an error response');
  return error;
}

const okHandlers: RpcHandlers = {
  request: async () => ({ ok: true }),
  notification: () => {},
};

// (a) oversized frame errors + closes the connection ---------------------------------------------
test('a: a frame over 1 MiB errors the peer and closes the connection', () => {
  const wire = makeWire(okHandlers);
  const bigFrame = `{"jsonrpc":"2.0","id":1,"method":"x","pad":"${'A'.repeat(RPC_FRAME_BOUND)}"}\n`;
  const { dead } = wire.feed(bigFrame);
  assert.equal(dead, true);
  assert.match(wire.deadReason() ?? '', /frame too large/);
  assert.equal(errOf(lastMessage(wire)).code, -32000);
  assert.match(errOf(lastMessage(wire)).message, /frame too large/);
  // dead: no further input is accepted and no further output leaves
  const before = wire.lines.length;
  wire.feed('{"jsonrpc":"2.0","id":2,"method":"x"}\n');
  assert.equal(wire.lines.length, before);
  assert.ok(wire.peer.isDead());
});

test('a: an oversized frame built across chunks dies the moment it crosses the bound', () => {
  const wire = makeWire(okHandlers);
  const half = 'X'.repeat(RPC_FRAME_BOUND / 2 + 1);
  const { dead: d1 } = wire.feed(`{"id":1,"pad":"${half}`);
  assert.equal(d1, false); // still under the bound
  const { dead: d2 } = wire.feed(`${half}"}\n`);
  assert.equal(d2, true); // the completed frame crosses the bound
  assert.match(wire.deadReason() ?? '', /frame too large/);
  assert.equal(errOf(lastMessage(wire)).code, -32000);
  assert.ok(wire.peer.isDead());
});

// (b) backpressure at the pending bound -----------------------------------------------------------
test('b: feed reports backpressure at the pending bound and never drops a frame', async () => {
  let release: (() => void) | undefined;
  const gate = new Promise<void>((r) => { release = r; });
  let executed = 0;
  const handlers: RpcHandlers = {
    request: async () => {
      executed++;
      if (executed <= RPC_PENDING_BOUND) await gate; // hold the first 64 in flight
      return { n: executed };
    },
    notification: () => {},
  };
  const busy = makeWire(handlers);
  // 64 requests fill the bound exactly; every one gets exactly one response.
  for (let i = 1; i <= RPC_PENDING_BOUND; i++) {
    busy.send({ jsonrpc: '2.0', id: i, method: 'hold' });
  }
  assert.equal(busy.peer.inflightCount(), RPC_PENDING_BOUND);
  const { backpressure } = busy.feed(''); // boundary probe
  assert.equal(backpressure, true);
  assert.equal(busy.drained(), 0);
  // the frame that arrives while backpressured is answered, never executed, never recorded…
  busy.send({ jsonrpc: '2.0', id: RPC_PENDING_BOUND + 1, method: 'hold' });
  assert.equal(errOf(lastMessage(busy)).code, -32004);
  assert.equal(busy.peer.inflightCount(), RPC_PENDING_BOUND); // …so it stays retryable
  release!();
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(busy.peer.inflightCount(), 0);
  assert.equal(busy.drained(), 1); // onDrain fired exactly once when the queue drained
  // …and the refused frame CAN now be retried (its id carries no outcome record).
  busy.send({ jsonrpc: '2.0', id: RPC_PENDING_BOUND + 1, method: 'hold' });
  await new Promise((r) => setTimeout(r, 20)); // the retry's reply lands in a microtask
  // the LAST line for this id is the post-drain result; the first was the overload refusal.
  const retried = busy.messages().filter((m) => m.id === RPC_PENDING_BOUND + 1).at(-1) as { result?: { n?: number } };
  assert.equal(retried.result?.n, RPC_PENDING_BOUND + 1);
  assert.equal(executed, RPC_PENDING_BOUND + 1); // exactly one execution per request
});

// (c) wrong protocol version rejected specifically -----------------------------------------------
test('c: an unsupported protocol version is rejected specifically and kills the connection', () => {
  const wire = makeWire(okHandlers, { policy: true });
  wire.send({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: 99, capabilities: [] } });
  const err = errOf(lastMessage(wire));
  assert.equal(err.code, -32002);
  assert.match(err.message, /unsupported protocol version/);
  assert.ok(wire.peer.isDead());
  assert.match(wire.deadReason() ?? '', /unsupported protocol version/);
  // the dead peer accepts no further input
  const before = wire.lines.length;
  wire.feed('{"jsonrpc":"2.0","id":2,"method":"initialize","params":{"protocolVersion":1}}\n');
  assert.equal(wire.lines.length, before);
});

// (d) missing initialize rejected ---------------------------------------------------------------
test('d: a first request that is not initialize is refused with `initialize required`', async () => {
  const wire = makeWire(okHandlers, { policy: true });
  wire.send({ jsonrpc: '2.0', id: 1, method: 'session/new', params: {} });
  const err = errOf(lastMessage(wire));
  assert.equal(err.code, -32001);
  assert.match(err.message, /initialize required/);
  assert.ok(!wire.peer.isDead()); // the peer survives; the session never starts
  // nothing executes until the handshake happens — not even a different method
  wire.send({ jsonrpc: '2.0', id: 2, method: 'session/load', params: {} });
  assert.equal(errOf(lastMessage(wire)).code, -32001);
  // and the handshake itself still works afterwards
  wire.send({ jsonrpc: '2.0', id: 3, method: 'initialize', params: { protocolVersion: ACP_PROTOCOL_VERSION, capabilities: [] } });
  await new Promise((r) => setTimeout(r, 10)); // the reply lands in a microtask
  assert.ok((lastMessage(wire) as { result?: unknown }).result !== undefined);
  assert.ok(!wire.peer.isDead());
});

// (e) un-negotiated capability refused ------------------------------------------------------------
test('e: a method whose capability was never negotiated is refused', async () => {
  const wire = makeWire(okHandlers, { policy: true });
  wire.send({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: ACP_PROTOCOL_VERSION, capabilities: ['session'] } });
  await new Promise((r) => setTimeout(r, 10));
  wire.send({ jsonrpc: '2.0', id: 2, method: 'session/new', params: {} }); // negotiated → allowed
  await new Promise((r) => setTimeout(r, 10));
  assert.ok((lastMessage(wire) as { result?: unknown }).result !== undefined);
  wire.send({ jsonrpc: '2.0', id: 3, method: 'session/prompt', params: {} }); // NOT negotiated
  const err = errOf(lastMessage(wire));
  assert.equal(err.code, -32003);
  assert.match(err.message, /capability not negotiated: prompt/);
  assert.ok(!wire.peer.isDead());
  // negotiating later does not help: capabilities are negotiated ONLY at initialize
  wire.send({ jsonrpc: '2.0', id: 4, method: 'session/prompt', params: {} });
  assert.equal(errOf(lastMessage(wire)).code, -32003);
});

// (f) duplicate request id returns the ORIGINAL outcome with no double side effect --------------
test('f: a duplicate request id returns the ORIGINAL outcome and never executes twice', async () => {
  let sideEffects = 0;
  const handlers: RpcHandlers = {
    request: async () => { sideEffects++; return { sideEffects }; },
    notification: () => {},
  };
  const wire = makeWire(handlers);
  wire.send({ jsonrpc: '2.0', id: 42, method: 'inc', params: { n: 1 } });
  await new Promise((r) => setTimeout(r, 10));
  assert.equal(sideEffects, 1);
  assert.equal((lastMessage(wire) as { result?: { sideEffects?: number } }).result?.sideEffects, 1);
  // same id, same content → the ledger answers with the original record; NO second execution
  wire.send({ jsonrpc: '2.0', id: 42, method: 'inc', params: { n: 1 } });
  await new Promise((r) => setTimeout(r, 10));
  assert.equal(sideEffects, 1);
  assert.equal((lastMessage(wire) as { result?: { sideEffects?: number } }).result?.sideEffects, 1);
  // same id, DIFFERENT content → typed id-reuse refusal; still no execution
  wire.send({ jsonrpc: '2.0', id: 42, method: 'inc', params: { n: 2 } });
  await new Promise((r) => setTimeout(r, 10));
  assert.equal(errOf(lastMessage(wire)).code, -32006);
  assert.equal(sideEffects, 1);
  // a FRESH id executes exactly once more — the ledger blocks reuse, not new work
  wire.send({ jsonrpc: '2.0', id: 43, method: 'inc', params: { n: 2 } });
  await new Promise((r) => setTimeout(r, 10));
  assert.equal(sideEffects, 2);
});

// (g) malformed line does not kill the peer -------------------------------------------------------
test('g: a malformed line is answered, never processed, and the peer stays usable', async () => {
  const wire = makeWire(okHandlers);
  wire.feed('this is not JSON\n');
  assert.equal(errOf(lastMessage(wire)).code, -32700);
  // the peer survives and the next VALID request works
  wire.send({ jsonrpc: '2.0', id: 7, method: 'ok', params: {} });
  await new Promise((r) => setTimeout(r, 10));
  assert.ok((lastMessage(wire) as { result?: unknown }).result !== undefined);
  // a bad line with a salvageable id is answered with that id so the client can correlate
  wire.feed('{"jsonrpc":"2.0","id":9,"method":\n');
  assert.equal(errOf(lastMessage(wire)).code, -32700);
  assert.equal((lastMessage(wire) as { id?: unknown }).id, 9);
  assert.ok(!wire.peer.isDead());
  // and the stream still works afterwards
  wire.send({ jsonrpc: '2.0', id: 10, method: 'ok', params: {} });
  await new Promise((r) => setTimeout(r, 10));
  assert.ok((lastMessage(wire) as { result?: unknown }).result !== undefined);
  assert.ok(!wire.peer.isDead());
});

// (h) cancellation aborts in-flight ---------------------------------------------------------------
test('h: tool_cancel force-aborts a never-resolving operation with a typed error', async () => {
  const wire = makeInitializedWire({
    request: (method, _params, ctx) =>
      method === 'tool_call'
        ? new Promise((_resolve, reject) => {
            // a never-resolving handler that only settles on the abort signal
            ctx.signal.addEventListener('abort', () => reject(new RpcFailure(-32005, 'operation cancelled by client')), { once: true });
          })
        : Promise.resolve({ ok: true }),
    notification: () => {},
  });
  wire.send({ jsonrpc: '2.0', id: 5, method: 'tool_call', params: { toolCallId: 't1' } });
  await new Promise((r) => setTimeout(r, 10));
  assert.equal(wire.peer.inflightCount(), 1); // the handler never resolves on its own
  wire.send({ jsonrpc: '2.0', method: 'tool_cancel', params: { toolCallId: 't1' } }); // notification
  await new Promise((r) => setTimeout(r, 10));
  assert.equal(errOf(lastMessage(wire)).code, -32005);
  assert.equal((lastMessage(wire) as { id?: unknown }).id, 5);
  assert.equal(wire.peer.inflightCount(), 0);
  assert.ok(!wire.peer.isDead());
  // a late handler result is discarded: nothing more arrives for that id
  const before = wire.lines.length;
  await new Promise((r) => setTimeout(r, 10));
  assert.equal(wire.lines.length, before);
  // the cancel surface requires its own negotiated capability
  const bare = makeWire(okHandlers, { policy: true });
  bare.send({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: ACP_PROTOCOL_VERSION, capabilities: ['session'] } });
  bare.send({ jsonrpc: '2.0', method: 'tool_cancel', params: { toolCallId: 't1' } });
  bare.send({ jsonrpc: '2.0', id: 2, method: 'tool_call', params: { toolCallId: 't2' } });
  assert.equal(errOf(lastMessage(bare)).code, -32003); // tool_call needs `cancellation`
});

// (i) approval spoofing: an approval for A cannot authorize B ------------------------------------
test('i: an approval recorded for request A cannot authorize request B', () => {
  const binding = new ApprovalBinding();
  const paramsA = { sessionId: 's1', options: [{ callToolId: 'write_file', kind: 'edit_file' }], assertions: { edits: [{ title: 'x', diff: 'y' }] } };
  const paramsB = { sessionId: 's1', options: [{ callToolId: 'write_file', kind: 'edit_file' }], assertions: { edits: [{ title: 'z', diff: 'zzz' }] } };
  assert.notEqual(binding.digestOf(paramsA), binding.digestOf(paramsB)); // A and B differ

  // the operator approves A: the seal is minted under A's OWN id against A's exact params
  const digestA = binding.seal('1', paramsA);
  assert.ok(binding.authorize('1', digestA, paramsA).ok); // first use: authorized, seal burned

  // spoof 1 — replay A's approval a second time: the seal burned, single-use
  const replay = binding.authorize('1', digestA, paramsA);
  assert.equal(replay.ok, false);
  assert.equal(replay.ok === false && replay.reason, 'no approval recorded for request 1');

  // spoof 2 — present A's approval under B's request id: no seal exists for B
  const crossId = binding.authorize('2', digestA, paramsB);
  assert.equal(crossId.ok, false);
  assert.equal(crossId.ok === false && crossId.reason, 'no approval recorded for request 2');

  // spoof 3 — the decisive mechanical case: A's id with A's digest, but executing B's params.
  // The content hash of B does not equal the sealed digest → refuse.
  const binding2 = new ApprovalBinding();
  const dA2 = binding2.seal('1', paramsA);
  const contentSpoof = binding2.authorize('1', dA2, paramsB);
  assert.equal(contentSpoof.ok, false);
  assert.equal(contentSpoof.ok === false && contentSpoof.reason, 'approval does not match request');

  // spoof 4 — a tampered digest (not the sealed one) is refused by constant-time comparison
  const binding3 = new ApprovalBinding();
  binding3.seal('1', paramsA);
  const tampered = binding3.authorize('1', `${'0'.repeat(63)}1`, paramsA);
  assert.equal(tampered.ok, false);
  assert.equal(tampered.ok === false && tampered.reason, 'approval does not match request');

  // NOT spoofing — a key-order permutation of the APPROVED params: the canonical digest is
  // order-independent, so reordering must not cause a false refusal.
  const binding4 = new ApprovalBinding();
  const dA4 = binding4.seal('1', paramsA);
  const permutedA = { assertions: paramsA.assertions, sessionId: paramsA.sessionId, options: paramsA.options };
  assert.ok(binding4.authorize('1', dA4, permutedA).ok);
});

test('i: a non-echoing editor approval is refused on the production path', () => {
  // cli.ts seals each ask under its wire id and authorizes against the response's echo: an
  // editor that does not echo _meta.approvalDigest cannot approve anything here.
  const approvalBinding = new ApprovalBinding();
  const params = { sessionId: 's1', options: [] };
  const wireId = '17';
  approvalBinding.seal(wireId, params);
  const editorResponse = { outcome: { behavior: 'allow', updatedInput: {} } }; // NO _meta echo
  const verdict = approvalBinding.authorize(wireId, approvalBinding.echoOf(editorResponse), params);
  assert.equal(verdict.ok, false);
  assert.equal(verdict.ok === false && verdict.reason, 'approval does not match request');
});
