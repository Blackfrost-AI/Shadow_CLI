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

test('ensureGgufServer reuses an already-running server (no spawn)', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'gguf-'));
  const fake = join(dir, 'model.gguf');
  writeFileSync(fake, 'x'); // existsSync passes; we never actually load it
  const realFetch = globalThis.fetch;
  // Pretend a llama.cpp server is already healthy on the chosen port.
  globalThis.fetch = (async () => new Response('ok', { status: 200 })) as typeof fetch;
  try {
    const r = await ensureGgufServer(entry({ gguf: fake, ggufPort: 8123 }));
    assert.equal(r.started, false); // reused, did not launch a child
    assert.equal(r.baseUrl, 'http://127.0.0.1:8123/v1');
  } finally {
    globalThis.fetch = realFetch;
    stopGgufServers();
  }
});
