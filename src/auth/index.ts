/**
 * Subscription / OAuth auth for Shadow — public surface.
 *
 * Legacy imported-credential surface (explicit SHADOW_ALLOW_IMPORT opt-in).
 * Native ChatGPT account access lives in chatgpt.ts. Claude subscriptions use the
 * unmodified official engine through claudeCode.ts; Shadow never imports Claude tokens.
 */
export type { SubProvider, AuthSource, ImportedCredential, ResolvedAuth } from './types.js';
export { SPECS, subProviderFor, type ProviderAuthSpec } from './spec.js';
export { createPkce, randomState, base64url, type Pkce } from './pkce.js';
export {
  readImported,
  parseCodexAuth,
  parseGrokAuth,
  jwtExp,
  isExpired,
  codexAuthPath,
  grokAuthPath,
} from './importStore.js';
export { getSubAuth, setSubAuth, clearSubAuth, subAuthPath } from './store.js';
export { resolveAuth, type ResolveInput } from './resolve.js';
export { importOfficialCredential, importAllOfficial, type ImportOutcome } from './importAction.js';
export { buildCodexAuthUrl, exchangeCodexCode, refreshCodex } from './oauth.js';
export { ensureFreshSubscriptionCredential, REFRESH_MARGIN_SEC, type RefreshOutcome } from './refresh.js';
export { subscriptionAuthStatus, subscriptionAuthLines, type SubAuthStatus } from './status.js';

import type { SubProvider, ResolvedAuth } from './types.js';
import { getSubAuth } from './store.js';
import { readImported } from './importStore.js';
import { resolveAuth } from './resolve.js';

/**
 * High-level convenience: resolve subscription auth for a provider, pulling the stored
 * + live-imported credentials itself. `allowImport` is the opt-in gate (default off).
 */
export function resolveSubscriptionAuth(opts: {
  provider: string;
  subProvider?: SubProvider;
  envBearer?: string;
  allowImport: boolean;
  nowSec: number;
}): ResolvedAuth | undefined {
  const { subProvider } = opts;
  return resolveAuth({
    provider: opts.provider,
    subProvider,
    allowImport: opts.allowImport,
    envBearer: opts.envBearer,
    storedCred: subProvider ? getSubAuth(subProvider) : undefined,
    liveImport: opts.allowImport && subProvider ? readImported(subProvider) : undefined,
    nowSec: opts.nowSec,
  });
}
