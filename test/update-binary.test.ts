import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { updateInstalledBinary } from '../src/update/binary.js';

test('binary update ignores env mirrors and leaves the target untouched on a bad signature', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'shadow-update-'));
  const target = join(dir, process.platform === 'win32' ? 'shadow.exe' : 'shadow');
  writeFileSync(target, 'known-good');
  const oldFetch = globalThis.fetch;
  const oldBase = process.env.SHADOW_INSTALL_BASE;
  const urls: string[] = [];
  process.env.SHADOW_INSTALL_BASE = 'https://attacker.invalid/releases';
  globalThis.fetch = (async (input: string | URL | Request) => {
    urls.push(String(input));
    return new Response('not-a-valid-release-signature', { status: 200 });
  }) as typeof fetch;
  try {
    await assert.rejects(() => updateInstalledBinary(target), /signature verification failed/);
    assert.equal(readFileSync(target, 'utf8'), 'known-good');
    assert.equal(urls.length, 2, 'an unauthenticated manifest must not trigger a binary download');
    assert.ok(urls.every((url) => url.startsWith('https://shadow.redpillreader.com/bin/')));
  } finally {
    globalThis.fetch = oldFetch;
    if (oldBase === undefined) delete process.env.SHADOW_INSTALL_BASE;
    else process.env.SHADOW_INSTALL_BASE = oldBase;
    rmSync(dir, { recursive: true, force: true });
  }
});
