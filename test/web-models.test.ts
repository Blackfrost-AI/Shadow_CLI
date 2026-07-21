import test from 'node:test';
import assert from 'node:assert/strict';
import { request } from 'node:http';
import { rmSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { isolateHome, assertStoreIsolated } from './helpers/isolateHome.js';

/**
 * Phase B: the models API. Every test runs against an isolated `~/.shadow` (see
 * isolateHome rationale) — these handlers call saveGlobalConfig and the vault migration,
 * which would otherwise rewrite the operator's real config.json.
 *
 * HOME must be redirected BEFORE any module that derives GLOBAL_DIR from homedir() is
 * imported. The server imports globalStore transitively, so it is imported dynamically
 * here, after isolateHome() has taken effect. (Same discipline as test/credref-migrate.test.ts.)
 */

const { home: HOME, shadowDir: SHADOW } = isolateHome('web-models');
process.env.PATH = ''; // no keychain backend
delete process.env.SHADOW_VAULT_PASSWORD;

const { EventBus } = await import('../src/agent/events.js');
const { startWebServer } = await import('../src/web/server.js');
const store = await import('../src/state/globalStore.js');
import type { WebServerHandle } from '../src/web/server.js';

assertStoreIsolated(store.GLOBAL_DIR, HOME);

const CONFIG = join(SHADOW, 'config.json');

test.after(() => rmSync(HOME, { recursive: true, force: true }));

function raw(
  port: number,
  method: string,
  path: string,
  headers: Record<string, string>,
  body?: string,
): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const req = request({ host: '127.0.0.1', port, path, method, headers }, (res) => {
      let b = '';
      res.on('data', (c) => (b += c));
      res.on('end', () => resolve({ status: res.statusCode ?? 0, body: b }));
    });
    req.on('error', reject);
    if (body !== undefined) req.write(body);
    req.end();
  });
}

async function withServer(fn: (h: WebServerHandle) => Promise<void>): Promise<void> {
  const bus = new EventBus();
  const h = await startWebServer({ bus });
  try {
    await fn(h);
  } finally {
    await h.close();
  }
}

const auth = (h: WebServerHandle, contentType?: string): Record<string, string> => {
  const hdrs: Record<string, string> = {
    host: `127.0.0.1:${h.port}`,
    authorization: `Bearer ${h.token}`,
  };
  if (contentType) hdrs['content-type'] = contentType;
  return hdrs;
};

function seedModels(models: unknown[]): void {
  store.saveGlobalConfig({ provider: 'openai', model: 'glm-5.2', models });
}

test('GET /api/models lists presets with secrets masked', async () => {
  seedModels([
    { label: 'Test Opus', provider: 'anthropic', model: 'claude-opus-4-8', apiKey: 'sk-SECRET-aaa' },
    { label: 'Local', provider: 'openai', model: 'qwen', baseUrl: 'http://127.0.0.1:8000/v1' },
  ]);
  await withServer(async (h) => {
    const r = await raw(h.port, 'GET', '/api/models', auth(h));
    assert.equal(r.status, 200);
    const body = JSON.parse(r.body);
    assert.ok(Array.isArray(body.models));
    assert.equal(body.models.length, 2);
    // No secret value anywhere in the response.
    assert.doesNotMatch(r.body, /sk-SECRET/);
    // The anthropic preset flags a credential present; the local one doesn't.
    const opus = body.models.find((m: { label: string }) => m.label === 'Test Opus');
    assert.equal(opus.hasCredential, true);
    const local = body.models.find((m: { label: string }) => m.label === 'Local');
    assert.equal(local.hasCredential, false);
  });
});

test('POST /api/models adds a keyless preset and persists it', async () => {
  seedModels([]);
  await withServer(async (h) => {
    const r = await raw(
      h.port,
      'POST',
      '/api/models',
      auth(h, 'application/json'),
      JSON.stringify({ label: 'My Endpoint', provider: 'openai', model: 'gpt-x', baseUrl: 'http://localhost:11434/v1' }),
    );
    assert.equal(r.status, 201);
    const persisted = JSON.parse(readFileSync(CONFIG, 'utf8'));
    assert.equal(persisted.models.length, 1);
    assert.equal(persisted.models[0].label, 'My Endpoint');
    assert.equal(persisted.models[0].model, 'gpt-x');
  });
});

test('POST rejects a duplicate label', async () => {
  seedModels([{ label: 'Dupe', provider: 'openai', model: 'a' }]);
  await withServer(async (h) => {
    const r = await raw(
      h.port,
      'POST',
      '/api/models',
      auth(h, 'application/json'),
      JSON.stringify({ label: 'Dupe', provider: 'openai', model: 'b' }),
    );
    assert.equal(r.status, 409);
    assert.match(JSON.parse(r.body).error, /already exists/i);
  });
});

test('POST rejects an invalid provider', async () => {
  seedModels([]);
  await withServer(async (h) => {
    const r = await raw(
      h.port,
      'POST',
      '/api/models',
      auth(h, 'application/json'),
      JSON.stringify({ label: 'Bad', provider: 'grok', model: 'x' }),
    );
    assert.equal(r.status, 400);
  });
});

test('POST with a key is refused when the vault is locked', async () => {
  seedModels([]);
  await withServer(async (h) => {
    const r = await raw(
      h.port,
      'POST',
      '/api/models',
      auth(h, 'application/json'),
      JSON.stringify({ label: 'With Key', provider: 'anthropic', model: 'claude', apiKey: 'sk-test-123' }),
    );
    // No vault was created in this isolated home, so vaultUnlocked() is false.
    assert.equal(r.status, 409);
    assert.equal(JSON.parse(r.body).error, 'vault-locked');
    // And the preset was NOT persisted.
    const persisted = JSON.parse(readFileSync(CONFIG, 'utf8'));
    assert.deepEqual(persisted.models, []);
  });
});

test('PATCH enable/disable toggles the disabled flag and persists', async () => {
  seedModels([{ label: 'Toggle', provider: 'openai', model: 'a' }]);
  await withServer(async (h) => {
    const off = await raw(
      h.port,
      'PATCH',
      '/api/models/Toggle',
      auth(h, 'application/json'),
      JSON.stringify({ action: 'disable' }),
    );
    assert.equal(off.status, 200);
    const persisted = JSON.parse(readFileSync(CONFIG, 'utf8'));
    assert.equal(persisted.models[0].disabled, true);

    const on = await raw(
      h.port,
      'PATCH',
      '/api/models/Toggle',
      auth(h, 'application/json'),
      JSON.stringify({ action: 'enable' }),
    );
    assert.equal(on.status, 200);
    const after = JSON.parse(readFileSync(CONFIG, 'utf8'));
    assert.notEqual(after.models[0].disabled, true);
  });
});

test('PATCH default sets the active provider/model/baseUrl', async () => {
  seedModels([{ label: 'Default Me', provider: 'anthropic', model: 'claude-x', baseUrl: 'https://api.anthropic.com' }]);
  await withServer(async (h) => {
    const r = await raw(
      h.port,
      'PATCH',
      '/api/models/Default%20Me',
      auth(h, 'application/json'),
      JSON.stringify({ action: 'default' }),
    );
    assert.equal(r.status, 200);
    const persisted = JSON.parse(readFileSync(CONFIG, 'utf8'));
    assert.equal(persisted.provider, 'anthropic');
    assert.equal(persisted.model, 'claude-x');
    assert.equal(persisted.lastModel, 'Default Me');
  });
});

test('PATCH rejects an unknown action', async () => {
  seedModels([{ label: 'X', provider: 'openai', model: 'a' }]);
  await withServer(async (h) => {
    const r = await raw(
      h.port,
      'PATCH',
      '/api/models/X',
      auth(h, 'application/json'),
      JSON.stringify({ action: 'nuke' }),
    );
    assert.equal(r.status, 400);
  });
});

test('DELETE removes a preset and persists', async () => {
  seedModels([
    { label: 'Keep', provider: 'openai', model: 'a' },
    { label: 'Drop', provider: 'openai', model: 'b' },
  ]);
  await withServer(async (h) => {
    const r = await raw(h.port, 'DELETE', '/api/models/Drop', auth(h));
    assert.equal(r.status, 200);
    const persisted = JSON.parse(readFileSync(CONFIG, 'utf8'));
    assert.equal(persisted.models.length, 1);
    assert.equal(persisted.models[0].label, 'Keep');
  });
});

test('DELETE of a missing preset is 404', async () => {
  seedModels([]);
  await withServer(async (h) => {
    const r = await raw(h.port, 'DELETE', '/api/models/Ghost', auth(h));
    assert.equal(r.status, 404);
  });
});

test('every models endpoint still requires the token', async () => {
  seedModels([]);
  await withServer(async (h) => {
    const hdrs = { host: `127.0.0.1:${h.port}` }; // no auth
    const get = await raw(h.port, 'GET', '/api/models', hdrs);
    const post = await raw(h.port, 'POST', '/api/models', { ...hdrs, 'content-type': 'application/json' }, '{}');
    const del = await raw(h.port, 'DELETE', '/api/models/X', hdrs);
    assert.equal(get.status, 401);
    assert.equal(post.status, 401);
    assert.equal(del.status, 401);
  });
});
