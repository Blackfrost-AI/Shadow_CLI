import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { readAsset } from '../src/web/assets.js';
import { parseOpenAISSE } from '../src/provider/openai.js';
import type { ProviderEvent } from '../src/provider/provider.js';

/** T2-3 — the low-severity batch. */

test("readAsset('__proto__') returns null instead of Object.prototype", async () => {
  // A bare index into a plain object literal returned Object.prototype. `res.end(obj)` then
  // throws, the catch tries writeHead AFTER headers are sent, that throws too and is swallowed —
  // and the socket hangs INDEFINITELY on a tokenless public path.
  for (const key of ['__proto__', 'constructor', 'toString', 'valueOf', 'hasOwnProperty']) {
    const v = readAsset(key);
    assert.ok(v === null || typeof v === 'string', `readAsset(${key}) returned ${typeof v}`);
    assert.equal(v, null, `${key} must not resolve to an inherited member`);
  }
  // Real assets still resolve.
  assert.equal(typeof readAsset('app.js'), 'string');
  assert.equal(readAsset('nope.js'), null);
});

test('the generated asset map is null-prototype at the source too', () => {
  const gen = readFileSync(new URL('../scripts/embed-webui.mjs', import.meta.url), 'utf8');
  assert.match(gen, /Object\.create\(null\)/, 'remove the class, not just the one exploitable key');
});

test('the console has no innerHTML sites left', () => {
  const shell = readFileSync(new URL('../src/web/ui/shell.html', import.meta.url), 'utf8');
  const uses = shell.split('\n').filter((l) => l.includes('innerHTML') && !l.trim().startsWith('//'));
  assert.deepEqual(uses, [], 'these render api.js Errors that interpolate raw server response bodies');
  assert.match(shell, /pre\.textContent =/, 'replaced with textContent');
  assert.match(shell, /replaceChildren\(pre\)/, 'and replaceChildren');
});

test('a nameless tool call is a recoverable error, not an "unknown tool: " round trip', async () => {
  const body = [
    'data: ' + JSON.stringify({ choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: '{"a":1}' } }] } }] }),
    'data: ' + JSON.stringify({ choices: [{ delta: {}, finish_reason: 'tool_calls' }] }),
    'data: [DONE]',
  ].join('\n');
  const evs: ProviderEvent[] = [];
  for await (const e of parseOpenAISSE((async function* () { for (const l of body.split('\n')) yield l; })(), 'gpt-4o')) {
    evs.push(e);
  }
  const err = evs.find((e) => e.type === 'error') as { code: string } | undefined;
  assert.equal(err?.code, 'nameless_tool_call', 'mirrors what the Anthropic parser already did');
  assert.equal(evs.some((e) => e.type === 'tool_call'), false, 'and no bogus empty-named call is emitted');
});

test('the launch URL token exposure is documented where the reader will look', () => {
  const browser = readFileSync(new URL('../src/web/browser.ts', import.meta.url), 'utf8');
  assert.match(browser, /--no-open|ps\b|argv/i, 'the argv visibility of the token must be called out');
});
