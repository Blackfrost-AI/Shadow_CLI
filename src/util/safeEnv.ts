/**
 * Minimal environment inherited by subprocesses that do not explicitly need the
 * agent process's credentials. Keep this in one module so run_shell, hooks, MCP,
 * and TUI helpers cannot silently drift back to `{ ...process.env }`.
 */
export const UNIX_SAFE_ENV = ['PATH', 'HOME', 'USER', 'LANG', 'LC_ALL', 'TERM', 'TMPDIR', 'SHELL'] as const;

export const WINDOWS_SAFE_ENV = [
  'PATH',
  'PATHEXT',
  'SYSTEMROOT',
  'WINDIR',
  'COMSPEC',
  'TEMP',
  'TMP',
  'USERPROFILE',
  'USERNAME',
  'HOMEDRIVE',
  'HOMEPATH',
  'APPDATA',
  'LOCALAPPDATA',
  'PROGRAMFILES',
  'PROGRAMDATA',
  'PSMODULEPATH',
] as const;

export const DEFAULT_SAFE_ENV: readonly string[] =
  process.platform === 'win32' ? WINDOWS_SAFE_ENV : UNIX_SAFE_ENV;

/** Build a fresh allowlisted environment, then add explicitly supplied values. */
export function scrubbedEnv(
  allowlist: readonly string[] = DEFAULT_SAFE_ENV,
  explicit: NodeJS.ProcessEnv | Record<string, string | undefined> = {},
  source: NodeJS.ProcessEnv = process.env,
): NodeJS.ProcessEnv {
  // Windows shells require these even when a user-provided allowlist omits them.
  const keys = process.platform === 'win32'
    ? new Set<string>([...WINDOWS_SAFE_ENV, ...allowlist])
    : new Set<string>(allowlist);
  const out: NodeJS.ProcessEnv = {};
  for (const key of keys) {
    const value = source[key];
    if (value !== undefined) out[key] = value;
  }
  for (const [key, value] of Object.entries(explicit)) {
    if (value !== undefined) out[key] = value;
  }
  return out;
}
