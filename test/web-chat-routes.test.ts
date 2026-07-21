import test from 'node:test';
import assert from 'node:assert/strict';
import { request } from 'node:http';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { isolateHome, assertStoreIsolated } from './helpers/isolateHome.js';

// Isolate ~/.shadow before importing the store/server (GLOBAL_DIR is import-time). This test builds
// a REAL agent (mock provider → no credentials/network) and writes a session log into a tmp
// project. `npm test`, never `bun test`.
const { home: HOME } = isolateHome('chat');

const store = await import('../src/state/globalStore.js');
assertStoreIsolated(store.GLOBAL_DIR, HOME);
const projects = await import('../src/web/projects.js');
const server = await import('../src/web/server.js');
const { EventBus } = await import('../src/agent/events.js');

// A mock-provider global config so a web build succeeds with no key and no network.
store.saveGlobalConfig({ provider: 'mock', model: 'mock', projects: [] });

function req(
  port: number,
  method: string,
  path: string,
  token: string,
  body?: unknown,
): Promise<{ status: number; json: Record<string, unknown>; raw: string }> {
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
        res.on('end', () => resolve({ status: res.statusCode ?? 0, json: data ? JSON.parse(data) : {}, raw: data }));
      },
    );
    r.on('error', reject);
    if (payload) r.write(payload);
    r.end();
  });
}

test('create → chat → the mock turn runs and lands a terminal stop on the transcript', async () => {
  const proj = mkdtempSync(join(HOME, 'chatproj-'));
  const h = await server.startWebServer({ bus: new EventBus(), workspaceRoot: proj });
  try {
    projects.addProject(proj);

    // A project that is NOT allowlisted is refused before a session exists.
    const bad = await req(h.port, 'POST', '/api/sessions', h.token, { projectRoot: '/definitely/not/allowed' });
    assert.equal(bad.status, 403, 'non-allowlisted project → 403');

    // Create a session in the allowlisted project.
    const created = await req(h.port, 'POST', '/api/sessions', h.token, { projectRoot: proj, title: 'demo' });
    assert.equal(created.status, 200);
    const id = created.json.id as string;
    assert.match(id, /^[0-9a-f]{16}$/, 'opaque session id');

    // The mirror cannot be prompted.
    const mirror = await req(h.port, 'POST', '/api/sessions/cli/chat', h.token, { prompt: 'drive the terminal' });
    assert.equal(mirror.status, 409);
    assert.equal(mirror.json.error, 'session_is_mirror');

    // Send a prompt → 202 immediately.
    const chat = await req(h.port, 'POST', `/api/sessions/${id}/chat`, h.token, { prompt: 'say hello' });
    assert.equal(chat.status, 202, 'chat is accepted asynchronously');

    // Poll until the turn finishes (idle) or errors.
    const deadline = Date.now() + 8000;
    let status = '';
    while (Date.now() < deadline) {
      const list = await req(h.port, 'GET', '/api/sessions', h.token);
      const row = (list.json.sessions as Array<{ id: string; status: string }>).find((s) => s.id === id);
      status = row?.status ?? '';
      if (status === 'idle' || status === 'error') break;
      await new Promise((r) => setTimeout(r, 20));
    }
    assert.equal(status, 'idle', 'the turn built a real agent and completed');

    // The transcript carries the user turn, the mock reply, and a terminal stop.
    const tr = await req(h.port, 'GET', `/api/transcript?session=${id}`, h.token);
    assert.equal(tr.status, 200);
    const types = (tr.json.events as Array<{ event: { type: string } }>).map((e) => e.event.type);
    assert.ok(types.includes('user'), 'user turn echoed');
    assert.ok(types.includes('stop'), 'a terminal stop frame landed — the spinner stops');
    // The inner quotes are JSON-escaped in the raw transcript; match the unambiguous prefix.
    assert.match(tr.raw, /Shadow \(mock\): I received/, 'the mock reply reached the transcript');
  } finally {
    await h.close();
    rmSync(proj, { recursive: true, force: true });
  }
});

test('interrupt on an idle web session is a clean 200 (nothing to interrupt)', async () => {
  const proj = mkdtempSync(join(HOME, 'chatproj2-'));
  const h = await server.startWebServer({ bus: new EventBus(), workspaceRoot: proj });
  try {
    projects.addProject(proj);
    const created = await req(h.port, 'POST', '/api/sessions', h.token, { projectRoot: proj });
    const id = created.json.id as string;
    const r = await req(h.port, 'POST', `/api/sessions/${id}/interrupt`, h.token);
    assert.equal(r.status, 200);
    assert.equal(r.json.interrupted, false, 'nothing running to interrupt');
  } finally {
    await h.close();
    rmSync(proj, { recursive: true, force: true });
  }
});
