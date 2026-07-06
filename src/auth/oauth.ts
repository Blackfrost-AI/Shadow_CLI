/**
 * Opt-in OAuth flow for Codex (auth.openai.com). PKCE authorization-code with a
 * localhost callback, plus a device-code path for headless boxes, plus token refresh.
 *
 * STATUS: scaffolded, NOT yet validated against a live endpoint (deferred). The shapes
 * mirror what the 0.141.0 Codex binary asserts (PKCE 43–128, response_type/client_id/
 * state/code_challenge/code_challenge_method/redirect_uri/scope; token exchange at
 * /oauth/token). Grok is intentionally absent — Shadow does not drive xAI's
 * consumer-subscription OAuth (ToS). Only wire this behind an explicit opt-in + a
 * one-time ToS acknowledgement.
 */
import type { ImportedCredential } from './types.js';
import { SPECS } from './spec.js';
import { createPkce, randomState, type Pkce } from './pkce.js';
import { jwtExp } from './importStore.js';

export interface AuthUrl {
  url: string;
  pkce: Pkce;
  state: string;
  redirectUri: string;
}

/** Build the authorization URL + the PKCE/state the caller must hold for the exchange. */
export function buildCodexAuthUrl(): AuthUrl {
  const spec = SPECS.codex;
  const pkce = createPkce();
  const state = randomState();
  const params = new URLSearchParams({
    response_type: 'code',
    client_id: spec.clientId!,
    redirect_uri: spec.redirectUri!,
    scope: spec.scopes!,
    state,
    code_challenge: pkce.challenge,
    code_challenge_method: pkce.method,
  });
  return { url: `${spec.authBaseUrl}/oauth/authorize?${params}`, pkce, state, redirectUri: spec.redirectUri! };
}

interface TokenResponse {
  access_token?: string;
  refresh_token?: string;
  id_token?: string;
  expires_in?: number;
}

function intoCredential(t: TokenResponse, nowSec: number): ImportedCredential {
  const access = t.access_token ?? '';
  return {
    provider: 'codex',
    kind: 'subscription',
    token: access,
    refreshToken: t.refresh_token,
    idToken: t.id_token,
    expiresAt: jwtExp(access) ?? (t.expires_in ? nowSec + t.expires_in : undefined),
  };
}

async function postForm(url: string, form: Record<string, string>, signal?: AbortSignal): Promise<TokenResponse> {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams(form).toString(),
    signal,
  });
  if (!res.ok) throw new Error(`oauth token endpoint ${res.status}: ${await res.text().catch(() => '')}`);
  return (await res.json()) as TokenResponse;
}

/** Exchange an authorization code (+ PKCE verifier) for tokens. */
export async function exchangeCodexCode(
  code: string,
  verifier: string,
  nowSec: number,
  signal?: AbortSignal,
): Promise<ImportedCredential> {
  const spec = SPECS.codex;
  const t = await postForm(
    `${spec.authBaseUrl}/oauth/token`,
    {
      grant_type: 'authorization_code',
      code,
      client_id: spec.clientId!,
      redirect_uri: spec.redirectUri!,
      code_verifier: verifier,
    },
    signal,
  );
  return intoCredential(t, nowSec);
}

/** Refresh an expiring subscription token. Returns a fresh credential to re-store. */
export async function refreshCodex(
  refreshToken: string,
  nowSec: number,
  signal?: AbortSignal,
): Promise<ImportedCredential> {
  const spec = SPECS.codex;
  const t = await postForm(
    `${spec.authBaseUrl}/oauth/token`,
    { grant_type: 'refresh_token', refresh_token: refreshToken, client_id: spec.clientId! },
    signal,
  );
  const cred = intoCredential(t, nowSec);
  // Token endpoints often omit a fresh refresh_token on refresh — keep the old one.
  if (!cred.refreshToken) cred.refreshToken = refreshToken;
  return cred;
}
