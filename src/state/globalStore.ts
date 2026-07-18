import { homedir } from 'node:os';
import { join } from 'node:path';
import { readFileSync, writeFileSync, mkdirSync, chmodSync, renameSync, existsSync, statSync, rmSync } from 'node:fs';
import { randomBytes } from 'node:crypto';

/**
 * User-level config + credentials written by `shadow onboard`, so subsequent runs
 * connect with no flags. Non-secret preferences (provider, model) live in
 * config.json; secrets (api keys / tokens) and the per-provider base URL live in
 * credentials.json (chmod 600). Env vars still override everything at runtime.
 */
export const GLOBAL_DIR = join(homedir(), '.shadow');
const CONFIG_PATH = join(GLOBAL_DIR, 'config.json');
const CREDS_PATH = join(GLOBAL_DIR, 'credentials.json');

const LAYOUT_DIRS = ['agents', 'commands', 'rules', 'workflows', 'projects', 'tasks', 'checkpoints', 'memories'] as const; // deeper ~/.shadow for Claude parity + recovery

/** Ensure the extended `~/.shadow` layout exists (idempotent). */
export function ensureShadowLayout(): void {
  mkdirSync(GLOBAL_DIR, { recursive: true, mode: 0o700 });
  try {
    chmodSync(GLOBAL_DIR, 0o700);
  } catch {
    /* best-effort */
  }
  for (const d of LAYOUT_DIRS) {
    mkdirSync(join(GLOBAL_DIR, d), { recursive: true, mode: 0o700 });
  }
}

export interface CredentialEntry {
  apiKey?: string;
  authToken?: string;
  baseUrl?: string;
}
type Credentials = Record<string, CredentialEntry>;

function readJson<T>(path: string, fallback: T): T {
  try {
    return JSON.parse(readFileSync(path, 'utf8')) as T;
  } catch {
    return fallback;
  }
}

function writeJsonAtomic(path: string, data: unknown, mode = 0o600): void {
  // ~/.shadow holds credentials.json (and config.json may carry creds in baseUrl),
  // so default to owner-only perms — set on the dir AND on the temp file BEFORE it is
  // renamed into place (no world-readable window, regardless of umask).
  mkdirSync(GLOBAL_DIR, { recursive: true, mode: 0o700 });
  try {
    chmodSync(GLOBAL_DIR, 0o700); // tighten a pre-existing 0755 dir (best-effort)
  } catch {
    /* not fatal */
  }
  const tmp = `${path}.tmp`;
  writeFileSync(tmp, JSON.stringify(data, null, 2) + '\n', { mode });
  chmodSync(tmp, mode); // force perms even if umask widened the create mode
  renameSync(tmp, path);
}

/** Non-secret global preferences (provider, model, …) — merged below the project config. */
export function loadGlobalConfig(): Record<string, unknown> {
  ensureShadowLayout();
  return readJson<Record<string, unknown>>(CONFIG_PATH, {});
}

export function saveGlobalConfig(patch: Record<string, unknown>): void {
  writeJsonAtomic(CONFIG_PATH, { ...loadGlobalConfig(), ...patch });
}

/** Secrets decrypted from the vault for THIS session (set by the unlock flow at startup). When set,
 *  it is the source of truth — the plaintext credentials.json is legacy/pre-migration only. */
let _unlockedVault: Credentials | null = null;

/** Install (or clear) the session's decrypted vault. Callers: the unlock flow / `/lock`. */
export function setUnlockedVault(v: Credentials | null): void {
  _unlockedVault = v;
}

/** True when a decrypted vault is installed for this session. */
export function vaultUnlocked(): boolean {
  return _unlockedVault !== null;
}

/**
 * Re-seal hook, registered by the unlock flow. Without it `saveCredential` mutated only the
 * in-memory vault and the change was lost at exit — a rotation appeared to work all session
 * and silently vanished. The store must not import the vault module (cycle), so the writer
 * is injected instead.
 */
let _vaultWriter: ((d: Credentials) => void) | null = null;

export function setVaultWriter(fn: ((d: Credentials) => void) | null): void {
  _vaultWriter = fn;
}

export function loadCredentials(): Credentials {
  // Prefer the encrypted vault once unlocked; fall back to the legacy plaintext file (unmigrated users).
  if (_unlockedVault) return _unlockedVault;
  return readJson<Credentials>(CREDS_PATH, {});
}

export function getCredential(provider: string): CredentialEntry | undefined {
  return loadCredentials()[provider];
}

export function saveCredential(provider: string, entry: CredentialEntry): void {
  const all = loadCredentials();
  all[provider] = { ...all[provider], ...entry };
  // With a vault unlocked the plaintext file is never written; the change is re-sealed into
  // the vault through the injected writer (registered by auth/unlock.ts installUnlocked).
  // If no writer is registered the change stays in memory only — the pre-existing behaviour
  // that tests without an unlock flow rely on.
  if (_unlockedVault) {
    _unlockedVault = all;
    _vaultWriter?.(all);
    return;
  }
  writeJsonAtomic(CREDS_PATH, all, 0o600);
}

// ── legacy plaintext migration ────────────────────────────────────────────────
export function credentialsPath(): string {
  return CREDS_PATH;
}

/** Read the plaintext credentials.json DIRECTLY (bypasses the vault cache) — for one-time migration. */
export function loadLegacyCredentials(): Credentials {
  return readJson<Credentials>(CREDS_PATH, {});
}

export function legacyCredentialsExist(): boolean {
  return existsSync(CREDS_PATH);
}

/** Overwrite-then-remove the plaintext credentials.json after it has been sealed into the vault, so the
 *  keys don't linger on disk (a plain unlink leaves the bytes recoverable). Best-effort. */
export function shredLegacyCredentials(): void {
  try {
    if (!existsSync(CREDS_PATH)) return;
    const size = Math.max(64, statSync(CREDS_PATH).size);
    writeFileSync(CREDS_PATH, randomBytes(size), { mode: 0o600 });
    rmSync(CREDS_PATH, { force: true });
  } catch {
    /* best-effort */
  }
}
