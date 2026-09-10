import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { detectAutoEndpoint, resolveAutoModel, DETECT_TIMEOUT_MS } from '../src/local/autoEndpoint.js';
import { parseLocalAddArgs, buildLocalEntry, listLocalModels, isEndpointModel, formatLocalList } from '../src/local/garage.js';
import type { ModelEntry } from '../src/config.js';

/**
 * Auto endpoint recognition: point an entry at a LAN inference box and use whatever it serves.
 *
 * A self-hosted box gets restarted with a different model constantly, and a preset that names one
 * id breaks the moment that changes — the request 404s and the fix is to hand-edit config.json.
 * These cover the detection itself, the base-URL correction, the fallback when the box is down, and
 * the fact that entry IDENTITY is untouched (the /model picker is keyed on it).
 */

/** A minimal OpenAI-compatible catalogue server. `bodies` records what it was asked for. */
async function catalogServer(
  catalog: Record<string, unknown>,
  opts: { status?: number; paths?: string[]; modelsPath?: string } = {},
): Promise<{ baseUrl: string; server: Server; paths: string[]; close: () => void }> {
  const paths: string[] = [];
  const modelsPath = opts.modelsPath ?? '/v1/models';
  const server = createServer((req, res) => {
    paths.push(req.url ?? '');
    if (req.url === modelsPath) {
      res.writeHead(opts.status ?? 200, { 'content-type': 'application/json' });
      res.end(JSON.stringify(catalog));
      return;
    }
    res.writeHead(404, { 'content-type': 'application/json' });
    res.end('{}');
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
  const { port } = server.address() as AddressInfo;
  return {
    baseUrl: `http://127.0.0.1:${port}/v1`,
    server,
    paths,
    close: () => server.close(),
  };
}

test('detects the served model and the context window from /v1/models', async () => {
  // vLLM's catalogue carries max_model_len; a swappable model has a swappable window.
  const fx = await catalogServer({
    data: [{ id: 'Qwen/Qwen3-Coder-30B', max_model_len: 131_072 }],
  });
  try {
    const found = await detectAutoEndpoint({ baseUrl: fx.baseUrl });
    assert.equal(found.model, 'Qwen/Qwen3-Coder-30B');
    assert.equal(found.contextWindow, 131_072);
    assert.deepEqual(found.models, ['Qwen/Qwen3-Coder-30B']);
    assert.equal(found.error, undefined);
  } finally {
    fx.close();
  }
});

test('a base URL written WITHOUT /v1 self-corrects to the one that answered', async () => {
  // The probe toggles the /v1 segment, so the URL the user types need not be exactly right.
  const fx = await catalogServer({ data: [{ id: 'llama-3.3-70b' }] }, { modelsPath: '/v1/models' });
  try {
    const root = fx.baseUrl.replace(/\/v1$/, '');
    const found = await detectAutoEndpoint({ baseUrl: root });
    assert.equal(found.model, 'llama-3.3-70b');
    assert.equal(found.baseUrl, fx.baseUrl, 'the PROVEN base URL is reported, /v1 included');
  } finally {
    fx.close();
  }
});

test('when several models are served, a declared preference wins — otherwise the first', async () => {
  const fx = await catalogServer({ data: [{ id: 'alpha' }, { id: 'beta' }, { id: 'gamma' }] });
  try {
    assert.equal((await detectAutoEndpoint({ baseUrl: fx.baseUrl, prefer: 'beta' })).model, 'beta');
    // A preference the endpoint does NOT serve must not be forced onto the wire.
    assert.equal((await detectAutoEndpoint({ baseUrl: fx.baseUrl, prefer: 'not-there' })).model, 'alpha');
    assert.equal((await detectAutoEndpoint({ baseUrl: fx.baseUrl })).model, 'alpha');
  } finally {
    fx.close();
  }
});

test('Ollama-shaped and bare-array catalogues are understood', async () => {
  const ollama = await catalogServer({ models: [{ name: 'llama3.2:latest' }] });
  try {
    assert.equal((await detectAutoEndpoint({ baseUrl: ollama.baseUrl })).model, 'llama3.2:latest');
  } finally {
    ollama.close();
  }
});

test('an unreachable box reports an error and yields NO model — never a throw', async () => {
  // Port 1 is reserved and nothing listens there. The caller must be able to fall back.
  const t0 = Date.now();
  const found = await detectAutoEndpoint({ baseUrl: 'http://127.0.0.1:1/v1', timeoutMs: 700 });
  const elapsed = Date.now() - t0;
  assert.equal(found.model, undefined);
  assert.deepEqual(found.models, []);
  assert.ok(found.error, 'the failure is reported so the caller can surface it');
  // The candidate list toggles a PATH on the same origin; when the connection itself is refused,
  // every remaining candidate is guaranteed to fail identically, so the probe must stop rather than
  // serially re-time-out. (Each candidate has its own timeout, so without the early bail this would
  // be ~3x.)
  assert.ok(elapsed < 2_000, `an unreachable host must not cost one timeout per path candidate (${elapsed}ms)`);
});

test('resolveAutoModel is inert for an ordinary entry (so callers can call it unconditionally)', async () => {
  const entry = { label: 'plain', provider: 'openai', model: 'gpt-4o' } as ModelEntry;
  assert.deepEqual(await resolveAutoModel(entry), { detected: false, models: [] });
  assert.deepEqual(await resolveAutoModel(undefined), { detected: false, models: [] });
});

test('resolveAutoModel needs a baseUrl and says so instead of probing nothing', async () => {
  const entry = { label: 'noUrl', provider: 'openai', model: 'auto', autoModel: true } as ModelEntry;
  const r = await resolveAutoModel(entry);
  assert.equal(r.detected, false);
  assert.match(r.error ?? '', /no baseUrl/);
});

test('resolveAutoModel returns the detected id for an auto entry', async () => {
  const fx = await catalogServer({ data: [{ id: 'served-model', max_model_len: 8_192 }] });
  try {
    const entry = {
      label: 'DGX',
      provider: 'openai',
      model: 'auto',
      baseUrl: fx.baseUrl,
      autoModel: true,
    } as ModelEntry;
    const r = await resolveAutoModel(entry);
    assert.equal(r.detected, true);
    assert.equal(r.model, 'served-model');
    assert.equal(r.contextWindow, 8_192);
    // The ENTRY is never mutated: its `model` stays the stable identity/fallback, which is what
    // every `cfg.models.find(m => m.model === cfg.model)` lookup and the picker's active row use.
    assert.equal(entry.model, 'auto');
  } finally {
    fx.close();
  }
});

test('a down box degrades to the declared fallback id', async () => {
  const entry = {
    label: 'DGX',
    provider: 'openai',
    model: 'last-known-model',
    baseUrl: 'http://127.0.0.1:1/v1',
    autoModel: true,
  } as ModelEntry;
  const r = await resolveAutoModel(entry, { timeoutMs: 700 });
  assert.equal(r.detected, false);
  assert.equal(r.model, undefined, 'no model is invented — the caller keeps its declared id');
  // The message must name the ENDPOINT and the fallback: a bare "fetch failed" at boot reads as a
  // Shadow bug rather than as the LAN box being off.
  assert.match(r.error ?? '', /DGX/);
  assert.match(r.error ?? '', /127\.0\.0\.1:1/);
  assert.match(r.error ?? '', /last-known-model/);
});

// ── creating the entry ──────────────────────────────────────────────────────────────────────

test('`local add --endpoint <url>` builds an auto-tracking entry', () => {
  const parsed = parseLocalAddArgs(['--endpoint', 'http://10.0.0.31:30000/v1', '--name', 'DGX Spark']);
  assert.equal(parsed.ok, true);
  if (!parsed.ok) return;
  assert.equal(parsed.value.endpoint, 'http://10.0.0.31:30000/v1');

  const built = buildLocalEntry(parsed.value);
  assert.equal(built.ok, true);
  if (!built.ok) return;
  assert.equal(built.value.label, 'DGX Spark');
  assert.equal(built.value.provider, 'openai');
  assert.equal(built.value.baseUrl, 'http://10.0.0.31:30000/v1');
  assert.equal(built.value.autoModel, true, 'the entry tracks whatever the box serves');
  assert.equal(built.value.model, 'auto', 'the id is a fallback, not a pin');
  // A LAN box pauses far longer between SSE chunks than a hosted API.
  assert.equal(built.value.idleTimeoutMs, 300_000);
  // Nothing is launched locally, so none of the local-runtime markers may be set.
  assert.equal(built.value.gguf, undefined);
  assert.equal(built.value.mlx, undefined);
  assert.equal(built.value.vllm, undefined);
});

test('a bare URL in the path slot means the same thing', () => {
  const parsed = parseLocalAddArgs(['http://10.0.0.31:30000/v1']);
  assert.equal(parsed.ok, true);
  if (!parsed.ok) return;
  assert.equal(parsed.value.endpoint, 'http://10.0.0.31:30000/v1');
  const built = buildLocalEntry(parsed.value);
  assert.equal(built.ok, true);
  if (!built.ok) return;
  // No --name: the label is derived from the host so the entry is usable immediately.
  assert.equal(built.value.label, '10.0.0.31:30000');
  assert.equal(built.value.autoModel, true);
});

test('--model pins a specific id while still tracking the endpoint', () => {
  const parsed = parseLocalAddArgs([
    '--endpoint',
    'http://box:8000/v1',
    '--model',
    'Qwen/Qwen3-Coder-30B',
  ]);
  assert.equal(parsed.ok, true);
  if (!parsed.ok) return;
  const built = buildLocalEntry(parsed.value);
  assert.equal(built.ok, true);
  if (!built.ok) return;
  assert.equal(built.value.model, 'Qwen/Qwen3-Coder-30B');
  assert.equal(built.value.autoModel, true);
});

test('a malformed endpoint is refused up front, with the reason', () => {
  // Validated at PARSE time rather than the builder: the user sees the complaint next to the
  // argument they typed, and a bad URL never reaches the model list.
  for (const bad of ['not-a-url', 'ftp://box/v1', 'file:///etc/passwd']) {
    const parsed = parseLocalAddArgs(['--endpoint', bad]);
    assert.equal(parsed.ok, false, `${bad} must be refused`);
    if (parsed.ok) continue;
    assert.match(parsed.message, /http\(s\) base URL/);
  }
  // …and the good shape is accepted.
  assert.equal(parseLocalAddArgs(['--endpoint', 'https://box.internal:8000/v1']).ok, true);
});

test('a missing --endpoint value is refused at parse time', () => {
  const parsed = parseLocalAddArgs(['--endpoint']);
  assert.equal(parsed.ok, false);
});

test('endpoint entries are listed and removable as local models', () => {
  const parsed = parseLocalAddArgs(['--endpoint', 'http://10.0.0.31:30000/v1', '--name', 'DGX']);
  assert.equal(parsed.ok, true);
  if (!parsed.ok) return;
  const built = buildLocalEntry(parsed.value);
  assert.equal(built.ok, true);
  if (!built.ok) return;

  // They carry no gguf/mlx/vllm, so the local list must recognise them explicitly or `/local list`
  // would omit the very entry the user just added.
  assert.equal(isEndpointModel(built.value), true);
  assert.equal(listLocalModels([built.value]).length, 1);
  const rendered = formatLocalList([built.value]).join('\n');
  assert.match(rendered, /10\.0\.0\.31:30000/);
  assert.match(rendered, /lan endpoint/);
});

test('the detection timeout is short enough to sit on the boot path', () => {
  assert.ok(DETECT_TIMEOUT_MS <= 3_000, 'a stalled probe must not stall startup');
});

test('a reachable server with NO model loaded is reported as such, not as unreachable', async () => {
  // A running inference server with nothing loaded answers /v1/models with an empty list. That is a
  // different problem from an unreachable box — "load a model on it" vs "start or route it" — and
  // one merged message sends the user to fix the wrong thing.
  const empty = await catalogServer({ object: 'list', data: [] });
  try {
    const found = await detectAutoEndpoint({ baseUrl: empty.baseUrl });
    assert.equal(found.model, undefined);
    assert.equal(found.reachable, true, 'it ANSWERED — that is the distinguishing fact');
    assert.match(found.error ?? '', /reachable but reports no loaded model/);

    const entry = {
      label: 'DGX Spark',
      provider: 'openai',
      model: 'my-fallback',
      baseUrl: empty.baseUrl,
      autoModel: true,
    } as ModelEntry;
    const r = await resolveAutoModel(entry);
    assert.equal(r.detected, false);
    assert.match(r.error ?? '', /has no model loaded/);
    assert.match(r.error ?? '', /load one on the box/);
    assert.match(r.error ?? '', /my-fallback/, 'and says which id it fell back to');
  } finally {
    empty.close();
  }
});

test('an unreachable box is reported as unreachable, not as empty', async () => {
  const r = await resolveAutoModel(
    { label: 'DGX', provider: 'openai', model: 'fb', baseUrl: 'http://127.0.0.1:1/v1', autoModel: true } as ModelEntry,
    { timeoutMs: 700 },
  );
  assert.equal(r.detected, false);
  assert.notEqual(r.reachable, true);
  assert.match(r.error ?? '', /could not be reached/);
  assert.doesNotMatch(r.error ?? '', /no model loaded/, 'the two causes must not be conflated');
});

test('a server whose catalog shape is unrecognized is not called empty', async () => {
  // A 200 that is not a model list at all (an HTML error page, a proxy banner) is a different
  // failure again: "reachable but empty" would wrongly imply the box is fine.
  const weird = await catalogServer({ hello: 'world' });
  try {
    const found = await detectAutoEndpoint({ baseUrl: weird.baseUrl });
    assert.equal(found.model, undefined);
    assert.equal(found.reachable, undefined);
    assert.ok(found.error);
  } finally {
    weird.close();
  }
});
