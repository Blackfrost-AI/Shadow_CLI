/** Native, public-client Sign in with ChatGPT. Never reads another CLI's credentials.
 * Contract: https://developers.openai.com/siwc/token-sharing-open-source/sign-in
 */
import {
  createHash,
  createPublicKey,
  randomBytes,
  randomUUID,
  timingSafeEqual,
  verify,
  type JsonWebKey,
} from 'node:crypto';
import { createServer, type Server } from 'node:http';
import { existsSync, readdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { z } from 'zod';
import { isOfflineMode, shadowFetch } from '../safety/egress.js';
import { registerSecret } from '../util/redact.js';
import {
  ChatGPTAuthError,
  cancelled,
  readAuthFile,
  requireActive,
  secureDirectory,
  withChatGPTLock,
  writeAuthFile,
} from './chatgptStore.js';
export { ChatGPTAuthError } from './chatgptStore.js';

const ISSUER = 'https://auth.openai.com';
const AUTHORIZE = `${ISSUER}/api/accounts/authorize`;
const TOKEN = `${ISSUER}/api/accounts/oauth/token`;
const DISCOVERY = `${ISSUER}/.well-known/openid-configuration`;
const JWKS = `${ISSUER}/.well-known/jwks.json`;
const REVOKE = `${ISSUER}/api/accounts/oauth/revoke`;
const RESOURCE = 'https://api.openai.com/v1';
export const CHATGPT_RESPONSES_URL = `${RESOURCE}/responses`;
export const CHATGPT_DIRECT_SCOPE = 'chatgpt.tokens.use.direct';
const SCOPE = `openid profile email offline_access resource.invoke ${CHATGPT_DIRECT_SCOPE}`;
const DYNAMIC_CLIENT = 'dynamic_agent_client';
const PROFILE = /^chatgpt-[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
const client = z
  .string()
  .min(1)
  .max(512)
  .regex(/^[A-Za-z0-9_.:-]+$/)
  .refine((v) => v !== DYNAMIC_CLIENT);
const tokensSchema = z.object({
  accessToken: z.string().min(1).max(128_000),
  refreshToken: z.string().min(1).max(128_000).optional(),
  idToken: z.string().min(1).max(128_000),
  expiresAt: z.number().finite().positive(),
  scopes: z.array(z.string().max(200)).max(100),
  authorizationNonce: z.string(),
  earliestRefreshAt: z.number().finite().optional(),
  /** A rotated grant is durable immediately, but never usable until identity is verified. */
  verificationPending: z.literal(true).optional(),
});
const accountSchema = z.object({
  version: z.literal(1),
  profileId: z.string().regex(PROFILE),
  clientId: client,
  issuer: z.literal(ISSUER),
  subject: z.string().min(1).max(1024).optional(),
  email: z.string().max(512).optional(),
  name: z.string().max(512).optional(),
  createdAt: z.number().finite(),
  tokens: tokensSchema.optional(),
});
type AccountRecord = z.infer<typeof accountSchema>;
type Tokens = z.infer<typeof tokensSchema>;
export interface ChatGPTAccount {
  profileId: string;
  label: string;
  email?: string;
  clientId: string;
  subject?: string;
  signedIn: boolean;
  planUsageEnabled: boolean;
  expiresAt?: number;
  verificationPending?: true;
}
export interface ChatGPTModel {
  slug: string;
  displayName: string;
}
export interface ChatGPTSignInOptions {
  profileId?: string;
  signal?: AbortSignal;
  /** Contains sensitive account hints on reauthorization; never log this URL. */
  onUrl: (url: string) => void | Promise<void>;
  /** User explicitly chose to enable ChatGPT plan usage after a prior decline. */
  enablePlanUsage?: boolean;
}
export interface ChatGPTLogoutResult {
  profileId: string;
  localCleared: true;
  revocation: 'confirmed' | 'unconfirmed' | 'not-needed';
}
/** Only dependency-injected instances expose test storage/transport seams. No endpoint override. */
export interface ChatGPTAuthDependencies {
  storageDir?: string;
  request?: typeof shadowFetch;
  now?: () => number;
  requestTimeoutMs?: number;
  callbackTimeoutMs?: number;
  lockTimeoutMs?: number;
}
const safeLabel = (value: string): string =>
  value.replace(/[\u0000-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/g, '').slice(0, 100);
function publicAccount(record: AccountRecord): ChatGPTAccount {
  return {
    profileId: record.profileId,
    label: `${safeLabel(record.email ?? record.name ?? 'ChatGPT account')} · ${record.profileId.slice(-8)}`,
    ...(record.email ? { email: safeLabel(record.email) } : {}),
    clientId: record.clientId,
    subject: record.subject,
    signedIn: !!record.tokens,
    planUsageEnabled:
      !record.tokens?.verificationPending && !!record.tokens?.scopes.includes(CHATGPT_DIRECT_SCOPE),
    expiresAt: record.tokens?.expiresAt,
    ...(record.tokens?.verificationPending ? { verificationPending: true as const } : {}),
  };
}
const equal = (a: string, b: string): boolean => {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  return left.length === right.length && timingSafeEqual(left, right);
};
function malformed(): ChatGPTAuthError {
  return new ChatGPTAuthError(
    'invalid_response',
    'OpenAI returned an incomplete or invalid authentication response.',
  );
}
function stringField(value: unknown, max = 128_000): string {
  if (typeof value !== 'string' || !value || value.length > max) throw malformed();
  return value;
}
function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw malformed();
  return value as Record<string, unknown>;
}
function deadline(
  parent: AbortSignal | undefined,
  ms: number,
): { signal: AbortSignal; close: () => void } {
  const controller = new AbortController();
  const onAbort = (): void => controller.abort();
  parent?.addEventListener('abort', onAbort, { once: true });
  if (parent?.aborted) controller.abort();
  const timer = setTimeout(onAbort, ms);
  return {
    signal: controller.signal,
    close: () => {
      clearTimeout(timer);
      parent?.removeEventListener('abort', onAbort);
    },
  };
}
async function abortable<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  requireActive(signal);
  return await new Promise<T>((resolve, reject) => {
    const onAbort = (): void => reject(cancelled());
    signal.addEventListener('abort', onAbort, { once: true });
    void promise.then(resolve, reject).finally(() => signal.removeEventListener('abort', onAbort));
  });
}

/** Pure protocol preparation; secrets in this return value must remain transient. */
export function prepareChatGPTAuthorization(input: {
  clientId?: string;
  hostId: string;
  redirectUri: string;
  idTokenHint?: string;
  loginHint?: string;
  enablePlanUsage?: boolean;
}): { url: string; state: string; nonce: string; verifier: string } {
  const callback = new URL(input.redirectUri);
  if (
    callback.protocol !== 'http:' ||
    callback.hostname !== '127.0.0.1' ||
    callback.pathname !== '/auth/callback' ||
    !callback.port ||
    callback.search ||
    callback.hash ||
    callback.username ||
    callback.password
  )
    throw new ChatGPTAuthError(
      'invalid_callback',
      'ChatGPT sign-in requires the local Shadow callback.',
    );
  if (input.clientId && !client.safeParse(input.clientId).success)
    throw new ChatGPTAuthError('invalid_client', 'Saved ChatGPT registration is invalid.');
  const state = randomBytes(32).toString('base64url');
  const nonce = randomBytes(32).toString('base64url');
  const verifier = randomBytes(64).toString('base64url');
  const params = new URLSearchParams({
    client_id: input.clientId ?? DYNAMIC_CLIENT,
    ext_agent_host_id: input.hostId,
    response_type: 'code',
    redirect_uri: input.redirectUri,
    scope: SCOPE,
    resource: RESOURCE,
    state,
    nonce,
    code_challenge_method: 'S256',
    code_challenge: createHash('sha256').update(verifier).digest('base64url'),
  });
  if (!input.clientId) params.set('agent_name_hint', 'Shadow');
  else {
    if (input.idTokenHint) params.set('id_token_hint', input.idTokenHint);
    if (input.loginHint) params.set('login_hint', input.loginHint);
  }
  if (input.enablePlanUsage) params.set('prompt', 'consent');
  return { url: `${AUTHORIZE}?${params}`, state, nonce, verifier };
}

export function createChatGPTAuth(deps: ChatGPTAuthDependencies = {}) {
  const dir = deps.storageDir ?? join(homedir(), '.shadow', 'chatgpt-auth');
  const request = deps.request ?? shadowFetch;
  const now = deps.now ?? Date.now;
  const requestTimeout = deps.requestTimeoutMs ?? 30_000;
  const lockTimeout = deps.lockTimeoutMs ?? 45_000;
  const profilePath = (id: string): string => {
    if (!PROFILE.test(id))
      throw new ChatGPTAuthError('invalid_profile', 'Select a saved Shadow ChatGPT account.');
    return join(dir, `${id}.json`);
  };
  function readAccount(id: string): AccountRecord {
    const parsed = accountSchema.safeParse(readAuthFile(profilePath(id)));
    if (!parsed.success || parsed.data.profileId !== id)
      throw new ChatGPTAuthError(
        'account_missing',
        'This ChatGPT registration is missing or unreadable. Select a saved account or sign in again.',
      );
    if (parsed.data.tokens && !parsed.data.subject)
      throw new ChatGPTAuthError(
        'storage_corrupt',
        'Saved ChatGPT credentials have no verified identity.',
      );
    return parsed.data;
  }
  function listChatGPTAccountsSync(): ChatGPTAccount[] {
    if (!existsSync(dir)) return [];
    secureDirectory(dir);
    return readdirSync(dir)
      .filter((name) => PROFILE.test(name.replace(/\.json$/, '')) && name.endsWith('.json'))
      .map((name) => readAccount(name.slice(0, -5)))
      .sort((a, b) => a.createdAt - b.createdAt || a.profileId.localeCompare(b.profileId))
      .map(publicAccount);
  }
  async function hostId(signal?: AbortSignal): Promise<string> {
    return await withChatGPTLock(dir, 'host', signal, lockTimeout, async () => {
      const path = join(dir, 'host.json');
      const record = readAuthFile(path);
      if (record !== undefined) {
        const parsed = z
          .object({ version: z.literal(1), hostId: z.string().regex(/^urn:uuid:[a-f0-9-]{36}$/) })
          .safeParse(record);
        if (!parsed.success)
          throw new ChatGPTAuthError(
            'storage_corrupt',
            'Shadow’s ChatGPT host registration is unreadable and was preserved.',
          );
        return parsed.data.hostId;
      }
      const id = `urn:uuid:${randomUUID()}`;
      await writeAuthFile(path, { version: 1, hostId: id });
      return id;
    });
  }
  async function http(
    url: string,
    init: RequestInit,
    purpose: 'oauth' | 'model-list',
    signal?: AbortSignal,
  ): Promise<{ status: number; body: unknown }> {
    requireActive(signal);
    const timeout = deadline(signal, requestTimeout);
    let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
    try {
      const response = await abortable(
        request(
          url,
          { ...init, redirect: 'error', signal: timeout.signal },
          { purpose, origin: 'user' },
        ),
        timeout.signal,
      );
      reader = response.body?.getReader();
      const chunks: Uint8Array[] = [];
      let size = 0;
      while (reader) {
        const result = await abortable(reader.read(), timeout.signal);
        if (result.done) break;
        size += result.value.byteLength;
        if (size > 1024 * 1024) throw malformed();
        chunks.push(result.value);
      }
      const text = Buffer.concat(chunks).toString('utf8');
      let body: unknown = {};
      if (text) {
        try {
          body = JSON.parse(text) as unknown;
        } catch {
          if (response.ok) throw malformed();
        }
      }
      return { status: response.status, body };
    } catch (error) {
      if (error instanceof ChatGPTAuthError) {
        if (error.code === 'cancelled' && !signal?.aborted)
          throw new ChatGPTAuthError('timeout', 'OpenAI authentication timed out. Try again.');
        throw error;
      }
      if (signal?.aborted) throw cancelled();
      if (timeout.signal.aborted)
        throw new ChatGPTAuthError('timeout', 'OpenAI authentication timed out. Try again.');
      throw new ChatGPTAuthError(
        'network_error',
        'OpenAI authentication could not be reached. Saved credentials were preserved.',
      );
    } finally {
      if (reader) void reader.cancel().catch(() => {});
      timeout.close();
    }
  }
  function endpointError(status: number, body: unknown): ChatGPTAuthError {
    const raw =
      body && typeof body === 'object' ? (body as Record<string, unknown>).error : undefined;
    const code =
      typeof raw === 'string'
        ? raw
        : raw && typeof raw === 'object'
          ? (raw as Record<string, unknown>).code
          : undefined;
    const known = [
      'invalid_grant',
      'invalid_refresh_token',
      'token_expired',
      'refresh_token_expired',
      'refresh_token_invalidated',
      'refresh_token_reused',
      'invalid_client',
      'access_denied',
    ];
    if (typeof code === 'string' && known.includes(code))
      return new ChatGPTAuthError(
        code,
        code === 'invalid_client'
          ? 'OpenAI rejected this ChatGPT client registration. Sign in again or check the integration.'
          : 'The selected ChatGPT authorization is no longer usable. Sign in again.',
        status,
      );
    return new ChatGPTAuthError(
      status >= 500 ? 'server_error' : 'request_rejected',
      `OpenAI rejected the authentication request (HTTP ${status}).`,
      status,
    );
  }
  async function postToken(
    form: Record<string, string>,
    signal?: AbortSignal,
  ): Promise<Record<string, unknown>> {
    const result = await http(
      TOKEN,
      {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams(form).toString(),
      },
      'oauth',
      signal,
    );
    if (result.status !== 200) throw endpointError(result.status, result.body);
    return object(result.body);
  }
  async function identity(
    idToken: string,
    clientId: string,
    nonce: string,
    initial: boolean,
    signal?: AbortSignal,
  ): Promise<{ subject: string; email?: string; name?: string }> {
    try {
      const parts = idToken.split('.');
      if (parts.length !== 3 || parts.some((part) => !part || !/^[A-Za-z0-9_-]+$/.test(part)))
        throw malformed();
      const header = object(JSON.parse(Buffer.from(parts[0]!, 'base64url').toString('utf8')));
      const claims = object(JSON.parse(Buffer.from(parts[1]!, 'base64url').toString('utf8')));
      if (
        header.alg !== 'RS256' ||
        typeof header.kid !== 'string' ||
        header.kid.length > 512 ||
        header.crit !== undefined
      )
        throw malformed();
      const result = await http(JWKS, {}, 'oauth', signal);
      if (result.status !== 200) throw endpointError(result.status, result.body);
      const keys = object(result.body).keys;
      if (!Array.isArray(keys) || keys.length > 100) throw malformed();
      const matches = keys
        .map(object)
        .filter(
          (key) =>
            key.kid === header.kid &&
            key.kty === 'RSA' &&
            (key.alg === undefined || key.alg === 'RS256') &&
            (key.use === undefined || key.use === 'sig'),
        );
      if (matches.length !== 1) throw malformed();
      const key = matches[0]!;
      if (
        key.key_ops !== undefined &&
        (!Array.isArray(key.key_ops) || !key.key_ops.includes('verify'))
      )
        throw malformed();
      const publicKey = createPublicKey({ key: key as JsonWebKey, format: 'jwk' });
      if (
        (publicKey.asymmetricKeyDetails?.modulusLength ?? 0) < 2048 ||
        !verify(
          'RSA-SHA256',
          Buffer.from(`${parts[0]}.${parts[1]}`),
          publicKey,
          Buffer.from(parts[2]!, 'base64url'),
        )
      )
        throw malformed();
      const seconds = now() / 1000;
      const audiences = Array.isArray(claims.aud) ? claims.aud : [claims.aud];
      if (
        claims.iss !== ISSUER ||
        audiences.length > 20 ||
        audiences.some((aud) => typeof aud !== 'string') ||
        !audiences.includes(clientId) ||
        (audiences.length > 1 && claims.azp !== clientId) ||
        (claims.azp !== undefined && claims.azp !== clientId) ||
        typeof claims.exp !== 'number' ||
        !Number.isFinite(claims.exp) ||
        claims.exp <= seconds - 5 ||
        typeof claims.iat !== 'number' ||
        !Number.isFinite(claims.iat) ||
        claims.iat > seconds + 5 ||
        claims.iat >= claims.exp ||
        (claims.nbf !== undefined &&
          (typeof claims.nbf !== 'number' ||
            !Number.isFinite(claims.nbf) ||
            claims.nbf > seconds + 5)) ||
        ((initial || claims.nonce !== undefined) && claims.nonce !== nonce)
      )
        throw malformed();
      return {
        subject: stringField(claims.sub, 1024),
        ...(typeof claims.email === 'string' ? { email: claims.email.slice(0, 512) } : {}),
        ...(typeof claims.name === 'string' ? { name: claims.name.slice(0, 512) } : {}),
      };
    } catch (error) {
      if (
        error instanceof ChatGPTAuthError &&
        ['cancelled', 'timeout', 'network_error', 'server_error'].includes(error.code)
      )
        throw error;
      throw new ChatGPTAuthError(
        'invalid_identity',
        'OpenAI identity verification failed. No unverified credentials were made available.',
      );
    }
  }
  function tokenRecord(
    response: Record<string, unknown>,
    nonce: string,
    previous?: Tokens,
  ): Tokens {
    if (
      typeof response.token_type !== 'string' ||
      response.token_type.toLowerCase() !== 'bearer' ||
      typeof response.expires_in !== 'number' ||
      !Number.isFinite(response.expires_in) ||
      response.expires_in <= 0 ||
      response.expires_in > 86400
    )
      throw malformed();
    const scopes =
      response.scope === undefined && previous
        ? previous.scopes
        : stringField(response.scope, 20_000).split(/\s+/).filter(Boolean);
    const accessToken = stringField(response.access_token);
    const idToken =
      response.id_token === undefined && previous
        ? previous.idToken
        : stringField(response.id_token);
    const refreshToken =
      response.refresh_token === undefined ? undefined : stringField(response.refresh_token);
    if ((previous?.refreshToken || scopes.includes('offline_access')) && !refreshToken)
      throw malformed(); // Never silently reuse a rotated grant.
    if (
      [accessToken, idToken, refreshToken].some(
        (value) => value !== undefined && /[\s\u0000-\u001f\u007f]/.test(value),
      )
    )
      throw malformed();
    for (const secret of [accessToken, idToken, refreshToken]) if (secret) registerSecret(secret);
    const earliest =
      typeof response.earliest_refresh_at === 'number' &&
      Number.isFinite(response.earliest_refresh_at)
        ? response.earliest_refresh_at * 1000
        : undefined;
    const parsed = tokensSchema.safeParse({
      accessToken,
      idToken,
      refreshToken,
      scopes,
      expiresAt: now() + response.expires_in * 1000,
      authorizationNonce: nonce,
      ...(earliest ? { earliestRefreshAt: earliest } : {}),
    });
    if (!parsed.success) throw malformed();
    return parsed.data;
  }
  async function callback(
    options: ChatGPTSignInOptions,
    host: string,
    record: AccountRecord | undefined,
    signal: AbortSignal,
  ): Promise<{
    code: string;
    clientId: string;
    redirectUri: string;
    nonce: string;
    verifier: string;
  }> {
    let server: Server | undefined;
    let settled = false;
    let prepared: ReturnType<typeof prepareChatGPTAuthorization> | undefined;
    let redirectUri = '';
    let resolveResult!: (result: {
      code: string;
      clientId: string;
      redirectUri: string;
      nonce: string;
      verifier: string;
    }) => void;
    let rejectResult!: (error: Error) => void;
    const result = new Promise<{
      code: string;
      clientId: string;
      redirectUri: string;
      nonce: string;
      verifier: string;
    }>((resolve, reject) => {
      resolveResult = resolve;
      rejectResult = reject;
    });
    void result.catch(() => {});
    const stop = (error: Error): void => {
      if (!settled) {
        settled = true;
        rejectResult(error);
      }
    };
    const onAbort = (): void => stop(cancelled());
    signal.addEventListener('abort', onAbort, { once: true });
    try {
      requireActive(signal);
      server = createServer((request, response) => {
        response.setHeader('content-type', 'text/plain; charset=utf-8');
        response.setHeader('cache-control', 'no-store');
        response.setHeader('connection', 'close');
        if (settled || request.method !== 'GET' || !request.url || request.url.length > 16_384) {
          response.writeHead(400);
          response.end('Invalid sign-in callback.');
          return;
        }
        let url: URL;
        try {
          url = new URL(request.url, 'http://127.0.0.1');
        } catch {
          response.writeHead(400);
          response.end('Invalid sign-in callback.');
          return;
        }
        if (url.pathname !== '/auth/callback') {
          response.writeHead(404);
          response.end('Not found.');
          return;
        }
        try {
          if (
            !prepared ||
            request.headers.host !== new URL(redirectUri).host ||
            ['state', 'code', 'client_id', 'error'].some(
              (key) => url.searchParams.getAll(key).length > 1,
            ) ||
            !equal(url.searchParams.get('state') ?? '', prepared.state)
          )
            throw new ChatGPTAuthError(
              'state_mismatch',
              'The ChatGPT sign-in callback did not match this attempt.',
            );
          if (url.searchParams.has('error'))
            throw new ChatGPTAuthError(
              'access_denied',
              'ChatGPT sign-in was declined or could not be completed.',
            );
          const supplied = url.searchParams.get('client_id');
          if (record && supplied && supplied !== record.clientId)
            throw new ChatGPTAuthError(
              'client_mismatch',
              'The callback changed the selected ChatGPT registration.',
            );
          const clientId = record?.clientId ?? supplied;
          if (!clientId || !client.safeParse(clientId).success)
            throw new ChatGPTAuthError(
              'registration_incomplete',
              'ChatGPT did not return an issued client ID. Start sign-in again.',
            );
          const code = stringField(url.searchParams.get('code'), 8192);
          settled = true;
          response.end('Authorization received. Return to Shadow to complete sign-in.');
          resolveResult({
            code,
            clientId,
            redirectUri,
            nonce: prepared.nonce,
            verifier: prepared.verifier,
          });
        } catch (error) {
          response.writeHead(400);
          response.end('Sign-in was not completed. Return to Shadow.');
          stop(error instanceof ChatGPTAuthError ? error : malformed());
        }
      });
      server.headersTimeout = 10_000;
      server.requestTimeout = 10_000;
      await abortable(
        new Promise<void>((resolve, reject) => {
          server!.once('error', reject);
          server!.listen(0, '127.0.0.1', () => resolve());
        }),
        signal,
      );
      const address = server.address();
      if (!address || typeof address === 'string')
        throw new ChatGPTAuthError(
          'callback_unavailable',
          'Shadow could not start the local ChatGPT callback.',
        );
      redirectUri = `http://127.0.0.1:${address.port}/auth/callback`;
      prepared = prepareChatGPTAuthorization({
        clientId: record?.clientId,
        hostId: host,
        redirectUri,
        idTokenHint: record?.tokens?.verificationPending ? undefined : record?.tokens?.idToken,
        loginHint: record?.email,
        enablePlanUsage: options.enablePlanUsage,
      });
      try {
        await abortable(
          Promise.resolve().then(() => options.onUrl(prepared!.url)),
          signal,
        );
      } catch {
        throw signal.aborted
          ? cancelled()
          : new ChatGPTAuthError(
              'browser_unavailable',
              'The ChatGPT sign-in page could not be opened.',
            );
      }
      return await result;
    } finally {
      signal.removeEventListener('abort', onAbort);
      if (server) {
        server.closeAllConnections();
        await new Promise<void>((resolve) => server!.close(() => resolve()));
      }
    }
  }
  async function signInChatGPT(options: ChatGPTSignInOptions): Promise<ChatGPTAccount> {
    requireActive(options.signal);
    // Browser navigation bypasses shadowFetch, so enforce offline before creating any host or
    // client registration, opening the loopback listener, or invoking the browser callback.
    if (isOfflineMode())
      throw new ChatGPTAuthError(
        'offline',
        'ChatGPT sign-in is unavailable in offline mode. Turn off offline mode to sign in.',
      );
    const host = await hostId(options.signal);
    const id = options.profileId ?? `chatgpt-${randomUUID()}`;
    profilePath(id);
    const timeout = deadline(options.signal, deps.callbackTimeoutMs ?? 10 * 60_000);
    try {
      return await withChatGPTLock(dir, id, timeout.signal, lockTimeout, async () => {
        let record = options.profileId ? readAccount(id) : undefined;
        for (let attempt = 0; attempt < 2; attempt++) {
          const auth = await callback(options, host, record, timeout.signal);
          // Retain the issued registration even if exchange fails; never register it twice.
          if (!record) {
            record = {
              version: 1,
              profileId: id,
              clientId: auth.clientId,
              issuer: ISSUER,
              createdAt: now(),
            };
            await writeAuthFile(profilePath(id), record);
          }
          let response: Record<string, unknown>;
          try {
            response = await postToken(
              {
                grant_type: 'authorization_code',
                client_id: auth.clientId,
                code: auth.code,
                code_verifier: auth.verifier,
                redirect_uri: auth.redirectUri,
                resource: RESOURCE,
              },
              timeout.signal,
            );
          } catch (error) {
            if (
              error instanceof ChatGPTAuthError &&
              error.code === 'invalid_grant' &&
              attempt === 0
            )
              continue;
            throw error;
          }
          const tokens = tokenRecord(response, auth.nonce);
          const verified = await identity(
            tokens.idToken,
            record.clientId,
            auth.nonce,
            true,
            timeout.signal,
          );
          if (record.subject && record.subject !== verified.subject)
            throw new ChatGPTAuthError(
              'identity_mismatch',
              'Sign-in returned a different ChatGPT identity. The selected account was preserved.',
            );
          requireActive(timeout.signal);
          const updated = { ...record, ...verified, tokens };
          await writeAuthFile(profilePath(id), updated);
          return publicAccount(updated);
        }
        throw new ChatGPTAuthError(
          'invalid_grant',
          'ChatGPT authorization expired. Sign in again using the saved registration.',
        );
      });
    } catch (error) {
      if (timeout.signal.aborted && !options.signal?.aborted) {
        throw new ChatGPTAuthError('timeout', 'ChatGPT sign-in timed out. Start sign-in again.');
      }
      throw error;
    } finally {
      timeout.close();
    }
  }
  /** Caller holds the account lock. Pending credentials are not exposed to callers or inference. */
  async function verifyRotation(record: AccountRecord, signal?: AbortSignal): Promise<Tokens> {
    const pending = record.tokens!;
    if (!pending.verificationPending) return pending;
    const verified = await identity(
      pending.idToken,
      record.clientId,
      pending.authorizationNonce,
      false,
      signal,
    );
    if (verified.subject !== record.subject)
      throw new ChatGPTAuthError(
        'identity_mismatch',
        'A renewed ChatGPT token changed identity. Sign in again.',
      );
    requireActive(signal);
    const tokens = { ...pending };
    delete tokens.verificationPending;
    await writeAuthFile(profilePath(record.profileId), { ...record, tokens });
    record.tokens = tokens;
    return tokens;
  }
  async function getChatGPTAccessToken(profileId: string, signal?: AbortSignal): Promise<string> {
    profilePath(profileId);
    return await withChatGPTLock(dir, profileId, signal, lockTimeout, async () => {
      const record = readAccount(profileId);
      if (!record.tokens)
        throw new ChatGPTAuthError('sign_in_required', 'Sign in to the selected ChatGPT account.');
      // A previous process may have received a successful rotation and then lost JWKS access.
      // Finish that verification first; never send the consumed previous refresh token again.
      const saved = await verifyRotation(record, signal);
      if (!saved.scopes.includes(CHATGPT_DIRECT_SCOPE))
        throw new ChatGPTAuthError(
          'plan_usage_disabled',
          'ChatGPT plan usage is not enabled for this account. Enable it in sign-in settings.',
        );
      if (
        saved.expiresAt > now() + 60_000 ||
        (saved.expiresAt > now() &&
          saved.earliestRefreshAt !== undefined &&
          saved.earliestRefreshAt > now())
      ) {
        registerSecret(saved.accessToken);
        return saved.accessToken;
      }
      if (!saved.refreshToken)
        throw new ChatGPTAuthError(
          'sign_in_required',
          'This ChatGPT session cannot be renewed. Sign in again.',
        );
      try {
        const response = await postToken(
          {
            grant_type: 'refresh_token',
            client_id: record.clientId,
            refresh_token: saved.refreshToken,
            resource: RESOURCE,
          },
          signal,
        );
        let tokens = tokenRecord(response, saved.authorizationNonce, saved);
        if (response.id_token !== undefined) tokens.verificationPending = true;
        // The refresh token was consumed by the successful exchange. Retain its replacement
        // before any further network operation, even if cancellation arrived meanwhile.
        await writeAuthFile(profilePath(profileId), { ...record, tokens });
        record.tokens = tokens;
        tokens = await verifyRotation(record, signal);
        requireActive(signal);
        if (!tokens.scopes.includes(CHATGPT_DIRECT_SCOPE))
          throw new ChatGPTAuthError(
            'plan_usage_disabled',
            'ChatGPT plan usage permission is no longer granted. Enable it in sign-in settings.',
          );
        return tokens.accessToken;
      } catch (error) {
        if (
          error instanceof ChatGPTAuthError &&
          [
            'invalid_grant',
            'invalid_refresh_token',
            'token_expired',
            'refresh_token_expired',
            'refresh_token_invalidated',
            'refresh_token_reused',
          ].includes(error.code)
        ) {
          delete record.tokens;
          await writeAuthFile(profilePath(profileId), record);
        }
        throw error;
      }
    });
  }
  async function listChatGPTModels(
    profileId: string,
    signal?: AbortSignal,
  ): Promise<ChatGPTModel[]> {
    const access = await getChatGPTAccessToken(profileId, signal);
    const result = await http(
      `${RESOURCE}/models`,
      { headers: { authorization: `Bearer ${access}` } },
      'model-list',
      signal,
    );
    if (result.status !== 200) throw endpointError(result.status, result.body);
    const models = object(result.body).models;
    if (!Array.isArray(models) || models.length > 2000) throw malformed();
    return models
      .map(object)
      .filter((model) => model.visibility === 'list')
      .map((model) => ({
        slug: stringField(model.slug, 512),
        displayName: safeLabel(stringField(model.display_name, 512)),
      }));
  }
  async function logoutChatGPT(
    profileId: string,
    signal?: AbortSignal,
  ): Promise<ChatGPTLogoutResult> {
    profilePath(profileId);
    return await withChatGPTLock(dir, profileId, signal, lockTimeout, async () => {
      const record = readAccount(profileId);
      let revocation: ChatGPTLogoutResult['revocation'] = record.tokens
        ? 'unconfirmed'
        : 'not-needed';
      try {
        if (record.tokens?.refreshToken) {
          const discovery = await http(DISCOVERY, {}, 'oauth', signal);
          const metadata = object(discovery.body);
          if (
            discovery.status !== 200 ||
            metadata.issuer !== ISSUER ||
            metadata.revocation_endpoint !== REVOKE
          )
            throw malformed();
          for (let attempt = 0; attempt < 3; attempt++) {
            try {
              const result = await http(
                REVOKE,
                {
                  method: 'POST',
                  headers: { 'content-type': 'application/x-www-form-urlencoded' },
                  body: new URLSearchParams({
                    token: record.tokens.refreshToken,
                    token_type_hint: 'refresh_token',
                    client_id: record.clientId,
                  }).toString(),
                },
                'oauth',
                signal,
              );
              if (result.status !== 200) throw endpointError(result.status, result.body);
              revocation = 'confirmed';
              break;
            } catch (error) {
              if (
                attempt === 2 ||
                !(error instanceof ChatGPTAuthError) ||
                !['network_error', 'timeout', 'server_error'].includes(error.code) ||
                signal?.aborted
              )
                throw error;
              await delay(100 * 2 ** attempt, undefined, { signal });
            }
          }
        }
      } catch {
        /* Clearing locally is explicit; report unconfirmed remote revocation honestly. */
      }
      delete record.tokens;
      await writeAuthFile(profilePath(profileId), record);
      return { profileId, localCleared: true, revocation };
    });
  }
  return {
    listChatGPTAccountsSync,
    listChatGPTAccounts: async () => listChatGPTAccountsSync(),
    signInChatGPT,
    getChatGPTAccessToken,
    listChatGPTModels,
    logoutChatGPT,
  };
}

// Lazy initialization keeps listing/auth storage independent from module import and test HOME.
const defaults = (): ReturnType<typeof createChatGPTAuth> => createChatGPTAuth();
export const listChatGPTAccountsSync = (): ChatGPTAccount[] => defaults().listChatGPTAccountsSync();
export const listChatGPTAccounts = async (): Promise<ChatGPTAccount[]> =>
  defaults().listChatGPTAccounts();
export const signInChatGPT = (options: ChatGPTSignInOptions): Promise<ChatGPTAccount> =>
  defaults().signInChatGPT(options);
export const getChatGPTAccessToken = (profileId: string, signal?: AbortSignal): Promise<string> =>
  defaults().getChatGPTAccessToken(profileId, signal);
export const listChatGPTModels = (
  profileId: string,
  signal?: AbortSignal,
): Promise<ChatGPTModel[]> => defaults().listChatGPTModels(profileId, signal);
export const logoutChatGPT = (
  profileId: string,
  signal?: AbortSignal,
): Promise<ChatGPTLogoutResult> => defaults().logoutChatGPT(profileId, signal);
