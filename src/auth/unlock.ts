/**
 * Session vault unlock + one-time migration of the legacy plaintext credentials.json.
 *
 * On startup:
 *   1. If a plaintext ~/.shadow/credentials.json exists and there's no vault yet, offer to ENCRYPT it
 *      into a vault (set a master password), then SHRED the plaintext.
 *   2. If a vault exists, UNLOCK it — silently via the OS-keychain-cached key, else via
 *      SHADOW_VAULT_PASSWORD (headless), else a masked interactive prompt.
 * The decrypted secrets are installed into the global store so getCredential()/resolveApiKey() read
 * them transparently — no other code changes. If neither a vault nor legacy creds exist, it's a no-op
 * (env vars / onboarding still work as before).
 */
import { vaultExists, unlockWithKey, unlockWithPassword, createVault, saveSecrets, type VaultData } from './vault.js';
import { retrieveKey, storeKey, clearKey, available as keychainAvailable } from './keychain.js';
import {
  setUnlockedVault,
  setVaultWriter,
  vaultUnlocked,
  loadCredentials,
  loadLegacyCredentials,
  legacyCredentialsExist,
  shredLegacyCredentials,
  type CredentialEntry,
} from '../state/globalStore.js';

// Control bytes we react to in raw mode.
const ENTER = '\r';
const NEWLINE = '\n';
const EOT = '\u0004'; // Ctrl-D
const ETX = '\u0003'; // Ctrl-C
const DEL = '\u007f'; // Backspace on most terminals
const BS = '\b';

/** The derived key for THIS session — kept so a credential rotation can be re-sealed into the vault. */
let sessionKey: Buffer | null = null;

/** Masked stdin prompt (raw mode; no echo). Falls back to a plain readline where raw mode is absent. */
function promptMasked(question: string): Promise<string> {
  return new Promise((resolve) => {
    const stdin = process.stdin;
    process.stdout.write(question);
    if (!stdin.isTTY || typeof stdin.setRawMode !== 'function') {
      // No TTY / no raw mode — read a line without masking (best we can do; headless should use the env).
      let buf = '';
      const onData = (d: Buffer): void => {
        buf += d.toString();
        const nl = buf.indexOf('\n');
        if (nl >= 0) {
          stdin.removeListener('data', onData);
          stdin.pause();
          resolve(buf.slice(0, nl).replace(/\r$/, ''));
        }
      };
      stdin.resume();
      stdin.on('data', onData);
      return;
    }
    stdin.setRawMode(true);
    stdin.resume();
    let input = '';
    const onData = (chunk: Buffer): void => {
      const c = chunk.toString('utf8');
      if (c === ENTER || c === NEWLINE || c === EOT) {
        // Enter / Ctrl-D → submit
        stdin.setRawMode(false);
        stdin.pause();
        stdin.removeListener('data', onData);
        process.stdout.write('\n');
        resolve(input);
      } else if (c === ETX) {
        // Ctrl-C → abort
        stdin.setRawMode(false);
        process.stdout.write('\n');
        process.exit(130);
      } else if (c === DEL || c === BS) {
        input = input.slice(0, -1);
      } else {
        // Accept printable input; ignore stray control sequences (arrow keys, etc.).
        input += c.replace(/[\u0000-\u001f\u007f]/g, '');
      }
    };
    stdin.on('data', onData);
  });
}

async function promptLine(question: string): Promise<string> {
  return (await promptMasked(question).catch(() => '')).trim();
}

/** Install the decrypted secrets + remember the key for the session. The vault stores the same
 *  provider→{apiKey,…} shape the credential store reads (plus a `kind` tag it ignores). */
function installUnlocked(data: VaultData, key: Buffer): void {
  setUnlockedVault(data as unknown as Record<string, CredentialEntry>);
  sessionKey = key;
  // Make saveCredential durable: without this a rotation lives only in memory and is lost
  // at exit (the vault file would keep the superseded key indefinitely).
  setVaultWriter((d) => persistToVault(d as unknown as VaultData));
}

/** Drop the session's secrets and stop re-sealing (used by `/lock`). */
export function lockVault(): void {
  setUnlockedVault(null);
  setVaultWriter(null);
  sessionKey = null;
}

/** Persist a credential change back into the vault (re-seal). No-op if the vault isn't the source. */
export function persistToVault(data: VaultData): void {
  if (sessionKey) saveSecrets(data, sessionKey);
}

/** The session's derived key, for flows that must verify a re-seal opens (credRef migration). */
export function getSessionKey(): Buffer | null {
  return sessionKey;
}

/** One-time migration: plaintext credentials.json → encrypted vault, then shred. Returns true if it
 *  migrated. Interactive; skipped on a non-TTY without disruption. */
async function maybeMigrateLegacy(write: (s: string) => void): Promise<boolean> {
  if (vaultExists() || !legacyCredentialsExist()) return false;
  const legacy = loadLegacyCredentials();
  if (!legacy || Object.keys(legacy).length === 0) return false;
  if (!process.stdin.isTTY) return false; // don't prompt in a pipe; leave legacy working
  write('\n⚠ Found plaintext API credentials in ~/.shadow/credentials.json.\n');
  const yes = await promptLine('Encrypt them into a password-protected vault now? [Y/n] ');
  if (/^n/i.test(yes)) {
    write('Left as-is — migrate later with `shadow onboard --web`.\n');
    return false;
  }
  let pw = '';
  for (let i = 0; i < 3; i++) {
    const a = await promptLine('Create a master password (min 8 chars): ');
    const b = await promptLine('Confirm: ');
    if (a.length >= 8 && a === b) {
      pw = a;
      break;
    }
    write(a.length < 8 ? 'Too short — try again.\n' : 'Passwords do not match — try again.\n');
  }
  if (!pw) {
    write('Migration skipped (kept the plaintext file).\n');
    return false;
  }
  const key = createVault(pw, legacy as VaultData);
  installUnlocked(legacy as VaultData, key);
  if (keychainAvailable()) storeKey(key.toString('base64'));
  shredLegacyCredentials();
  write('✓ Credentials encrypted into ~/.shadow/vault.enc; the plaintext file was removed.\n\n');
  return true;
}

/**
 * Adopt a plaintext credentials.json that outlived the vault's creation.
 *
 * `maybeMigrateLegacy` bails the moment a vault exists, and `persistOnboardSecret` creates a
 * vault without shredding — so a vault and a live plaintext file could coexist forever, with
 * the plaintext still served by `loadCredentials()` whenever nothing is unlocked. This closes
 * that hole: merge whatever the vault does not already hold, re-seal, verify, then shred.
 *
 * Vault values win on conflict — the vault is the newer, deliberate store.
 */
export function adoptLegacyIntoUnlockedVault(write: (s: string) => void = () => {}): number {
  if (!vaultUnlocked() || !sessionKey || !legacyCredentialsExist()) return 0;
  const legacy = loadLegacyCredentials();
  const slots = Object.keys(legacy ?? {});
  if (slots.length === 0) {
    shredLegacyCredentials(); // empty file, nothing to keep
    return 0;
  }
  const current = loadCredentials();
  const merged: Record<string, CredentialEntry> = { ...current };
  let adopted = 0;
  for (const slot of slots) {
    if (merged[slot]) continue; // vault wins
    merged[slot] = legacy[slot];
    adopted++;
  }
  // Seal FIRST and prove it opens before destroying the only other copy.
  setUnlockedVault(merged);
  persistToVault(merged as unknown as VaultData);
  try {
    unlockWithKey(sessionKey);
  } catch {
    write('⚠ Could not verify the vault after merging legacy credentials — plaintext left in place.\n');
    return 0;
  }
  shredLegacyCredentials();
  if (adopted > 0) {
    write(`✓ Adopted ${adopted} credential(s) from the plaintext credentials.json into your vault; the file was removed.\n`);
  }
  return adopted;
}

/** Unlock the vault for this session: keychain (silent) → env → masked prompt. */
async function unlockExisting(write: (s: string) => void): Promise<'ok' | 'failed'> {
  // 1) OS-keychain-cached derived key — silent.
  const cached = retrieveKey();
  if (cached) {
    try {
      const key = Buffer.from(cached, 'base64');
      installUnlocked(unlockWithKey(key), key);
      return 'ok';
    } catch {
      clearKey(); // stale key (password rotated / different vault) — fall through
    }
  }
  // 2) SHADOW_VAULT_PASSWORD (headless / CI).
  const envPw = process.env.SHADOW_VAULT_PASSWORD;
  if (envPw) {
    try {
      const { data, key } = unlockWithPassword(envPw);
      installUnlocked(data, key);
      if (keychainAvailable()) storeKey(key.toString('base64'));
      return 'ok';
    } catch {
      write('SHADOW_VAULT_PASSWORD did not unlock the vault.\n');
      return 'failed';
    }
  }
  // 3) Interactive masked prompt (3 tries).
  if (!process.stdin.isTTY) {
    write('Vault is locked and no SHADOW_VAULT_PASSWORD is set (non-interactive). Cannot unlock.\n');
    return 'failed';
  }
  for (let i = 0; i < 3; i++) {
    const pw = await promptLine('Master password to unlock your vault: ');
    if (!pw) break;
    try {
      const { data, key } = unlockWithPassword(pw);
      installUnlocked(data, key);
      if (keychainAvailable()) storeKey(key.toString('base64'));
      return 'ok';
    } catch {
      write('Incorrect password.\n');
    }
  }
  return 'failed';
}

/**
 * Ensure secrets are available for the session. Runs migration then unlock. Returns true if the session
 * can proceed (vault unlocked, migrated, or nothing to do), false only if a vault exists but couldn't be
 * unlocked. Never throws.
 */
export async function ensureVaultReady(write: (s: string) => void = (s) => process.stderr.write(s)): Promise<boolean> {
  try {
    await maybeMigrateLegacy(write);
    if (!vaultExists()) return true; // no vault (fresh install / declined migration) — env/onboarding path
    if ((await unlockExisting(write)) !== 'ok') return false;
    // A vault created by `onboard --web` may have left the old plaintext file behind.
    adoptLegacyIntoUnlockedVault(write);
    // Plaintext keys hand-written into config.json presets move into the vault too. Imported
    // lazily to keep the module graph acyclic (credRefMigrate imports from here).
    try {
      const { migratePresetKeysIntoVault } = await import('./credRefMigrate.js');
      migratePresetKeysIntoVault(write);
    } catch {
      /* migration is best-effort; a failure must never block startup */
    }
    return true;
  } catch {
    return true; // never block startup on an unexpected error — env vars may still carry the key
  }
}
