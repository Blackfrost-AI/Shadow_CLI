import test from 'node:test';
import assert from 'node:assert/strict';
import { request } from 'node:http';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { isolateHome, assertStoreIsolated } from './helpers/isolateHome.js';

const { home: HOME } = isolateHome('plugins');
const store = await import('../src/state/globalStore.js');
assertStoreIsolated(store.GLOBAL_DIR, HOME);
const manager = await import('../src/plugins/manager.js');
const server = await import('../src/web/server.js');
const { EventBus } = await import('../src/agent/events.js');

function req(
  port: number,
  method: string,
  path: string,
  token: string,
): Promise<{ status: number; json: Record<string, unknown> }> {
  return new Promise((resolve, reject) => {
    const r = request(
      {
        host: '127.0.0.1',
        port,
        path,
        method,
        headers: { host: `127.0.0.1:${port}`, authorization: `Bearer ${token}` },
      },
      (res) => {
        let data = '';
        res.on('data', (chunk) => (data += chunk));
        res.on('end', () => resolve({ status: res.statusCode ?? 0, json: data ? JSON.parse(data) : {} }));
      },
    );
    r.on('error', reject);
    r.end();
  });
}

function makePluginSource(): string {
  const dir = mkdtempSync(join(HOME, 'plugin-src-'));
  mkdirSync(join(dir, 'commands'), { recursive: true });
  mkdirSync(join(dir, 'skills', 'demo'), { recursive: true });
  writeFileSync(
    join(dir, 'manifest.json'),
    JSON.stringify({ name: 'demo-plugin', version: '1.0.0', description: 'Demo plugin' }),
  );
  writeFileSync(join(dir, 'commands', 'hello.md'), '# hello\n\nSay hello.');
  writeFileSync(join(dir, 'skills', 'demo', 'SKILL.md'), '# Demo\n\nA demo skill.');
  return dir;
}

test('plugins can be listed, toggled and archived without leaking host paths', async () => {
  const source = makePluginSource();
  manager.installPluginFromPath(source);
  const proj = mkdtempSync(join(HOME, 'pluginsproj-'));
  const h = await server.startWebServer({ bus: new EventBus(), workspaceRoot: proj });
  try {
    const listed = await req(h.port, 'GET', '/api/plugins', h.token);
    assert.equal(listed.status, 200);
    const plugins = listed.json.plugins as Array<Record<string, unknown>>;
    assert.equal(plugins.length, 1);
    assert.equal(plugins[0]!.name, 'demo-plugin');
    assert.equal(plugins[0]!.enabled, false, 'install stays disabled');
    assert.equal(plugins[0]!.source, 'path');
    assert.equal('dir' in plugins[0]!, false, 'absolute paths never cross the wire');
    const counts = plugins[0]!.counts as Record<string, number>;
    assert.ok(counts.commands >= 1);
    assert.ok(counts.skills >= 1);

    const enabled = await req(h.port, 'POST', '/api/plugins/demo-plugin/enable', h.token);
    assert.equal(enabled.status, 200);
    assert.equal((enabled.json.plugin as { enabled: boolean }).enabled, true);
    assert.equal(manager.describePlugin('demo-plugin')!.meta.enabled, true);

    const disabled = await req(h.port, 'POST', '/api/plugins/demo-plugin/disable', h.token);
    assert.equal(disabled.status, 200);
    assert.equal((disabled.json.plugin as { enabled: boolean }).enabled, false);

    const unknown = await req(h.port, 'POST', '/api/plugins/not-installed/enable', h.token);
    assert.equal(unknown.status, 404);
    const traversal = await req(h.port, 'POST', `/api/plugins/${encodeURIComponent('../escape')}/enable`, h.token);
    assert.equal(traversal.status, 404);

    const removed = await req(h.port, 'DELETE', '/api/plugins/demo-plugin', h.token);
    assert.equal(removed.status, 200);
    assert.equal(removed.json.archived, true);
    const after = await req(h.port, 'GET', '/api/plugins', h.token);
    assert.deepEqual(after.json.plugins, []);
  } finally {
    await h.close();
    rmSync(proj, { recursive: true, force: true });
    rmSync(source, { recursive: true, force: true });
  }
});