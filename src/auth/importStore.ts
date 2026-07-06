/**
 * Import credentials an OFFICIAL CLI already minted, instead of running our own
 * OAuth dance (the "Hermes pattern" — lowest ToS exposure: Shadow never
 * impersonates a client_id, it reuses a token the user legitimately obtained).
 *
 * Schemas verified against the 0.141.0 Codex and 0.2.59 Grok binaries:
 *   ~/.codex/auth.json  { auth_mode, OPENAI_API_KEY, tokens:{id_token,access_token,
 *                         refresh_token,account_id}, last_refresh }
 *   ~/.grok/auth.json   { "<issuer>::<entity-uuid>": { access_token, refresh_token,
 *                         expires_at, id_token, token_type, scope, api_key } }
 *
 * Parsers are pure (operate on already-parsed JSON); the reader injects fs for tests.
 * We NEVER write back to the official CLI's file — a refresh stores into Shadow's
 * own store instead, so we cannot corrupt the official credential.
 */
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { ImportedCredential, SubProvider } from './types.js';

export function codexAuthPath(): string {
  const home = process.env.CODEX_HOME;
  return home ? join(home, 'auth.json') : join(homedir(), '.codex', 'auth.json');
}

export function grokAuthPath(): string {
  return join(homedir(), '.grok', 'auth.json');
}

/** Decode a JWT's `exp` (unix seconds) without verifying the signature. */
export function jwtExp(token: string): number | undefined {
  const parts = token.split('.');
  if (parts.length < 2) return undefined;
  try {
    const json = Buffer.from(parts[1]!.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8');
    const payload = JSON.parse(json) as { exp?: unknown };
    return typeof payload.exp === 'number' ? payload.exp : undefined;
  } catch {
    return undefined;
  }
}

type Json = Record<string, unknown>;
const str = (v: unknown): string | undefined => (typeof v === 'string' && v ? v : undefined);

/** Normalize an expiry that may be unix seconds, unix millis, or an RFC3339 string → unix seconds. */
export function toUnixSeconds(v: unknown): number | undefined {
  if (typeof v === 'number') return v > 1e12 ? Math.floor(v / 1000) : v;
  if (typeof v === 'string') {
    const ms = Date.parse(v);
    if (!Number.isNaN(ms)) return Math.floor(ms / 1000);
    const n = Number(v);
    if (!Number.isNaN(n)) return n > 1e12 ? Math.floor(n / 1000) : n;
  }
  return undefined;
}

/** Parse `~/.codex/auth.json`. API-key mode wins (sanctioned); else the ChatGPT subscription token. */
export function parseCodexAuth(json: unknown): ImportedCredential | undefined {
  if (!json || typeof json !== 'object') return undefined;
  const o = json as Json;
  const apiKey = str(o.OPENAI_API_KEY);
  if (apiKey) return { provider: 'codex', kind: 'apiKey', token: apiKey };

  const tokens = (o.tokens as Json | undefined) ?? undefined;
  const access = tokens && str(tokens.access_token);
  if (!access) return undefined;
  return {
    provider: 'codex',
    kind: 'subscription',
    token: access,
    refreshToken: tokens && str(tokens.refresh_token),
    idToken: tokens && str(tokens.id_token),
    accountId: tokens && str(tokens.account_id),
    expiresAt: jwtExp(access),
  };
}

/**
 * Parse `~/.grok/auth.json`. The file is a map keyed by "<issuer>::<entity>". A
 * sanctioned `api_key` wins; otherwise the OAuth/OIDC session bearer, which the Grok
 * CLI stores under `key` (browser-login) or `access_token`, with `expires_at` as an
 * RFC3339 string.
 */
export function parseGrokAuth(json: unknown): ImportedCredential | undefined {
  if (!json || typeof json !== 'object') return undefined;
  for (const entry of Object.values(json as Json)) {
    if (!entry || typeof entry !== 'object') continue;
    const e = entry as Json;
    const apiKey = str(e.api_key);
    if (apiKey) return { provider: 'grok', kind: 'apiKey', token: apiKey };
    const bearer = str(e.key) ?? str(e.access_token);
    if (!bearer) continue;
    return {
      provider: 'grok',
      kind: 'subscription',
      token: bearer,
      refreshToken: str(e.refresh_token),
      idToken: str(e.id_token),
      expiresAt: toUnixSeconds(e.expires_at) ?? jwtExp(bearer),
    };
  }
  return undefined;
}

/** Read + parse an official CLI's credential, or undefined if absent/unreadable. */
export function readImported(
  provider: SubProvider,
  readFile: (p: string) => string = (p) => readFileSync(p, 'utf8'),
): ImportedCredential | undefined {
  const path = provider === 'codex' ? codexAuthPath() : grokAuthPath();
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFile(path));
  } catch {
    return undefined; // missing file or bad JSON → no imported credential
  }
  return provider === 'codex' ? parseCodexAuth(parsed) : parseGrokAuth(parsed);
}

/** Is this credential expired (with skew)? API keys never expire; tokens without a known exp are treated as live. */
export function isExpired(cred: ImportedCredential, nowSec: number, skewSec = 60): boolean {
  if (cred.kind === 'apiKey' || cred.expiresAt === undefined) return false;
  return cred.expiresAt <= nowSec + skewSec;
}
