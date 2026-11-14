import test from 'node:test';
import assert from 'node:assert/strict';
import { request } from 'node:http';
import { mkdtempSync, rmSync, realpathSync } from 'node:fs';
import { join } from 'node:path';
import { isolateHome, assertStoreIsolated } from './helpers/isolateHome.js';
import type { SessionHarnessSnapshot } from '../src/state/sessionState.js';

// The companion "Shadow Host" contract: the /api/host handshake, the /api/resumable listing, and
// persisted-session resume over POST /api/sessions. Resume mirrors the ACP editor's session/load:
// it authenticates the owner-only harness binding and FAILS CLOSED, preserves the sole-writer
// JSONL invariant, and replays history for display without re-recording it. Isolate ~/.shadow
// FIRST — the route reads the DEFAULT binding dir under the (isolated) home. `npm test`, never bun.
const { home: HOME } = isolateHome('hostresume');

const store = await import('../src/state/globalStore.js');
assertStoreIsolated(store.GLOBAL_DIR, HOME);
const projects = await import('../src/web/projects.js');
const serverMod = await import('../src/web/server.js');
const { EventBus } = await import('../src/agent/events.js');
const { Context } = await import('../src/agent/context.js');
const { SessionLog } = await import('../src/state/session.js');
const { captureSessionState } = await import('../src/state/sessionState.js');
const { recordSessionHarnessBinding } = await import('../src/state/sessionHarnessBinding.js');

(store as unknown as { saveGlobalConfig: (c: unknown) => void }).saveGlobalConfig({
  provider: 'mock',
  model: 'mock',
  projects: [],
});

const contextOptions = { contextBudget: 10_000, triggerRatio: 0.75, keepLastTurns: 4 };

function harness(): SessionHarnessSnapshot {
  return {
    foundation: { id: 'shadow-security', version: '1', digest: 'foundation-a' },
    addons: [{ id: 'incident-response', version: '1.0.0', digest: 'incident-a' }],
    digest: 'stack-a',
  };
}

// realpath up front: resolveJail() pins the realpath'd root, but harness-binding digests use
// resolve() (not realpath). Seeding under the canonical path keeps the two digests identical so
// the route's default-dir binding lookup matches the one recorded here.
function workspace(label: string): string {
  return realpathSync(mkdtempSync(join(HOME, `${label}-`)));
}

function seedSession(proj: string, withBinding = true): { id: string; path: string } {
  const log = SessionLog.open(proj);
  const context = new Context(contextOptions);
  context.append({ role: 'user', content: [{ type: 'text', text: 'saved user question' }] });
  context.append({ role: 'assistant', content: [{ type: 'text', text: 'saved assistant reply' }] });
  const h = harness();
  log.bindSessionState(context, () => captureSessionState({ harness: h }));
  log.recordSnapshot(context, 0);
  const path = log.path;
  log.close();
  // No bindingsDir override → the DEFAULT isolated ~/.shadow the route reads.
  if (withBinding) recordSessionHarnessBinding(path, h);
  return { id: SessionLog.sessionIdFromPath(path), path };
}

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

test('GET /api/host advertises the secret-free Shadow companion contract', async () => {
  const proj = workspace('host');
  const h = await serverMod.startWebServer({ bus: new EventBus(), workspaceRoot: proj });
  try {
    const res = await http(h.port, 'GET', '/api/host', h.token);
    assert.equal(res.status, 200);
    assert.equal(res.json.name, 'shadow');
    assert.equal(res.json.protocol, 1);
    const caps = res.json.capabilities as string[];
    assert.ok(Array.isArray(caps));
    for (const expected of ['sessions', 'resume', 'chat', 'approvals', 'transcript']) {
      assert.ok(caps.includes(expected), `capability ${expected} advertised`);
    }
  } finally {
    await h.close();
    rmSync(proj, { recursive: true, force: true });
  }
});

test('GET /api/resumable validates the allowlist and lists persisted sessions without paths', async () => {
  const proj = workspace('resumable');
  const h = await serverMod.startWebServer({ bus: new EventBus(), workspaceRoot: proj });
  try {
    const missing = await http(h.port, 'GET', '/api/resumable', h.token);
    assert.equal(missing.status, 400, 'projectRoot is required');

    const denied = await http(h.port, 'GET', `/api/resumable?projectRoot=${encodeURIComponent(proj)}`, h.token);
    assert.equal(denied.status, 403, 'a non-allowlisted project is refused');

    projects.addProject(proj);
    const seeded = seedSession(proj);
    const listed = await http(h.port, 'GET', `/api/resumable?projectRoot=${encodeURIComponent(proj)}`, h.token);
    assert.equal(listed.status, 200);
    const sessions = listed.json.sessions as Array<{ id: string; ts: string; title: string }>;
    assert.equal(sessions.length, 1);
    assert.equal(sessions[0]!.id, seeded.id);
    assert.equal(typeof sessions[0]!.ts, 'string');
    assert.ok(!JSON.stringify(listed.json).includes(proj), 'no absolute workspace path leaks');
  } finally {
    await h.close();
    rmSync(proj, { recursive: true, force: true });
  }
});

test('POST /api/sessions resumeSessionId hydrates a bound log and replays history for display', async () => {
  const proj = workspace('resume-ok');
  const h = await serverMod.startWebServer({ bus: new EventBus(), workspaceRoot: proj });
  try {
    projects.addProject(proj);
    const seeded = seedSession(proj);

    const res = await http(h.port, 'POST', '/api/sessions', h.token, { projectRoot: proj, resumeSessionId: seeded.id });
    assert.equal(res.status, 200);
    assert.equal(res.json.resumed, true);
    assert.equal(res.json.id, seeded.id, 'the live session adopts the persisted log id');

    const tr = await http(h.port, 'GET', `/api/transcript?session=${seeded.id}`, h.token);
    assert.equal(tr.status, 200);
    const events = (tr.json.events as Array<{ event: { type: string; text?: string } }>).map((f) => f.event);
    assert.ok(events.some((e) => e.type === 'user' && e.text === 'saved user question'), 'prior user turn replayed');
    assert.ok(events.some((e) => e.type === 'assistant_done' && e.text === 'saved assistant reply'), 'prior assistant turn replayed');

    const list = await http(h.port, 'GET', '/api/sessions', h.token);
    const row = (list.json.sessions as Array<{ id: string; canPrompt: boolean }>).find((s) => s.id === seeded.id);
    assert.ok(row, 'the resumed session is listed');
    assert.equal(row!.canPrompt, true, 'a resumed companion session can be driven');
  } finally {
    await h.close();
    rmSync(proj, { recursive: true, force: true });
  }
});

test('POST /api/sessions resume rejects an unknown persisted id with 404', async () => {
  const proj = workspace('resume-404');
  const h = await serverMod.startWebServer({ bus: new EventBus(), workspaceRoot: proj });
  try {
    projects.addProject(proj);
    const res = await http(h.port, 'POST', '/api/sessions', h.token, { projectRoot: proj, resumeSessionId: 'no-such-session' });
    assert.equal(res.status, 404);
  } finally {
    await h.close();
    rmSync(proj, { recursive: true, force: true });
  }
});

test('POST /api/sessions resume fails closed (403) on an unbound persisted log', async () => {
  const proj = workspace('resume-403');
  const h = await serverMod.startWebServer({ bus: new EventBus(), workspaceRoot: proj });
  try {
    projects.addProject(proj);
    const seeded = seedSession(proj, false); // snapshot present, owner-only binding absent
    const res = await http(h.port, 'POST', '/api/sessions', h.token, { projectRoot: proj, resumeSessionId: seeded.id });
    assert.equal(res.status, 403, 'an unauthenticated log must never hydrate');
  } finally {
    await h.close();
    rmSync(proj, { recursive: true, force: true });
  }
});

test('POST /api/sessions resume refuses (409) a log already owned by a live session', async () => {
  const proj = workspace('resume-409');
  const h = await serverMod.startWebServer({ bus: new EventBus(), workspaceRoot: proj });
  try {
    projects.addProject(proj);
    const seeded = seedSession(proj);
    const first = await http(h.port, 'POST', '/api/sessions', h.token, { projectRoot: proj, resumeSessionId: seeded.id });
    assert.equal(first.status, 200);
    const second = await http(h.port, 'POST', '/api/sessions', h.token, { projectRoot: proj, resumeSessionId: seeded.id });
    assert.equal(second.status, 409, 'the sole-writer JSONL invariant blocks a second live owner');
  } finally {
    await h.close();
    rmSync(proj, { recursive: true, force: true });
  }
});