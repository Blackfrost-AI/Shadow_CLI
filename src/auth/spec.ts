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
  /**
   * Wire protocol the SUBSCRIPTION backend speaks.
   *
   * Not cosmetic: the Codex subscription backend is a ChatGPT host that serves the RESPONSES api,
   * so the request must land on `<subscriptionBaseUrl>/responses`. Shadow's default `openai` wire
   * appends `/chat/completions`, which that host does not serve — the token is valid and the call
   * is still a 404. The credential therefore has to carry its wire alongside its base URL, exactly
   * as it carries its identity headers, or the two can be recombined into a request that cannot work.
   */
  subscriptionWire: 'chat' | 'responses';
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
    subscriptionBaseUrl: 'https://chatgpt.com/backend-api/codex',
    // The ChatGPT backend serves the Responses api — see subscriptionWire's note.
    subscriptionWire: 'responses',
    authBaseUrl: 'https://auth.openai.com',
    clientId: 'app_EMoamEEZ73f0CkXaXp7hrann', // first-party Codex client (from the 0.141.0 binary)
    redirectUri: 'http://localhost:1455/auth/callback',
    scopes: 'openid profile email offline_access',
    ownOAuth: true,
    /**
     * The identity headers the ChatGPT backend requires, mirroring the official client's request.
     *
     * `chatgpt-account-id` selects the workspace the subscription belongs to; without it the
     * backend cannot tell which account is being billed and refuses the call. `OpenAI-Beta:
     * responses=experimental` opts into the Responses surface the Codex path uses. `originator`
     * identifies the client to that surface.
     *
     * PROVENANCE: these shapes are transcribed from the official Codex client's wire contract, not
     * discovered by Shadow against a live endpoint. A wrong name here surfaces as a 4xx on the
     * first call — never as a token sent somewhere it does not belong, because the same code path
     * binds this credential to `subscriptionBaseUrl` and refuses to pair it with any other host.
     */
    extraHeaders: (c) => {
      const h: Record<string, string> = {
        'OAI-Product-Sku': 'codex',
        'OpenAI-Beta': 'responses=experimental',
        originator: 'codex_cli_rs',
      };
      if (c.accountId) h['chatgpt-account-id'] = c.accountId;
      return h;
    },
  },
  grok: {
    apiBaseUrl: 'https://api.x.ai/v1',
    // Import-only. Shadow does NOT drive Grok's consumer-subscription OAuth — xAI's
    // consumer ToS bars bot access / reverse engineering. Sanctioned paths: api key,
    // Enterprise OIDC. See SUBSCRIPTION-OAUTH-AND-TOS.md.
    subscriptionBaseUrl: 'https://api.x.ai/v1',
    // xAI's subscription backend IS its public API base, which speaks chat completions.
    subscriptionWire: 'chat',
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
