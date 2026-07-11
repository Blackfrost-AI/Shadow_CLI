/**
 * Cross-platform OS keychain cache for the vault's DERIVED KEY (not the password) — so the master
 * password is typed once and later sessions unlock silently.
 *
 *   macOS   → `security` (login Keychain, Touch-ID protected)
 *   Linux   → `secret-tool` (libsecret / GNOME Keyring)   — used only if the binary exists
 *   Windows → DPAPI (CurrentUser scope) via PowerShell, blob stored at ~/.shadow/vault.key.dpapi
 *
 * Every backend is OPTIONAL. On a box with no usable keychain (headless Linux with no libsecret, a
 * locked-down machine), `available()` is false and the unlock flow falls back to prompting for the
 * master password each session — still fully secure, just less convenient. We cache the derived KEY,
 * not the password, so a keychain compromise can't reveal a password reused elsewhere.
 *
 * All backends shell out via execFileSync with argument ARRAYS (no shell string) — no injection.
 */
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync, existsSync, rmSync, chmodSync } from 'node:fs';
import { join } from 'node:path';
import { GLOBAL_DIR } from '../state/globalStore.js';

const SERVICE = 'shadow-vault';
const ACCOUNT = 'shadow';
const IS_MAC = process.platform === 'darwin';
const IS_WIN = process.platform === 'win32';
const WIN_BLOB = join(GLOBAL_DIR, 'vault.key.dpapi');

function has(bin: string, probe: string[]): boolean {
  try {
    execFileSync(bin, probe, { stdio: 'ignore' });
    return true;
  } catch (e) {
    // `--version`-style probes may exit non-zero but still prove the binary EXISTS; ENOENT means it
    // isn't installed. Treat "found but errored" as present.
    return (e as NodeJS.ErrnoException).code !== 'ENOENT';
  }
}

let _backend: 'mac' | 'linux' | 'win' | null | undefined;
function backend(): 'mac' | 'linux' | 'win' | null {
  if (_backend !== undefined) return _backend;
  if (IS_MAC && has('security', ['help'])) _backend = 'mac';
  else if (IS_WIN && has('powershell', ['-NoProfile', '-Command', '$PSVersionTable.PSVersion'])) _backend = 'win';
  else if (!IS_MAC && !IS_WIN && has('secret-tool', ['--version'])) _backend = 'linux';
  else _backend = null;
  return _backend;
}

/** True when THIS machine has a usable keychain backend (else: fall back to password each session). */
export function available(): boolean {
  return backend() !== null;
}

/** Cache the derived key (base64). Returns false if no backend / the store failed (caller degrades). */
export function storeKey(keyB64: string): boolean {
  try {
    switch (backend()) {
      case 'mac':
        // -U updates in place if the item already exists.
        execFileSync('security', ['add-generic-password', '-U', '-s', SERVICE, '-a', ACCOUNT, '-w', keyB64], { stdio: 'ignore' });
        return true;
      case 'linux':
        // secret-tool reads the secret from STDIN (keeps it out of argv/ps).
        execFileSync('secret-tool', ['store', '--label=Shadow vault key', 'service', SERVICE, 'account', ACCOUNT], {
          input: keyB64,
          stdio: ['pipe', 'ignore', 'ignore'],
        });
        return true;
      case 'win': {
        // DPAPI Protect (CurrentUser) → base64 blob written to a user-scoped file. Only this Windows
        // user can Unprotect it. keyB64 passed via env so it isn't in the command line.
        const ps =
          "$b=[Convert]::FromBase64String($env:SHADOW_VK);" +
          "$p=[System.Security.Cryptography.ProtectedData]::Protect($b,$null,'CurrentUser');" +
          '[Convert]::ToBase64String($p)';
        const out = execFileSync('powershell', ['-NoProfile', '-Command', ps], {
          env: { ...process.env, SHADOW_VK: keyB64 },
          encoding: 'utf8',
        }).trim();
        writeFileSync(WIN_BLOB, out, { mode: 0o600 });
        try {
          chmodSync(WIN_BLOB, 0o600);
        } catch {
          /* windows perms differ; best-effort */
        }
        return true;
      }
      default:
        return false;
    }
  } catch {
    return false;
  }
}

/** Retrieve the cached derived key (base64), or null if none / backend unavailable. */
export function retrieveKey(): string | null {
  try {
    switch (backend()) {
      case 'mac':
        return execFileSync('security', ['find-generic-password', '-s', SERVICE, '-a', ACCOUNT, '-w'], { encoding: 'utf8' }).trim() || null;
      case 'linux':
        return execFileSync('secret-tool', ['lookup', 'service', SERVICE, 'account', ACCOUNT], { encoding: 'utf8' }).trim() || null;
      case 'win': {
        if (!existsSync(WIN_BLOB)) return null;
        const blob = readFileSync(WIN_BLOB, 'utf8').trim();
        const ps =
          "$p=[Convert]::FromBase64String($env:SHADOW_VB);" +
          "$b=[System.Security.Cryptography.ProtectedData]::Unprotect($p,$null,'CurrentUser');" +
          '[Convert]::ToBase64String($b)';
        return execFileSync('powershell', ['-NoProfile', '-Command', ps], {
          env: { ...process.env, SHADOW_VB: blob },
          encoding: 'utf8',
        }).trim() || null;
      }
      default:
        return null;
    }
  } catch {
    return null;
  }
}

/** Forget the cached key (on `/lock`, password rotation, or a stale-key mismatch). */
export function clearKey(): void {
  try {
    switch (backend()) {
      case 'mac':
        execFileSync('security', ['delete-generic-password', '-s', SERVICE, '-a', ACCOUNT], { stdio: 'ignore' });
        break;
      case 'linux':
        execFileSync('secret-tool', ['clear', 'service', SERVICE, 'account', ACCOUNT], { stdio: 'ignore' });
        break;
      case 'win':
        if (existsSync(WIN_BLOB)) rmSync(WIN_BLOB, { force: true });
        break;
    }
  } catch {
    /* best-effort */
  }
}
