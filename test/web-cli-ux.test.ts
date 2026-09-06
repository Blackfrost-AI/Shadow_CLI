import { test } from 'node:test';
import assert from 'node:assert/strict';
import { formatWebBoot, parseWebArgs } from '../src/web/cli.js';

test('web flags support an available port, a fixed port, and no browser launch', () => {
  assert.deepEqual(parseWebArgs([]), { port: undefined, open: true });
  assert.deepEqual(parseWebArgs(['--port', '8080', '--no-open']), { port: 8080, open: false });
  assert.equal(parseWebArgs(['--port=65535']).port, 65535);
});

test('mistyped web options never silently start a differently configured server', () => {
  for (const args of [['--port'], ['--port', '--no-open'], ['--port=0'], ['--port=65536'], ['--port=8e3'], ['--port=-1']]) {
    assert.throws(() => parseWebArgs(args), /Invalid --port/);
  }
  assert.throws(() => parseWebArgs(['--host', '0.0.0.0']), /Unknown web option/);
});

test('the console launch explains the listener and actual network behavior', () => {
  const message = formatWebBoot({ port: 8080, url: 'http://127.0.0.1:8080/#t=demo' });
  assert.match(message, /this machine only/);
  assert.match(message, /configured endpoint/);
  assert.doesNotMatch(message, /Nothing leaves this machine/);
});
