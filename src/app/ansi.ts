// src/app/ansi.ts — StyledSpan → ANSI, and the live theme view the transcript flattener reads.
//
// The pi-tui engine's Component contract is `render(width): string[]`: one pre-styled ANSI string
// per terminal row. Shadow's flattener (src/tui/flatten.ts) already produces exactly that — a
// StyledSpan[] per row — so this module is the whole bridge. Nothing about the visual language
// changes; only who owns the cursor.

import { C } from '../tui/theme.js';
import type { StyledSpan, ViewportTheme } from '../tui/flatten.js';

export const RESET = '\x1b[0m';

// ── color → SGR ──────────────────────────────────────────────────────────────

const fgCache = new Map<string, string>();
const bgCache = new Map<string, string>();

/** Parse `#rrggbb` / `#rgb`. Returns null for anything else (named colors pass through below). */
function parseHex(hex: string): [number, number, number] | null {
  const m = /^#([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(hex.trim());
  if (!m) return null;
  let h = m[1]!;
  if (h.length === 3) h = h[0]! + h[0]! + h[1]! + h[1]! + h[2]! + h[2]!;
  return [parseInt(h.slice(0, 2), 16), parseInt(h.slice(2, 4), 16), parseInt(h.slice(4, 6), 16)];
}

/** Foreground SGR for a palette value. Cached — the transcript repaints constantly. */
export function fgAnsi(color: string | undefined): string {
  if (!color) return '';
  const hit = fgCache.get(color);
  if (hit !== undefined) return hit;
  const rgb = parseHex(color);
  const seq = rgb ? `\x1b[38;2;${rgb[0]};${rgb[1]};${rgb[2]}m` : '';
  fgCache.set(color, seq);
  return seq;
}

/** Background SGR for a palette value (the inline-code chip). */
export function bgAnsi(color: string | undefined): string {
  if (!color) return '';
  const hit = bgCache.get(color);
  if (hit !== undefined) return hit;
  const rgb = parseHex(color);
  const seq = rgb ? `\x1b[48;2;${rgb[0]};${rgb[1]};${rgb[2]}m` : '';
  bgCache.set(color, seq);
  return seq;
}

/**
 * One span → its styled text. The attribute order matters: reset first, then bg, then fg, then
 * the toggles, so a span never inherits the previous span's style. `dim` maps to the theme's
 * explicit ADA gray rather than the faint SGR-2 attribute, which the ADA pass banned as
 * unreadable (see ViewportTheme.dim).
 */
export function spanToAnsi(span: StyledSpan, theme: ViewportTheme): string {
  const text = span.text;
  if (!text) return '';
  const color = span.color ?? (span.dim ? theme.dim : undefined);
  const parts: string[] = [];
  if (color || span.bg || span.bold || span.italic) parts.push(RESET);
  const bg = bgAnsi(span.bg);
  if (bg) parts.push(bg);
  const f = fgAnsi(color);
  if (f) parts.push(f);
  if (span.bold) parts.push('\x1b[1m');
  if (span.italic) parts.push('\x1b[3m');
  parts.push(text);
  if (color || span.bg || span.bold || span.italic) parts.push(RESET);
  return parts.join('');
}

/** One flattened row → a single ANSI line with no trailing reset (the engine adds line resets). */
export function lineToAnsi(spans: readonly StyledSpan[], theme: ViewportTheme): string {
  let out = '';
  for (const s of spans) out += spanToAnsi(s, theme);
  return out;
}

/**
 * The palette handed to flattenItem. Getters, not a snapshot, so `/theme` re-themes the
 * committed transcript in place — the same live-view contract the Ink path used (a frozen
 * literal left light-mode prose painted in dark-theme gray).
 */
export const PIN_THEME: ViewportTheme = {
  get fg() {
    return C.body;
  },
  get bright() {
    return C.bright;
  },
  get dim() {
    return C.dim;
  },
  get green() {
    return C.green;
  },
  get cyan() {
    return C.cyan;
  },
  get yellow() {
    return C.yellow;
  },
  get red() {
    return C.red;
  },
  get purple() {
    return C.purple;
  },
  get user() {
    return C.user;
  },
  /**
   * The band behind a user turn. Falls back to the theme's menu fill, which every theme defines —
   * so a theme that has not tuned a dedicated user band still gets a coherent one rather than a
   * hardcoded color that clashes with its palette.
   */
  get userBg() {
    return C.userBg ?? C.menuBg;
  },
  get accent() {
    return C.accent;
  },
  get codeBg() {
    return C.codeBg;
  },
};

// ── text styling helpers for chrome (not transcript) ─────────────────────────

export const style = {
  fg: (color: string, s: string) => fgAnsi(color) + s + RESET,
  dim: (s: string) => fgAnsi(C.dim) + s + RESET,
  bold: (s: string) => '\x1b[1m' + s + RESET,
  green: (s: string) => fgAnsi(C.green) + s + RESET,
  cyan: (s: string) => fgAnsi(C.cyan) + s + RESET,
  yellow: (s: string) => fgAnsi(C.yellow) + s + RESET,
  red: (s: string) => fgAnsi(C.red) + s + RESET,
  purple: (s: string) => fgAnsi(C.purple) + s + RESET,
  bg: (color: string, s: string) => bgAnsi(color) + s + RESET,
};
