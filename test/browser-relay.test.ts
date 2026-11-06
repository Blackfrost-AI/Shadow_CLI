import test from 'node:test';
import assert from 'node:assert/strict';
import { connect } from 'node:net';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  attachDigest,
  BrowserRelayError,
  createBrowserRelay,
  grantDigest,
  RELAY_ACTIONS,
  RELAY_BIND_HOST,
  type RelayApprovalRequest,
  type RelayTarget,
} from '../src/web/browserRelay.js';

/**
 * Mission m-11 tests. Fully in-memory request/response fixtures drive the same
 * dispatcher the loopback listener forwards into — no real browser anywhere.
 * The single socket test proves the listener's actual bind address.
 */

const TAB: RelayTarget = { kind: 'tab', id: 'tab-A17', label: 'operator chosen: docs tab' };
const OTHER_TAB: RelayTarget = { kind: 'tab', id: 'tab-B99', label: 'some other tab' };

/** An operator that approves everything they are shown, verbatim (the digest). */
function autoApprove(): { ask: (r: RelayApprovalRequest) => Promise<string | undefined>; seen: RelayApprovalRequest[] } {
  const seen: RelayApprovalRequest[] = [];
  return {
    seen,
    ask: async (r) => { seen.push(r); return r.digest; },
  };
}

/** An operator that refuses everything. */
const refuseAll = { ask: async () => undefined };

/** Build the in-memory fixture headers a request would arrive with. */
function fixture(port: number | null, token: string | null, over: Record<string, string> = {}) {
  return {
    host: over.host ?? `${RELAY_BIND_HOST}:${port ?? 0}`,
    origin: over.origin ?? `http://${RELAY_BIND_HOST}:${port ?? 0}`,
    ...(over.referer !== undefined ? { referer: over.referer } : {}),
    authorization: over.authorization ?? `Bearer ${token ?? 'none'}`,
  };
}

async function attachedRelay(dispatch?: (request: { action: never; target: RelayTarget; detail: Record<string, unknown> }) => Promise<unknown>) {
  const op = autoApprove();
  const relay = createBrowserRelay({ ask: op.ask, dispatch: dispatch as never });
  await relay.operator.attach(TAB);
  return { relay, op };
}

// --- default posture: nothing exists until an operator explicitly attaches ------

test('relay defaults to disabled: no port, no listener, nothing answers', async () => {
  const relay = createBrowserRelay({ ask: refuseAll.ask });
  const status = relay.operator.status();
  assert.equal(status.attached, false);
  assert.equal(status.listening, false);
  assert.equal(status.port, null);
  assert.equal(status.grantedActions.length, 0);
  // The dispatcher refuses before any attachment exists: fail closed.
  const token = relay.operator.token();
  const response = await relay.handle({
    path: '/action/navigate',
    method: 'POST',
    headers: fixture(null, token),
    body: { targetId: TAB.id },
  });
  assert.equal(response.status, 403); // no listener ⇒ channel illegitimate ⇒ 403
  assert.deepEqual(response.body, { error: 'refused' });
  await relay.operator.close();
});

test('attach requires explicit operator approval', async () => {
  const relay = createBrowserRelay({ ask: refuseAll.ask });
  await assert.rejects(() => relay.operator.attach(TAB), /operator refused attach/);
  assert.equal(relay.operator.status().attached, false);
  assert.equal(relay.operator.status().port, null);
  assert.equal(relay.operator.boundAddress(), null);
  await relay.operator.close();
});

test('attach approval is bound to the exact target digest', async () => {
  const relay = createBrowserRelay({
    ask: async () => attachDigest({ ...TAB, id: 'tab-OTHER' }), // approves a DIFFERENT target
  });
  await assert.rejects(() => relay.operator.attach(TAB), /operator refused attach/);
  assert.equal(relay.operator.status().attached, false);
  await relay.operator.close();
});

test('a refused attach leaves no port and nothing answers', async () => {
  const relay = createBrowserRelay({ ask: refuseAll.ask });
  await assert.rejects(() => relay.operator.attach(OTHER_TAB), /operator refused attach/);
  assert.equal(relay.operator.boundAddress(), null);
  await relay.operator.close();
});

// --- authentication -----------------------------------------------------------

test('missing token is rejected', async () => {
  const { relay } = await attachedRelay();
  const port = relay.operator.status().port!;
  const response = await relay.handle({
    path: '/action/navigate',
    method: 'POST',
    headers: fixture(port, null, { authorization: '' }),
    body: { targetId: TAB.id },
  });
  assert.equal(response.status, 401);
  assert.deepEqual(response.body, { error: 'refused' });
  await relay.operator.close();
});

test('wrong token is rejected with the same shape as a missing one', async () => {
  const { relay } = await attachedRelay();
  const port = relay.operator.status().port!;
  const missing = await relay.handle({
    path: '/action/navigate', method: 'POST',
    headers: fixture(port, null, { authorization: '' }), body: { targetId: TAB.id },
  });
  const wrong = await relay.handle({
    path: '/action/navigate', method: 'POST',
    headers: fixture(port, 'definitely-not-the-token'), body: { targetId: TAB.id },
  });
  assert.equal(wrong.status, 401);
  assert.deepEqual(wrong.body, missing.body, 'wrong-token rejection must look identical to missing-token');
  assert.deepEqual(wrong.headers, missing.headers);
  await relay.operator.close();
});

test('the token never appears in any refusal body or header', async () => {
  const { relay } = await attachedRelay();
  const port = relay.operator.status().port!;
  const token = relay.operator.token()!;
  const response = await relay.handle({
    path: '/action/navigate', method: 'POST',
    headers: fixture(port, 'wrong-token-value'), body: { targetId: TAB.id },
  });
  const text = JSON.stringify(response);
  assert.ok(!text.includes(token), 'the session token must never appear in any response');
  await relay.operator.close();
});

// --- origin validation --------------------------------------------------------

test('hostile origin is rejected with 403 and no detail leak', async () => {
  const { relay } = await attachedRelay();
  const port = relay.operator.status().port!;
  for (const origin of [
    'http://evil.com',
    `http://127.0.0.1:${port + 1}`,
    'null',
    'https://127.0.0.1',
  ]) {
    const response = await relay.handle({
      path: '/action/navigate', method: 'POST',
      headers: fixture(port, relay.operator.token(), { origin }), body: { targetId: TAB.id },
    });
    assert.equal(response.status, 403, origin);
    assert.deepEqual(response.body, { error: 'refused' }, 'no detail leak');
  }
  await relay.operator.close();
});

test('missing origin is rejected (the relay has one legitimate client, which asserts it)', async () => {
  const { relay } = await attachedRelay();
  const port = relay.operator.status().port!;
  const headers = fixture(port, relay.operator.token());
  delete (headers as Record<string, unknown>).origin;
  const response = await relay.handle({
    path: '/action/navigate', method: 'POST', headers, body: { targetId: TAB.id },
  });
  assert.equal(response.status, 403);
  assert.deepEqual(response.body, { error: 'refused' });
  await relay.operator.close();
});

test('hostile Host (DNS rebinding) is rejected before any other check', async () => {
  const { relay } = await attachedRelay();
  const port = relay.operator.status().port!;
  for (const host of [`evil.com:${port}`, `localhost:${port}`, '[::1]:1', '127.0.0.1']) {
    const response = await relay.handle({
      path: '/action/navigate', method: 'POST',
      headers: fixture(port, relay.operator.token(), { host }), body: { targetId: TAB.id },
    });
    assert.equal(response.status, 403, host);
    assert.deepEqual(response.body, { error: 'refused' }, host);
  }
  await relay.operator.close();
});

test('a foreign Referer is rejected', async () => {
  const { relay } = await attachedRelay();
  const port = relay.operator.status().port!;
  const response = await relay.handle({
    path: '/action/navigate', method: 'POST',
    headers: fixture(port, relay.operator.token(), { referer: 'http://evil.com/page' }),
    body: { targetId: TAB.id },
  });
  assert.equal(response.status, 403);
  assert.deepEqual(response.body, { error: 'refused' });
  await relay.operator.close();
});

// --- scoped targets ------------------------------------------------------------

test('requests for any other tab/profile are refused', async () => {
  const { relay } = await attachedRelay();
  const port = relay.operator.status().port!;
  await relay.operator.grant('navigate');
  for (const other of [OTHER_TAB.id, 'profile-X', '']) {
    const response = await relay.handle({
      path: '/action/navigate', method: 'POST',
      headers: fixture(port, relay.operator.token()),
      body: { targetId: other },
    });
    assert.equal(response.status, 403, other);
    assert.equal((response.body as { error: string }).error, 'scoped target mismatch');
  }
  await relay.operator.close();
});

// --- action-grant separation ---------------------------------------------------

test('a navigation grant does not allow click (no blanket grant)', async () => {
  const { relay } = await attachedRelay();
  const port = relay.operator.status().port!;
  await relay.operator.grant('navigate');
  assert.deepEqual(relay.operator.status().grantedActions, ['navigate']);
  const response = await relay.handle({
    path: '/action/click', method: 'POST',
    headers: fixture(port, relay.operator.token()),
    body: { targetId: TAB.id, detail: { selector: '#buy' } },
  });
  assert.equal(response.status, 403);
  assert.match((response.body as { error: string }).error, /no operator grant for click/);
  await relay.operator.close();
});

test('each of the four actions needs its own operator approval', async () => {
  const op = autoApprove();
  const relay = createBrowserRelay({ ask: op.ask });
  await relay.operator.attach(TAB);
  const port = relay.operator.status().port!;
  // Nothing is granted initially.
  for (const action of RELAY_ACTIONS) {
    const response = await relay.handle({
      path: `/action/${action}`, method: 'POST',
      headers: fixture(port, relay.operator.token()), body: { targetId: TAB.id },
    });
    assert.equal(response.status, 403, action);
    assert.match((response.body as { error: string }).error, /no operator grant/);
  }
  // Each grant prompts the operator separately.
  await relay.operator.grant('click');
  assert.deepEqual(relay.operator.status().grantedActions, ['click']);
  await relay.operator.grant('form-fill');
  assert.deepEqual(relay.operator.status().grantedActions, ['click', 'form-fill']);
  const kinds = op.seen.map((r) => r.kind);
  assert.deepEqual(kinds.slice(0, 3), ['attach', 'grant', 'grant']);
  assert.deepEqual(op.seen[1]!.action, 'click');
  assert.deepEqual(op.seen[2]!.action, 'form-fill');
  // And the operator was shown distinct digests for distinct actions.
  assert.notEqual(op.seen[1]!.digest, op.seen[2]!.digest);
  await relay.operator.close();
});

test('a grant is bound to the exact target and cannot be replayed against another', async () => {
  const op = autoApprove();
  const relay = createBrowserRelay({ ask: op.ask });
  await relay.operator.attach(TAB);
  const port = relay.operator.status().port!;
  await relay.operator.grant('navigate');
  // A second target attached on the same relay must not inherit the grant.
  await relay.operator.attach(OTHER_TAB);
  assert.deepEqual(relay.operator.status().grantedActions, [], 'no grant survives a re-attach');
  const response = await relay.handle({
    path: '/action/navigate', method: 'POST',
    headers: fixture(port, relay.operator.token()), body: { targetId: OTHER_TAB.id },
  });
  assert.equal(response.status, 403);
  await relay.operator.close();
});

// --- stale attachment ----------------------------------------------------------

test('after a simulated disconnect, every action is refused with a stale-attachment error', async () => {
  const { relay } = await attachedRelay();
  const port = relay.operator.status().port!;
  await relay.operator.grant('navigate');
  await relay.operator.grant('read-dom');
  // Simulated broker disconnect.
  const gone = await relay.handle({
    path: '/disconnect', method: 'POST',
    headers: fixture(port, relay.operator.token()), body: { targetId: TAB.id },
  });
  assert.equal(gone.status, 200);
  assert.equal(relay.operator.status().stale, true);
  assert.deepEqual(relay.operator.status().grantedActions, [], 'disconnect clears all grants');
  for (const action of ['navigate', 'read-dom'] as const) {
    const response = await relay.handle({
      path: `/action/${action}`, method: 'POST',
      headers: fixture(port, relay.operator.token()), body: { targetId: TAB.id },
    });
    assert.equal(response.status, 410, action);
    assert.match((response.body as { error: string }).error, /stale attachment/);
  }
  await relay.operator.close();
});

test('a stale attachment recovers only through a fresh explicit attach, with no surviving grants', async () => {
  const op = autoApprove();
  const relay = createBrowserRelay({ ask: op.ask });
  await relay.operator.attach(TAB);
  const port = relay.operator.status().port!;
  await relay.operator.grant('navigate');
  await relay.handle({
    path: '/disconnect', method: 'POST',
    headers: fixture(port, relay.operator.token()), body: { targetId: TAB.id },
  });
  // Grants are gone and the operator cannot grant onto the dead attachment.
  await assert.rejects(() => relay.operator.grant('click'), /stale attachment/);
  assert.equal(relay.operator.status().stale, true);
  // Fresh explicit attach clears stale and grants.
  await relay.operator.attach(TAB);
  assert.equal(relay.operator.status().stale, false);
  assert.deepEqual(relay.operator.status().grantedActions, []);
  await relay.operator.close();
});

// --- disconnect/teardown ------------------------------------------------------

test('close() kills the listener and clears grants, token, and audit log', async () => {
  const { relay } = await attachedRelay();
  const port = relay.operator.status().port!;
  const token = relay.operator.token()!;
  assert.ok(port, 'attached relay must have a loopback port');
  await relay.operator.grant('navigate');
  await relay.handle({
    path: '/action/navigate', method: 'POST',
    headers: fixture(port, token),
    body: { targetId: TAB.id, detail: { url: 'https://example.com/' } },
  }).catch(() => {});
  assert.ok(relay.operator.auditLog().length > 0);
  await relay.operator.close();
  assert.equal(relay.operator.status().closed, true);
  assert.equal(relay.operator.status().attached, false);
  assert.equal(relay.operator.status().grantedActions.length, 0);
  assert.equal(relay.operator.status().port, null);
  assert.equal(relay.operator.token(), null);
  assert.equal(relay.operator.auditLog().length, 0);
  // The socket is really dead: a connection attempt fails.
  await assert.rejects(() => new Promise<void>((resolve, reject) => {
    const socket = connect(port, RELAY_BIND_HOST, () => { socket.destroy(); resolve(); });
    socket.on('error', (e) => reject(e));
  }), /ECONNREFUSED|ECONNRESET/);
  // And a closed relay reattaches nothing.
  await assert.rejects(() => relay.operator.attach(TAB), /relay is closed/);
});

// --- redaction ----------------------------------------------------------------

test('cookie values and Authorization headers are redacted in logged output', async () => {
  const dispatch = async (req: { action: string; detail: Record<string, unknown> }): Promise<unknown> => ({
    echoed: req.detail,
    authorization: 'Bearer abc123def456',
    cookie: 'session=super-secret-cookie-value',
  });
  const { relay } = await attachedRelay(dispatch);
  const port = relay.operator.status().port!;
  await relay.operator.grant('read-dom');
  const response = await relay.handle({
    path: '/action/read-dom', method: 'POST',
    headers: fixture(port, relay.operator.token()),
    body: {
      targetId: TAB.id,
      detail: {
        cookie: 'session=hunter2-hunter2-hunter2',
        authorization: 'Bearer sk-live-SECRETKEY12345',
        selector: '.balance',
      },
    },
  });
  assert.equal(response.status, 200);
  const text = JSON.stringify(response.body);
  assert.ok(!text.includes('hunter2'), 'cookie value must not survive into results');
  assert.ok(!text.includes('SECRETKEY12345'), 'authorization value must not survive into results');
  assert.ok(!text.includes(relay.operator.token()!), 'the session token must not survive into results');
  // ...and the audit log is equally redacted.
  const logText = JSON.stringify(relay.operator.auditLog());
  assert.ok(!logText.includes('hunter2'), 'cookie value must not survive into the audit log');
  assert.ok(!logText.includes('SECRETKEY12345'), 'authorization value must not survive into the audit log');
  // The credential KEYS are still visible for auditability, but values are gone.
  assert.ok(logText.includes('cookie'), 'credential key names remain auditable');
  assert.ok(logText.includes('[redacted]'), 'values are explicitly [redacted]');
  await relay.operator.close();
});

test('raw credential material never appears in the audit log even when the broker fails', async () => {
  const dispatch = async (): Promise<unknown> => { throw new Error('broker exploded'); };
  const { relay } = await attachedRelay(dispatch);
  const port = relay.operator.status().port!;
  await relay.operator.grant('form-fill');
  const response = await relay.handle({
    path: '/action/form-fill', method: 'POST',
    headers: fixture(port, relay.operator.token()),
    body: {
      targetId: TAB.id,
      detail: { authorization: 'Bearer rawtoken987654321', password: 'hunter2-hunter2' },
    },
  });
  assert.equal(response.status, 502);
  const logText = JSON.stringify(relay.operator.auditLog());
  assert.ok(!logText.includes('rawtoken987654321'));
  assert.ok(!logText.includes('hunter2-hunter2'));
  await relay.operator.close();
});

// --- transport honesty --------------------------------------------------------

test('with no broker transport, an authorized action fails closed instead of pretending', async () => {
  const { relay } = await attachedRelay(); // no dispatch
  const port = relay.operator.status().port!;
  await relay.operator.grant('navigate');
  const response = await relay.handle({
    path: '/action/navigate', method: 'POST',
    headers: fixture(port, relay.operator.token()), body: { targetId: TAB.id },
  });
  assert.equal(response.status, 503);
  assert.deepEqual(response.body, { error: 'no broker transport' });
  assert.equal(relay.operator.auditLog().at(-1)!.outcome, 'refused: no broker transport');
  await relay.operator.close();
});

// --- loopback binding: the one real socket test ---------------------------------

test('the listener binds 127.0.0.1 only — never 0.0.0.0 — and only while attached', async () => {
  const { relay } = await attachedRelay();
  const bound = relay.operator.boundAddress();
  assert.ok(bound, 'attached relay must have a bound address');
  assert.equal(bound.address, RELAY_BIND_HOST, 'must bind the literal loopback address');
  const port = bound.port;
  // A real loopback connect must reach the dispatcher (and be refused: no grant).
  const response = await new Promise<string>((resolve, reject) => {
    const socket = connect(port, RELAY_BIND_HOST, () => {
      socket.write(
        `POST /action/navigate HTTP/1.1\r\nHost: ${RELAY_BIND_HOST}:${port}\r\nOrigin: http://${RELAY_BIND_HOST}:${port}\r\nAuthorization: Bearer ${relay.operator.token()}\r\nContent-Length: 0\r\nConnection: close\r\n\r\n`,
      );
    });
    let data = '';
    socket.on('data', (chunk) => { data += chunk.toString(); });
    socket.on('end', () => resolve(data));
    socket.on('error', reject);
  });
  assert.match(response, /HTTP\/1\.1 403/, 'authenticated request for an ungranted action must be refused');
  assert.match(response, /scoped target mismatch|no operator grant/, response);
  await relay.operator.close();
  // After close, the port is dead.
  await assert.rejects(() => new Promise<void>((resolve, reject) => {
    const socket = connect(port, RELAY_BIND_HOST, () => { socket.destroy(); resolve(); });
    socket.on('error', (e) => reject(e));
  }), /ECONNREFUSED|ECONNRESET/);
});

test('isolated browsing defaults are untouched: no other module wires the relay in, and it imports no preset machinery', () => {
  const source = readFileSync('src/web/browserRelay.ts', 'utf8');
  // Import-surface assertion: only stdlib and the redaction utility may be imported.
  const imports = [...source.matchAll(/^import .*?from '([^']+)';/gm)].map((m) => m[1]);
  assert.deepEqual(imports.sort(), ['../util/redact.js', 'node:crypto', 'node:http', 'node:net'].sort());
  // No wiring into any default surface: nothing else in src/ references this module.
  const srcRoot = 'src';
  const referenced: string[] = [];
  const walk = (dir: string): void => {
    for (const entry of readdirSync(join(dir), { withFileTypes: true })) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) { walk(full); continue; }
      if (!entry.name.endsWith('.ts') && !entry.name.endsWith('.tsx')) continue;
      if (full === 'src/web/browserRelay.ts') continue;
      if (readFileSync(full, 'utf8').includes('browserRelay')) referenced.push(full);
    }
  };
  walk(srcRoot);
  assert.deepEqual(referenced, [], 'the relay must not be reachable from any default surface in this slice');
});

// --- digest-binding surface ---------------------------------------------------

test('digests are namespaced, per-action, and per-target', () => {
  const dA1 = grantDigest(TAB, 'navigate');
  const dA2 = grantDigest(TAB, 'click');
  const dB = grantDigest(OTHER_TAB, 'navigate');
  assert.notEqual(dA1, dA2, 'action separation is reflected in the digest');
  assert.notEqual(dA1, dB, 'target scoping is reflected in the digest');
  assert.notEqual(attachDigest(TAB), dA1, 'attach and grant digests never collide');
  assert.match(dA1, /^[0-9a-f]{64}$/, 'sha256 hex');
  const differentLabel = grantDigest({ ...TAB, label: 'relabelled' }, 'navigate');
  assert.notEqual(dA1, differentLabel, 'the label the operator saw is part of the binding');
});

test('BrowserRelayError carries its refusal status', () => {
  const e = new BrowserRelayError('stale attachment', 410, true);
  assert.equal(e.status, 410);
  assert.equal(e.expose, true);
});
