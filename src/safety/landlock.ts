/**
 * Landlock backend for Linux — confinement without user namespaces.
 *
 * Adapted from DeepSeek Harness (`deepseek-ai/deepseek-harness`), MIT License,
 * `packages/experimental/webworker-runtime/src/shell/process/landlock.ts` (the launcher grammar).
 * Copyright (c) DeepSeek. See THIRD_PARTY_NOTICES.md.
 *
 * WHY THIS EXISTS ALONGSIDE BUBBLEWRAP
 * ------------------------------------
 * bwrap needs unprivileged user namespaces. Those are commonly disabled — in containers, on
 * hardened Kali, on CI runners, under some apparmor profiles — and when they are, Shadow silently
 * fell back to running unconfined. Landlock is an unprivileged LSM: no namespaces, no setuid, no
 * daemon. On a kernel that has it (5.13+, and it is on by default in Debian/Kali/Ubuntu), it is
 * strictly better than "no sandbox".
 *
 * The launcher is compiled on first use from the C source we ship and cached. That keeps the
 * release artifact free of per-arch native binaries while still giving us a real syscall boundary.
 */
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const LAUNCHER_NAME = 'shadow-landlock';

/** Cached probe result — Landlock availability cannot change within a process. */
let landlockProbe: { ok: boolean; launcher?: string; reason?: string } | undefined;

function cacheDir(): string {
  return join(homedir(), '.shadow', 'bin');
}

function launcherPath(): string {
  return join(cacheDir(), LAUNCHER_NAME);
}

/** Locate the C source, whether running from `src/`, `dist/`, or a bundled binary. */
function launcherSource(): string | undefined {
  const here = dirname(fileURLToPath(import.meta.url));
  const candidates = [
    resolve(here, '../../native/shadow-landlock.c'),
    resolve(here, '../native/shadow-landlock.c'),
    resolve(process.cwd(), 'native/shadow-landlock.c'),
  ];
  return candidates.find((p) => existsSync(p));
}

function buildLauncher(source: string, out: string): void {
  mkdirSync(dirname(out), { recursive: true });
  execFileSync('cc', ['-O2', '-o', out, source], { stdio: 'pipe', timeout: 60_000 });
}

/**
 * Is Landlock usable here? Compiles the launcher on first call.
 *
 * Never throws: a missing compiler or an old kernel is a normal condition, and the caller's job is
 * to fall back to bwrap or to report that confinement is unavailable.
 */
export function probeLandlock(): { ok: boolean; launcher?: string; reason?: string } {
  if (landlockProbe) return landlockProbe;
  if (process.platform !== 'linux') {
    landlockProbe = { ok: false, reason: 'not linux' };
    return landlockProbe;
  }

  const out = launcherPath();
  try {
    let built = false;
    if (existsSync(out)) {
      // Rebuild if the cached launcher predates the shipped source (upgrade case).
      const src = launcherSource();
      if (src) {
        try {
          built = statSync(out).mtimeMs >= statSync(src).mtimeMs;
        } catch {
          built = true;
        }
      } else {
        built = true;
      }
    }
    if (!built) {
      const src = launcherSource();
      if (!src) {
        landlockProbe = { ok: false, reason: 'launcher source not found' };
        return landlockProbe;
      }
      buildLauncher(src, out);
    }
    execFileSync(out, ['--probe'], { stdio: 'pipe', timeout: 10_000 });
    landlockProbe = { ok: true, launcher: out };
  } catch (e) {
    landlockProbe = {
      ok: false,
      reason: e instanceof Error ? e.message.split('\n')[0] : 'landlock probe failed',
    };
  }
  return landlockProbe;
}

export interface LandlockInvocation {
  readOnly: readonly string[];
  readWrite: readonly string[];
  argv: readonly string[];
}

/**
 * Build launcher arguments.
 *
 * `allowedRead` must include everything the command legitimately needs — the runtime itself, shared
 * libraries, and device nodes. We pass a conservative standard set rather than `/`: the entire point
 * of read confinement is that an unlisted path is unreadable.
 */
export function buildLandlockArgs(
  command: string,
  opts: {
    launcher: string;
    allowedRead: readonly string[];
    writableRoots: readonly string[];
    shell?: string;
  },
): string[] {
  const args: string[] = [];
  for (const p of opts.allowedRead) args.push('--ro', p);
  for (const p of opts.writableRoots) args.push('--rw', p);
  args.push('--', opts.shell ?? '/bin/sh', '-c', command);
  return args;
}

/**
 * The read set a confined command needs to function: runtime, shared libs, device nodes, and the
 * workspace (so a sample can be read and its behaviour observed). Deliberately does NOT include
 * `$HOME` or `/etc` broadly — that is where credentials live.
 */
export function standardReadRoots(workspaceRoot: string): string[] {
  const roots = [
    '/usr',
    '/lib',
    '/lib64',
    '/bin',
    '/sbin',
    '/etc/ld.so.cache',
    '/etc/ld.so.conf',
    '/etc/ld.so.conf.d',
    '/etc/alternatives',
    '/etc/ssl/certs',
    '/etc/resolv.conf',
    '/etc/hosts',
    '/etc/nsswitch.conf',
    '/etc/passwd',
    '/etc/group',
    '/etc/localtime',
    '/proc',
    '/sys/devices/system/cpu',
    workspaceRoot,
  ];
  return roots.map((p) => resolve(p));
}

/**
 * Device nodes that must be WRITABLE for an ordinary shell to work.
 *
 * Landlock's write access is all-or-nothing per path: granting `/dev/null` read-only still makes
 * `cmd 2>/dev/null` fail with "Permission denied", because the shell opens it O_WRONLY. A sandbox
 * that breaks harmless redirection teaches people to switch the sandbox off, so these are granted
 * write in every mode — they carry no persistence risk.
 */
export function standardWritableDevices(): string[] {
  return ['/dev/null', '/dev/zero', '/dev/full', '/dev/tty', '/dev/stdout', '/dev/stderr'].map((p) =>
    resolve(p),
  );
}

/** Reset the cached probe. Test-only. */
export function resetLandlockProbeForTests(): void {
  landlockProbe = undefined;
}