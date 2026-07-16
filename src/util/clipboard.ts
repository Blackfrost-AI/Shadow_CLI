/**
 * Clipboard copy — best-effort, platform-native, never throws.
 *
 * Picks the first available copy helper for the platform (macOS pbcopy, Linux
 * wl-copy/xclip/xsel, Windows clip.exe) and pipes `text` to its stdin. Resolves
 * to true on success, false if no helper exists or the copy failed — callers show
 * a toast either way and NEVER crash the TUI on a clipboard miss.
 *
 * SECURITY: `text` is passed only via stdin (never as a argv) so a value
 * containing shell metacharacters or a literal command cannot be injected. The
 * helper binary is invoked by name from PATH with a fixed argv; the user's text
 * never touches a shell.
 */
import { spawn } from 'node:child_process';

type CopySpec = { bin: string; args: string[] };

function pickCopySpec(platform: NodeJS.Platform): CopySpec | null {
  switch (platform) {
    case 'darwin':
      return { bin: 'pbcopy', args: [] };
    case 'win32':
      return { bin: 'clip', args: [] };
    case 'linux':
    default:
      // Wayland first (modern), then X11 xclip, then xsel. Caller resolves the
      // first one that actually exists on PATH.
      return { bin: 'wl-copy', args: [] };
  }
}

const LINUX_FALLBACKS: CopySpec[] = [
  { bin: 'xclip', args: ['-selection', 'clipboard'] },
  { bin: 'xsel', args: ['--clipboard', '--input'] },
];

import { accessSync, constants, existsSync, statSync } from 'node:fs';

function pathSeparator(): ':' | ';' {
  // Windows PATH is ';'-delimited; splitting on ':' there corrupts drive letters
  // (C:\foo → 'C' + '\foo').
  return process.platform === 'win32' ? ';' : ':';
}

function onPath(bin: string): boolean {
  // Avoid shelling out to `which`/`command -v` (extra process + PATH quirks). A
  // direct PATH scan is deterministic and dependency-free. On Windows we honor
  // PATHEXT (clip.exe, not clip); on POSIX we require a regular file with the
  // executable bit set, so a planted non-executable file is never selected.
  const PATH = (process.env.PATH ?? '').split(pathSeparator()).filter(Boolean);
  const exts =
    process.platform === 'win32'
      ? (process.env.PATHEXT ?? '.EXE;.CMD;.BAT').split(';').filter(Boolean)
      : [''];
  for (const dir of PATH) {
    for (const ext of exts) {
      const candidate = `${dir}/${bin}${ext}`;
      try {
        if (!existsSync(candidate)) continue;
        if (!statSync(candidate).isFile()) continue; // skip directories named like the bin
        if (process.platform !== 'win32') {
          accessSync(candidate, constants.X_OK); // throws if not executable
        }
        return true;
      } catch {
        /* ignore stat/access errors on unreadable or non-exec entries */
      }
    }
  }
  return false;
}

/** Resolve the first actually-installed copy helper for this platform. */
export function resolveClipboardBin(platform: NodeJS.Platform = process.platform): CopySpec | null {
  const primary = pickCopySpec(platform);
  const candidates = [primary, ...(platform === 'linux' || platform === 'freebsd' ? LINUX_FALLBACKS : [])].filter(
    Boolean,
  ) as CopySpec[];
  return candidates.find((c) => onPath(c.bin)) ?? null;
}

/** True if any platform clipboard helper is available. */
export function hasClipboard(): boolean {
  return resolveClipboardBin() !== null;
}

// ── read (paste) ──────────────────────────────────────────────────────────────

type PasteSpec = { bin: string; args: string[] };

/** Read-side helpers, mirroring the copy set: macOS pbpaste, Wayland wl-paste,
 *  X11 xclip/xsel, Windows PowerShell Get-Clipboard (clip.exe is write-only). */
function pastePrimary(platform: NodeJS.Platform): PasteSpec | null {
  switch (platform) {
    case 'darwin':
      return { bin: 'pbpaste', args: [] };
    case 'win32':
      // -Raw preserves newlines as-is instead of returning a line array.
      return { bin: 'powershell', args: ['-NoProfile', '-Command', 'Get-Clipboard', '-Raw'] };
    case 'linux':
    default:
      return { bin: 'wl-paste', args: ['--no-newline'] };
  }
}

const LINUX_PASTE_FALLBACKS: PasteSpec[] = [
  { bin: 'xclip', args: ['-selection', 'clipboard', '-o'] },
  { bin: 'xsel', args: ['--clipboard', '--output'] },
];

/** Resolve the first actually-installed paste helper for this platform. */
export function resolvePasteBin(platform: NodeJS.Platform = process.platform): PasteSpec | null {
  const primary = pastePrimary(platform);
  const candidates = [primary, ...(platform === 'linux' || platform === 'freebsd' ? LINUX_PASTE_FALLBACKS : [])].filter(
    Boolean,
  ) as PasteSpec[];
  return candidates.find((c) => onPath(c.bin)) ?? null;
}

/** Cap on clipboard reads — a runaway clipboard (screen recording buffer, huge log copy)
 *  must not balloon the composer or the session. 2 MB of text is far beyond any real prompt. */
const READ_CAP_BYTES = 2 * 1024 * 1024;

/**
 * Read the system clipboard as text. Resolves the text ('' for an empty clipboard),
 * or null when no helper exists / the read failed / it exceeded the size cap.
 * Never rejects, and a hung helper is killed after 2s — a paste miss must never
 * wedge the composer.
 */
export function readClipboard(): Promise<string | null> {
  const spec = resolvePasteBin();
  if (!spec) return Promise.resolve(null);
  return new Promise((resolve) => {
    let child;
    try {
      child = spawn(spec.bin, spec.args, { stdio: ['ignore', 'pipe', 'ignore'] });
    } catch {
      resolve(null);
      return;
    }
    const chunks: Buffer[] = [];
    let size = 0;
    let done = false;
    const finish = (val: string | null): void => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      resolve(val);
    };
    const timer = setTimeout(() => {
      try {
        child.kill('SIGKILL');
      } catch {
        /* already gone */
      }
      finish(null);
    }, 2000);
    child.on('error', () => finish(null));
    child.stdout?.on('data', (b: Buffer) => {
      size += b.length;
      if (size > READ_CAP_BYTES) {
        try {
          child.kill('SIGKILL');
        } catch {
          /* already gone */
        }
        finish(null);
        return;
      }
      chunks.push(b);
    });
    child.on('close', (code) => {
      if (code !== 0) {
        finish(null);
        return;
      }
      finish(Buffer.concat(chunks).toString('utf8'));
    });
  });
}

/**
 * Copy `text` to the system clipboard. Resolves true on success, false otherwise.
 * Never rejects — a clipboard miss is a soft failure, surfaced as a toast.
 */
export function copyToClipboard(text: string): Promise<boolean> {
  const spec = resolveClipboardBin();
  if (!spec) return Promise.resolve(false);
  return new Promise((resolve) => {
    let child;
    try {
      child = spawn(spec.bin, spec.args, { stdio: ['pipe', 'ignore', 'ignore'] });
    } catch {
      resolve(false);
      return;
    }
    child.on('error', () => resolve(false));
    child.on('close', (code) => resolve(code === 0));
    // Broken-pipe / closed-stdin on a fast helper is an async 'error', not a throw.
    child.stdin?.on('error', () => resolve(false));
    try {
      child.stdin?.end(text);
    } catch {
      resolve(false);
    }
  });
}
