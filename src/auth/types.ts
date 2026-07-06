/**
 * Subscription / OAuth auth types for Shadow.
 *
 * Shadow lets a user reach a provider three ways, in precedence order:
 *   1. an explicit API key (env / ~/.shadow store)            — the sanctioned path
 *   2. an imported credential from an OFFICIAL CLI's auth.json — lowest ToS exposure
 *   3. Shadow's own opt-in OAuth flow (PKCE / device code)     — only when asked
 *
 * ANTHROPIC IS DELIBERATELY EXCLUDED from tiers 2–3: reusing a Claude.ai
 * subscription in a third-party client violates Anthropic's ToS. Anthropic stays
 * API-key-only. See shared research: SUBSCRIPTION-OAUTH-AND-TOS.md.
 */

/** Providers whose *subscription* auth Shadow may import / drive. NOT anthropic. */
export type SubProvider = 'codex' | 'grok';

/** Where a resolved credential came from (debug/source labeling — never logs the secret). */
export type AuthSource =
  | 'env'
  | 'shadow-store'
  | 'imported-codex'
  | 'imported-grok'
  | 'oauth';

/**
 * A credential parsed out of an official CLI's auth.json (`~/.codex/auth.json`,
 * `~/.grok/auth.json`). `apiKey` kind is a sanctioned key bound to the public API
 * base; `subscription` kind is an OAuth access token bound to the subscription
 * backend and needs the provider's extra identity headers.
 */
export interface ImportedCredential {
  provider: SubProvider;
  kind: 'apiKey' | 'subscription';
  /** The bearer secret: an API key (kind=apiKey) or an OAuth access token (kind=subscription). */
  token: string;
  refreshToken?: string;
  idToken?: string;
  accountId?: string;
  /** Unix seconds when `token` expires, when derivable (JWT `exp` / `expires_at`). */
  expiresAt?: number;
}

/** A credential resolved to everything the provider adapter needs to send a request. */
export interface ResolvedAuth {
  /** Goes into `Authorization: Bearer <bearer>`. */
  bearer: string;
  /** Extra request headers (e.g. `ChatGPT-Account-ID`, `OAI-Product-Sku`). */
  extraHeaders?: Record<string, string>;
  /** Base URL override — subscription backends differ from the public API base. */
  baseUrl?: string;
  source: AuthSource;
  /** Unix seconds expiry, when known, so the caller can refresh proactively. */
  expiresAt?: number;
}
