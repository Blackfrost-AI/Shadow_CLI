/**
 * Per-provider auth specs: where the sanctioned API lives, where the subscription
 * backend lives, the (reused) first-party OAuth client, and the identity headers a
 * subscription token needs. Data only — no logic.
 *
 * NOTE: `codex.subscriptionBaseUrl` is the ChatGPT backend and MUST be confirmed
 * against a live request before the subscription path is shipped (live OAuth
 * round-trip is deliberately deferred). The sanctioned apiBaseUrl paths are safe now.
 */
import type { ImportedCredential, SubProvider } from './types.js';

export interface ProviderAuthSpec {
  /** Sanctioned API base for an API key (kind=apiKey). */
  apiBaseUrl: string;
  /** Subscription backend base for an OAuth access token (kind=subscription). */
  subscriptionBaseUrl: string;
  /** OAuth issuer for Shadow's own opt-in flow (codex only). */
  authBaseUrl?: string;
  clientId?: string;
  redirectUri?: string;
  scopes?: string;
  /** Does Shadow offer its OWN OAuth flow for this provider? Grok=false (ToS decision). */
  ownOAuth: boolean;
  /** Identity headers a subscription request must carry. */
  extraHeaders(cred: ImportedCredential): Record<string, string>;
}

export const SPECS: Record<SubProvider, ProviderAuthSpec> = {
  codex: {
    apiBaseUrl: 'https://api.openai.com/v1',
    subscriptionBaseUrl: 'https://chatgpt.com/backend-api/codex', // VERIFY before live use
    authBaseUrl: 'https://auth.openai.com',
    clientId: 'app_EMoamEEZ73f0CkXaXp7hrann', // first-party Codex client (from the 0.141.0 binary)
    redirectUri: 'http://localhost:1455/auth/callback',
    scopes: 'openid profile email offline_access',
    ownOAuth: true,
    extraHeaders: (c) => {
      const h: Record<string, string> = { 'OAI-Product-Sku': 'codex' };
      if (c.accountId) h['ChatGPT-Account-ID'] = c.accountId;
      return h;
    },
  },
  grok: {
    apiBaseUrl: 'https://api.x.ai/v1',
    // Import-only. Shadow does NOT drive Grok's consumer-subscription OAuth — xAI's
    // consumer ToS bars bot access / reverse engineering. Sanctioned paths: api key,
    // Enterprise OIDC. See SUBSCRIPTION-OAUTH-AND-TOS.md.
    subscriptionBaseUrl: 'https://api.x.ai/v1',
    ownOAuth: false,
    extraHeaders: () => ({}),
  },
};

/** Map a Shadow provider id to its subscription provider, if any. */
export function subProviderFor(provider: string, model: string): SubProvider | undefined {
  if (provider === 'anthropic') return undefined; // never — ToS
  if (/grok/i.test(model)) return 'grok';
  if (/gpt-5.*codex|codex|gpt-5|o[34]\b/i.test(model)) return 'codex';
  return undefined;
}
