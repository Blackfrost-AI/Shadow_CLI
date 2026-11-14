import test from 'node:test';
import assert from 'node:assert/strict';
import { request } from 'node:http';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { isolateHome, assertStoreIsolated } from './helpers/isolateHome.js';

const { home: HOME } = isolateHome('hooks');
const store = await import('../src/state/globalStore.js');
assertStoreIsolated(store.GLOBAL_DIR, HOME);
const server = await import('../src/web/server.js');
const { EventBus } = await import('../src/agent/events.js');

function req(
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
          ...(payload
            ? { 'content-type': 'application/json', 'content-length': Buffer.byteLength(payload) }
            : {}),
        },
      },
      (res) => {
        let data = '';
        res.on('data', (chunk) => (data += chunk));
        res.on('end', () => resolve({ status: res.statusCode ?? 0, json: data ? JSON.parse(data) : {} }));
      },
    );
    r.on('error', reject);
    if (payload) r.write(payload);
    r.end();
  });
}

test('hooks can be listed, replaced, normalized and are validated', async () => {
  const proj = mkdtempSync(join(HOME, 'hooksproj-'));
  const h = await server.startWebServer({ bus: new EventBus(), workspaceRoot: proj });
  try {
    const empty = await req(h.port, 'GET', '/api/hooks', h.token);
    assert.equal(empty.status, 200);
    assert.deepEqual((empty.json.hooks as Record<string, unknown>).pre_tool_use, []);
    assert.ok((empty.json.events as string[]).includes('stop'));

    const saved = await req(h.port, 'PUT', '/api/hooks', h.token, {
      hooks: {
        pre_tool_use: [{ command: 'echo pre', matcher: 'run_shell' }],
        stop: ['echo done'],
      },
    });
    assert.equal(saved.status, 200);
    const hooks = saved.json.hooks as Record<string, { command: string; matcher?: string }[]>;
    assert.deepEqual(hooks.pre_tool_use, [{ command: 'echo pre', matcher: 'run_shell' }]);
    assert.deepEqual(hooks.stop, [{ command: 'echo done' }], 'v1 strings are normalized');
    assert.deepEqual(hooks.session_start, [], 'missing events are filled');

    const persisted = store.loadGlobalConfig().hooks as Record<string, unknown>;
    assert.deepEqual(persisted.stop, [{ command: 'echo done' }]);
    const reread = await req(h.port, 'GET', '/api/hooks', h.token);
    assert.deepEqual((reread.json.hooks as Record<string, unknown>).stop, [{ command: 'echo done' }]);

    const badEvent = await req(h.port, 'PUT', '/api/hooks', h.token, {
      hooks: { made_up: [{ command: 'x' }] },
    });
    assert.equal(badEvent.status, 400);
    const badEntry = await req(h.port, 'PUT', '/api/hooks', h.token, {
      hooks: { stop: [{ matcher: 'x' }] },
    });
    assert.equal(badEntry.status, 400);
    const unchanged = await req(h.port, 'GET', '/api/hooks', h.token);
    assert.deepEqual(
      (unchanged.json.hooks as Record<string, unknown>).stop,
      [{ command: 'echo done' }],
      'invalid writes never replace the stored hooks',
    );
  } finally {
    await h.close();
    rmSync(proj, { recursive: true, force: true });
  }
});