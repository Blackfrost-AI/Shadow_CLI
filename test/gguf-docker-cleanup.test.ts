import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  dockerStopTarget,
  ensureGgufServer,
  ensureVllmServer,
  forceStopGgufServers,
  stopGgufServers,
  vllmContainerName,
  type Running,
} from '../src/gguf.js';
import type { ModelEntry } from '../src/config.js';

function entry(over: Partial<ModelEntry> = {}): ModelEntry {
  return { label: 'local', provider: 'openai', model: 'm', ...over } as ModelEntry;
}

async function withPlatform<T>(p: string, fn: () => Promise<T>): Promise<T> {
  const orig = Object.getOwnPropertyDescriptor(process, 'platform')!;
  Object.defineProperty(process, 'platform', { value: p, configurable: true });
  try {
    return await fn();
  } finally {
    Object.defineProperty(process, 'platform', orig);
  }
}

test('the cleanup decision names a container only for docker-backed tracked servers', () => {
  assert.equal(vllmContainerName(8123), 'shadow-vllm-8123');
  assert.equal(
    dockerStopTarget({ baseUrl: 'http://127.0.0.1:8123/v1', container: vllmContainerName(8123) }),
    'shadow-vllm-8123',
  );
  assert.equal(
    dockerStopTarget({ baseUrl: 'http://127.0.0.1:8123/v1', target: 'org/model' } satisfies Running),
    null,
    'a plain child dies with its process group — no rm -f for it',
  );
  assert.equal(
    dockerStopTarget({ baseUrl: 'http://127.0.0.1:9990/v1' }),
    null,
    'a reused external server (proc undefined, no container) has nothing of ours to remove',
  );
});

/** A fake `docker` CLI on PATH: publishes its pid and DEFERS SIGTERM (like a real `docker run`
 *  waiting on a slow container shutdown) so the stop paths actually reach their SIGKILL
 *  escalation. Lets a vLLM docker-backed server get tracked — and its cleanup asserted — with no
 *  docker daemon and no image. */
function fakeDockerDir(pidFile: string, termMarker: string): string {
  const dir = mkdtempSync(join(tmpdir(), 'fake-docker-'));
  writeFileSync(
    join(dir, 'docker'),
    [
      '#!/bin/sh',
      `echo $$ > "${pidFile}"`,
      // Marker via redirection, not touch(1): the child's PATH is only this dir, and echo/: are builtins.
      `trap 'echo touched > "${termMarker}"' TERM`,
      'while :; do /bin/sleep 1; done',
      '',
    ].join('\n'),
  );
  chmodSync(join(dir, 'docker'), 0o755);
  return dir;
}

/**
 * Drive a REAL ensureVllmServer through the docker fallback (platform + PATH + readiness faked)
 * so the module's own tracking records a docker-backed entry — no test-only seam into the map.
 */
async function trackDockerServer(port: number, pidFile: string, termMarker: string): Promise<void> {
  process.env.PATH = fakeDockerDir(pidFile, termMarker); // only the fake docker: `which vllm` fails → fallback
  const realFetch = globalThis.fetch;
  let probes = 0;
  globalThis.fetch = (async () => {
    // Probe 1-2 are the "already running?" reuse check and must FAIL (else no spawn happens);
    // after the spawn the server counts as ready.
    probes += 1;
    return probes <= 2 ? new Response('nope', { status: 404 }) : new Response('ok', { status: 200 });
  }) as typeof fetch;
  try {
    await withPlatform('linux', () => ensureVllmServer(entry({ vllm: 'org/test-model', ggufPort: port })));
  } finally {
    delete process.env.PATH;
    globalThis.fetch = realFetch;
  }
}

async function waitFor(what: string, condition: () => boolean, ms: number): Promise<void> {
  const deadline = Date.now() + ms;
  while (!condition()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 25));
  }
}

function trackedPid(pidFile: string): number {
  return Number(readFileSync(pidFile, 'utf8').trim());
}

/** The fake CLI writes its pid asynchronously — wait for it rather than race the spawn. */
async function waitForTrackedPid(pidFile: string): Promise<number> {
  await waitFor('the fake docker pid file', () => existsSync(pidFile), 5_000);
  return trackedPid(pidFile);
}

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

test('stopGgufServers SIGTERMs first, then force-removes the container of a wedged docker CLI', async () => {
  const base = mkdtempSync(join(tmpdir(), 'vllm-stop-'));
  const pidFile = join(base, 'pid');
  const termMarker = join(base, 'termed');
  await trackDockerServer(8341, pidFile, termMarker);
  const pid = await waitForTrackedPid(pidFile);
  const removed: string[] = [];
  try {
    // Grace long enough for the fake CLI's TERM trap to fire, so the marker proves SIGTERM went
    // out BEFORE the escalation — the graceful path is still tried first, exactly as before.
    await stopGgufServers(3_000, (c) => removed.push(c));
    await waitFor('docker CLI death', () => !alive(pid), 5_000);
    assert.deepEqual(removed, [vllmContainerName(8341)], 'the orphaned container is rm -f’ed by name');
    assert.ok(existsSync(termMarker), 'SIGTERM reached the docker CLI before the force path');
  } finally {
    await stopGgufServers(); // belt: kills the CLI even if an assertion fired early
  }
});

test('forceStopGgufServers force-removes the container WITHOUT a graceful signal', async () => {
  const base = mkdtempSync(join(tmpdir(), 'vllm-force-'));
  const pidFile = join(base, 'pid');
  const termMarker = join(base, 'termed');
  await trackDockerServer(8343, pidFile, termMarker);
  const pid = await waitForTrackedPid(pidFile);
  const removed: string[] = [];
  forceStopGgufServers((c) => removed.push(c));
  await waitFor('docker CLI death', () => !alive(pid), 5_000);
  assert.deepEqual(removed, [vllmContainerName(8343)]);
  assert.equal(existsSync(termMarker), false, 'the exit-hook path is SIGKILL-only — nothing graceful');
});

test('plain (non-docker) tracked servers never trigger a docker rm -f', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'gguf-plain-'));
  const fake = join(dir, 'model.gguf');
  writeFileSync(fake, 'x');
  const realFetch = globalThis.fetch;
  globalThis.fetch = (async () =>
    new Response(JSON.stringify({ data: [{ id: '/models/dir/MODEL.gguf' }] }), { status: 200 })) as typeof fetch;
  const removed: string[] = [];
  try {
    await ensureGgufServer(entry({ gguf: fake, ggufPort: 8347 })); // reuse → tracked with no proc, no container
    await stopGgufServers(50, (c) => removed.push(c));
    forceStopGgufServers((c) => removed.push(c));
    assert.deepEqual(removed, [], 'a server we did not spawn has no container to remove');
  } finally {
    globalThis.fetch = realFetch;
    await stopGgufServers();
  }
});
