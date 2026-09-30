import test from 'node:test';
import assert from 'node:assert/strict';
import { request } from 'node:http';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { EventBus } from '../src/agent/events.js';
import { startWebServer } from '../src/web/server.js';

function req(port: number, token: string, method: string, path: string): Promise<{ status: number; body: any }> {
  return new Promise((resolve, reject) => {
    const r = request({ host: '127.0.0.1', port, method, path, headers: { host: `127.0.0.1:${port}`, authorization: `Bearer ${token}` } }, (res) => {
      let data = '';
      res.on('data', (chunk) => (data += chunk));
      res.on('end', () => resolve({ status: res.statusCode ?? 0, body: data ? JSON.parse(data) : {} }));
    });
    r.on('error', reject);
    r.end();
  });
}

test('authenticated web API lists, inspects, and cancels live Work Center items', async () => {
  const root = mkdtempSync(join(tmpdir(), 'shadow-web-work-'));
  const bus = new EventBus();
  const server = await startWebServer({ bus, workspaceRoot: root });
  try {
    bus.emit({ type: 'subagent_start', taskId: 'agent-web', subagentType: 'review', description: 'web visible', background: true });
    const list = await req(server.port, server.token, 'GET', '/api/sessions/cli/work');
    assert.equal(list.status, 200);
    assert.equal(list.body.items[0].id, 'agent-web');
    const detail = await req(server.port, server.token, 'GET', '/api/sessions/cli/work/agent-web');
    assert.equal(detail.body.item.description, 'web visible');
    let cancelled = false;
    const off = bus.on((event) => { if (event.type === 'cancel_subagent' && event.taskId === 'agent-web') cancelled = true; });
    const cancel = await req(server.port, server.token, 'POST', '/api/sessions/cli/work/agent-web/cancel');
    off();
    assert.equal(cancel.status, 200);
    assert.equal(cancelled, true);
    const noAuth = await req(server.port, '', 'GET', '/api/sessions/cli/work');
    assert.equal(noAuth.status, 401);
  } finally {
    await server.close();
    rmSync(root, { recursive: true, force: true });
  }
});
