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

test('connection edits preserve a preset’s credential reference and require endpoint consent', async () => {
  seedModels([{ label: 'Edit', provider: 'openai', model: 'old-model', baseUrl: 'http://127.0.0.1:8000/v1', credRef: 'model.saved' }]);
  await withServer(async (h) => {
    const update = (body: unknown) => raw(h.port, 'PATCH', '/api/models/Edit', auth(h, 'application/json'), JSON.stringify(body));
    assert.equal((await update({ action: 'update', model: 'new-model' })).status, 200);
    let saved = JSON.parse(readFileSync(CONFIG, 'utf8')).models[0];
    assert.equal(saved.credRef, 'model.saved');
    assert.equal(saved.model, 'new-model');
    assert.equal((await update({ action: 'update', baseUrl: 'http://127.0.0.1:9000/v1' })).status, 409);
    assert.equal((await update({ action: 'update', baseUrl: 'http://127.0.0.1:9000/v1', reuseCredential: true })).status, 200);
    saved = JSON.parse(readFileSync(CONFIG, 'utf8')).models[0];
    assert.equal(saved.baseUrl, 'http://127.0.0.1:9000/v1');
    assert.equal(saved.credRef, 'model.saved');
  });
});

test('model probes are explicit, authenticated and validate their test kind', async () => {
  seedModels([{ label: 'Demo', provider: 'mock', model: 'demo' }]);
  await withServer(async (h) => {
    const probe = '/api/models/Demo/probe';
    assert.equal((await raw(h.port, 'POST', probe, { host: `127.0.0.1:${h.port}`, 'content-type': 'application/json' }, '{"kind":"endpoint"}')).status, 401);
    assert.equal((await raw(h.port, 'POST', probe, auth(h, 'application/json'), '{}')).status, 400);
    const r = await raw(h.port, 'POST', probe, auth(h, 'application/json'), '{"kind":"endpoint"}');
    assert.equal(r.status, 200);
    assert.equal(JSON.parse(r.body).ok, true);
    assert.match(JSON.parse(r.body).message, /no network request/);
  });
});

test('adding and rotating a model key seals it before config is written and preserves other slots', async () => {
  const { createVault, unlockWithKey } = await import('../src/auth/vault.js');
  const { ensureVaultReady, lockVault } = await import('../src/auth/unlock.js');
  const key = createVault('fixture-password', { 'model.other': { apiKey: 'keep-other-key' } });
  process.env.SHADOW_VAULT_PASSWORD = 'fixture-password';
  seedModels([]);
  try {
    await ensureVaultReady(() => {});
    await withServer(async (h) => {
      const added = await raw(h.port, 'POST', '/api/models', auth(h, 'application/json'), JSON.stringify({ label: 'Keyed', provider: 'openai', model: 'sample', apiKey: 'fixture-first-key' }));
      assert.equal(added.status, 201);
      const before = JSON.parse(readFileSync(CONFIG, 'utf8')).models[0];
      assert.ok(before.credRef);
      assert.doesNotMatch(readFileSync(CONFIG, 'utf8'), /fixture-first-key/);
      const updated = await raw(h.port, 'PATCH', '/api/models/Keyed', auth(h, 'application/json'), JSON.stringify({ action: 'update', apiKey: 'fixture-second-key' }));
      assert.equal(updated.status, 200);
      const after = JSON.parse(readFileSync(CONFIG, 'utf8')).models[0];
      assert.notEqual(after.credRef, before.credRef, 'rotation does not overwrite a possibly shared slot');
      assert.doesNotMatch(readFileSync(CONFIG, 'utf8'), /fixture-first-key|fixture-second-key/);
      const secrets = unlockWithKey(key) as Record<string, { apiKey: string }>;
      assert.equal(secrets[after.credRef]!.apiKey, 'fixture-second-key');
      assert.equal(secrets['model.other']!.apiKey, 'keep-other-key');
      assert.doesNotMatch(added.body + updated.body, /fixture-first-key|fixture-second-key|keep-other-key/);
    });
  } finally { lockVault(); delete process.env.SHADOW_VAULT_PASSWORD; }
});

test('POST /api/models adds a keyless preset and persists it', async () => {
  seedModels([]);
  await withServer(async (h) => {
    const r = await raw(
      h.port,
      'POST',
      '/api/models',
      auth(h, 'application/json'),
      JSON.stringify({
        label: 'My Endpoint',
        provider: 'openai',
        model: 'gpt-x',
        baseUrl: 'https://models.example.net/v1',
        selfHosted: true,
      }),
    );
    assert.equal(r.status, 201);
    const persisted = JSON.parse(readFileSync(CONFIG, 'utf8'));
    assert.equal(persisted.models.length, 1);
    assert.equal(persisted.models[0].label, 'My Endpoint');
    assert.equal(persisted.models[0].model, 'gpt-x');
    assert.equal(persisted.models[0].selfHosted, true);
    assert.equal(JSON.parse(r.body).model.selfHosted, true);
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

test('POST rejects selfHosted on native provider presets', async () => {
  seedModels([]);
  await withServer(async (h) => {
    const r = await raw(
      h.port,
      'POST',
      '/api/models',
      auth(h, 'application/json'),
      JSON.stringify({
        label: 'Not OpenAI-compatible',
        provider: 'anthropic',
        model: 'claude-opus-4-8',
        selfHosted: true,
      }),
    );
    assert.equal(r.status, 400);
    assert.match(JSON.parse(r.body).error, /OpenAI-compatible/);
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
  store.saveGlobalConfig({ selfHosted: true });
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
    assert.equal(persisted.selfHosted, undefined, 'a cloud default clears a stale endpoint marker');
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
