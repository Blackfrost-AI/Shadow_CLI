import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isolateHome } from './helpers/isolateHome.js';

/**
 * The Codex subscription path end to end (minus the live network): an imported subscription
 * credential must reach the provider as ONE indivisible unit — bearer + base URL + identity headers
 * + wire — because each piece is meaningless without the others, and recombining them wrongly is
 * either a broken request (404, missing headers) or a disclosure (a ChatGPT token sent to another
 * host).
 *
 * HOME is redirected before the config/auth modules load, since they bind ~/.shadow at import time.
 */
// Redirect ~/.shadow to a throwaway HOME BEFORE the modules below load (they bind it at import).
isolateHome('codex-sub');
const { resolveProviderCredential } = await import('../src/config.js');
const { setSubAuth, clearSubAuth, getSubAuth } = await import('../src/auth/store.js');
const { subscriptionAuthStatus } = await import('../src/auth/status.js');
const { ensureFreshSubscriptionCredential } = await import('../src/auth/refresh.js');
const { SPECS } = await import('../src/auth/spec.js');
const { jwtAccountId } = await import('../src/auth/importStore.js');


/** A complete CompletionRequest: the providers read system/tools/maxOutputTokens, not just messages. */
const wireRequest = (model: string) => ({
  model,
  system: 'system',
  messages: [{ role: 'user' as const, content: [{ type: 'text' as const, text: 'hi' }] }],
  tools: [],
  maxOutputTokens: 1024,
});

const NOW = 1_700_000_000;
const SUB_BASE = 'https://chatgpt.com/backend-api/codex';

const codexCred = (over: Partial<Parameters<typeof setSubAuth>[1]> = {}) => ({
  provider: 'codex' as const,
  kind: 'subscription' as const,
  token: 'at-secret',
  refreshToken: 'rt-secret',
  accountId: 'acc-9',
  expiresAt: NOW + 3600,
  ...over,
});

function withImport<T>(fn: () => T): T {
  const prev = process.env.SHADOW_ALLOW_IMPORT;
  process.env.SHADOW_ALLOW_IMPORT = '1';
  try {
    return fn();
  } finally {
    if (prev === undefined) delete process.env.SHADOW_ALLOW_IMPORT;
    else process.env.SHADOW_ALLOW_IMPORT = prev;
  }
}

test.afterEach(() => {
  clearSubAuth('codex');
  clearSubAuth('grok');
});

const header = (h: Record<string, string> | undefined, name: string): string | undefined => {
  const want = name.toLowerCase();
  for (const [k, v] of Object.entries(h ?? {})) if (k.toLowerCase() === want) return v;
  return undefined;
};

test('an imported codex subscription resolves to bearer + its OWN endpoint + headers + wire', () => {
  setSubAuth('codex', codexCred());
  const c = withImport(() =>
    resolveProviderCredential('openai', { model: 'gpt-5-codex', allowImport: true }),
  );
  assert.equal(c.bearer, 'at-secret');
  assert.equal(c.source, 'subscription');
  assert.equal(c.subProvider, 'codex');
  // The endpoint is supplied BY the credential, not left to the provider default
  // (https://api.openai.com/v1), which does not serve this token.
  assert.equal(c.baseUrl, SUB_BASE);
  assert.equal(header(c.extraHeaders, 'chatgpt-account-id'), 'acc-9');
  assert.equal(header(c.extraHeaders, 'openai-beta'), 'responses=experimental');
  assert.equal(header(c.extraHeaders, 'originator'), 'codex_cli_rs');
  assert.equal(header(c.extraHeaders, 'oai-product-sku'), 'codex');
  // The ChatGPT backend serves the Responses api; chat completions 404s there.
  assert.equal(c.wire, 'responses');
  assert.equal(c.expiresAt, NOW + 3600);
});

test('a configured base URL that is NOT the subscription backend refuses the token', () => {
  setSubAuth('codex', codexCred());
  for (const foreign of ['https://my-proxy.internal/v1', 'https://api.openai.com/v1']) {
    const c = withImport(() =>
      resolveProviderCredential('openai', {
        model: 'gpt-5-codex',
        allowImport: true,
        configuredBaseUrl: foreign,
      }),
    );
    // Refused, not relocated: the token is never handed out to be sent somewhere it was not issued.
    assert.equal(c.bearer, undefined, `token must not be used at ${foreign}`);
    assert.equal(c.baseUrl, undefined);
    assert.equal(c.extraHeaders, undefined);
    assert.match(c.conflict ?? '', /not used/i, `conflict must be reported for ${foreign}`);
    assert.ok(c.conflict?.includes(foreign), `conflict should name ${foreign}: ${c.conflict}`);
  }
});

test('pinning baseUrl to the subscription backend keeps it working', () => {
  setSubAuth('codex', codexCred());
  const c = withImport(() =>
    resolveProviderCredential('openai', {
      model: 'gpt-5-codex',
      allowImport: true,
      // A trailing slash is the same endpoint; the comparison must not be fooled by it.
      configuredBaseUrl: `${SUB_BASE}/`,
    }),
  );
  assert.equal(c.bearer, 'at-secret');
  assert.equal(c.baseUrl, SUB_BASE);
});

test('an explicit API key outranks the subscription and carries no binding', () => {
  setSubAuth('codex', codexCred());
  const prev = process.env.OPENAI_API_KEY;
  process.env.OPENAI_API_KEY = 'sk-explicit';
  try {
    const c = withImport(() =>
      resolveProviderCredential('openai', { model: 'gpt-5-codex', allowImport: true }),
    );
    assert.equal(c.bearer, 'sk-explicit');
    assert.equal(c.source, 'env');
    assert.equal(c.baseUrl, undefined, 'a plain key must not pin the endpoint');
    assert.equal(c.extraHeaders, undefined);
    assert.equal(c.wire, undefined);
  } finally {
    if (prev === undefined) delete process.env.OPENAI_API_KEY;
    else process.env.OPENAI_API_KEY = prev;
  }
});

test('without the opt-in gate the credential is not handed out at all', () => {
  setSubAuth('codex', codexCred());
  const c = resolveProviderCredential('openai', { model: 'gpt-5-codex', allowImport: false });
  assert.equal(c.bearer, undefined);
  assert.equal(c.source, 'env');
});

test('a grok subscription keeps the chat wire (its backend is the public API base)', () => {
  setSubAuth('grok', {
    provider: 'grok',
    kind: 'subscription',
    token: 'xai-token',
    expiresAt: NOW + 3600,
  });
  const c = withImport(() =>
    resolveProviderCredential('openai', { model: 'grok-4', allowImport: true, configuredBaseUrl: 'https://api.x.ai/v1' }),
  );
  assert.equal(c.bearer, 'xai-token');
  assert.deepEqual(c.extraHeaders, {});
  assert.equal(c.wire, 'chat');
});

// ── refresh ─────────────────────────────────────────────────────────────────────────────────

test('a token far from expiry is returned untouched and makes no request', async () => {
  setSubAuth('codex', codexCred({ expiresAt: NOW + 3600 }));
  // allowNetwork:true — if this tried to reach the network it would fail, which is the point:
  // the steady state must be a pure read.
  const r = await ensureFreshSubscriptionCredential('codex', { nowSec: NOW, allowNetwork: true });
  assert.equal(r.refreshed, false);
  assert.equal(r.error, undefined);
  assert.equal(r.cred?.token, 'at-secret');
});

test('refresh is skipped (not attempted) when the network is disallowed', async () => {
  setSubAuth('codex', codexCred({ expiresAt: NOW - 10 }));
  const r = await ensureFreshSubscriptionCredential('codex', { nowSec: NOW, allowNetwork: false });
  assert.equal(r.refreshed, false);
  assert.match(r.error ?? '', /offline/i);
  // The stored credential is still handed back so the caller can surface the provider's own error.
  assert.equal(r.cred?.token, 'at-secret');
});

test('an expired token with no refresh token and no reachable endpoint degrades, never throws', async () => {
  setSubAuth('codex', codexCred({ expiresAt: NOW - 10, refreshToken: undefined }));
  const r = await ensureFreshSubscriptionCredential('codex', { nowSec: NOW, allowNetwork: true });
  assert.equal(r.refreshed, false);
  assert.equal(r.cred?.token, 'at-secret', 'the stored credential survives a failed refresh');
  assert.equal(getSubAuth('codex')?.token, 'at-secret', 'and the store is not clobbered');
});

test('an api key never expires and is never refreshed', async () => {
  setSubAuth('codex', { provider: 'codex', kind: 'apiKey', token: 'sk-imported' });
  const r = await ensureFreshSubscriptionCredential('codex', { nowSec: NOW + 10 ** 6, allowNetwork: true });
  assert.equal(r.refreshed, false);
  assert.equal(r.cred?.token, 'sk-imported');
});

test('the account id survives a rotation (the refresh response omits account_id)', () => {
  // A refresh returns access/id tokens but NOT the account_id field the auth.json parser reads.
  // Losing it would break every request after the first rotation, so it is recovered from the
  // id_token — and carried forward as a fallback.
  const payload = Buffer.from(
    JSON.stringify({ 'https://api.openai.com/auth': { chatgpt_account_id: 'acc-from-jwt' } }),
  ).toString('base64url');
  const idToken = `header.${payload}.sig`;
  assert.equal(jwtAccountId(idToken), 'acc-from-jwt');
  // Flat spellings are tolerated too — the claim layout belongs to the issuer, not to us.
  const flat = Buffer.from(JSON.stringify({ chatgpt_account_id: 'acc-flat' })).toString('base64url');
  assert.equal(jwtAccountId(`h.${flat}.s`), 'acc-flat');
  assert.equal(jwtAccountId(undefined), undefined);
  assert.equal(jwtAccountId('not-a-jwt'), undefined);
});

// ── status surface ──────────────────────────────────────────────────────────────────────────

test('status reports the endpoint, the gate, and never the secret', () => {
  setSubAuth('codex', codexCred());
  const [codex] = subscriptionAuthStatus(NOW).filter((s) => s.provider === 'codex');
  assert.ok(codex);
  assert.equal(codex.stored, true);
  assert.equal(codex.endpoint, SUB_BASE);
  assert.equal(codex.wire, 'responses');
  assert.equal(codex.expiresInSec, 3600);
  assert.equal(codex.hasRefresh, true);
  assert.equal(
    codex.enabled,
    process.env.SHADOW_ALLOW_IMPORT === '1',
    'the gate is reported as it actually is',
  );
  assert.ok(
    !JSON.stringify(codex).includes('at-secret') && !JSON.stringify(codex).includes('rt-secret'),
    'the descriptor must never carry the token',
  );
});

test('the spec declares a wire for every subscription backend', () => {
  for (const [name, spec] of Object.entries(SPECS)) {
    assert.ok(
      spec.subscriptionWire === 'chat' || spec.subscriptionWire === 'responses',
      `${name} must declare a subscription wire`,
    );
    // A backend whose subscription base differs from its API base is almost certainly not a
    // chat-completions host, which is the whole reason the wire travels with the credential.
    if (spec.subscriptionBaseUrl !== spec.apiBaseUrl) {
      assert.equal(spec.subscriptionWire, 'responses', `${name}: a distinct subscription backend speaks responses`);
    }
  }
});

// ── the wire itself ─────────────────────────────────────────────────────────────────────────
// The threading above only proves the OPTIONS carry the contract. This proves the REQUEST does:
// a loopback server sees the exact path, method and headers of a real send.
test('a Responses provider actually sends the subscription headers and the /responses path', async () => {
  const { createServer } = await import('node:http');
  const { ResponsesProvider } = await import('../src/provider/responses.js');

  let seen: { path?: string; headers?: Record<string, string | string[] | undefined> } = {};
  const server = createServer((req, res) => {
    seen = { path: req.url, headers: req.headers };
    req.resume();
    req.on('end', () => {
      // A minimal well-formed SSE tail so the parser finishes cleanly.
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.end('data: {"type":"response.completed","response":{"output":[],"usage":{"input_tokens":1,"output_tokens":1}}}\n\n');
    });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
  const { port } = server.address() as { port: number };

  try {
    const p = new ResponsesProvider({
      apiKey: 'at-secret',
      baseUrl: `http://127.0.0.1:${port}`,
      model: 'gpt-5-codex',
      extraHeaders: {
        'chatgpt-account-id': 'acc-9',
        'OpenAI-Beta': 'responses=experimental',
        originator: 'codex_cli_rs',
      },
    });
    for await (const _ of p.send(wireRequest('gpt-5-codex'))) {
      // drain
    }
    assert.equal(seen.path, '/responses', 'the Codex backend is a Responses surface');
    assert.equal(seen.headers?.authorization, 'Bearer at-secret');
    assert.equal(seen.headers?.['chatgpt-account-id'], 'acc-9');
    assert.equal(seen.headers?.['openai-beta'], 'responses=experimental');
    assert.equal(seen.headers?.originator, 'codex_cli_rs');
  } finally {
    server.close();
  }
});

test('a chat-completions provider sends the same identity headers when given them', async () => {
  const { createServer } = await import('node:http');
  const { OpenAIProvider } = await import('../src/provider/openai.js');
  let seen: { path?: string; headers?: Record<string, string | string[] | undefined> } = {};
  const server = createServer((req, res) => {
    seen = { path: req.url, headers: req.headers };
    req.resume();
    req.on('end', () => {
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.end('data: {"choices":[{"delta":{},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n');
    });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
  const { port } = server.address() as { port: number };
  try {
    const p = new OpenAIProvider({
      apiKey: 'at-secret',
      baseUrl: `http://127.0.0.1:${port}`,
      model: 'gpt-5-codex',
      extraHeaders: { originator: 'codex_cli_rs' },
    });
    for await (const _ of p.send(wireRequest('gpt-5-codex'))) {
      // drain
    }
    assert.equal(seen.path, '/chat/completions');
    assert.equal(seen.headers?.originator, 'codex_cli_rs');
    assert.equal(seen.headers?.authorization, 'Bearer at-secret');
  } finally {
    server.close();
  }
});

test('no extraHeaders → no stray identity headers on an ordinary endpoint', async () => {
  const { createServer } = await import('node:http');
  const { OpenAIProvider } = await import('../src/provider/openai.js');
  let seen: Record<string, string | string[] | undefined> = {};
  const server = createServer((req, res) => {
    seen = req.headers;
    req.resume();
    req.on('end', () => {
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.end('data: {"choices":[{"delta":{},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n');
    });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
  const { port } = server.address() as { port: number };
  try {
    const p = new OpenAIProvider({ apiKey: 'sk-plain', baseUrl: `http://127.0.0.1:${port}`, model: 'gpt-4o' });
    for await (const _ of p.send(wireRequest('gpt-4o'))) {
      // drain
    }
    assert.equal(seen.authorization, 'Bearer sk-plain');
    assert.equal(seen.originator, undefined);
    assert.equal(seen['chatgpt-account-id'], undefined);
    assert.equal(seen['openai-beta'], undefined);
  } finally {
    server.close();
  }
});

// ── wire selection ──────────────────────────────────────────────────────────────────────────
test('a credential-required wire outranks the SHADOW_WIRE_API default, in both directions', async () => {
  const { createProvider } = await import('../src/provider/index.js');
  const { ResponsesProvider } = await import('../src/provider/responses.js');
  const { OpenAIProvider } = await import('../src/provider/openai.js');
  const prev = process.env.SHADOW_WIRE_API;
  const base = { provider: 'openai' as const, model: 'gpt-5-codex', apiKey: 'k', baseUrl: 'https://example.test/v1' };
  try {
    // The credential says responses → responses, even though the env default is chat.
    delete process.env.SHADOW_WIRE_API;
    assert.ok(createProvider({ ...base, wire: 'responses' }) instanceof ResponsesProvider);

    // The credential says chat → chat, even though the env default is responses. A grok
    // subscription lands here: its backend is the public API base, which is not a Responses host.
    process.env.SHADOW_WIRE_API = 'responses';
    assert.ok(createProvider({ ...base, wire: 'chat' }) instanceof OpenAIProvider);

    // No credential wire → the env default still decides (unchanged behaviour).
    assert.ok(createProvider(base) instanceof ResponsesProvider);
    delete process.env.SHADOW_WIRE_API;
    assert.ok(createProvider(base) instanceof OpenAIProvider);
  } finally {
    if (prev === undefined) delete process.env.SHADOW_WIRE_API;
    else process.env.SHADOW_WIRE_API = prev;
  }
});
