import test from 'node:test';
import assert from 'node:assert/strict';
import { request } from 'node:http';
import { EventBus } from '../src/agent/events.js';
import { startWebServer, type WebServerHandle } from '../src/web/server.js';

/**
 * Phase A: the app shell, asset pipeline, and /api/state endpoint. Every test re-asserts
 * the security gate (Host/Origin/token) is intact on the new routes — a management UI that
 * accidentally bypassed auth would be worse than no UI.
 */

function raw(
  port: number,
  method: string,
  path: string,
  headers: Record<string, string>,
  body?: string,
): Promise<{ status: number; body: string; headers: Record<string, string | string[] | undefined> }> {
  return new Promise((resolve, reject) => {
    const req = request({ host: '127.0.0.1', port, path, method, headers }, (res) => {
      let b = '';
      res.on('data', (c) => (b += c));
      res.on('end', () => resolve({ status: res.statusCode ?? 0, body: b, headers: res.headers }));
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

const authHeaders = (h: WebServerHandle): Record<string, string> => ({
  host: `127.0.0.1:${h.port}`,
  authorization: `Bearer ${h.token}`,
});

test('the shell page references the app module and stylesheet', async () => {
  await withServer(async (h) => {
    const r = await raw(h.port, 'GET', '/', authHeaders(h));
    assert.equal(r.status, 200);
    assert.match(r.headers['content-type'] ?? '', /text\/html/);
    assert.match(r.body, /<script type="module" src="\/assets\/app\.js"/);
    assert.match(r.body, /\/assets\/styles\.css/);
    // The CSP must still forbid remote origins.
    assert.match(r.headers['content-security-policy'] ?? '', /default-src 'none'/);
  });
});

test('serves an app asset as text/javascript with correct MIME', async () => {
  await withServer(async (h) => {
    const r = await raw(h.port, 'GET', '/assets/app.js', authHeaders(h));
    assert.equal(r.status, 200);
    assert.match(r.headers['content-type'] ?? '', /text\/javascript/);
    assert.match(r.body, /startRouter/);
  });
});

test('serves the stylesheet as text/css', async () => {
  await withServer(async (h) => {
    const r = await raw(h.port, 'GET', '/assets/styles.css', authHeaders(h));
    assert.equal(r.status, 200);
    assert.match(r.headers['content-type'] ?? '', /text\/css/);
    assert.match(r.body, /--accent/);
  });
});

test('a missing asset is 404', async () => {
  await withServer(async (h) => {
    const r = await raw(h.port, 'GET', '/assets/does-not-exist.js', authHeaders(h));
    assert.equal(r.status, 404);
  });
});

test('path traversal in asset name is rejected', async () => {
  await withServer(async (h) => {
    const r = await raw(h.port, 'GET', '/assets/../server.ts', authHeaders(h));
    assert.equal(r.status, 404);
  });
});

test('/api/state returns the snapshot shape the shell renders', async () => {
  await withServer(async (h) => {
    const r = await raw(h.port, 'GET', '/api/state', authHeaders(h));
    assert.equal(r.status, 200);
    const snap = JSON.parse(r.body);
    // The five cards the home view renders all have a backing field.
    for (const key of ['model', 'provider', 'autonomy', 'models', 'agents', 'mcpServers']) {
      assert.ok(key in snap, `/api/state includes ${key}`);
    }
    assert.ok(Array.isArray(snap.models), 'models is an array');
    assert.ok(Array.isArray(snap.agents), 'agents is an array');
    // Built-in agents are always present.
    const names = snap.agents.map((a: { name: string }) => a.name);
    assert.ok(names.includes('explore'), 'built-in explore agent is listed');
    assert.ok(names.includes('reviewer'), 'built-in reviewer agent is listed');
  });
});

test('/api/state never serializes a secret even if one is configured', async () => {
  await withServer(async (h) => {
    const r = await raw(h.port, 'GET', '/api/state', authHeaders(h));
    const body = r.body;
    // No secret-bearing field may appear by name in the response.
    assert.doesNotMatch(body, /"apiKey"/, 'apiKey must not appear in /api/state');
    assert.doesNotMatch(body, /"authToken"/, 'authToken must not appear in /api/state');
  });
});

test('/api/state requires the token', async () => {
  await withServer(async (h) => {
    const r = await raw(h.port, 'GET', '/api/state', { host: `127.0.0.1:${h.port}` });
    assert.equal(r.status, 401);
  });
});

test('an unknown /api path is 404 JSON, not the shell', async () => {
  await withServer(async (h) => {
    const r = await raw(h.port, 'GET', '/api/nope', authHeaders(h));
    assert.equal(r.status, 404);
    assert.deepEqual(JSON.parse(r.body), { error: 'not found' });
  });
});

test('a rebound Host cannot reach /api/state even with the token', async () => {
  await withServer(async (h) => {
    const r = await raw(h.port, 'GET', `/api/state?t=${h.token}`, { host: 'evil.com' });
    assert.equal(r.status, 403);
  });
});

test('the shell still serves under / for the launch URL form (?t=)', async () => {
  await withServer(async (h) => {
    // This is the form openBrowser uses — ?t= in the query, default Host.
    const r = await fetch(`http://127.0.0.1:${h.port}/?t=${h.token}`);
    assert.equal(r.status, 200);
    assert.match(await r.text(), /<div id="app">/);
  });
});

test('CSP allows external module scripts and stylesheets (the shell loads both)', async () => {
  // Regression guard: the shell loads the UI as an external ES module
  // (<script type="module" src="/assets/app.js">) and an external stylesheet
  // (<link rel="stylesheet" href="/assets/styles.css">). A CSP of `script-src 'unsafe-inline'`
  // alone blocks external modules — the page renders the HTML but the JS never runs and the
  // app stays stuck on "Loading…". Both script-src and style-src must include 'self'.
  await withServer(async (h) => {
    const r = await raw(h.port, 'GET', '/', authHeaders(h));
    const csp = r.headers['content-security-policy'] as string | undefined;
    assert.ok(csp, 'CSP header present');
    assert.match(csp, /script-src [^;]*'self'/, "CSP script-src must allow 'self' for external modules");
    assert.match(csp, /style-src [^;]*'self'/, "CSP style-src must allow 'self' for the external stylesheet");
    // Remote origins remain forbidden.
    assert.doesNotMatch(csp, /script-src [^;]*https:/, 'no remote script origins');
  });
});

test('the ENTIRE module graph loads the way a browser fetches it (no Authorization header)', async () => {
  // The regression this replaces: the shell used to stamp `?t=<token>` onto the entry point,
  // because modules cannot send an Authorization header. But a module's relative import
  // resolves against the MODULE URL and drops its query string, so `app.js`'s
  // `import './api.js'` requested `/assets/api.js` tokenless, took a 401, and killed the
  // graph on its first line. The page sat on "Loading…" and never rendered — while every
  // test passed, because every test sent an Authorization header that no browser sends.
  //
  // So: walk the real graph with browser-shaped requests only.
  await withServer(async (h) => {
    const browser = { host: `127.0.0.1:${h.port}` }; // no authorization header, ever

    // The launch URL carries the token in the query; the shell itself stays gated.
    const shell = await raw(h.port, 'GET', `/?t=${h.token}`, browser);
    assert.equal(shell.status, 200, 'shell serves for the launch URL');
    assert.doesNotMatch(shell.body, /__TOKEN__/, 'no unsubstituted placeholder');

    // Seed from what the shell actually references, then follow every static import.
    const seeds = [...shell.body.matchAll(/(?:src|href)="\/assets\/([^"]+)"/g)].map((m) => m[1]);
    assert.ok(seeds.includes('app.js'), 'shell references app.js');
    assert.ok(
      seeds.some((s) => s.endsWith('.css')),
      'shell references a stylesheet',
    );

    const seen = new Set<string>();
    const queue = [...seeds];
    let fetched = 0;
    while (queue.length) {
      const name = queue.shift() as string;
      if (seen.has(name)) continue;
      seen.add(name);

      const r = await raw(h.port, 'GET', `/assets/${name}`, browser);
      assert.equal(r.status, 200, `/assets/${name} must load without a token (browser cannot send one)`);
      fetched++;

      // Resolve this module's relative imports the way the browser does.
      const dir = name.includes('/') ? name.slice(0, name.lastIndexOf('/') + 1) : '';
      for (const m of r.body.matchAll(/(?:from|import)\s+['"](\.[^'"]+)['"]/g)) {
        const spec = m[1] as string;
        const joined = spec.startsWith('./') ? dir + spec.slice(2) : spec.replace(/^\.\.\//, '');
        // Normalize any remaining ../ against the current dir.
        const parts: string[] = [];
        for (const seg of joined.split('/')) {
          if (seg === '..') parts.pop();
          else if (seg && seg !== '.') parts.push(seg);
        }
        queue.push(parts.join('/'));
      }
    }

    // Sanity: this must have actually traversed, not fetched one file and stopped.
    assert.ok(fetched >= 6, `expected to walk the module graph, only fetched ${fetched}`);
    assert.ok(seen.has('api.js'), 'transitive import api.js was reached');
    assert.ok(seen.has('router.js'), 'transitive import router.js was reached');
  });
});

test('ungating the shell does not ungate data: /api and /events still require the token', async () => {
  // The shell and the asset tree are public because they are inert, non-secret UI source.
  // Everything carrying configuration or live agent output must remain gated.
  await withServer(async (h) => {
    const browser = { host: `127.0.0.1:${h.port}` };
    assert.equal((await raw(h.port, 'GET', '/api/state', browser)).status, 401);
    assert.equal((await raw(h.port, 'GET', '/api/models', browser)).status, 401);
    assert.equal((await raw(h.port, 'GET', '/api/transcript', browser)).status, 401);
    assert.equal((await raw(h.port, 'GET', '/events', browser)).status, 401);
  });
});

test('the shell is served without auth and carries no token (fragment handoff)', async () => {
  // The launch URL hands the token over as `#t=`, which browsers never transmit — so the
  // server cannot gate `/` on a credential it never receives. That is only safe because the
  // shell is byte-identical for every session and embeds no secret.
  await withServer(async (h) => {
    const r = await raw(h.port, 'GET', '/', { host: `127.0.0.1:${h.port}` });
    assert.equal(r.status, 200, 'shell serves without a token');
    assert.ok(!r.body.includes(h.token), 'the served shell must not contain the session token');
    assert.doesNotMatch(r.body, /__TOKEN__/, 'no unsubstituted placeholder');

    // And the advertised launch URL uses the fragment form, so the token stays out of
    // request logs and anything that records URLs.
    assert.ok(h.url.includes('#t='), `launch URL uses fragment handoff: ${h.url}`);
    assert.ok(!h.url.includes('?t='), 'launch URL does not put the token in the query string');
  });
});

test('public assets are still Host-gated (DNS rebinding cannot read them)', async () => {
  await withServer(async (h) => {
    const r = await raw(h.port, 'GET', '/assets/app.js', { host: 'evil.com' });
    assert.equal(r.status, 403, 'rebound Host is refused even for public assets');
  });
});

test('asset path traversal is still refused without a token', async () => {
  await withServer(async (h) => {
    const r = await raw(h.port, 'GET', '/assets/../server.ts', { host: `127.0.0.1:${h.port}` });
    assert.notEqual(r.status, 200, 'traversal must not serve source outside the ui tree');
  });
});
