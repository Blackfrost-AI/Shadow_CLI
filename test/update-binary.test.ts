import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { download, updateInstalledBinary } from '../src/update/binary.js';
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
    // The manifest+sig pair is retried together (a CDN edge can serve them from different
    // generations for a few seconds after a publish), so the count is a small multiple of 2.
    // The invariant that matters is that ONLY those two metadata URLs are ever touched — a bad
    // signature must never trigger the much larger binary download.
    assert.ok(urls.length >= 2 && urls.length % 2 === 0, `expected manifest+sig pairs, got ${urls.length}`);
    assert.deepEqual(
      [...new Set(urls)].toSorted(),
      [
        'https://storage.googleapis.com/blackfrost-ai-prod-shadow-releases/bin/SHASUMS256.txt',
        'https://storage.googleapis.com/blackfrost-ai-prod-shadow-releases/bin/SHASUMS256.txt.sig',
      ],
      'an unauthenticated manifest must not trigger a binary download',
    );
    assert.ok(redirects.every((r) => r === 'error'), 'migration must preserve redirect refusal');
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

test('download bounds INACTIVITY, not elapsed time (regression: silent no-op update)', async () => {
  // The bug: `AbortSignal.timeout(60_000)` bounded the WHOLE response. A 74 MB binary on a
  // ~1 MB/s link takes ~85 s, so `shadow update` aborted mid-transfer, exited 0, and replaced
  // nothing — a silent no-op.
  //
  // This test would FAIL on the old code and passes on the new: the transfer takes ~10x the
  // idle budget in total, while never going idle. Timeouts are injected so it runs in ~300ms.
  const dir = mkdtempSync(join(tmpdir(), 'shadow-dl-slow-'));
  setEgressLogPathForTests(join(dir, 'egress.log'));
  const restoreResolver = resolveFakeHosts();
  const payload = Buffer.from('slow-release-payload-0123456789');
  const oldFetch = globalThis.fetch;

  globalThis.fetch = (async (_input: unknown, init?: RequestInit) => {
    const stream = new ReadableStream<Uint8Array>({
      async start(controller) {
        // Honour the abort signal like a real fetch, so an over-eager total timeout is
        // observable here rather than silently succeeding.
        let aborted = false;
        init?.signal?.addEventListener('abort', () => {
          aborted = true;
          controller.error(new Error('aborted by timeout'));
        });
        for (let i = 0; i < payload.length; i += 4) {
          await new Promise((r) => setTimeout(r, 30)); // 30ms/chunk x 8 chunks = ~240ms total
          if (aborted) return;
          controller.enqueue(payload.subarray(i, i + 4));
        }
        controller.close();
      },
    });
    return new Response(stream, { status: 200 });
  }) as typeof fetch;

  try {
    const got = await download('https://example.invalid/slow-binary', 1024 * 1024, {
      idleMs: 60,     // > the 30ms inter-chunk gap, but 4x SMALLER than the ~240ms transfer
      totalMs: 60_000,
    });
    assert.equal(got.equals(payload), true, 'a slow-but-healthy transfer must complete');
  } finally {
    globalThis.fetch = oldFetch;
    restoreResolver();
    await flushEgressLogForTests();
    setEgressLogPathForTests(null);
    rmSync(dir, { recursive: true, force: true });
  }
});

test('download aborts a genuinely stalled transfer', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'shadow-dl-stall-'));
  setEgressLogPathForTests(join(dir, 'egress.log'));
  const restoreResolver = resolveFakeHosts();
  const oldFetch = globalThis.fetch;

  globalThis.fetch = (async (_input: unknown, init?: RequestInit) => {
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new Uint8Array([1, 2, 3]));
        // ...then never sends again, and never closes. Wire the abort signal through, as a real
        // fetch implementation would — otherwise the idle timer fires and nothing observes it.
        init?.signal?.addEventListener('abort', () => {
          controller.error(new Error('aborted by idle timeout'));
        });
      },
    });
    return new Response(stream, { status: 200 });
  }) as typeof fetch;

  try {
    await assert.rejects(
      () => download('https://example.invalid/stalled', 1024 * 1024, { idleMs: 50, totalMs: 60_000 }),
      /stalled|aborted/i,
    );
  } finally {
    globalThis.fetch = oldFetch;
    restoreResolver();
    await flushEgressLogForTests();
    setEgressLogPathForTests(null);
    rmSync(dir, { recursive: true, force: true });
  }
});

test('download still fails fast on a body that exceeds the declared byte limit', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'shadow-dl-cap-'));
  setEgressLogPathForTests(join(dir, 'egress.log'));
  const restoreResolver = resolveFakeHosts();
  const oldFetch = globalThis.fetch;
  globalThis.fetch = (async () => new Response(Buffer.alloc(4096), { status: 200 })) as typeof fetch;
  try {
    await assert.rejects(() => download('https://example.invalid/big', 1024), /exceeds 1024 byte limit/);
  } finally {
    globalThis.fetch = oldFetch;
    restoreResolver();
    await flushEgressLogForTests();
    setEgressLogPathForTests(null);
    rmSync(dir, { recursive: true, force: true });
  }
});
