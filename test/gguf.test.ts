import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ensureGgufServer, stopGgufServers } from '../src/gguf.js';
import type { ModelEntry } from '../src/config.js';

function entry(over: Partial<ModelEntry> = {}): ModelEntry {
  return { label: 'local', provider: 'openai', model: 'm', ...over } as ModelEntry;
}

test('ensureGgufServer rejects a missing .gguf path (no spawn)', async () => {
  await assert.rejects(
    () => ensureGgufServer(entry({ gguf: '/no/such/model.gguf' })),
    /gguf file not found/,
  );
});

test('ensureGgufServer rejects a non-gguf entry', async () => {
  await assert.rejects(() => ensureGgufServer(entry()), /non-gguf/);
});

/** Fake a llama-server: /health ok + /v1/models reporting `ids` (like the real thing). */
function fakeLlama(ids: string[]): typeof fetch {
  return (async (url: RequestInfo | URL) => {
    const u = String(url);
    if (u.includes('/v1/models')) {
      return new Response(JSON.stringify({ data: ids.map((id) => ({ id })) }), { status: 200 });
    }
    return new Response('ok', { status: 200 }); // /health
  }) as typeof fetch;
}

test('ensureGgufServer reuses an already-running server serving THIS model (no spawn)', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'gguf-'));
  const fake = join(dir, 'model.gguf');
  writeFileSync(fake, 'x'); // existsSync passes; we never actually load it
  const realFetch = globalThis.fetch;
  globalThis.fetch = fakeLlama(['/models/dir/MODEL.gguf']); // path-like id, case differs — still ours
  try {
    const r = await ensureGgufServer(entry({ gguf: fake, ggufPort: 8123 }));
    assert.equal(r.started, false); // reused, did not launch a child
    assert.equal(r.baseUrl, 'http://127.0.0.1:8123/v1');
  } finally {
    globalThis.fetch = realFetch;
    stopGgufServers();
  }
});

test('ensureGgufServer reuses an ALIAS server (llama-server -a main) instead of failing hard', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'gguf-'));
  const fake = join(dir, 'aliased.gguf');
  writeFileSync(fake, 'x');
  const realFetch = globalThis.fetch;
  globalThis.fetch = fakeLlama(['main']); // alias proves nothing → reuse with a note, never throw
  try {
    const notes: string[] = [];
    const r = await ensureGgufServer(entry({ gguf: fake, ggufPort: 8125 }), (m) => notes.push(m));
    assert.equal(r.started, false);
    assert.ok(notes.some((n) => /alias "main"/.test(n)), 'the alias assumption is visible, not silent');
  } finally {
    globalThis.fetch = realFetch;
    stopGgufServers();
  }
});

test('ensureGgufServer REFUSES a port serving a DIFFERENT model (path-like id mismatch)', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'gguf-'));
  const fake = join(dir, 'mymodel.gguf');
  writeFileSync(fake, 'x');
  const realFetch = globalThis.fetch;
  globalThis.fetch = fakeLlama(['/other/place/other-model.gguf']);
  try {
    await assert.rejects(() => ensureGgufServer(entry({ gguf: fake, ggufPort: 8127 })), /DIFFERENT model/);
  } finally {
    globalThis.fetch = realFetch;
    stopGgufServers();
  }
});

test('ensureGgufServer REFUSES a /health-only occupant (no /v1/models → probably not llama-server)', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'gguf-'));
  const fake = join(dir, 'model.gguf');
  writeFileSync(fake, 'x');
  const realFetch = globalThis.fetch;
  globalThis.fetch = (async (url: RequestInfo | URL) =>
    String(url).includes('/v1/models') ? new Response('nope', { status: 404 }) : new Response('ok', { status: 200 })) as typeof fetch;
  try {
    await assert.rejects(() => ensureGgufServer(entry({ gguf: fake, ggufPort: 8129 })), /not a llama-server/);
  } finally {
    globalThis.fetch = realFetch;
    stopGgufServers();
  }
});
