/**
 * The Shadow secret vault — API keys / tokens / endpoints ENCRYPTED AT REST.
 *
 * Replaces the plaintext `~/.shadow/credentials.json`: secrets are sealed in `~/.shadow/vault.enc`
 * with AES-256-GCM under a key derived from the user's MASTER PASSWORD via scrypt. GCM is
 * authenticated encryption, so a wrong password (or a tampered file) fails to open rather than
 * returning garbage. Node built-in `crypto` only — zero dependencies, works in the Bun binary too.
 *
 * Day-to-day the derived key is cached in the OS keychain (see keychain.ts) so the password is typed
 * once; the password stays the portable fallback (`SHADOW_VAULT_PASSWORD` for headless/CI). The file
 * lives OUTSIDE the repo (~/.shadow), 0600, atomic write — secrets never touch the project dir or env.
 */
import {
  randomBytes,
  scryptSync,
  createCipheriv,
  createDecipheriv,
  timingSafeEqual,
} from 'node:crypto';
import { readFileSync, writeFileSync, mkdirSync, chmodSync, renameSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { GLOBAL_DIR } from '../state/globalStore.js';

/** The decrypted secret payload — the credentials object (per-provider keys/tokens/endpoints). */
export type VaultData = Record<string, unknown>;

/** scrypt cost — N=2^16, r=8, p=1 → ~64MB / a few hundred ms per derive. Strong for a one-time unlock;
 *  bumped maxmem so Node doesn't refuse the allocation. Stored in the file so params can evolve. */
const KDF = { N: 1 << 16, r: 8, p: 1, keylen: 32 } as const;
const KDF_MAXMEM = 128 * KDF.N * KDF.r * 2; // scrypt needs 128*N*r bytes; give headroom

const VAULT_VERSION = 1;

/** On-disk envelope. Only the ciphertext holds secrets; salt/nonce are public by design. */
interface VaultFile {
  v: number;
  kdf: 'scrypt';
  N: number;
  r: number;
  p: number;
  salt: string; // base64
  nonce: string; // base64 (GCM IV, 12 bytes)
  ct: string; // base64 (ciphertext || 16-byte GCM auth tag)
}

export function vaultPath(): string {
  return join(GLOBAL_DIR, 'vault.enc');
}

export function vaultExists(): boolean {
  return existsSync(vaultPath());
}

/** Derive the 32-byte encryption key from a master password + salt (scrypt). */
export function deriveKey(password: string, salt: Buffer, params: { N: number; r: number; p: number } = KDF): Buffer {
  return scryptSync(password.normalize('NFKC'), salt, KDF.keylen, {
    N: params.N,
    r: params.r,
    p: params.p,
    maxmem: 128 * params.N * params.r * 2,
  });
}

/** Seal a secrets object with a key → the on-disk envelope (pure; no I/O). `params` only records the
 *  KDF cost into the file (seal itself doesn't run the KDF), so it needs just N/r/p. */
export function seal(data: VaultData, key: Buffer, salt: Buffer, params: { N: number; r: number; p: number } = KDF): VaultFile {
  const nonce = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, nonce);
  const pt = Buffer.from(JSON.stringify(data), 'utf8');
  const ct = Buffer.concat([cipher.update(pt), cipher.final()]);
  const tag = cipher.getAuthTag(); // 16 bytes — appended so open() can verify integrity + key
  return {
    v: VAULT_VERSION,
    kdf: 'scrypt',
    N: params.N,
    r: params.r,
    p: params.p,
    salt: salt.toString('base64'),
    nonce: nonce.toString('base64'),
    ct: Buffer.concat([ct, tag]).toString('base64'),
  };
}

/** Open an envelope with a key → the secrets object (pure). Throws on wrong key / tamper (GCM). */
export function open(file: VaultFile, key: Buffer): VaultData {
  const raw = Buffer.from(file.ct, 'base64');
  const tag = raw.subarray(raw.length - 16);
  const ct = raw.subarray(0, raw.length - 16);
  const decipher = createDecipheriv('aes-256-gcm', key, Buffer.from(file.nonce, 'base64'));
  decipher.setAuthTag(tag);
  const pt = Buffer.concat([decipher.update(ct), decipher.final()]); // throws if key/tag mismatch
  return JSON.parse(pt.toString('utf8')) as VaultData;
}

function readVaultFile(): VaultFile {
  const f = JSON.parse(readFileSync(vaultPath(), 'utf8')) as VaultFile;
  if (f.v !== VAULT_VERSION || f.kdf !== 'scrypt') {
    throw new Error(`unsupported vault format (v=${f.v}, kdf=${f.kdf})`);
  }
  return f;
}

function writeVaultFile(f: VaultFile): void {
  mkdirSync(GLOBAL_DIR, { recursive: true, mode: 0o700 });
  try {
    chmodSync(GLOBAL_DIR, 0o700);
  } catch {
    /* best-effort */
  }
  const p = vaultPath();
  const tmp = `${p}.tmp`;
  writeFileSync(tmp, JSON.stringify(f, null, 2) + '\n', { mode: 0o600 });
  chmodSync(tmp, 0o600); // force perms even if umask widened the create mode
  renameSync(tmp, p);
}

/** Create (or overwrite) the vault from a master password + initial secrets. Returns the derived key
 *  so the caller can cache it in the OS keychain (so the password isn't needed again). */
export function createVault(password: string, data: VaultData): Buffer {
  const salt = randomBytes(16);
  const key = deriveKey(password, salt);
  writeVaultFile(seal(data, key, salt));
  return key;
}

/** Unlock with the MASTER PASSWORD. Returns the secrets AND the derived key (to cache). Throws on a
 *  wrong password (GCM auth failure). */
export function unlockWithPassword(password: string): { data: VaultData; key: Buffer } {
  const f = readVaultFile();
  const key = deriveKey(password, Buffer.from(f.salt, 'base64'), f);
  const data = open(f, key); // throws on wrong password
  return { data, key };
}

/** Unlock with a KEY already cached in the OS keychain (silent path). Throws if the key is stale. */
export function unlockWithKey(key: Buffer): VaultData {
  return open(readVaultFile(), key);
}

/** Re-seal updated secrets under the SAME key/salt (used when adding/rotating a credential). */
export function saveSecrets(data: VaultData, key: Buffer): void {
  const f = readVaultFile();
  writeVaultFile(seal(data, key, Buffer.from(f.salt, 'base64'), f));
}

/** Verify a candidate key actually opens the vault (used to validate a keychain-cached key). */
export function keyOpensVault(key: Buffer): boolean {
  try {
    open(readVaultFile(), key);
    return true;
  } catch {
    return false;
  }
}

/** Constant-time compare (for any password-hash checks callers layer on top). */
export function safeEqual(a: Buffer, b: Buffer): boolean {
  return a.length === b.length && timingSafeEqual(a, b);
}
