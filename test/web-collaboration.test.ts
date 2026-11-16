import test from 'node:test';
import assert from 'node:assert/strict';
import { request } from 'node:http';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { isolateHome, assertStoreIsolated } from './helpers/isolateHome.js';

const { home: HOME } = isolateHome('collab');

const store = await import('../src/state/globalStore.js');
assertStoreIsolated(store.GLOBAL_DIR, HOME);
const server = await import('../src/web/server.js');
const { EventBus } = await import('../src/agent/events.js');
const { COLLABORATION_PRESETS, collaborationSchema } = await import(
  '../src/agent/collaboration.js'
);

store.saveGlobalConfig({ provider: 'mock', model: 'mock', projects: [] });

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
        headers: {
          host: `127.0.0.1:${port}`,
          authorization: `Bearer ${token}`,
        },
      },
      (res) => {
        let data = '';
        res.on('data', (chunk) => (data += chunk));
        res.on('end', () =>
          resolve({ status: res.statusCode ?? 0, json: data ? JSON.parse(data) : {} }),
        );
      },
    );
    r.on('error', reject);
    r.end();
  });
}

test('GET /api/collaboration lists the presets the collaborate tool accepts', async () => {
  const proj = mkdtempSync(join(HOME, 'collabproj-'));
  const h = await server.startWebServer({ bus: new EventBus(), workspaceRoot: proj });
  try {
    const r = await req(h.port, 'GET', '/api/collaboration', h.token);
    assert.equal(r.status, 200);
    const presets = r.json.presets as Array<{
      id: string;
      label: string;
      description: string;
    }>;
    assert.deepEqual(
      presets.map((preset) => preset.id),
      [...collaborationSchema.shape.preset.options],
    );
    assert.deepEqual(
      presets.map((preset) => preset.id),
      COLLABORATION_PRESETS.map((preset) => preset.id),
    );
    for (const preset of presets) {
      assert.ok(preset.label.length > 0, `${preset.id} has a label`);
      assert.ok(preset.description.length > 0, `${preset.id} has a description`);
    }
  } finally {
    await h.close();
    rmSync(proj, { recursive: true, force: true });
  }
});