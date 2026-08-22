// ─────────────────────────────────────────────────────────────────────────────
// Toast — a transient one-line acknowledgment that NEVER commits to Static.
//
// Before this module every ack (clipboard hit/miss, theme/style/autonomy/effort
// switches) was a permanent transcript line in native scrollback. The web console
// already had toasts (src/web/ui/ui.js); the TUI now has the equivalent: a single
// bottom row that replaces itself on new toasts and expires after a short delay.
//
// Pure module (no process, no Ink) — unit tests cover the shape and the width clamp.
// ─────────────────────────────────────────────────────────────────────────────

import { displayWidth } from '../util/width.js';

/** Semantic tint of a toast — keeps the caller away from raw hex codes. */
export type ToastKind = 'ok' | 'info' | 'warn' | 'error';

export interface ToastView {
  /** The display text — already width-clamped by clampToastText. */
  text: string;
  kind: ToastKind;
}

/** How long a toast stays on screen before it clears itself (ms). */
export const TOAST_TTL_MS = 3200;

/** Breathing room on the right edge so the tinted row doesn't kiss the terminal border. */
const TOAST_MARGIN = 2;

/**
 * The columns the TUI's page margin INDENTS a toast row. The render side prefixes
 * PAGE_MARGIN (= 4 in tui.tsx) spaces to the clamped text, so the clamp budget must
 * exclude those or the ellipsis gets clipped by Ink's truncate. Must equal the indent
 * actually used at the render call site — pinned by toast.test.
 */
export const TOAST_INDENT = 4;

/**
 * Map a toast kind to a palette color.
 *
 * `theme` may be a live ThemePalette or a static color table — the C tables in
 * tui.tsx ARE the active palette (rebuilt when the theme changes), so either
 * shape works as long as it carries cyan/yellow/red.
 */
export function toastColor(kind: ToastKind, theme: { cyan?: string; yellow?: string; red?: string }): string {
  switch (kind) {
    case 'ok':
      return theme.cyan ?? '#4fd6be';
    case 'warn':
      return theme.yellow ?? '#f9e2af';
    case 'error':
      return theme.red ?? '#ff6b6b';
    default:
      return theme.cyan ?? '#4fd6be';
  }
}

/**
 * Clamp a toast message to a single terminal row.
 *
 * The toast renders as ` text ` inside the HUD (one leading space for the row
 * gutter), so the visible budget is cols − margin. Full-width/CJK characters are
 * measured with displayWidth so the row can never wrap and force an Ink reflow
 * mid-frame.
 */
export function clampToastText(text: string, cols: number): string {
  const budget = Math.max(0, cols - TOAST_INDENT - TOAST_MARGIN);
  // Cheap path: ASCII-ish text that already fits.
  if (displayWidth(text) <= budget) return text;
  const ellipsis = '…';
  let out = '';
  for (const ch of text) {
    const w = displayWidth(ch);
    // Reserve the ellipsis width up front — the truncated row must STILL fit in the
    // budget once '…' is appended, or the toast wraps and forces an Ink reflow.
    if (displayWidth(out) + w + displayWidth(ellipsis) > budget) break;
    out += ch;
  }
  return out + ellipsis;
}
