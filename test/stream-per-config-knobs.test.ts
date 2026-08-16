import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { isolateHome } from './helpers/isolateHome.js';
import { resolveFakeHosts } from './helpers/fakeHostEgress.js';

// Redirect ~/.shadow to a throwaway HOME BEFORE any config module is imported. GLOBAL_DIR is a
// module-level const derived from os.homedir() at import time inside globalStore.js, so this
// MUST run first, before anything that transitively imports it. One isolated home per test
// process — each parallel node --test file gets its own, so this is safe.
const { home: HOME } = isolateHome('p1a04');

import { OpenAIProvider } from '../src/provider/openai.js';
import { entryStreamContract } from '../src/provider/index.js';

// Now safe to import the config loader (which reads the GLOBAL config through globalStore.js).
const { loadConfig } = await import('../src/config.js');

/**
 * P1A-04 — per-endpoint stream resilience knobs + headers-first self-hosted rescue tagging.
 *
 * Self-hosted inference servers (llama.cpp, vLLM, MLX, SGLang) routinely pause for tens of
 * seconds between SSE chunks: long tool-call generation, deep prefill, queueing. Shadow's tight
 * public-API watchdog fights a slow local serve. This item adds:
 *
 *   1. a per-entry `idleTimeoutMs` / `firstByteTimeoutMs` / `streamRetries` knob (ModelEntrySchema);
 *   2. a session-wide `SHADOW_IDLE_MS` env escape hatch that beats any config, resolved in
 *      bootstrap.ts (where the active model entry is known) — a rescue env must be applicable to
 *      a LIVE wedged session without editing config.json;
 *   3. an honest watchdog: `firstByteTimeoutMs` is a FIRST-CHUNK-ONLY budget that hands off to the
 *      steady-state frame on the first byte (it used to persist per-chunk and re-trip mid-stream);
 *   4. the empty-mid-stream rescue tagging a headers-first self-hosted serve as 'idle'
 *      (the C4 no-re-POST protection) instead of 'empty'.
 */

function stalled(signal?: AbortSignal): Response {
  return new Response(
    new ReadableStream<Uint8Array>({
      start(c) {
        let settled = false;
        const onAbort = () => {
          if (settled) return;
          settled = true;
          c.error(new DOMException('Aborted', 'AbortError'));
        };
        wireAbortToBody(signal, onAbort);
        setTimeout(() => {
          // The watchdog may have already errored the body; closing a second time throws, so only
          // settle once. (In this test the watchdog fires at idleTimeoutMs ≪ 500ms, but never
          // call close() on an already-errored controller.)
          if (settled) return;
          settled = true;
          c.close();
        }, 500);
      },
    }),
    { status: 200, headers: { 'content-type': 'application/json' } },
  );
}

/** A response that never closes — the watchdog MUST fire; no race with the body ending. */
function neverClosing(signal?: AbortSignal): Response {
  return new Response(
    new ReadableStream<Uint8Array>({
      start(c) {
        /* enqueue nothing, never close — the watchdog abort must be what releases the read */
        wireAbortToBody(signal, () => c.error(new DOMException('Aborted', 'AbortError')));
      },
    }),
    { status: 200, headers: { 'content-type': 'application/json' } },
  );
}

/**
 * Real `fetch` propagates an abort to the response BODY: aborting the request signal rejects an
 * in-flight `response.body` read with an AbortError. A manually-constructed `new ReadableStream()`
 * is NOT wired to any signal, so a body whose `start()` never enqueues/closes would leave
 * `streamLines`' `reader.read()` pending forever — the idle watchdog fires but there is no read to
 * reject, nothing throws, and the mid-stream rescue under test is never reached. These stubs
 * reproduce real fetch's abort contract (abort → reject the in-flight read with an AbortError) so
 * the watchdog-driven rescue paths can be exercised deterministically.
 */
function wireAbortToBody(signal: AbortSignal | undefined, onAbort: () => void): void {
  if (!signal) return;
  if (signal.aborted) onAbort();
  else signal.addEventListener('abort', onAbort, { once: true });
}

/**
 * A successful non-stream response for the rescue re-POST. The rescue sends `stream:false` and
 * MUST resolve to a parseable completion so the generator actually finishes (a hanging body would
 * re-raise the same stuck-read problem in the rescue path).
 */
function resolvedJson(): Response {
  return new Response(
    JSON.stringify({ choices: [{ message: { content: 'rescued' }, finish_reason: 'stop' }] }),
    { status: 200, headers: { 'content-type': 'application/json' } },
  );
}

/** True when the request body asks for an SSE stream (`stream:true`); false for the non-stream rescue. */
function isStreamRequest(init?: RequestInit): boolean {
  try {
    const body = init?.body ? (JSON.parse(String(init.body)) as { stream?: boolean }) : {};
    return body.stream !== false;
  } catch {
    return true;
  }
}

async function collect<T>(stream: AsyncIterable<T>): Promise<T[]> {
  const out: T[] = [];
  for await (const ev of stream) out.push(ev);
  return out;
}

// Test 1 — the emitted===0 rescue on a selfHosted endpoint tags 'idle' and skips the re-POST.
test('empty mid-stream rescue on selfHosted is tagged idle (C4: never re-fires the prompt)', async () => {
  const calls: string[] = [];
  const orig = globalThis.fetch;
  globalThis.fetch = (async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
    calls.push(typeof input === 'string' ? input : input instanceof URL ? input.toString() : (input as Request).url);
    return isStreamRequest(init) ? stalled(init?.signal ?? undefined) : resolvedJson();
  }) as typeof fetch;
  try {
    const provider = new OpenAIProvider({ model: 'qwen', baseUrl: 'http://127.0.0.1:18080', selfHosted: true, idleTimeoutMs: 6 });
    await collect(
      provider.send({ model: 'qwen', system: 's', messages: [{ role: 'user', content: [{ type: 'text', text: 'hello' }] }], maxOutputTokens: 16, tools: [] }),
    );
    assert.equal(
      calls.filter((u) => u.includes('/chat/completions')).length,
      1,
      'a stalled self-hosted stream must NOT re-fire the identical prompt into a busy serve',
    );
  } finally {
    globalThis.fetch = orig;
  }
});

// Test 2 — the same shape keeps the 'empty' rescue on a PUBLIC endpoint (unchanged from C4).
test('empty mid-stream rescue on a public endpoint re-POSTs (path preserved)', async () => {
  const calls: string[] = [];
  const orig = globalThis.fetch;
  const restoreEgress = resolveFakeHosts(); // api.example.com is not resolvable — let it reach the stub
  globalThis.fetch = (async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
    calls.push(typeof input === 'string' ? input : input instanceof URL ? input.toString() : (input as Request).url);
    return isStreamRequest(init) ? neverClosing(init?.signal ?? undefined) : resolvedJson();
  }) as typeof fetch;
  try {
    const provider = new OpenAIProvider({ model: 'gpt', baseUrl: 'https://api.example.com/v1', idleTimeoutMs: 50 });
    await collect(
      provider.send({ model: 'gpt', system: 's', messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }], maxOutputTokens: 16, tools: [] }),
    );
    assert.equal(
      calls.length,
      2,
      'a stalled PUBLIC stream keeps the empty rescue: one stream attempt + one re-POST',
    );
  } finally {
    restoreEgress();
    globalThis.fetch = orig;
  }
});

// Test 3 — the provider factory threads all three knobs into every endpoint's streamWithRetry.
test('each real provider reaches streamWithRetry with the per-entry knobs', () => {
  const src = readFileSync(new URL('../src/provider/index.ts', import.meta.url), 'utf8');
  for (const providerType of ['OpenAIProvider', 'ResponsesProvider', 'AnthropicProvider']) {
    assert.match(
      src,
      new RegExp(`new ${providerType}\\(\\{[^}]*idleTimeoutMs[^}]*firstByteTimeoutMs[^}]*streamRetries`),
      `${providerType} must receive idleTimeoutMs / firstByteTimeoutMs / streamRetries from the factory`,
    );
  }
});

// Test 4 — ModelEntrySchema declares the knobs and loadConfig from the GLOBAL file preserves them.
test('ModelEntrySchema exposes idleTimeoutMs / firstByteTimeoutMs / streamRetries (global config path)', () => {
  writeFileSync(
    join(HOME, '.shadow', 'config.json'),
    JSON.stringify({
      models: [
        {
          label: 'qwen-test',
          provider: 'openai',
          model: 'Qwen3.8-Max',
          baseUrl: 'http://127.0.0.1:8080',
          selfHosted: true,
          idleTimeoutMs: 180_000,
          firstByteTimeoutMs: 60_000,
          streamRetries: 8,
        },
      ],
    }),
  );
  const cfg = loadConfig(HOME);
  const entry = cfg.models![0];
  assert.equal(entry.idleTimeoutMs, 180_000, 'idleTimeoutMs must survive the global config path');
  assert.equal(entry.firstByteTimeoutMs, 60_000, 'firstByteTimeoutMs must survive');
  assert.equal(entry.streamRetries, 8, 'streamRetries must survive');
  assert.equal(entry.baseUrl, 'http://127.0.0.1:8080', 'baseUrl must survive (untouched by redaction)');
  assert.equal(entry.selfHosted, true, 'selfHosted must survive');
});

// Test 5 — the watchdog hop: firstByteTimeoutMs is the frame until the first byte, steady-state after.
test('the watchdog arms firstByteTimeoutMs for the first byte, steady-state after', () => {
  const src = readFileSync(new URL('../src/provider/stream.ts', import.meta.url), 'utf8');
  assert.match(
    src,
    /new IdleWatchdog\(a\.firstByteTimeoutMs \?\? frameMs, frameMs\)/,
    'first-byte frame must hand off to the steady-state frame on the first byte',
  );
});

// Test 6 — SHADOW_IDLE_MS resolution pin + bogus-value fail-closed. The operator escape hatch
// MUST beat per-entry config; resolved in entryStreamContract (the F10-01 shared helper) so
// bootstrap AND every interactive rebuild share one resolution path.
test('SHADOW_IDLE_MS env override beats ModelEntry.idleTimeoutMs (resolution pinned)', () => {
  writeFileSync(
    join(HOME, '.shadow', 'config.json'),
    JSON.stringify({
      models: [
        {
          label: 'env-test',
          provider: 'openai',
          model: 'm',
          baseUrl: 'http://127.0.0.1:1',
          selfHosted: true,
          idleTimeoutMs: 5_000,
        },
      ],
    }),
  );
  const cfg = loadConfig(HOME);
  const entry = cfg.models![0];
  assert.equal(entry.idleTimeoutMs, 5_000, 'the config knob itself loads (proving the write took)');
  (process.env as Record<string, string | undefined>).SHADOW_IDLE_MS = '240000';
  try {
    // Behavioral pin: with the env set, the shared helper resolves the env value…
    assert.equal(entryStreamContract(entry).idleTimeoutMs, 240_000, 'env must beat per-entry config');
  } finally {
    delete (process.env as Record<string, string | undefined>).SHADOW_IDLE_MS;
  }
  // …and without it, the per-entry knob rules.
  assert.equal(entryStreamContract(entry).idleTimeoutMs, 5_000, 'config knob rules when env unset');
});

// Test 6b (F10-01) — the contract travels on EVERY provider construction from a ModelEntry:
// bootstrap (startup + fallback), the TUI (/model switch + /model test), and the headless doctor
// probe. A createProvider call that hand-picks fields can silently shed idle knobs/capabilities
// on a live switch — that is exactly the critical F10-01 regression this pins against.
test('every createProvider-from-entry site spreads entryStreamContract (F10-01 drift pin)', () => {
  const helper = entryStreamContract({
    idleTimeoutMs: 600_000,
    firstByteTimeoutMs: 30_000,
    streamRetries: 4,
    capabilities: { preserveThinking: true } as never,
  });
  assert.equal(helper.idleTimeoutMs, 600_000);
  assert.equal(helper.firstByteTimeoutMs, 30_000);
  assert.equal(helper.streamRetries, 4);
  assert.deepEqual(helper.capabilities, { preserveThinking: true }, 'capability block must be carried');
  assert.deepEqual(
    entryStreamContract(undefined),
    { idleTimeoutMs: undefined, firstByteTimeoutMs: undefined, streamRetries: undefined, capabilities: undefined },
    'entry-less callers get an all-undefined contract (defaults apply downstream)',
  );
  for (const [file, sites] of [
    ['../src/agent/bootstrap.ts', 2],
    ['../src/tui.tsx', 1], // the /model-switch site stayed here (extracted switch helper)
    ['../src/tui/slash.ts', 1], // P3-02: the /model-test PROBE site moved here with runSlash
    ['../src/index.ts', 1],
  ] as const) {
    const src = readFileSync(new URL(file, import.meta.url), 'utf8');
    const calls = (src.match(/createProvider\(\{/g) ?? []).length;
    const spreads = (src.match(/\.\.\.entryStreamContract\(/g) ?? []).length;
    assert.equal(calls, sites, `${file}: expected ${sites} createProvider site(s) — new site? spread entryStreamContract there and bump this pin`);
    assert.equal(spreads, calls, `${file}: every createProvider call must spread entryStreamContract`);
  }
});

// Test 7 — a bogus SHADOW_IDLE_MS is ignored (fail-closed; a typo must not disable the watchdog).
test('a bogus SHADOW_IDLE_MS is ignored (fail-closed)', () => {
  for (const bad of ['', 'abc', '12.5', '0', '-1', '1_000', 'NaN', '  ']) {
    const norm = /^\d+$/.test(bad.trim()) && Number(bad.trim()) > 0 ? Number(bad.trim()) : undefined;
    assert.equal(norm, undefined, `SHADOW_IDLE_MS=${JSON.stringify(bad)} must be ignored`);
  }
});

// Test 8 — every real adapter receives selfHosted + all three knobs explicitly from the factory.
test('every real adapter is constructed with selfHosted so the C4 bail-out can trigger', () => {
  const src = readFileSync(new URL('../src/provider/index.ts', import.meta.url), 'utf8');
  for (const providerType of ['OpenAIProvider', 'ResponsesProvider', 'AnthropicProvider']) {
    assert.match(
      src,
      new RegExp(`new ${providerType}\\(\\{[^}]*selfHosted[^}]*idleTimeoutMs[^}]*firstByteTimeoutMs[^}]*streamRetries`),
      `${providerType} must receive selfHosted + all three knobs from the factory`,
    );
  }
});
