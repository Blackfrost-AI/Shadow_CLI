import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { probeModelEndpoint } from '../src/onboard/probe.js';
import { testConnection } from '../src/onboard/connection.js';

test('discovery has one total deadline even when a fetcher never settles', async () => {
  let signal: AbortSignal | null = null;
  const start = Date.now();
  const result = await probeModelEndpoint({
    adapter: 'auto',
    baseUrl: 'http://localhost:8000',
    timeoutMs: 30,
    fetcher: async (_url, init) => {
      signal = init.signal!;
      return new Promise<Response>(() => {});
    },
  });
  assert.equal(result.ok, false);
  assert.match(result.error!, /No response within/);
  assert.ok(Date.now() - start < 1000);
  assert.equal((signal as AbortSignal | null)?.aborted, true);
});

test('discovery deadline includes a response body that never finishes', async () => {
  let closed = false;
  const result = await probeModelEndpoint({
    adapter: 'auto',
    baseUrl: 'http://localhost:8000',
    timeoutMs: 30,
    fetcher: async () =>
      new Response(
        new ReadableStream({
          start(controller) {
            controller.enqueue(new TextEncoder().encode('{"data":'));
          },
          cancel() {
            closed = true;
          },
        }),
      ),
  });
  assert.equal(result.ok, false);
  assert.match(result.error!, /No response within/);
  assert.equal(closed, true, 'timed out response bodies are closed');
});

test('cancelled discovery does not start another candidate or lose its fallback', async () => {
  const controller = new AbortController();
  let requests = 0;
  const pending = probeModelEndpoint({
    adapter: 'auto',
    baseUrl: 'http://localhost:8000',
    signal: controller.signal,
    fallbackModels: ['manual-model'],
    fetcher: async () => {
      requests++;
      controller.abort(new Error('Cancelled by user'));
      return new Response('missing', { status: 404 });
    },
  });
  const result = await pending;
  assert.equal(requests, 1);
  assert.equal(result.ok, false);
  assert.deepEqual(result.models, ['manual-model']);
});

test('connection success, empty output, HTTP errors and stalled requests settle cleanly', async () => {
  let mode = 'success';
  let requests = 0;
  const server = createServer((req, res) => {
    requests++;
    req.resume();
    if (mode === 'hang') return;
    if (mode === 'error') {
      res.writeHead(401, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: { message: 'bad key test-onboard-secret' } }));
      return;
    }
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    if (['success', 'late-error', 'incomplete', 'invalid'].includes(mode))
      res.write(
        'data: ' + JSON.stringify({ choices: [{ index: 0, delta: {
          tool_calls: [{ index: 0, id: 'setup-call', type: 'function', function: {
            name: 'shadow_connection_test', arguments: mode === 'invalid' ? '{"ok":false}' : '{"ok":true}',
          } }],
        } }] }) + '\n\n',
      );
    if (mode === 'usage-only') res.write('data: ' + JSON.stringify({ usage: { prompt_tokens: 10, completion_tokens: 1 }, choices: [] }) + '\n\n');
    if (mode !== 'incomplete') res.write('data: ' + JSON.stringify({ choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }] }) + '\n\n');
    if (mode === 'late-error') res.write('data: ' + JSON.stringify({ error: { code: 'quota_exceeded', message: 'Quota exceeded' } }) + '\n\n');
    res.end('data: [DONE]\n\n');
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`;
  try {
    const options = {
      provider: 'openai' as const,
      model: 'onboard-test-model',
      baseUrl,
      apiKey: 'test-onboard-secret',
      wire: 'chat' as const,
    };
    assert.equal((await testConnection(options, undefined, 2000)).ok, true);
    for (mode of ['late-error', 'incomplete', 'invalid', 'usage-only']) {
      assert.equal((await testConnection(options, undefined, 2000)).ok, false, mode);
    }
    mode = 'empty';
    assert.equal((await testConnection(options, undefined, 2000)).ok, false);
    mode = 'error';
    const error = await testConnection(options, undefined, 2000);
    assert.equal(error.ok, false);
    assert.doesNotMatch(error.error!, /test-onboard-secret/);
    mode = 'hang';
    const start = Date.now();
    const timeout = await testConnection(options, undefined, 50);
    assert.equal(timeout.ok, false);
    assert.match(timeout.error!, /No response within/);
    assert.ok(Date.now() - start < 1000);
    assert.equal(requests, 8, 'setup checks do not retry behind the UI');
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});
