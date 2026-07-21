import test from 'node:test';
import assert from 'node:assert/strict';
import { request } from 'node:http';
import { rmSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { isolateHome } from './helpers/isolateHome.js';

/**
 * Phase C: the agents API. Writes go to ~/.shadow/agents, so HOME is isolated — these would
 * otherwise create/delete the operator's real agent definition files.
 */

const { home: HOME, shadowDir: SHADOW } = isolateHome('web-agents');

const { EventBus } = await import('../src/agent/events.js');
const { startWebServer } = await import('../src/web/server.js');
import type { WebServerHandle } from '../src/web/server.js';

const AGENTS_DIR = join(SHADOW, 'agents');

test.after(() => rmSync(HOME, { recursive: true, force: true }));

function raw(port, method, path, headers, body?) {
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

async function withServer(fn) {
  const bus = new EventBus();
  const h = await startWebServer({ bus });
  try {
    await fn(h);
  } finally {
    await h.close();
  }
}

const auth = (h, ct?) => {
  const hdrs = { host: `127.0.0.1:${h.port}`, authorization: `Bearer ${h.token}` };
  if (ct) hdrs['content-type'] = ct;
  return hdrs;
};

test('GET /api/agents lists built-ins plus any custom', async () => {
  await withServer(async (h) => {
    const r = await raw(h.port, 'GET', '/api/agents', auth(h));
    assert.equal(r.status, 200);
    const agents = JSON.parse(r.body).agents;
    const names = agents.map((a) => a.name);
    assert.ok(names.includes('explore'));
    assert.ok(names.includes('reviewer'));
    assert.equal(agents.find((a) => a.name === 'explore').builtin, true);
  });
});

test('GET returns systemPrompt, so an edit can round-trip without destroying it', async () => {
  // The bug: the list response omitted systemPrompt, so the edit form bound `undefined` into
  // its textarea and PUT saved the literal string "undefined" over the real prompt. Changing
  // an agent's description silently destroyed its behaviour.
  await withServer(async (h) => {
    const PROMPT = 'You audit dependency licences and nothing else.';
    await raw(
      h.port,
      'POST',
      '/api/agents',
      auth(h, 'application/json'),
      JSON.stringify({ name: 'round-trip', description: 'v1', tools: ['read_file'], systemPrompt: PROMPT }),
    );

    const list = JSON.parse((await raw(h.port, 'GET', '/api/agents', auth(h))).body).agents;
    const found = list.find((a) => a.name === 'round-trip');
    assert.ok(found, 'the custom agent is listed');
    assert.equal(found.systemPrompt, PROMPT, 'systemPrompt survives the read side');

    // Now do what the edit form does: change one field, send everything back.
    const put = await raw(
      h.port,
      'PUT',
      '/api/agents/round-trip',
      auth(h, 'application/json'),
      JSON.stringify({ ...found, description: 'v2' }),
    );
    assert.equal(put.status, 200);

    const after = JSON.parse((await raw(h.port, 'GET', '/api/agents', auth(h))).body).agents.find(
      (a) => a.name === 'round-trip',
    );
    assert.equal(after.description, 'v2', 'the intended change landed');
    assert.equal(after.systemPrompt, PROMPT, 'the prompt was NOT clobbered by the edit');
    assert.notEqual(after.systemPrompt, 'undefined', 'never the literal string "undefined"');
  });
});

test('PUT rejects a body missing systemPrompt instead of blanking the prompt', async () => {
  await withServer(async (h) => {
    await raw(
      h.port,
      'POST',
      '/api/agents',
      auth(h, 'application/json'),
      JSON.stringify({ name: 'keep-prompt', description: 'x', tools: ['read_file'], systemPrompt: 'original' }),
    );
    const bad = await raw(
      h.port,
      'PUT',
      '/api/agents/keep-prompt',
      auth(h, 'application/json'),
      JSON.stringify({ name: 'keep-prompt', description: 'x', tools: ['read_file'] }), // no systemPrompt
    );
    assert.equal(bad.status, 400, 'PUT validates like POST');

    const after = JSON.parse((await raw(h.port, 'GET', '/api/agents', auth(h))).body).agents.find(
      (a) => a.name === 'keep-prompt',
    );
    assert.equal(after.systemPrompt, 'original', 'the rejected write left the prompt intact');
  });
});

test('POST creates a custom agent and writes the file', async () => {
  await withServer(async (h) => {
    const r = await raw(
      h.port,
      'POST',
      '/api/agents',
      auth(h, 'application/json'),
      JSON.stringify({
        name: 'web-test-agent',
        description: 'A test agent',
        tools: ['read_file', 'grep'],
        systemPrompt: 'You are a test agent.',
      }),
    );
    assert.equal(r.status, 201);
    assert.ok(existsSync(join(AGENTS_DIR, 'web-test-agent.md')));
  });
});

test('POST rejects a builtin name with 409', async () => {
  await withServer(async (h) => {
    const r = await raw(
      h.port,
      'POST',
      '/api/agents',
      auth(h, 'application/json'),
      JSON.stringify({ name: 'explore', description: 'x', tools: ['read_file'], systemPrompt: 'y' }),
    );
    assert.equal(r.status, 409);
  });
});

test('POST validates required fields', async () => {
  await withServer(async (h) => {
    const noTools = await raw(
      h.port,
      'POST',
      '/api/agents',
      auth(h, 'application/json'),
      JSON.stringify({ name: 'ok', description: 'x', tools: [], systemPrompt: 'y' }),
    );
    assert.equal(noTools.status, 400);
    assert.match(JSON.parse(noTools.body).error, /tool/i);

    const badName = await raw(
      h.port,
      'POST',
      '/api/agents',
      auth(h, 'application/json'),
      JSON.stringify({ name: 'Bad Name', description: 'x', tools: ['read_file'], systemPrompt: 'y' }),
    );
    assert.equal(badName.status, 400);
  });
});

test('PUT replaces an existing agent', async () => {
  await withServer(async (h) => {
    // Create first.
    await raw(
      h.port,
      'POST',
      '/api/agents',
      auth(h, 'application/json'),
      JSON.stringify({ name: 'replace-me', description: 'v1', tools: ['read_file'], systemPrompt: 'first' }),
    );
    // Then replace.
    const r = await raw(
      h.port,
      'PUT',
      '/api/agents/replace-me',
      auth(h, 'application/json'),
      JSON.stringify({ name: 'replace-me', description: 'v2', tools: ['read_file', 'grep'], systemPrompt: 'second' }),
    );
    assert.equal(r.status, 200);
    const list = JSON.parse((await raw(h.port, 'GET', '/api/agents', auth(h))).body).agents;
    const got = list.find((a) => a.name === 'replace-me');
    assert.equal(got.description, 'v2');
    assert.deepEqual(got.tools, ['read_file', 'grep']);
  });
});

test('DELETE removes a custom agent', async () => {
  await withServer(async (h) => {
    await raw(
      h.port,
      'POST',
      '/api/agents',
      auth(h, 'application/json'),
      JSON.stringify({ name: 'del-me', description: 'x', tools: ['read_file'], systemPrompt: 'y' }),
    );
    const r = await raw(h.port, 'DELETE', '/api/agents/del-me', auth(h));
    assert.equal(r.status, 200);
    assert.equal(existsSync(join(AGENTS_DIR, 'del-me.md')), false);
  });
});

test('DELETE of a missing agent is 404', async () => {
  await withServer(async (h) => {
    const r = await raw(h.port, 'DELETE', '/api/agents/never-existed', auth(h));
    assert.equal(r.status, 404);
  });
});

test('DELETE of a builtin is 409', async () => {
  await withServer(async (h) => {
    const r = await raw(h.port, 'DELETE', '/api/agents/explore', auth(h));
    assert.equal(r.status, 409);
  });
});

test('every agents endpoint requires the token', async () => {
  await withServer(async (h) => {
    const hdrs = { host: `127.0.0.1:${h.port}` };
    assert.equal((await raw(h.port, 'GET', '/api/agents', hdrs)).status, 401);
    assert.equal((await raw(h.port, 'POST', '/api/agents', hdrs, '{}')).status, 401);
    assert.equal((await raw(h.port, 'DELETE', '/api/agents/x', hdrs)).status, 401);
  });
});
