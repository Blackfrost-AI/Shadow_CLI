import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash, generateKeyPairSync, sign } from 'node:crypto';
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { pathToFileURL } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import { setTimeout as delay } from 'node:timers/promises';
import {
  ChatGPTAuthError,
  createChatGPTAuth,
  prepareChatGPTAuthorization,
  type ChatGPTSignInOptions,
} from '../src/auth/chatgpt.js';
import { withChatGPTLock } from '../src/auth/chatgptStore.js';
import { isOfflineMode, setOfflineMode, type shadowFetch } from '../src/safety/egress.js';

const pair = generateKeyPairSync('rsa', { modulusLength: 2048 });
const jwk = {
  ...pair.publicKey.export({ format: 'jwk' }),
  kid: 'fixture-key',
  alg: 'RS256',
  use: 'sig',
};
const issuer = 'https://auth.openai.com';
const direct = 'chatgpt.tokens.use.direct';
const scopes = `openid profile email offline_access resource.invoke ${direct}`;
type RequestHook = (
  url: string,
  init: RequestInit | undefined,
) => Promise<Response | undefined> | Response | undefined;
function fixture() {
  const dir = mkdtempSync(join(tmpdir(), 'shadow-chatgpt-'));
  let clock = Date.now();
  let issued = 'oaiapp_fixture';
  let subject = 'fixture-subject';
  let scope = scopes;
  let refreshes = 0;
  let grants = 0;
  let hook: RequestHook | undefined;
  let claimsPatch: Record<string, unknown> = {};
  let badSignature = false;
  const urls: URL[] = [];
  const requests: Array<{ url: string; init: RequestInit | undefined; purpose?: string }> = [];
  function idToken(): string {
    const payload = {
      iss: issuer,
      aud: issued,
      sub: subject,
      email: 'fixture@example.test',
      name: 'Fixture',
      iat: Math.floor(clock / 1000),
      exp: Math.floor(clock / 1000) + 3600,
      nonce: urls.at(-1)?.searchParams.get('nonce'),
      ...claimsPatch,
    };
    const base = [{ alg: 'RS256', kid: 'fixture-key' }, payload]
      .map((v) => Buffer.from(JSON.stringify(v)).toString('base64url'))
      .join('.');
    const signature = sign('RSA-SHA256', Buffer.from(base), pair.privateKey);
    if (badSignature) signature[0] = signature[0]! ^ 1;
    return `${base}.${signature.toString('base64url')}`;
  }
  const request: typeof shadowFetch = async (url, init, opts) => {
    requests.push({ url, init, purpose: opts?.purpose });
    const special = await hook?.(url, init);
    if (special) return special;
    if (url === `${issuer}/.well-known/jwks.json`) return Response.json({ keys: [jwk] });
    if (url === `${issuer}/.well-known/openid-configuration`)
      return Response.json({ issuer, revocation_endpoint: `${issuer}/api/accounts/oauth/revoke` });
    if (url === `${issuer}/api/accounts/oauth/revoke`) return new Response(null, { status: 200 });
    if (url === 'https://api.openai.com/v1/models')
      return Response.json({
        models: [
          { slug: 'eligible-b', display_name: 'Eligible B', visibility: 'list' },
          { slug: 'hidden', display_name: 'Hidden', visibility: 'hidden' },
          { slug: 'eligible-a', display_name: 'Eligible A', visibility: 'list' },
        ],
      });
    assert.equal(url, `${issuer}/api/accounts/oauth/token`);
    assert.equal(init?.redirect, 'error');
    const form = new URLSearchParams(String(init?.body));
    assert.equal(form.get('client_id'), issued);
    assert.equal(form.get('resource'), 'https://api.openai.com/v1');
    if (form.get('grant_type') === 'refresh_token') {
      refreshes++;
      assert.equal(form.has('scope'), false);
      await delay(25);
    } else {
      grants++;
      const auth = urls.at(-1)!;
      assert.equal(form.get('redirect_uri'), auth.searchParams.get('redirect_uri'));
      assert.equal(
        createHash('sha256').update(form.get('code_verifier')!).digest('base64url'),
        auth.searchParams.get('code_challenge'),
      );
    }
    return Response.json({
      access_token: `access-private-${refreshes}`,
      refresh_token: `refresh-private-${refreshes}`,
      id_token: idToken(),
      token_type: 'Bearer',
      expires_in: 3600,
      scope,
    });
  };
  const auth = createChatGPTAuth({
    storageDir: dir,
    request,
    now: () => clock,
    requestTimeoutMs: 500,
    callbackTimeoutMs: 1500,
    lockTimeoutMs: 2000,
  });
  const onUrl: ChatGPTSignInOptions['onUrl'] = async (raw) => {
    const url = new URL(raw);
    urls.push(url);
    const callback = new URL(url.searchParams.get('redirect_uri')!);
    callback.searchParams.set('state', url.searchParams.get('state')!);
    callback.searchParams.set('code', 'fixture-code');
    callback.searchParams.set('client_id', issued);
    const response = await fetch(callback);
    assert.equal(response.status, 200);
    await response.text();
  };
  return {
    dir,
    auth,
    urls,
    requests,
    onUrl,
    request,
    idToken,
    setHook: (value: RequestHook | undefined) => {
      hook = value;
    },
    setSubject: (value: string) => {
      subject = value;
    },
    setClient: (value: string) => {
      issued = value;
    },
    setScopes: (value: string) => {
      scope = value;
    },
    patchClaims: (value: Record<string, unknown>) => {
      claimsPatch = value;
    },
    breakSignature: () => {
      badSignature = true;
    },
    advance: (ms: number) => {
      clock += ms;
    },
    get refreshes() {
      return refreshes;
    },
    get grants() {
      return grants;
    },
    close: () => rmSync(dir, { recursive: true, force: true }),
  };
}

test('authorization preparation fixes endpoints, loopback path and scopes, with fresh PKCE/state/nonce', () => {
  const input = { hostId: 'urn:uuid:fixture', redirectUri: 'http://127.0.0.1:1455/auth/callback' };
  const a = prepareChatGPTAuthorization(input);
  const b = prepareChatGPTAuthorization(input);
  const url = new URL(a.url);
  assert.equal(url.origin, issuer);
  assert.equal(url.pathname, '/api/accounts/authorize');
  assert.equal(url.searchParams.get('client_id'), 'dynamic_agent_client');
  assert.equal(url.searchParams.get('agent_name_hint'), 'Shadow');
  assert.equal(url.searchParams.get('scope'), scopes);
  for (const field of ['state', 'nonce', 'verifier'] as const) assert.notEqual(a[field], b[field]);
  assert.equal(
    url.searchParams.get('code_challenge'),
    createHash('sha256').update(a.verifier).digest('base64url'),
  );
  const returning = new URL(
    prepareChatGPTAuthorization({
      ...input,
      clientId: 'oaiapp_returning',
      idTokenHint: 'sensitive-hint',
      loginHint: 'fixture@example.test',
      enablePlanUsage: true,
    }).url,
  );
  assert.equal(returning.searchParams.has('agent_name_hint'), false);
  assert.equal(returning.searchParams.get('prompt'), 'consent');
  assert.equal(returning.searchParams.get('id_token_hint'), 'sensitive-hint');
  for (const redirectUri of [
    'http://localhost:1455/auth/callback',
    'http://127.0.0.1:1455/callback',
    'https://127.0.0.1:1455/auth/callback',
    'http://127.0.0.1:1455/auth/callback?x=1',
  ])
    assert.throws(() => prepareChatGPTAuthorization({ ...input, redirectUri }), ChatGPTAuthError);
});

test('native sign-in validates identity, stores only Shadow credentials and returns a secret-free account', async () => {
  const h = fixture();
  try {
    const account = await h.auth.signInChatGPT({ onUrl: h.onUrl });
    assert.equal(account.clientId, 'oaiapp_fixture');
    assert.equal(account.subject, 'fixture-subject');
    assert.equal(account.signedIn, true);
    assert.equal(account.planUsageEnabled, true);
    assert.equal(await h.auth.getChatGPTAccessToken(account.profileId), 'access-private-0');
    assert.deepEqual(await h.auth.listChatGPTAccounts(), h.auth.listChatGPTAccountsSync());
    assert.doesNotMatch(
      JSON.stringify(account),
      /access-private|refresh-private|idToken|authorizationNonce/,
    );
    assert.equal(h.requests.filter((r) => r.url.endsWith('/token')).length, 1);
    assert.ok(h.requests.every((r) => r.purpose === 'oauth'));
    if (process.platform !== 'win32') {
      assert.equal(statSync(h.dir).mode & 0o777, 0o700);
      for (const name of readdirSync(h.dir))
        assert.equal(statSync(join(h.dir, name)).mode & 0o777, 0o600);
    }
    const raw = JSON.parse(readFileSync(join(h.dir, `${account.profileId}.json`), 'utf8'));
    assert.equal(raw.tokens.refreshToken, 'refresh-private-0');
  } finally {
    h.close();
  }
});

test('returning sign-in reuses client and host but renews all attempt secrets; logout keeps registration', async () => {
  const h = fixture();
  try {
    const first = await h.auth.signInChatGPT({ onUrl: h.onUrl });
    const second = await h.auth.signInChatGPT({ profileId: first.profileId, onUrl: h.onUrl });
    assert.equal(second.profileId, first.profileId);
    const [a, b] = h.urls;
    assert.equal(b!.searchParams.get('client_id'), 'oaiapp_fixture');
    assert.equal(b!.searchParams.has('agent_name_hint'), false);
    assert.equal(
      a!.searchParams.get('ext_agent_host_id'),
      b!.searchParams.get('ext_agent_host_id'),
    );
    assert.notEqual(a!.searchParams.get('state'), b!.searchParams.get('state'));
    assert.notEqual(a!.searchParams.get('nonce'), b!.searchParams.get('nonce'));
    assert.ok(b!.searchParams.get('id_token_hint'));
    assert.equal((await h.auth.logoutChatGPT(first.profileId)).revocation, 'confirmed');
    const saved = h.auth.listChatGPTAccountsSync()[0]!;
    assert.equal(saved.signedIn, false);
    assert.equal(saved.clientId, first.clientId);
    assert.equal(saved.subject, first.subject);
    const text = readFileSync(join(h.dir, `${first.profileId}.json`), 'utf8');
    assert.doesNotMatch(text, /access-private|refresh-private|idToken|authorizationNonce/);
    await h.auth.signInChatGPT({ profileId: first.profileId, onUrl: h.onUrl });
    assert.equal(h.urls.at(-1)!.searchParams.get('client_id'), 'oaiapp_fixture');
    assert.equal(h.urls.at(-1)!.searchParams.has('id_token_hint'), false);
  } finally {
    h.close();
  }
});

test('accounts with the same email remain separate and model catalogs preserve eligible server order', async () => {
  const h = fixture();
  try {
    const a = await h.auth.signInChatGPT({ onUrl: h.onUrl });
    h.setClient('oaiapp_another');
    const b = await h.auth.signInChatGPT({ onUrl: h.onUrl });
    assert.notEqual(a.profileId, b.profileId);
    assert.notEqual(a.label, b.label);
    assert.equal(a.email, b.email);
    assert.equal(h.auth.listChatGPTAccountsSync().length, 2);
    assert.deepEqual(await h.auth.listChatGPTModels(b.profileId), [
      { slug: 'eligible-b', displayName: 'Eligible B' },
      { slug: 'eligible-a', displayName: 'Eligible A' },
    ]);
    const catalog = h.requests.at(-1)!;
    assert.equal(catalog.purpose, 'model-list');
    assert.equal(
      new Headers(catalog.init?.headers).get('authorization'),
      'Bearer access-private-0',
    );
  } finally {
    h.close();
  }
});

test('a valid identity without direct plan scope is retained but never authorizes inference or model-list calls', async () => {
  const h = fixture();
  h.setScopes('openid profile email');
  try {
    const a = await h.auth.signInChatGPT({ onUrl: h.onUrl });
    assert.equal(a.signedIn, true);
    assert.equal(a.planUsageEnabled, false);
    await assert.rejects(
      h.auth.getChatGPTAccessToken(a.profileId),
      (e: unknown) => e instanceof ChatGPTAuthError && e.code === 'plan_usage_disabled',
    );
    await assert.rejects(h.auth.listChatGPTModels(a.profileId), /plan usage is not enabled/);
    assert.ok(!h.requests.some((r) => r.url.includes('/models')));
  } finally {
    h.close();
  }
});

for (const [name, patch] of Object.entries({
  issuer: { iss: 'https://invalid.example' },
  audience: { aud: 'other-client' },
  expiry: { exp: 1 },
  nonce: { nonce: 'wrong' },
  futureIssued: { iat: 9999999999 },
  authorizedParty: { aud: ['oaiapp_fixture', 'other'], azp: 'other' },
})) {
  test(`ID token ${name} validation rejects before activating the account`, async () => {
    const h = fixture();
    h.patchClaims(patch);
    try {
      await assert.rejects(
        h.auth.signInChatGPT({ onUrl: h.onUrl }),
        (e: unknown) => e instanceof ChatGPTAuthError && e.code === 'invalid_identity',
      );
      assert.equal(h.auth.listChatGPTAccountsSync()[0]?.signedIn, false);
    } finally {
      h.close();
    }
  });
}
test('invalid signature and a returning identity change do not replace saved credentials', async () => {
  const h = fixture();
  try {
    const a = await h.auth.signInChatGPT({ onUrl: h.onUrl });
    const before = readFileSync(join(h.dir, `${a.profileId}.json`), 'utf8');
    h.setSubject('different-subject');
    await assert.rejects(
      h.auth.signInChatGPT({ profileId: a.profileId, onUrl: h.onUrl }),
      /different ChatGPT identity/,
    );
    assert.equal(readFileSync(join(h.dir, `${a.profileId}.json`), 'utf8'), before);
    h.breakSignature();
    await assert.rejects(
      h.auth.signInChatGPT({ profileId: a.profileId, onUrl: h.onUrl }),
      /identity verification failed/,
    );
    assert.equal(readFileSync(join(h.dir, `${a.profileId}.json`), 'utf8'), before);
  } finally {
    h.close();
  }
});

test('callback state, denied consent and mismatched issued client reject without exchange', async () => {
  for (const mode of ['state', 'denied', 'client']) {
    const h = fixture();
    try {
      const existing =
        mode === 'client' ? await h.auth.signInChatGPT({ onUrl: h.onUrl }) : undefined;
      const grants = h.grants;
      await assert.rejects(
        h.auth.signInChatGPT({
          profileId: existing?.profileId,
          onUrl: async (raw) => {
            const auth = new URL(raw);
            const callback = new URL(auth.searchParams.get('redirect_uri')!);
            callback.searchParams.set(
              'state',
              mode === 'state' ? 'wrong' : auth.searchParams.get('state')!,
            );
            callback.searchParams.set('code', 'fixture');
            callback.searchParams.set(
              'client_id',
              mode === 'client' ? 'other-client' : 'oaiapp_fixture',
            );
            if (mode === 'denied') callback.searchParams.set('error', 'access_denied');
            const response = await fetch(callback);
            assert.equal(response.status, 400);
            await response.text();
          },
        }),
        ChatGPTAuthError,
      );
      assert.equal(h.grants, grants);
    } finally {
      h.close();
    }
  }
});

test('invalid_grant retries fresh authorization once using the already issued client ID', async () => {
  const h = fixture();
  let exchanges = 0;
  h.setHook((url) =>
    url.endsWith('/oauth/token') && ++exchanges === 1
      ? Response.json(
          { error: 'invalid_grant', description: 'secret response must not be logged' },
          { status: 400 },
        )
      : undefined,
  );
  try {
    const a = await h.auth.signInChatGPT({ onUrl: h.onUrl });
    assert.equal(a.signedIn, true);
    assert.equal(h.urls.length, 2);
    assert.equal(h.urls[0]!.searchParams.get('client_id'), 'dynamic_agent_client');
    assert.equal(h.urls[1]!.searchParams.get('client_id'), 'oaiapp_fixture');
    assert.notEqual(h.urls[0]!.searchParams.get('state'), h.urls[1]!.searchParams.get('state'));
  } finally {
    h.close();
  }
});

test('cancellation and a rejected browser opener always close the loopback listener', async () => {
  for (const cancel of [true, false]) {
    const h = fixture();
    const controller = new AbortController();
    let callback = '';
    try {
      await assert.rejects(
        h.auth.signInChatGPT({
          signal: controller.signal,
          onUrl: (raw) => {
            callback = new URL(raw).searchParams.get('redirect_uri')!;
            if (cancel) controller.abort();
            else throw new Error(`Sensitive URL ${raw}`);
          },
        }),
        (e: unknown) =>
          e instanceof ChatGPTAuthError &&
          !e.message.includes('state=') &&
          !e.message.includes('Sensitive URL'),
      );
      await assert.rejects(fetch(callback));
      assert.equal(h.requests.length, 0);
    } finally {
      h.close();
    }
  }
});

test('two auth instances serialize rotating refresh and persist the latest set atomically', async () => {
  const h = fixture();
  try {
    const a = await h.auth.signInChatGPT({ onUrl: h.onUrl });
    h.advance(3_600_000);
    const other = createChatGPTAuth({
      storageDir: h.dir,
      request: h.request,
      now: () => Date.now() + 3_600_000,
    });
    const [first, second] = await Promise.all([
      h.auth.getChatGPTAccessToken(a.profileId),
      other.getChatGPTAccessToken(a.profileId),
    ]);
    assert.equal(first, 'access-private-1');
    assert.equal(second, first);
    assert.equal(h.refreshes, 1);
    const record = JSON.parse(readFileSync(join(h.dir, `${a.profileId}.json`), 'utf8'));
    assert.equal(record.tokens.refreshToken, 'refresh-private-1');
  } finally {
    h.close();
  }
});

test('a rotated grant survives transient JWKS failure and restart without reusing the old refresh token', async () => {
  const h = fixture();
  try {
    const account = await h.auth.signInChatGPT({ onUrl: h.onUrl });
    h.advance(3_600_000);
    h.setHook((url) => {
      if (url.endsWith('/jwks.json')) throw new Error('Fixture transient JWKS outage');
      return undefined;
    });
    await assert.rejects(
      h.auth.getChatGPTAccessToken(account.profileId),
      (error: unknown) => error instanceof ChatGPTAuthError && error.code === 'network_error',
    );
    const path = join(h.dir, `${account.profileId}.json`);
    const pending = JSON.parse(readFileSync(path, 'utf8'));
    assert.equal(pending.tokens.refreshToken, 'refresh-private-1');
    assert.equal(pending.tokens.verificationPending, true);
    assert.ok(!readFileSync(path, 'utf8').includes('refresh-private-0'));
    assert.equal(h.auth.listChatGPTAccountsSync()[0]?.verificationPending, true);
    assert.equal(h.auth.listChatGPTAccountsSync()[0]?.planUsageEnabled, false);
    assert.equal(h.refreshes, 1);

    const restarted = createChatGPTAuth({
      storageDir: h.dir,
      request: h.request,
      now: () => Date.now() + 3_600_000,
    });
    await assert.rejects(
      restarted.getChatGPTAccessToken(account.profileId),
      (error: unknown) => error instanceof ChatGPTAuthError && error.code === 'network_error',
    );
    assert.equal(h.refreshes, 1, 'verification retry does not exchange any refresh token');
    h.setHook(undefined);
    assert.equal(await restarted.getChatGPTAccessToken(account.profileId), 'access-private-1');
    assert.equal(h.refreshes, 1);
    assert.equal(JSON.parse(readFileSync(path, 'utf8')).tokens.verificationPending, undefined);

    h.advance(3_600_000);
    assert.equal(await h.auth.getChatGPTAccessToken(account.profileId), 'access-private-2');
    const exchanged = h.requests
      .filter((entry) => entry.url.endsWith('/token'))
      .map((entry) => new URLSearchParams(String(entry.init?.body)))
      .filter((form) => form.get('grant_type') === 'refresh_token')
      .map((form) => form.get('refresh_token'));
    assert.deepEqual(exchanged, ['refresh-private-0', 'refresh-private-1']);
  } finally {
    h.close();
  }
});

test('an unverified renewed identity is withheld from inference and logout revokes its replacement grant', async () => {
  const h = fixture();
  try {
    const account = await h.auth.signInChatGPT({ onUrl: h.onUrl });
    h.advance(3_600_000);
    h.setSubject('unexpected-renewed-identity');
    for (let attempt = 0; attempt < 2; attempt++) {
      await assert.rejects(
        h.auth.listChatGPTModels(account.profileId),
        (error: unknown) => error instanceof ChatGPTAuthError && error.code === 'identity_mismatch',
      );
    }
    assert.equal(h.refreshes, 1);
    assert.equal(
      h.requests.some((entry) => entry.url === 'https://api.openai.com/v1/models'),
      false,
    );
    const pending = JSON.parse(readFileSync(join(h.dir, `${account.profileId}.json`), 'utf8'));
    assert.equal(pending.subject, account.subject, 'verified account identity remains unchanged');
    assert.equal(pending.tokens.verificationPending, true);
    const result = await h.auth.logoutChatGPT(account.profileId);
    assert.equal(result.revocation, 'confirmed');
    const revoke = h.requests.find((entry) => entry.url.endsWith('/revoke'))!;
    assert.equal(new URLSearchParams(String(revoke.init?.body)).get('token'), 'refresh-private-1');
    assert.equal(h.auth.listChatGPTAccountsSync()[0]?.signedIn, false);
  } finally {
    h.close();
  }
});

test('offline sign-in refuses before browser navigation, network requests or local registration', async () => {
  const root = mkdtempSync(join(tmpdir(), 'shadow-chatgpt-offline-'));
  const storageDir = join(root, 'not-created');
  const before = isOfflineMode();
  let opened = false;
  try {
    setOfflineMode(true);
    // Production transport is deliberately used: the preflight must stop before any I/O.
    const auth = createChatGPTAuth({ storageDir });
    await assert.rejects(
      auth.signInChatGPT({
        onUrl: () => {
          opened = true;
        },
      }),
      (error: unknown) => error instanceof ChatGPTAuthError && error.code === 'offline',
    );
    assert.equal(opened, false);
    assert.equal(existsSync(storageDir), false);
  } finally {
    setOfflineMode(before);
    rmSync(root, { recursive: true, force: true });
  }
});

test('two separate processes consume a rotating refresh token only once', async () => {
  const h = fixture();
  try {
    const account = await h.auth.signInChatGPT({ onUrl: h.onUrl });
    const clock = Date.now() + 3_600_000;
    const modulePath = pathToFileURL(resolve('src/auth/chatgpt.ts')).href;
    const countPath = join(h.dir, 'refresh-count.txt');
    const script = `import {createChatGPTAuth} from ${JSON.stringify(modulePath)}; import {appendFileSync} from 'node:fs'; const auth=createChatGPTAuth({storageDir:${JSON.stringify(h.dir)},now:()=>${clock},request:async()=>{appendFileSync(${JSON.stringify(countPath)},'refresh\\n');await new Promise(r=>setTimeout(r,100));return Response.json({access_token:'process-access',refresh_token:'process-refresh',token_type:'Bearer',expires_in:3600});}}); process.stdout.write(await auth.getChatGPTAccessToken(${JSON.stringify(account.profileId)}));`;
    const run = async (): Promise<string> => {
      const child = spawn(
        process.execPath,
        ['--import', 'tsx', '--input-type=module', '-e', script],
        { stdio: ['ignore', 'pipe', 'pipe'] },
      );
      let output = '';
      let stderr = '';
      child.stdout.on('data', (bytes) => {
        output += bytes.toString();
      });
      child.stderr.on('data', (bytes) => {
        stderr += bytes.toString();
      });
      const guard = setTimeout(() => child.kill('SIGKILL'), 5000);
      try {
        const [code] = await once(child, 'close');
        assert.equal(code, 0, stderr);
        return output;
      } finally {
        clearTimeout(guard);
      }
    };
    assert.deepEqual(await Promise.all([run(), run()]), ['process-access', 'process-access']);
    assert.equal(readFileSync(countPath, 'utf8'), 'refresh\n');
  } finally {
    h.close();
  }
});

test('terminal refresh failure clears tokens but temporary failures preserve them and never expose response text', async () => {
  for (const terminal of [true, false]) {
    const h = fixture();
    try {
      const a = await h.auth.signInChatGPT({ onUrl: h.onUrl });
      h.advance(3_600_000);
      h.setHook((url) =>
        url.endsWith('/token')
          ? Response.json(
              {
                error: terminal ? 'refresh_token_reused' : 'server_error',
                message: 'refresh-private-0 access-private-0 sensitive-body',
              },
              { status: terminal ? 400 : 503 },
            )
          : undefined,
      );
      await assert.rejects(
        h.auth.getChatGPTAccessToken(a.profileId),
        (e: unknown) => e instanceof ChatGPTAuthError && !/private|sensitive-body/.test(e.message),
      );
      const record = JSON.parse(readFileSync(join(h.dir, `${a.profileId}.json`), 'utf8'));
      assert.equal(!!record.tokens, !terminal);
      assert.equal(record.clientId, a.clientId);
      assert.equal(record.subject, a.subject);
    } finally {
      h.close();
    }
  }
});

test('timed-out token transport cannot hang sign-in or leak transport error secrets', async () => {
  const h = fixture();
  h.setHook((url) => (url.endsWith('/token') ? new Promise(() => {}) : undefined));
  try {
    await assert.rejects(
      h.auth.signInChatGPT({ onUrl: h.onUrl }),
      (e: unknown) => e instanceof ChatGPTAuthError && e.code === 'timeout',
    );
  } finally {
    h.close();
  }
});

test('failed revocation is retried, clears local tokens and reports remote uncertainty', async () => {
  const h = fixture();
  let revocations = 0;
  try {
    const a = await h.auth.signInChatGPT({ onUrl: h.onUrl });
    h.setHook((url) =>
      url.endsWith('/revoke')
        ? (revocations++,
          Response.json({ error: 'temporary', message: 'private-token' }, { status: 503 }))
        : undefined,
    );
    const result = await h.auth.logoutChatGPT(a.profileId);
    assert.equal(result.localCleared, true);
    assert.equal(result.revocation, 'unconfirmed');
    assert.equal(revocations, 3);
    assert.equal(h.auth.listChatGPTAccountsSync()[0]?.signedIn, false);
  } finally {
    h.close();
  }
});

test('refresh lock excludes another process and is released automatically after an owner crash', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'shadow-chatgpt-lock-'));
  const modulePath = pathToFileURL(resolve('src/auth/chatgptStore.ts')).href;
  const script = `import {withChatGPTLock} from ${JSON.stringify(modulePath)}; await withChatGPTLock(${JSON.stringify(dir)},'crash',undefined,5000,async()=>{process.stdout.write('LOCKED\\n');await new Promise(()=>setInterval(()=>{},1000));});`;
  const child = spawn(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', script], {
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let stderr = '';
  child.stderr.on('data', (bytes) => {
    stderr += bytes.toString();
  });
  const guard = setTimeout(() => child.kill('SIGKILL'), 5000);
  try {
    const [first] = await Promise.race([
      once(child.stdout, 'data'),
      once(child, 'close').then(() => {
        throw new Error(`Lock fixture exited before acquiring: ${stderr}`);
      }),
    ]);
    assert.match(String(first), /LOCKED/, stderr);
    await assert.rejects(
      withChatGPTLock(dir, 'crash', undefined, 75, async () => {
        throw new Error('Must not acquire');
      }),
      (e: unknown) => e instanceof ChatGPTAuthError && e.code === 'account_busy',
    );
    const closed = once(child, 'close');
    child.kill('SIGKILL');
    await closed;
    assert.equal(
      await withChatGPTLock(dir, 'crash', undefined, 1000, async () => 'recovered'),
      'recovered',
    );
    const db = new DatabaseSync(join(dir, 'crash.lock.sqlite'));
    db.close();
  } finally {
    clearTimeout(guard);
    if (child.exitCode === null && !child.killed) {
      const closed = once(child, 'close');
      child.kill('SIGKILL');
      await closed;
    }
    rmSync(dir, { recursive: true, force: true });
  }
});

test('unreadable stored account data fails closed without replacement', async () => {
  const h = fixture();
  try {
    const a = await h.auth.signInChatGPT({ onUrl: h.onUrl });
    const path = join(h.dir, `${a.profileId}.json`);
    writeFileSync(path, '{broken');
    assert.throws(() => h.auth.listChatGPTAccountsSync(), ChatGPTAuthError);
    assert.equal(readFileSync(path, 'utf8'), '{broken');
  } finally {
    h.close();
  }
});
