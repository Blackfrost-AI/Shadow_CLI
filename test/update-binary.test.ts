import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { updateInstalledBinary } from '../src/update/binary.js';
import { closeAgentsForTests, flushEgressLogForTests, setEgressLogPathForTests } from '../src/safety/egress.js';
import { resolveFakeHosts } from './helpers/fakeHostEgress.js';

test('binary update ignores env mirrors and leaves the target untouched on a bad signature', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'shadow-update-'));
  setEgressLogPathForTests(join(dir, 'egress.log'));
  const restoreResolver = resolveFakeHosts();
  const target = join(dir, process.platform === 'win32' ? 'shadow.exe' : 'shadow');
  writeFileSync(target, 'known-good');
  const oldFetch = globalThis.fetch;
  const oldBase = process.env.SHADOW_INSTALL_BASE;
  const urls: string[] = [];
  const redirects: Array<RequestRedirect | undefined> = [];
  process.env.SHADOW_INSTALL_BASE = 'https://attacker.invalid/releases';
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    urls.push(String(input));
    redirects.push(init?.redirect);
    return new Response('not-a-valid-release-signature', { status: 200 });
  }) as typeof fetch;
  try {
    await assert.rejects(() => updateInstalledBinary(target), /signature verification failed/);
    assert.equal(readFileSync(target, 'utf8'), 'known-good');
    assert.equal(urls.length, 2, 'an unauthenticated manifest must not trigger a binary download');
    assert.deepEqual(urls.toSorted(), [
      'https://storage.googleapis.com/blackfrost-ai-prod-shadow-releases/bin/SHASUMS256.txt',
      'https://storage.googleapis.com/blackfrost-ai-prod-shadow-releases/bin/SHASUMS256.txt.sig',
    ]);
    assert.deepEqual(redirects, ['error', 'error'], 'migration must preserve redirect refusal');
  } finally {
    globalThis.fetch = oldFetch;
    restoreResolver();
    if (oldBase === undefined) delete process.env.SHADOW_INSTALL_BASE;
    else process.env.SHADOW_INSTALL_BASE = oldBase;
    await flushEgressLogForTests();
    setEgressLogPathForTests(null);
    await closeAgentsForTests();
    rmSync(dir, { recursive: true, force: true });
  }
});
