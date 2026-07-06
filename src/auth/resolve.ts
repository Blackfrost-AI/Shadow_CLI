/**
 * The tiered credential resolver. Pure logic over injected inputs (testable, no fs/net).
 *
 * Precedence:
 *   1. Anthropic → env/store bearer ONLY. Never subscription import/OAuth (ToS).
 *   2. Explicit bearer (env / ~/.shadow store) → wins for every provider.
 *   3. allowImport (opt-in) → freshest of {Shadow subscription store, live official-CLI import}.
 *   4. otherwise undefined (caller falls back to whatever it had).
 */
import type { ImportedCredential, ResolvedAuth, SubProvider } from './types.js';
import { SPECS } from './spec.js';
import { isExpired } from './importStore.js';

export interface ResolveInput {
  provider: string; // 'anthropic' | 'openai' | 'mock' | ...
  subProvider?: SubProvider;
  allowImport: boolean;
  /** Bearer from env / onboarding store (resolveApiKey / resolveAuthToken). */
  envBearer?: string;
  /** Credential previously materialized into Shadow's subscription store. */
  storedCred?: ImportedCredential;
  /** Credential read live from an official CLI's auth.json. */
  liveImport?: ImportedCredential;
  nowSec: number;
}

/** Prefer Shadow's own stored cred unless it's expired and the live one is fresher. */
function pickFreshest(
  stored: ImportedCredential | undefined,
  live: ImportedCredential | undefined,
  nowSec: number,
): ImportedCredential | undefined {
  if (stored && !isExpired(stored, nowSec)) return stored;
  if (live && !isExpired(live, nowSec)) return live;
  return stored ?? live; // both stale (or absent) → hand back what exists so the caller can refresh
}

function toResolved(cred: ImportedCredential): ResolvedAuth {
  const spec = SPECS[cred.provider];
  if (cred.kind === 'apiKey') {
    return { bearer: cred.token, baseUrl: spec.apiBaseUrl, source: `imported-${cred.provider}` as ResolvedAuth['source'] };
  }
  return {
    bearer: cred.token,
    baseUrl: spec.subscriptionBaseUrl,
    extraHeaders: spec.extraHeaders(cred),
    expiresAt: cred.expiresAt,
    source: `imported-${cred.provider}` as ResolvedAuth['source'],
  };
}

export function resolveAuth(input: ResolveInput): ResolvedAuth | undefined {
  if (input.provider === 'anthropic') {
    // Hard ToS boundary: Anthropic is API-key-only. No import, no OAuth, ever.
    return input.envBearer ? { bearer: input.envBearer, source: 'env' } : undefined;
  }
  if (input.envBearer) return { bearer: input.envBearer, source: 'env' };
  if (!input.allowImport || !input.subProvider) return undefined;
  const cred = pickFreshest(input.storedCred, input.liveImport, input.nowSec);
  return cred ? toResolved(cred) : undefined;
}
