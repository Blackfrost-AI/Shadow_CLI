import { stripVTControlCharacters } from 'node:util';
import { redactString } from '../util/redact.js';

/** Titles are plain, bounded text everywhere: disk, pickers and the terminal's OSC title. */
export function normalizeSessionTitle(text: string): string {
  const clean = stripVTControlCharacters(redactString(text))
    .replace(/[\x00-\x1f\x7f-\x9f\u061c\u200b-\u200f\u2028-\u202e\u2060-\u206f\ufeff]/g, ' ')
    .replace(/\s+/g, ' ').trim();
  const chars = Array.from(clean);
  return chars.length > 72 ? chars.slice(0, 71).join('').trimEnd() + '…' : clean;
}

/** A local label from the opening request; no extra provider call or background request. */
export function deriveSessionTitle(prompt: string): string {
  const opening = redactString(prompt).trim().split(/\r?\n/, 1)[0] ?? '';
  const clean = opening
    .replace(/^\s{0,3}#{1,6}\s+/, '')
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
    .replace(/[`*_]/g, '')
    .replace(/^(?:(?:can|could|would) you(?: please)?\s+|(?:i want|i'd like) (?:you )?to\s+|help me\s+|please\s+)/i, '')
    .replace(/[.!?]+$/, '');
  const title = normalizeSessionTitle(clean);
  return title ? title[0]!.toLocaleUpperCase() + title.slice(1) : '';
}

export function sessionTerminalTitle(title = '', activity?: TitleActivity): string {
  const base = `${normalizeSessionTitle(title) || 'New session'} — Shadow`;
  const frame = activity ? activityFrame(activity) : '';
  return frame ? `${frame} ${base}` : base;
}

/** Working-state spinner for the terminal title. Braille runs at 10 frames with even weight. */
export const TITLE_FRAMES = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'] as const;

/** Shown instead of an animation when motion is reduced: visibly "busy", never moving. */
export const TITLE_STATIC_BUSY = '●';

export interface TitleActivity {
  /** Live tick from the render loop; advances the frame. */
  tick: number;
  /** `reducedMotion` swaps the animation for a single static marker. */
  reducedMotion?: boolean;
}

/**
 * The leading glyph for a working session, or `''` when idle.
 *
 * A tab title is the only part of a long-running session visible when you are looking at a
 * different window, so "is it working?" needs to be answerable without focusing the tab. The
 * glyph leads because terminal tab strips truncate from the right — a trailing marker disappears
 * first on a narrow tab.
 */
export function activityFrame(activity: TitleActivity): string {
  if (activity.reducedMotion) return TITLE_STATIC_BUSY;
  const i = Math.abs(Math.floor(activity.tick)) % TITLE_FRAMES.length;
  return TITLE_FRAMES[i]!;
}
