import { test } from 'node:test';
import assert from 'node:assert/strict';
import { RpcPeer, type RpcHandlers } from '../src/acp/jsonrpc.js';
import { acpPolicy, ACP_CAPABILITIES } from '../src/acp/policy.js';
import { M_SESSION_REQUEST_PERMISSION, ACP_PROTOCOL_VERSION } from '../src/acp/protocol.js';
import { ApprovalBinding } from '../src/acp/approvalBinding.js';

/**
 * m-14 security fix (RPC review V1): the approval digest must RIDE THE WIRE in
 * `_meta.approvalDigest`. A spec-compliant editor can only echo what it
 * actually received; before the fix the params were sent unmodified, the
 * editor never saw the digest, authorize() always failed, and the approvals
 * capability was a total-deny in production.
 *
 * These tests drive the REAL wire semantics — the exact sealing logic cli.ts
 * uses (seal on send, `_meta.approvalDigest` injected before serialization)
 * against a policy-mode RpcPeer with a completed versioned handshake — then a
 * spec-compliant echo is applied.
 */

const okHandlers: RpcHandlers = {
  request: async () => ({ ok: true }),
  notification: () => {},
};

function makeEditorWire() {
  const lines: string[] = [];
  const peer = new RpcPeer(
    (line) => lines.push(line),
    okHandlers,
    { policy: acpPolicy(), onDead: () => undefined },
  );
  // Complete the versioned handshake exactly as the production editor does:
  peer.feed(
    `${JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: { protocolVersion: ACP_PROTOCOL_VERSION, capabilities: [...ACP_CAPABILITIES] },
    })}\n`,
  );
  return { lines, peer };
}

/** The production askPermission closure logic from src/acp/cli.ts, verbatim in shape. */
function sealedAsk(peer: RpcPeer, approvalBinding: ApprovalBinding) {
  return async (params: Record<string, unknown>): Promise<unknown> => {
    let wireId = '';
    try {
      const sealed: Record<string, unknown> = { ...params };
      const result = await peer.request(M_SESSION_REQUEST_PERMISSION, sealed, {
        onSend: (id) => {
          wireId = String(id);
          sealed._meta = { approvalDigest: approvalBinding.seal(wireId, params) };
        },
      });
      const verdict = approvalBinding.authorize(wireId, approvalBinding.echoOf(result), params);
      return verdict.ok ? result : undefined;
    } catch {
      approvalBinding.unseal(wireId);
      return undefined;
    }
  };
}

function parseAskFrame(lines: string[]) {
  const frame = lines.find((f) => f.includes(M_SESSION_REQUEST_PERMISSION));
  assert.ok(frame, 'a request_permission frame must have been written to the wire');
  return JSON.parse(frame) as {
    id?: unknown;
    params?: { _meta?: { approvalDigest?: string }; method?: string };
  };
}

test('the approval digest rides the wire — a spec-compliant editor receives it (m-14 RPC V1)', async () => {
  const approvalBinding = new ApprovalBinding();
  const { lines, peer } = makeEditorWire();
  const ask = sealedAsk(peer, approvalBinding);

  const asked = ask({ method: 'bash', toolInput: { cmd: 'ls' } });
  await new Promise((r) => setTimeout(r, 20));

  const parsed = parseAskFrame(lines);
  assert.equal(parsed.params?.method, 'bash', 'the original params ride alongside');
  const digest = parsed.params?._meta?.approvalDigest;
  assert.equal(typeof digest, 'string', 'the approval digest rides the wire in _meta');
  assert.ok(digest!.length >= 64, 'the digest must be a real sha256 hex value');

  // Settle the pending ask the way a refusing editor would (error response).
  // The id must be echoed EXACTLY as it appeared on the wire (type included):
  peer.feed(
    `{"id":${JSON.stringify(parsed.id)},"jsonrpc":"2.0","error":{"code":-32603,"message":"editor refused"}}\n`,
  );
  assert.equal(await asked, undefined, 'the refused ask fails closed');
});

test('a spec-compliant echoing editor passes authorize — the loop closes end-to-end (m-14 RPC V1b)', async () => {
  const approvalBinding = new ApprovalBinding();
  const { lines, peer } = makeEditorWire();
  const ask = sealedAsk(peer, approvalBinding);

  const asked = ask({ method: 'bash', toolInput: { cmd: 'ls' } });
  await new Promise((r) => setTimeout(r, 20));

  const parsed = parseAskFrame(lines);
  const echo = parsed.params?._meta?.approvalDigest ?? '';
  assert.ok(echo.length >= 64, 'the editor must have a digest to echo');

  // The editor answers with the SAME digest it received on the wire:
  peer.feed(
    `{"id":${JSON.stringify(parsed.id)},"jsonrpc":"2.0","result":{"outcome":"allow","_meta":{"approvalDigest":${JSON.stringify(echo)}}}}\n`,
  );
  const result = (await asked) as { outcome?: string } | undefined;
  assert.equal(result?.outcome, 'allow', 'the echoing editor’s decision is accepted');
});

test('a non-echoing (spoofed) editor fails closed to deny (m-14 RPC V1c)', async () => {
  const approvalBinding = new ApprovalBinding();
  const { lines, peer } = makeEditorWire();
  const ask = sealedAsk(peer, approvalBinding);

  const asked = ask({ method: 'bash', toolInput: { cmd: 'ls' } });
  await new Promise((r) => setTimeout(r, 20));

  const parsed = parseAskFrame(lines);
  // The editor answers WITHOUT the digest echo — the pre-fix behavior of every real editor:
  peer.feed(`{"id":${JSON.stringify(parsed.id)},"jsonrpc":"2.0","result":{"outcome":"allow"}}\n`);
  assert.equal(await asked, undefined, 'a non-echoing response fails closed to deny');
});
