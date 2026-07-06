import { test } from 'node:test';
import assert from 'node:assert/strict';
import { webFetch } from '../src/tools/webFetch.js';

/**
 * Regression guard: a web_fetch/web_search failure on ONE URL (dead host, or an
 * SSRF-refused private/metadata address) must be RECOVERABLE — the model gets the
 * error and tries another URL. It must NEVER be fatal, because the loop treats a
 * result with `error.recoverable === false` as `fatal_tool_error` and HALTS the whole
 * run (loop.ts: `isFatal = !ok && error.recoverable === false`). This is what killed a
 * live Lumix run mid-task on a "could not resolve host" on one wallpaper link.
 */

const ctx = {
  signal: new AbortController().signal,
  dryRun: false,
  workspaceRoot: '/tmp',
  additionalRoots: [] as string[],
} as never;

test('web_fetch: an unresolvable host is recoverable, not fatal', async () => {
  const r = await webFetch.run({ url: 'http://nonexistent-zzz-shadow-test.invalid/' }, ctx);
  assert.equal(r.ok, false);
  assert.notEqual(r.error?.recoverable, false, 'a dead URL must not halt the run');
});

test('web_fetch: an SSRF-blocked metadata address is recoverable, not fatal', async () => {
  const r = await webFetch.run({ url: 'http://169.254.169.254/latest/meta-data/' }, ctx);
  assert.equal(r.ok, false);
  assert.notEqual(r.error?.recoverable, false, 'an SSRF-blocked URL must not halt the run');
});
