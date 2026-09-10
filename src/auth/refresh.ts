/**
 * Keep a subscription access token fresh.
 *
 * `refreshCodex` existed from the start with no caller, so an imported subscription credential was
 * used until it expired and then broke — the OAuth access tokens these backends mint last about an
 * hour, which makes "unused refresh path" the same thing as "this feature stops working shortly
 * after you set it up". This is the missing caller.
 *
 * Design constraints, in order:
 *  1. NEVER throw. A refresh is an optimization; a network or endpoint failure must degrade to the
 *     credential already on disk (the caller can still surface the provider's own error) rather than
 *     take down boot.
 *  2. Never refresh unnecessarily. Tokens are refreshed only inside a margin of expiry, so the
 *     steady state is a pure read of `~/.shadow/subscription-auth.json` with no network at all.
 *  3. Respect the offline wall. Refreshing is egress; under `--offline` we skip it entirely instead
 *     of attempting a request the broker will deny (which would also record a denial receipt).
 *  4. Persist the rotated credential. Refresh responses may return a NEW refresh token, and the old
 *     one is often invalidated — dropping it would strand the user at the next expiry.
 */
import type { ImportedCredential, SubProvider } from './types.js';
import { SPECS } from './spec.js';
import { getSubAuth, setSubAuth } from './store.js';
import { refreshCodex } from './oauth.js';
import { isExpired } from './importStore.js';
import { isOfflineMode } from '../safety/egress.js';
import { registerSecret } from '../util/redact.js';

/**
 * Refresh this far ahead of expiry. The margin has to cover a request that is already in flight
 * plus clock skew between this machine and the token issuer, so it is deliberately generous: the
 * cost of refreshing early is one extra round trip, and the cost of refreshing late is a 401
 * mid-turn.
 */
export const REFRESH_MARGIN_SEC = 5 * 60;

export interface RefreshOutcome {
  /** The credential to use: the rotated one on success, otherwise whatever is stored. */
  cred?: ImportedCredential;
  /** True only when a NEW token was fetched and persisted this call. */
  refreshed: boolean;
  /** Why a refresh was attempted and failed — for a user-visible warning. Never contains the token. */
  error?: string;
}

/**
 * Return a usable subscription credential, refreshing it first when it is at or near expiry.
 *
 * A credential with no expiry, or an API key (which never expires), is returned untouched.
 */
export async function ensureFreshSubscriptionCredential(
  subProvider: SubProvider,
  opts: {
    nowSec: number;
    signal?: AbortSignal;
    marginSec?: number;
    /**
     * Whether a refresh may touch the network. Defaults to "no when offline mode is armed", but
     * callers that KNOW the mode (the boot path reads the flag before the wall is armed) pass it
     * explicitly so the decision cannot depend on the order two unrelated lines of setup ran in.
     */
    allowNetwork?: boolean;
  },
): Promise<RefreshOutcome> {
  const cred = getSubAuth(subProvider);
  if (!cred) return { refreshed: false };
  // API keys do not expire, and a token whose expiry we could not derive cannot be judged — both
  // are used as-is. `isExpired` already encodes that.
  if (!isExpired(cred, opts.nowSec, opts.marginSec ?? REFRESH_MARGIN_SEC)) {
    return { cred, refreshed: false };
  }
  if (cred.kind === 'apiKey') return { cred, refreshed: false };
  // Only codex has a refresh implementation. Grok is import-only by ToS (see spec.ts), so its
  // credential is returned as-is rather than half-implemented here.
  if (!SPECS[subProvider].ownOAuth || !cred.refreshToken) return { cred, refreshed: false };
  if (!(opts.allowNetwork ?? !isOfflineMode())) {
    return { cred, refreshed: false, error: 'offline mode: skipped refreshing the subscription token' };
  }

  try {
    const fresh = await refreshCodex(cred.refreshToken, opts.nowSec, opts.signal);
    // `refreshCodex` preserves the previous refresh token when the response omits a new one; the
    // account id is NOT always echoed back, so carry it forward rather than losing the workspace
    // binding on every rotation.
    if (!fresh.accountId && cred.accountId) fresh.accountId = cred.accountId;
    if (fresh.token) {
      // The ROTATED token has never been seen by the scrubber, so register it the way boot
      // registers a resolved bearer — otherwise the value that is now live is the one value that
      // would print in full if it ever reached a log or an error message.
      registerSecret(fresh.token);
      setSubAuth(subProvider, fresh);
      return { cred: fresh, refreshed: true };
    }
    return { cred, refreshed: false, error: 'the token endpoint returned no access token' };
  } catch (e) {
    return { cred, refreshed: false, error: (e as Error).message };
  }
}
