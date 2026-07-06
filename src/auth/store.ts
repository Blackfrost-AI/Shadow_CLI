/**
 * Shadow's own subscription-credential store: `~/.shadow/subscription-auth.json`
 * (chmod 600, atomic write). Separate from the onboarding `credentials.json` because
 * subscription creds carry refresh tokens / account ids / expiry that the small
 * CredentialEntry shape can't hold.
 *
 * This lives OUTSIDE the git repo (~/.shadow, not the project dir) so it can never be
 * committed. Secrets never go into the repo, env-allowlisted shells, or logs.
 */
import { readFileSync, writeFileSync, mkdirSync, chmodSync, renameSync } from 'node:fs';
import { join } from 'node:path';
import { GLOBAL_DIR } from '../state/globalStore.js';
import type { ImportedCredential, SubProvider } from './types.js';

const SUB_AUTH_PATH = join(GLOBAL_DIR, 'subscription-auth.json');

type Store = Partial<Record<SubProvider, ImportedCredential>>;

function load(): Store {
  try {
    return JSON.parse(readFileSync(SUB_AUTH_PATH, 'utf8')) as Store;
  } catch {
    return {};
  }
}

function writeAtomic(data: Store): void {
  mkdirSync(GLOBAL_DIR, { recursive: true, mode: 0o700 });
  try {
    chmodSync(GLOBAL_DIR, 0o700);
  } catch {
    /* best-effort */
  }
  const tmp = `${SUB_AUTH_PATH}.tmp`;
  writeFileSync(tmp, JSON.stringify(data, null, 2) + '\n', { mode: 0o600 });
  chmodSync(tmp, 0o600); // force perms even if umask widened the create mode
  renameSync(tmp, SUB_AUTH_PATH);
}

export function subAuthPath(): string {
  return SUB_AUTH_PATH;
}

export function getSubAuth(provider: SubProvider): ImportedCredential | undefined {
  return load()[provider];
}

export function setSubAuth(provider: SubProvider, cred: ImportedCredential): void {
  writeAtomic({ ...load(), [provider]: cred });
}

export function clearSubAuth(provider: SubProvider): void {
  const s = load();
  delete s[provider];
  writeAtomic(s);
}
