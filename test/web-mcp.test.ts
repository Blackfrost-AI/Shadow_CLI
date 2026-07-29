import test from 'node:test';
import assert from 'node:assert/strict';
import { request } from 'node:http';
import { rmSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { isolateHome, assertStoreIsolated } from './helpers/isolateHome.js';

/**
 * Phase E: the MCP servers API. Writes go to ~/.shadow/config.json's mcpServers, so HOME is
 * isolated — these would otherwise rewrite the operator's real config.
 */

const { home: HOME, shadowDir: SHADOW } = isolateHome('web-mcp');

const { EventBus } = await import('../src/agent/events.js');
const { startWebServer } = await import('../src/web/server.js');
const store = await import('../src/state/globalStore.js');
import type { WebServerHandle } from '../src/web/server.js';

assertStoreIsolated(store.GLOBAL_DIR, HOME);
const CONFIG = join(SHADOW, 'config.json');

test.after(() => rmSync(HOME, { recursive: true, force: true }));
type HttpResult = { status: number; body: string };

function raw(port: number, method: string, path: string, headers: Record<string, string>, body?: string): Promise<HttpResult> {
  return new Promise<HttpResult>((resolve, reject) => {
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

async function withServer(fn: (handle: WebServerHandle) => Promise<void>): Promise<void> {
  const bus = new EventBus();
  const h = await startWebServer({ bus });
  try {
    await fn(h);
  } finally {
    await h.close();
  }
}

const auth = (h: WebServerHandle, ct?: string): Record<string, string> => {
  const hdrs: Record<string, string> = { host: `127.0.0.1:${h.port}`, authorization: `Bearer ${h.token}` };
  if (ct) hdrs['content-type'] = ct;
  return hdrs;
};

test('GET /api/mcp lists servers with secret values masked', async () => {
  store.saveGlobalConfig({
    mcpServers: {
      'secret-server': { url: 'https://x/v1', headers: { Authorization: 'Bearer sk-SECRET-mcp' } },
      'stdio-server': { command: 'node', args: ['s.js'] },
    },
  });
  await withServer(async (h) => {
    const r = await raw(h.port, 'GET', '/api/mcp', auth(h));
    assert.equal(r.status, 200);
    const servers = JSON.parse(r.body).servers;
    assert.ok('secret-server' in servers);
    assert.ok('stdio-server' in servers);
    // The bearer token must not appear.
    assert.doesNotMatch(r.body, /sk-SECRET-mcp/);
    // Header keys ARE shown (so the user knows a header is set), but no values.
    assert.deepEqual(servers['secret-server'].headerKeys, ['Authorization']);
  });
});

test('POST adds a stdio server and persists', async () => {
  store.saveGlobalConfig({ mcpServers: {} });
  await withServer(async (h) => {
    const r = await raw(
      h.port,
      'POST',
      '/api/mcp',
      auth(h, 'application/json'),
      JSON.stringify({ name: 'my-tool', command: 'npx', args: ['-y', '@mcp/server'] }),
    );
    assert.equal(r.status, 201);
    const cfg = JSON.parse(readFileSync(CONFIG, 'utf8'));
    assert.equal(cfg.mcpServers['my-tool'].command, 'npx');
    assert.deepEqual(cfg.mcpServers['my-tool'].args, ['-y', '@mcp/server']);
  });
});

test('POST adds an http server and persists', async () => {
  store.saveGlobalConfig({ mcpServers: {} });
  await withServer(async (h) => {
    const r = await raw(
      h.port,
      'POST',
      '/api/mcp',
      auth(h, 'application/json'),
      JSON.stringify({ name: 'remote', url: 'https://mcp.example.com/v1' }),
    );
    assert.equal(r.status, 201);
    const cfg = JSON.parse(readFileSync(CONFIG, 'utf8'));
    assert.equal(cfg.mcpServers.remote.url, 'https://mcp.example.com/v1');
  });
});

test('POST rejects both command and url', async () => {
  store.saveGlobalConfig({ mcpServers: {} });
  await withServer(async (h) => {
    const r = await raw(
      h.port,
      'POST',
      '/api/mcp',
      auth(h, 'application/json'),
      JSON.stringify({ name: 'bad', command: 'x', url: 'http://y' }),
    );
    assert.equal(r.status, 400);
  });
});

test('POST rejects a non-http url', async () => {
  store.saveGlobalConfig({ mcpServers: {} });
  await withServer(async (h) => {
    const r = await raw(
      h.port,
      'POST',
      '/api/mcp',
      auth(h, 'application/json'),
      JSON.stringify({ name: 'bad', url: 'file:///etc/passwd' }),
    );
    assert.equal(r.status, 400);
  });
});

test('POST rejects a duplicate name', async () => {
  store.saveGlobalConfig({ mcpServers: { there: { command: 'x' } } });
  await withServer(async (h) => {
    const r = await raw(
      h.port,
      'POST',
      '/api/mcp',
      auth(h, 'application/json'),
      JSON.stringify({ name: 'there', command: 'y' }),
    );
    assert.equal(r.status, 409);
  });
});

test('PUT replaces an existing server', async () => {
  store.saveGlobalConfig({ mcpServers: { svc: { command: 'old' } } });
  await withServer(async (h) => {
    const r = await raw(
      h.port,
      'PUT',
      '/api/mcp/svc',
      auth(h, 'application/json'),
      JSON.stringify({ command: 'new', args: ['--x'] }),
    );
    assert.equal(r.status, 200);
    const cfg = JSON.parse(readFileSync(CONFIG, 'utf8'));
    assert.equal(cfg.mcpServers.svc.command, 'new');
    assert.deepEqual(cfg.mcpServers.svc.args, ['--x']);
  });
});

test('DELETE removes a server and persists', async () => {
  store.saveGlobalConfig({ mcpServers: { drop: { command: 'x' }, keep: { command: 'y' } } });
  await withServer(async (h) => {
    const r = await raw(h.port, 'DELETE', '/api/mcp/drop', auth(h));
    assert.equal(r.status, 200);
    const cfg = JSON.parse(readFileSync(CONFIG, 'utf8'));
    assert.ok(!('drop' in cfg.mcpServers));
    assert.ok('keep' in cfg.mcpServers);
  });
});

test('DELETE of a missing server is 404', async () => {
  store.saveGlobalConfig({ mcpServers: {} });
  await withServer(async (h) => {
    const r = await raw(h.port, 'DELETE', '/api/mcp/ghost', auth(h));
    assert.equal(r.status, 404);
  });
});

test('every mcp endpoint requires the token', async () => {
  store.saveGlobalConfig({ mcpServers: {} });
  await withServer(async (h) => {
    const hdrs = { host: `127.0.0.1:${h.port}` };
    assert.equal((await raw(h.port, 'GET', '/api/mcp', hdrs)).status, 401);
    assert.equal((await raw(h.port, 'POST', '/api/mcp', hdrs, '{}')).status, 401);
    assert.equal((await raw(h.port, 'DELETE', '/api/mcp/x', hdrs)).status, 401);
  });
});

/**
 * T0-9 regression: /api/state is a DIFFERENT route that also serialized mcpServers — and it
 * returned them verbatim, while /api/mcp one module over already had the masking helper. The
 * Home view fetches /api/state on every load, so a configured bearer token landed in the
 * DevTools network log and the page's JS heap. Fails against the pre-fix router.
 */
test('GET /api/state masks MCP env and header VALUES too', async () => {
  store.saveGlobalConfig({
    mcpServers: {
      'http-server': { url: 'https://x/v1', headers: { Authorization: 'Bearer ghp_STATE_LEAK' } },
      'stdio-server': { command: 'node', args: ['s.js'], env: { TOKEN: 'env-STATE-LEAK' } },
    },
  });
  await withServer(async (h) => {
    const r = await raw(h.port, 'GET', '/api/state', auth(h));
    assert.equal(r.status, 200);
    assert.doesNotMatch(r.body, /ghp_STATE_LEAK/, 'header value must never be serialized');
    assert.doesNotMatch(r.body, /env-STATE-LEAK/, 'env value must never be serialized');
    const servers = JSON.parse(r.body).mcpServers;
    // The KEYS still ship — the user must be able to see that a header/env var is configured.
    assert.deepEqual(servers['http-server'].headerKeys, ['Authorization']);
    assert.deepEqual(servers['stdio-server'].envKeys, ['TOKEN']);
    assert.equal(servers['stdio-server'].command, 'node');
  });
});
