// Compile/run this probe with Bun; never use bun test (which defeats test-home isolation).
// Only loopback sockets and a newly-created temporary receipt file are used. No credential store.
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { shadowFetch, setOfflineMode, setEgressResolverForTests, setEgressLogPathForTests, closeAgentsForTests, flushEgressLogForTests } from '../src/safety/egress.js';

const temp = mkdtempSync(join(tmpdir(), 'shadow-egress-smoke-'));
setEgressLogPathForTests(join(temp, 'receipt.log'));
const server = createServer((_request, response) => response.end('loopback-ok'));
try {
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  assert.ok(address && typeof address === 'object');
  setEgressResolverForTests(async () => ['127.0.0.1']);
  // This hostname cannot resolve normally: only the validated per-request pin can reach it.
  const pinned = await shadowFetch(`http://snowfall-runtime.invalid:${address.port}/pin`, { signal: AbortSignal.timeout(5000) }, { purpose: 'provider' });
  assert.equal(await pinned.text(), 'loopback-ok');
  setOfflineMode(true);
  await assert.rejects(() => fetch('https://offline-runtime.invalid/'), (error: Error & { cause?: Error }) => /offline mode/.test(`${error.message} ${error.cause?.message}`));
  const local = await shadowFetch(`http://127.0.0.1:${address.port}/offline`, { signal: AbortSignal.timeout(5000) }, { purpose: 'local-probe' });
  assert.equal(await local.text(), 'loopback-ok');
  console.log(JSON.stringify({ node: process.versions.node, bun: process.versions.bun ?? null, pinnedRequest: true, rawFetchOfflineWall: true, offlineLoopback: true }));
} finally {
  setOfflineMode(false);
  await closeAgentsForTests();
  server.closeAllConnections();
  await new Promise<void>((resolve) => server.close(() => resolve()));
  await flushEgressLogForTests();
  rmSync(temp, { recursive: true, force: true });
}
