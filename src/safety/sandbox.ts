import { existsSync, realpathSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';

/**
 * OS-level sandbox for run_shell — the real boundary the env-allowlist/denylist
 * can't provide (an arbitrary subprocess is otherwise unconfined). Mirrors how
 * the reference client sandboxes bash: macOS seatbelt (`sandbox-exec`), Linux bubblewrap
 * (`bwrap`). Policy: filesystem WRITES are confined to the workspace + /tmp;
 * reads of ~/.shadow (the credentials store) are denied; network is allowed by
 * default (agent tasks need installs/fetches) and can be turned off.
 *
 * Under --yolo: explicitly disabled (passthrough, no sandbox).
 *
 * Claude-parity review: profiles match research (deny writes except allowed, tmpfs for creds).
 * Added denies for typical injection paths via model policy (see classifier/denylist).
 * Gaps: Win no sandbox (documented); could add more proc/exec denies but would break agent needs (e.g. installs).
 *
 * Fail-open with a note when no sandbox tool is available (so run_shell still
 * works on a bare system) — never on macOS, where sandbox-exec ships built in.
 */
const IS_WIN = process.platform === 'win32';
const IS_MAC = process.platform === 'darwin';

export interface SandboxResult {
  argv: string[]; // argv[0] is the program to spawn
  sandboxed: boolean;
  note?: string; // populated when sandboxing was requested but unavailable
}

const real = (p: string): string => {
  try {
    return realpathSync(p);
  } catch {
    return p;
  }
};

const hasBwrap = (): boolean =>
  ['/usr/bin/bwrap', '/bin/bwrap', '/usr/local/bin/bwrap'].some((p) => existsSync(p));

/** The macOS seatbelt profile, parameterized by WS (workspace) and SD (~/.shadow). */
function seatbeltProfile(allowNetwork: boolean, extraWrite: string[]): string {
  return [
    '(version 1)',
    '(allow default)',
    '(deny file-write*)',
    '(allow file-write*',
    '  (subpath (param "WS"))',
    ...extraWrite.map((p) => `  (subpath ${JSON.stringify(p)})`),
    '  (subpath "/private/tmp")',
    '  (subpath "/private/var/folders")',
    '  (literal "/dev/null") (literal "/dev/zero") (literal "/dev/urandom")',
    '  (literal "/dev/stdout") (literal "/dev/stderr") (literal "/dev/tty") (literal "/dev/dtracehelper"))',
    '(deny file-read* (subpath (param "SD")))', // protect the credentials store
    allowNetwork ? '' : '(deny network*)',
  ]
    .filter(Boolean)
    .join('\n');
}

export function wrapCommand(opts: {
  command: string;
  workspaceRoot: string;
  /** Extra granted roots (additionalDirectories / --add-dir); bound writable in the sandbox. */
  additionalRoots?: string[];
  allowNetwork: boolean;
  enabled: boolean;
}): SandboxResult {
  const { command, workspaceRoot, allowNetwork, enabled } = opts;
  const shell = process.env.SHELL || '/bin/sh';
  const ws = real(workspaceRoot);
  const shadowDir = real(join(homedir(), '.shadow'));
  // Real, existing, de-duplicated extra roots — bwrap can't bind a missing path.
  const extra = [...new Set((opts.additionalRoots ?? []).map(real))].filter((p) => p !== ws && existsSync(p));

  const passthrough = (note?: string): SandboxResult => ({
    argv: IS_WIN
      ? ['powershell.exe', '-NoProfile', '-NonInteractive', '-Command', command]
      : [shell, '-c', command],
    sandboxed: false,
    note,
  });

  if (!enabled) return passthrough();
  // --yolo (or explicit noSandbox/unrestricted) means the caller wants no sandbox at all.
  if (IS_WIN) return passthrough('no OS sandbox on Windows — run_shell runs unconfined');

  if (IS_MAC) {
    if (!existsSync('/usr/bin/sandbox-exec')) {
      return passthrough('sandbox-exec not found — run_shell runs unconfined');
    }
    return {
      argv: ['sandbox-exec', '-D', `WS=${ws}`, '-D', `SD=${shadowDir}`, '-p', seatbeltProfile(allowNetwork, extra), shell, '-c', command],
      sandboxed: true,
    };
  }

  // Linux
  if (hasBwrap()) {
    const flags = [
      '--die-with-parent',
      '--new-session',
      // New PID namespace (+ the fresh --proc below) so a run_shell command cannot read the parent
      // agent's environment via /proc/<agent-pid>/environ and exfiltrate the provider API key.
      '--unshare-pid',
      '--ro-bind', '/', '/', // whole fs read-only…
      '--dev', '/dev',
      '--proc', '/proc',
      '--bind', ws, ws, // …workspace writable…
      '--bind', '/tmp', '/tmp', // …and /tmp…
      ...extra.flatMap((d) => ['--bind', d, d]), // …and any granted dirs writable…
      '--tmpfs', shadowDir, // …and ~/.shadow hidden behind an empty tmpfs (no creds read)
      '--chdir', ws,
    ];
    if (!allowNetwork) flags.push('--unshare-net');
    return { argv: ['bwrap', ...flags, shell, '-c', command], sandboxed: true };
  }
  return passthrough('bubblewrap (bwrap) not found — run_shell runs unconfined');
}

/**
 * Whether an OS sandbox tool is actually present on this host. The sandbox
 * fails open (run_shell runs UNCONFINED) when the platform tool is missing —
 * most Linux container images ship no bubblewrap — so any surface that
 * *advertises* the sandbox status (e.g. the system prompt) must probe this,
 * not assume "ON". Mirrors the platform branches in wrapCommand exactly.
 */
export function sandboxToolAvailable(): boolean {
  if (IS_WIN) return false;
  if (IS_MAC) return existsSync('/usr/bin/sandbox-exec');
  return hasBwrap();
}

/**
 * Truthful OS-sandbox status string for the system prompt / status surfaces.
 * `requested` is whether the sandbox is meant to be on (i.e. not --yolo /
 * --no-sandbox / full autonomy). When it's requested but the host has no
 * sandbox tool, run_shell silently runs unconfined — say so, rather than
 * claiming "ON" (the prompt must not lie about the boundary).
 */
export function osSandboxStatus(requested: boolean): string {
  if (!requested) return 'OFF';
  if (sandboxToolAvailable()) return 'ON (bwrap or seatbelt where available)';
  return 'REQUESTED but UNAVAILABLE — run_shell runs UNCONFINED';
}
