/**
 * Inline terminal images — detection + protocol emission + save/open fallback. Hand-rolled to
 * stay dep-light (Shadow runs on ink/react/undici/zod only); the two protocols cover every common
 * macOS terminal:
 *   - iTerm2 OSC 1337 (`ESC ]1337;File=inline=1;...:<base64> BEL`) — iTerm2, Ghostty, WezTerm.
 *   - Kitty graphics APC (`ESC G ... ESC \`, chunked base64) — Kitty (and Ghostty/WezTerm).
 *
 * IMPORTANT scrollback caveat: inline images are out-of-band pixel writes — on most terminals they
 * do NOT survive scroll-up (scrollback stores characters, not pixels). Callers MUST also render a
 * durable text placeholder + offer save/open, so an image is never truly lost when it scrolls away.
 * See the `image` TranscriptItem render in flatten.ts.
 */
import { execFileSync } from 'node:child_process';
import { homedir } from 'node:os';
import { mkdirSync, writeFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { join, extname } from 'node:path';

/** Cap inline emission: a base64 string this large in a single Ink <Text> node gets slow/memory-
 *  heavy, and huge in-place images are a poor UX. Beyond this, fall back to save+open only. */
const INLINE_MAX_BYTES = 1_000_000;

const INLINE_IMAGE_TERMINALS = new Set(['ghostty', 'iTerm.app', 'iTerm2', 'kitty', 'WezTerm']);

export interface ImageTermOpts {
  env?: NodeJS.ProcessEnv;
  isTTY?: boolean;
}

/** True if stdout is a TTY on a terminal known to render inline images. Conservative — unknown
 *  terminals get the save+open fallback, never raw escape codes (mirrors supportsHyperlinks). */
export function supportsInlineImages(opts: ImageTermOpts = {}): boolean {
  const isTTY = opts.isTTY ?? !!process.stdout.isTTY;
  if (!isTTY) return false;
  const env = opts.env ?? process.env;
  const tp = env.TERM_PROGRAM;
  if (tp && INLINE_IMAGE_TERMINALS.has(tp)) return true;
  const lc = env.LC_TERMINAL;
  if (lc && INLINE_IMAGE_TERMINALS.has(lc)) return true;
  const term = env.TERM ?? '';
  if (term.includes('kitty') || term.includes('wezterm') || term.includes('ghostty')) return true;
  // tmux passthrough can forward graphics to a capable outer terminal.
  if (tp === 'tmux' && lc && INLINE_IMAGE_TERMINALS.has(lc)) return true;
  return false;
}

/** Which inline protocol to emit. Kitty ONLY speaks its own graphics protocol; every other capable
 *  terminal also speaks iTerm2's OSC 1337, so prefer the simpler 1337 for them. */
function inlineProtocol(env: NodeJS.ProcessEnv = process.env): 'iterm' | 'kitty' | null {
  const term = env.TERM ?? '';
  const tp = env.TERM_PROGRAM ?? '';
  const lc = env.LC_TERMINAL ?? '';
  if (tp === 'kitty' || term.includes('kitty')) return 'kitty';
  if (
    tp === 'iTerm.app' ||
    tp === 'iTerm2' ||
    lc.startsWith('iTerm') ||
    tp === 'ghostty' ||
    term.includes('ghostty') ||
    tp === 'WezTerm' ||
    term.includes('wezterm')
  ) {
    return 'iterm';
  }
  return null;
}

const BEL = '\x07';
const ST = '\x1b\\'; // String Terminator (ends an APC/DCS sequence).

/** iTerm2 OSC 1337 inline image: `ESC ]1337;File=inline=1;width=W;name=N:size=B:<base64> BEL`. */
function itermImage(bytes: Buffer, cols: number, name: string): string {
  const b64 = bytes.toString('base64');
  const width = cols > 0 ? `width=${cols};` : ''; // cell-width: fits the terminal, scales height
  const safeName = name.replace(/[\x00-\x1f\x7f;]/g, '').slice(0, 80);
  const namePart = safeName ? `name=${safeName};` : '';
  return `\x1b]1337;File=inline=1;${width}${namePart}size=${bytes.length};:${b64}${BEL}`;
}

/**
 * Kitty graphics APC, chunked (Kitty caps a single transmission's base64 at ~4096 chars). The image
 * bytes are sent as a file (`t=f` → Kitty decodes PNG/JPEG/GIF/WebP); display width set in cells.
 */
function kittyImage(bytes: Buffer, cols: number): string {
  const b64 = bytes.toString('base64');
  const CHUNK = 4096;
  const parts: string[] = [];
  const colOpt = cols > 0 ? `c=${cols},` : '';
  for (let i = 0; i < b64.length; i += CHUNK) {
    const slice = b64.slice(i, i + CHUNK);
    const more = i + CHUNK < b64.length;
    // First chunk carries the action/format; m=1 on every chunk that has another following it.
    const opts = i === 0 ? `${colOpt}a=T,t=f${more ? ',m=1' : ''}` : more ? 'm=1' : '';
    parts.push(`\x1bG${opts};${slice}${ST}`);
  }
  return parts.join('');
}

export interface InlineImageOpts {
  /** Display width in terminal columns (height scales to preserve aspect). 0 = natural size. */
  cols?: number;
  /** Filename (shown in iTerm2's hover/caption; sanitized). */
  name?: string;
}

/**
 * Build the inline-image escape for `bytes`, or return null if the terminal can't render inline
 * (caller falls back to the text placeholder + save/open). Also null if the image exceeds
 * {@link INLINE_MAX_BYTES} (too large to inline cleanly).
 */
export function inlineImageEsc(bytes: Buffer, opts: InlineImageOpts = {}): string | null {
  const proto = inlineProtocol();
  if (!proto) return null;
  if (bytes.length > INLINE_MAX_BYTES) return null;
  const cols = opts.cols ?? 0;
  const name = opts.name ?? '';
  return proto === 'kitty' ? kittyImage(bytes, cols) : itermImage(bytes, cols, name);
}

const MEDIA_EXT: Record<string, string> = {
  'image/png': '.png',
  'image/jpeg': '.jpg',
  'image/gif': '.gif',
  'image/webp': '.webp',
};

/** File extension for a media type, with a name/uuid fallback. */
function extFor(mediaType: string, name?: string): string {
  return MEDIA_EXT[mediaType] ?? (name ? extname(name) : '') ?? '.png';
}

/**
 * Durable fallback that works on EVERY terminal: write the bytes to `~/.shadow/img-cache/` and open
 * them in the OS viewer (Preview.app on macOS, xdg-open elsewhere). Returns the saved path. Used as
 * the universal non-inline path AND the "re-view" action for the persistent placeholder.
 */
export function saveAndOpen(bytes: Buffer, mediaType: string, name?: string): string {
  const dir = join(homedir(), '.shadow', 'img-cache');
  mkdirSync(dir, { recursive: true });
  const safeName = name ? name.replace(/[^A-Za-z0-9._-]/g, '_').slice(0, 40) : '';
  const fname = `${safeName ? safeName + '-' : ''}${randomUUID()}${extFor(mediaType, name)}`;
  const path = join(dir, fname);
  writeFileSync(path, bytes);
  const opener = process.platform === 'darwin' ? 'open' : 'xdg-open';
  try {
    execFileSync(opener, [path], { stdio: 'ignore' });
  } catch {
    // No viewer available — the file is still on disk; the returned path lets the user open it.
  }
  return path;
}

/** Human-readable byte size, e.g. "234 KB", "1.5 MB". */
export function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${Math.round(n / 1024)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}
