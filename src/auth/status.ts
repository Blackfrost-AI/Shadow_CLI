/**
 * Human-readable state of the subscription-credential path, shared by `shadow login status` and the
 * TUI's `/login` so the two can never describe the same store differently.
 *
 * Why this exists: the credential could be stored and still not be used, for two reasons that were
 * invisible from inside the app — the `SHADOW_ALLOW_IMPORT` opt-in gate, and an expired token. A user
 * who had imported a credential and then saw the normal API path behave as if none existed had no
 * way to tell which. This reports the ENDPOINT and the GATE along with the credential, never the
 * secret.
 */
import type { ImportedCredential, SubProvider } from './types.js';
import { SPECS } from './spec.js';
import { getSubAuth } from './store.js';

export interface SubAuthStatus {
  provider: SubProvider;
  stored: boolean;
  kind?: ImportedCredential['kind'];
  /** Unix seconds, when known. */
  expiresAt?: number;
  /** Seconds remaining (negative = already expired), when the expiry is known. */
  expiresInSec?: number;
  hasRefresh: boolean;
  accountId?: string;
  /** Where a subscription credential is sent, and by which wire. */
  endpoint: string;
  wire: 'chat' | 'responses';
  /** Whether the opt-in gate is open. A stored credential is inert while this is false. */
  enabled: boolean;
  /** An actionable remedy, present only when this credential will NOT be used as things stand. */
  hint?: string;
}

/** The stored state of every sub-provider, ready to render. Never includes the token. */
export function subscriptionAuthStatus(nowSec: number): SubAuthStatus[] {
  const enabled = process.env.SHADOW_ALLOW_IMPORT === '1';
  return (['codex', 'grok'] as const).map((provider) => {
    const cred = getSubAuth(provider);
    const spec = SPECS[provider];
    const status: SubAuthStatus = {
      provider,
      stored: Boolean(cred),
      kind: cred?.kind,
      expiresAt: cred?.expiresAt,
      expiresInSec: cred?.expiresAt !== undefined ? cred.expiresAt - nowSec : undefined,
      hasRefresh: Boolean(cred?.refreshToken),
      accountId: cred?.accountId,
      endpoint: spec.subscriptionBaseUrl,
      wire: spec.subscriptionWire,
      enabled,
    };
    if (cred && !enabled) {
      status.hint =
        `Stored, but not in use: subscription credentials need an explicit opt-in. ` +
        `Start Shadow with SHADOW_ALLOW_IMPORT=1 (this is the ToS acknowledgement for reusing a ` +
        `${provider} subscription in a third-party client).`;
    } else if (cred && status.expiresInSec !== undefined && status.expiresInSec <= 0) {
      status.hint = status.hasRefresh
        ? 'Expired — Shadow refreshes it automatically on the next start.'
        : 'Expired with no refresh token on file — re-import it from the official CLI.';
    }
    return status;
  });
}

/** One display line per provider, for the CLI and the TUI's `/login`. */
export function subscriptionAuthLines(nowSec: number): string[] {
  const out: string[] = [];
  for (const s of subscriptionAuthStatus(nowSec)) {
    if (!s.stored) {
      out.push(`${s.provider}: no subscription credential stored`);
      continue;
    }
    const when =
      s.expiresInSec === undefined
        ? 'no expiry recorded'
        : s.expiresInSec <= 0
          ? 'EXPIRED'
          : `expires in ${Math.round(s.expiresInSec / 60)}m`;
    const parts = [
      `${s.provider}: ${s.kind} (${when})`,
      s.hasRefresh ? 'refresh token present' : 'no refresh token',
      s.accountId ? 'account bound' : 'no account id',
    ];
    out.push(parts.join(' · '));
    out.push(`  endpoint: ${s.endpoint} (${s.wire} wire)`);
    if (s.hint) out.push(`  ⚠ ${s.hint}`);
  }
  if (process.env.SHADOW_ALLOW_IMPORT !== '1') {
    out.push('SHADOW_ALLOW_IMPORT is not set — stored subscription credentials are inert.');
  }
  return out;
}
