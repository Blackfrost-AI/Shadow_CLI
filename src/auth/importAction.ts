/**
 * Materialize a credential the user already minted with an OFFICIAL CLI into Shadow's
 * own subscription store (`~/.shadow/subscription-auth.json`). This is the "place mine
 * into Shadow" action — it snapshots the durable parts (refresh token, account id) so
 * Shadow keeps working even if the official CLI logs out, without ever impersonating a
 * client_id itself.
 *
 * Reads stay local; nothing is written into the git repo or sent anywhere.
 */
import { readImported } from './importStore.js';
import { setSubAuth } from './store.js';
import type { ImportedCredential, SubProvider } from './types.js';

export interface ImportOutcome {
  provider: SubProvider;
  imported: boolean;
  kind?: ImportedCredential['kind'];
  hasRefresh?: boolean;
  expiresAt?: number;
}

/** Pull one provider's official-CLI credential into Shadow's store. Never logs the secret. */
export function importOfficialCredential(
  provider: SubProvider,
  readFile?: (p: string) => string,
): ImportOutcome {
  const cred = readImported(provider, readFile);
  if (!cred) return { provider, imported: false };
  setSubAuth(provider, cred);
  return {
    provider,
    imported: true,
    kind: cred.kind,
    hasRefresh: Boolean(cred.refreshToken),
    expiresAt: cred.expiresAt,
  };
}

/** Import every provider that has an official-CLI credential present. */
export function importAllOfficial(): ImportOutcome[] {
  return (['codex', 'grok'] as const).map((p) => importOfficialCredential(p));
}
