import test from 'node:test';
import assert from 'node:assert/strict';
import { request } from 'node:http';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { isolateHome, assertStoreIsolated } from './helpers/isolateHome.js';
import type { LoopEvent } from '../src/agent/events.js';
import type { ApprovalRequest } from '../src/agent/approval.js';
import type { AgentBuilder, TurnRunner, JailCapability } from '../src/web/registry.js';

// The browser approval channel end-to-end: WebApprovalGate (park + emit + settle), the registry's
// decide()/setAutonomy(), and the HTTP routes that reach them. Isolate ~/.shadow FIRST — the
// HTTP tests build a REAL agent (mock provider, no credentials/network). `npm test`, never bun.
const { home: HOME } = isolateHome('approval');

const store = await import('../src/state/globalStore.js');
assertStoreIsolated(store.GLOBAL_DIR, HOME);
const projects = await import('../src/web/projects.js');
const serverMod = await import('../src/web/server.js');
const { EventBus } = await import('../src/agent/events.js');
const { createSessionRegistry } = await import('../src/web/registry.js');
const { WebApprovalGate } = await import('../src/web/approvalGate.js');

(store as unknown as { saveGlobalConfig: (c: unknown) => void }).saveGlobalConfig({
  provider: 'mock',
  model: 'mock',
  projects: [],
});

const JAIL: JailCapability = { workspaceRoot: '/tmp/ws', additionalRoots: [] };

function http(
  port: number,
  method: string,
  path: string,
  token: string,
  body?: unknown,
): Promise<{ status: number; json: Record<string, unknown> }> {
  return new Promise((resolve, reject) => {
    const payload = body === undefined ? undefined : JSON.stringify(body);
    const r = request(
      {
        host: '127.0.0.1',
        port,
        path,
        method,
        headers: {
          host: `127.0.0.1:${port}`,
          authorization: `Bearer ${token}`,
          ...(payload ? { 'content-type': 'application/json', 'content-length': Buffer.byteLength(payload) } : {}),
        },
      },
      (res) => {
        let data = '';
        res.on('data', (c) => (data += c));
        res.on('end', () => resolve({ status: res.statusCode ?? 0, json: data ? JSON.parse(data) : {} }));
      },
    );
    r.on('error', reject);
    if (payload) r.write(payload);
    r.end();
  });
}

// -------------------------------------------------------------------------------------------------
// WebApprovalGate unit tests (registry-created session, no server)
// -------------------------------------------------------------------------------------------------

const noopBuilder: AgentBuilder = async () => ({
  agent: { bg: { killAll: () => {} }, wakeup: { clear: () => {} } } as never,
  mcp: [],
  jail: JAIL,
});
const noopTurn: TurnRunner = async () => {};

function gateFixture() {
  const registry = createSessionRegistry({ builder: noopBuilder, runTurn: noopTurn });
  const session = registry.create({ projectRoot: '/tmp/ws' });
  const seen: LoopEvent[] = [];
  session.bus.on((e) => seen.push(e));
  const gate = new WebApprovalGate(session);
  return { registry, session, gate, seen };
}

function permReq(over: Partial<ApprovalRequest> = {}): ApprovalRequest {
  return {
    id: 'ap_test1',
    kind: 'permission',
    call: { id: 'call_1', name: 'run_shell', input: { command: 'rm -rf /tmp/x' } },
    risk: 'exec',
    reason: 'run_shell at auto-edit',
    preview: '',
    ...over,
  };
}

test('gate: park → approval_request on the wire (redacted digest, never raw input) → decide resolves', async () => {
  const { registry, session, gate, seen } = gateFixture();
  const pending = gate.request(permReq());
  await new Promise((r) => setTimeout(r, 10));

  const ask = seen.find((e) => e.type === 'approval_request');
  assert.ok(ask && ask.type === 'approval_request', 'approval_request emitted');
  assert.equal(ask.tool, 'run_shell');
  assert.equal(ask.argHint, 'rm -rf /tmp/x', 'command surfaces as the display digest');
  assert.equal(JSON.stringify(ask).includes('"input"'), false, 'raw call.input never crosses the bus');
  assert.equal(session.pendingApprovals.size, 1, 'resolver parked');

  assert.equal(registry.decide(session.id, 'ap_test1', 'approve'), true);
  assert.equal(await pending, 'approve');
  const resolved = seen.filter((e) => e.type === 'approval_resolved').at(-1);
  assert.ok(resolved && resolved.type === 'approval_resolved');
  assert.equal(resolved.outcome, 'approved');
  assert.equal(session.pendingApprovals.size, 0, 'park cleared');
  // A late second answer is not-pending, not an error.
  assert.equal(registry.decide(session.id, 'ap_test1', 'deny'), false);
});

test("gate: 'session' decision maps to approveForSession and reports outcome 'session'", async () => {
  const { registry, session, gate, seen } = gateFixture();
  const pending = gate.request(permReq());
  await new Promise((r) => setTimeout(r, 5));
  registry.decide(session.id, 'ap_test1', { approveForSession: true });
  assert.deepEqual(await pending, { approveForSession: true });
  const resolved = seen.filter((e) => e.type === 'approval_resolved').at(-1);
  assert.ok(resolved && resolved.type === 'approval_resolved' && resolved.outcome === 'session');
});

test('gate: interrupt during a pending ask denies (outcome cancelled) and unparks', async () => {
  const { registry, session, gate, seen } = gateFixture();
  const ctrl = new AbortController();
  const pending = gate.request(permReq({ signal: ctrl.signal }));
  await new Promise((r) => setTimeout(r, 5));
  ctrl.abort();
  assert.equal(await pending, 'deny');
  const resolved = seen.filter((e) => e.type === 'approval_resolved').at(-1);
  assert.ok(resolved && resolved.type === 'approval_resolved' && resolved.outcome === 'cancelled');
  assert.equal(session.pendingApprovals.size, 0);
  assert.equal(registry.decide(session.id, 'ap_test1', 'approve'), false, 'late answer after abort');
});

test('gate: pre-aborted signal never asks', async () => {
  const { gate, seen } = gateFixture();
  const ctrl = new AbortController();
  ctrl.abort();
  assert.equal(await gate.request(permReq({ signal: ctrl.signal })), 'deny');
  assert.equal(seen.filter((e) => e.type === 'approval_request').length, 0);
});

test('gate: acknowledgeOnly is informational — any answer still denies', async () => {
  const { registry, session, gate, seen } = gateFixture();
  const pending = gate.request(permReq({ acknowledgeOnly: true }));
  await new Promise((r) => setTimeout(r, 5));
  const ask = seen.find((e) => e.type === 'approval_request');
  assert.ok(ask && ask.type === 'approval_request' && ask.acknowledgeOnly === true);
  registry.decide(session.id, 'ap_test1', 'approve');
  assert.equal(await pending, 'deny', 'the call stays hard-blocked');
});

test('gate: user_question round-trips browser answers; plan mode transitions auto-approve', async () => {
  const { registry, session, gate, seen } = gateFixture();
  const questions = [{ question: 'Deploy?', options: [{ label: 'yes' }, { label: 'no' }] }];
  const pending = gate.request(permReq({ kind: 'user_question', questions }));
  await new Promise((r) => setTimeout(r, 5));
  const ask = seen.find((e) => e.type === 'approval_request');
  assert.ok(ask && ask.type === 'approval_request');
  assert.deepEqual(ask.questions, questions, 'questions ride the wire for the composer');
  const answers = [{ question: 'Deploy?', selected: ['yes'] }];
  registry.decide(session.id, 'ap_test1', { answers });
  assert.deepEqual(await pending, { answers });

  assert.equal(await gate.request(permReq({ id: 'ap_p1', kind: 'plan_enter' })), 'approve');
  assert.equal(seen.filter((e) => e.type === 'approval_request').length, 1, 'plan transitions never ask');
});

test('gate: session close settles parked asks as cancelled', async () => {
  const { session, gate, seen } = gateFixture();
  const pending = gate.request(permReq());
  await new Promise((r) => setTimeout(r, 5));
  await session.close();
  assert.equal(await pending, 'deny');
  const resolved = seen.filter((e) => e.type === 'approval_resolved').at(-1);
  assert.ok(resolved && resolved.type === 'approval_resolved' && resolved.outcome === 'cancelled');
});

test('registry: setAutonomy changes the live level; the reserved mirror is read-only', () => {
  const { registry } = gateFixture();
  const s = registry.create({ projectRoot: '/tmp/ws' });
  assert.equal(s.autonomy(), 'auto-edit', 'default');
  assert.equal(registry.setAutonomy(s.id, 'full'), true);
  assert.equal(s.autonomy(), 'full');

  registry.attachReserved({ bus: new EventBus(), displayPath: '/tmp/ws', origin: 'local' });
  assert.equal(registry.setAutonomy('cli', 'full'), false, 'reserved sessions cannot be driven');
});

// -------------------------------------------------------------------------------------------------
// HTTP: the routes (real server, mock provider)
// -------------------------------------------------------------------------------------------------

test('HTTP: approvals + autonomy routes; usage event carries per-iteration metrics', async () => {
  const proj = mkdtempSync(join(HOME, 'approvalproj-'));
  const h = await serverMod.startWebServer({ bus: new EventBus(), workspaceRoot: proj });
  try {
    projects.addProject(proj);

    const created = await http(h.port, 'POST', '/api/sessions', h.token, { projectRoot: proj, title: 'ap' });
    assert.equal(created.status, 200);
    const sid = created.json.id as string;

    // Park a pending ask directly (the gate tests above cover park mechanics) and answer it over
    // HTTP — this pins the route → registry.decide → settle path.
    const settled: unknown[] = [];
    h.registry.get(sid)!.pendingApprovals.set('ap_http1', {
      settle: (d) => settled.push(d),
      receivedAt: Date.now(),
    });

    const bad = await http(h.port, 'POST', `/api/sessions/${sid}/approvals/ap_http1`, h.token, { decision: 'explode' });
    assert.equal(bad.status, 400, 'unknown decision shape rejected');

    const ok = await http(h.port, 'POST', `/api/sessions/${sid}/approvals/ap_http1`, h.token, { decision: 'session' });
    assert.equal(ok.status, 200);
    assert.deepEqual(settled, [{ approveForSession: true }]);

    const late = await http(h.port, 'POST', `/api/sessions/${sid}/approvals/ap_http1`, h.token, { decision: 'deny' });
    assert.equal(late.status, 409, 'late/duplicate answers are not-pending');

    // Autonomy route.
    const aut = await http(h.port, 'POST', `/api/sessions/${sid}/autonomy`, h.token, { level: 'full' });
    assert.equal(aut.status, 200);
    assert.equal(h.registry.get(sid)!.autonomy(), 'full');
    const autBad = await http(h.port, 'POST', `/api/sessions/${sid}/autonomy`, h.token, { level: 'yolo' });
    assert.equal(autBad.status, 400);
    const autMirror = await http(h.port, 'POST', '/api/sessions/cli/autonomy', h.token, { level: 'full' });
    assert.equal(autMirror.status, 409);

    // A real mock turn → the widened usage event crosses SSE with per-iteration numbers.
    const chat = await http(h.port, 'POST', `/api/sessions/${sid}/chat`, h.token, { prompt: 'hello' });
    assert.equal(chat.status, 202);
    const deadline = Date.now() + 8000;
    let status = '';
    while (Date.now() < deadline) {
      const list = await http(h.port, 'GET', '/api/sessions', h.token);
      const row = (list.json.sessions as Array<{ id: string; status: string }>).find((s) => s.id === sid);
      status = row?.status ?? '';
      if (status === 'idle' || status === 'error') break;
      await new Promise((r) => setTimeout(r, 20));
    }
    assert.equal(status, 'idle', 'the mock turn completed');

    const tr = await http(h.port, 'GET', `/api/transcript?session=${sid}`, h.token, undefined);
    assert.equal(tr.status, 200);
    const events = (tr.json.events as { event: LoopEvent }[]).map((f) => f.event);
    const usage = events.filter((e) => e.type === 'usage').at(-1);
    assert.ok(usage && usage.type === 'usage', 'usage event crossed');
    assert.equal(typeof usage.iterInputTokens, 'number', 'per-request input tokens present');
    assert.equal(typeof usage.iterOutputTokens, 'number', 'per-request output tokens present');
    assert.equal(typeof usage.ttftMs, 'number', 'ttft measured (mock streams text before usage)');
    assert.ok(events.some((e) => e.type === 'stop'), 'terminal frame landed');
  } finally {
    await h.close();
    rmSync(proj, { recursive: true, force: true });
  }
});
