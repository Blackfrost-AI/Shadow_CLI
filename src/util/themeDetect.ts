// src/util/themeDetect.ts — F02-05: follow the terminal's own background when the user has never
// explicitly chosen a theme, and recognize terminals too dumb for the raw-mode TUI.
//
// Two halves, both pure/testable:
//   1. TERM=dumb classification — a `dumb` terminal has no cursor addressing, so the Ink raw-mode
//      TUI renders as garbage. The caller (index.ts) forces the plain renderer instead.
//   2. OSC 11 background query — the terminal can REPORT its default background color. One query
//      with a bounded wait (~100ms), luminance → light vs dark. Missing reply = dark (the default
//      posture; Shadow's stock palettes are dark-terminal palettes).
//
// No egress, no state written: detection result is applied in-memory only. Only an explicit
// `/theme <name>` persists a choice — so detection re-runs on every launch until the user chooses.

export interface TermBg {
  /** Normalized 0..1 channel values. */
  r: number;
  g: number;
  b: number;
}

/** True when TERM says the terminal cannot do cursor addressing at all. */
export function isDumbTerm(env: NodeJS.ProcessEnv = process.env): boolean {
  return (env.TERM ?? '').trim().toLowerCase() === 'dumb';
}

/** Normalize one 1-4 digit hex channel to 0..1 (terminals send 4-digit hex; some send 2). */
function channelToUnit(hex: string): number | null {
  if (!/^[0-9a-f]{1,4}$/i.test(hex)) return null;
  const n = parseInt(hex, 16);
  const max = 16 ** hex.length - 1;
  return n / max;
}

/**
 * Parse an OSC 11 background-color REPLY: `ESC ]11;rgb:RRRR/GGGG/BBBB (BEL|ST)`. Lenient on
 * purpose: scans for the `]11;rgb:` marker anywhere in the buffer (tmux wraps replies in a DCS
 * envelope; some terminals answer several queries at once), tolerates BEL or ST termination, and
 * accepts 1-4 hex digits per channel. Returns normalized 0..1 channels or null.
 */
export function parseOsc11Reply(raw: string): TermBg | null {
  const i = raw.indexOf(']11;rgb:');
  if (i < 0) return null;
  const rest = raw.slice(i + ']11;rgb:'.length);
  const m = /^([0-9a-f]{1,4})\/([0-9a-f]{1,4})\/([0-9a-f]{1,4})/i.exec(rest);
  if (!m) return null;
  const r = channelToUnit(m[1]!);
  const g = channelToUnit(m[2]!);
  const b = channelToUnit(m[3]!);
  if (r === null || g === null || b === null) return null;
  return { r, g, b };
}

/** WCAG 2.x relative luminance (0 = black, 1 = white) of a normalized sRGB triple. */
export function bgLuminance({ r, g, b }: TermBg): number {
  const lin = (c: number): number => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);
  return 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b);
}

/** Luminance at and above which the terminal background reads as "light". */
export const LIGHT_BG_THRESHOLD = 0.4;

/** Which Shadow theme fits a terminal with this background. */
export function themeForBackground(bg: TermBg): 'light' | 'og' {
  return bgLuminance(bg) >= LIGHT_BG_THRESHOLD ? 'light' : 'og';
}

/** The OSC 11 background QUERY. The terminal answers with the rgb: form parseOsc11Reply handles. */
export const OSC11_QUERY = '\x1b]11;?\x07';

export interface QueryStdinLike {
  isTTY?: boolean;
  setRawMode?(mode: boolean): void;
  resume?(): void;
  pause?(): void;
  on(event: 'data', fn: (chunk: Buffer | string) => void): void;
  removeListener(event: 'data', fn: (chunk: Buffer | string) => void): void;
}

export interface QueryStdoutLike {
  write(s: string): unknown;
}

export interface TermBgQueryOpts {
  /** Bounded wait for the reply (default 100ms). Silence resolves null — dark stays the default. */
  timeoutMs?: number;
  stdin?: QueryStdinLike;
  stdout?: QueryStdoutLike;
  isTTY?: boolean;
  env?: NodeJS.ProcessEnv;
}

/**
 * Ask the terminal for its default background color. Resolves the parsed background, or null on
 * any of: opted out (SHADOW_NO_THEME_DETECT=1), test env, not a TTY, no raw-mode control, no reply
 * within the bounded wait. NEVER throws and NEVER hangs — startup may await this unconditionally.
 */
export function queryTerminalBackground(opts: TermBgQueryOpts = {}): Promise<TermBg | null> {
  const env = opts.env ?? process.env;
  if (env.SHADOW_NO_THEME_DETECT === '1') return Promise.resolve(null);
  // Test suites mount the TUI constantly — never write terminal queries into their captured output
  // (the same stance as canOpenViewer in termImage.ts).
  if (env.NODE_ENV === 'test' || env.VITEST || env.JEST_WORKER_ID) return Promise.resolve(null);
  const stdin = opts.stdin ?? (process.stdin as unknown as QueryStdinLike);
  const stdout = opts.stdout ?? (process.stdout as unknown as QueryStdoutLike);
  const isTTY = opts.isTTY ?? !!stdin.isTTY;
  if (!isTTY || typeof stdin.setRawMode !== 'function') return Promise.resolve(null);
  // Capture the narrowed method: closures don't keep member-narrowing, and finish()/the raw-mode
  // arm below both run inside the Promise executor. MUST stay bound to stdin — a detached
  // setRawMode loses its `this` and throws inside the executor, which the catch would turn into a
  // silent null (detection dead on every terminal, including real ones).
  const setRaw = stdin.setRawMode.bind(stdin);
  const timeoutMs = opts.timeoutMs ?? 100;

  return new Promise((resolve) => {
    let buf = '';
    let done = false;
    const finish = (bg: TermBg | null): void => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      stdin.removeListener('data', onData);
      try {
        stdin.pause?.();
        setRaw(false);
      } catch {
        /* restoring terminal state is best-effort */
      }
      resolve(bg);
    };
    const onData = (chunk: Buffer | string): void => {
      buf += typeof chunk === 'string' ? chunk : chunk.toString('utf8');
      const bg = parseOsc11Reply(buf);
      if (bg) return finish(bg);
      // Garbage-in guard: a terminal echoing input or a noisy pipe must not keep raw mode armed
      // for the whole window once it's clear no parseable reply is coming in this chunk run.
      if (buf.length > 512) finish(null);
    };
    const timer = setTimeout(() => finish(null), timeoutMs);
    timer.unref?.();
    try {
      setRaw(true);
      stdin.resume?.();
    } catch {
      return finish(null);
    }
    stdin.on('data', onData);
    stdout.write(OSC11_QUERY);
  });
}
