// Shared terminal identity: the original solid-block SHADOW banner, the radial icon,
// and the compact mark. Both interactive renderers and onboarding import this module.
//
// Founder review on 2026-10-04 restored the retro block letters from the pre-v10
// onboarding banner (b15504e^), replacing the thin outlined flake-as-O candidate.
// Keep the artwork in one place and derive its dimensions so layout cannot drift.
// Use plain literals, never String.raw: Bun compilation can escape Unicode glyphs,
// and raw strings would display those escapes instead of the original artwork.
// All art uses single-width text glyphs; avoid emoji and variation selectors.

import { SHADOW_ART as ICON_ART } from './wordmark.js';

/** Original six-row, 51-column block-letter banner, recovered without redrawing. */
export const SHADOW_LOGOTYPE: string[] = [
  '███████╗██╗  ██╗ █████╗ ██████╗  ██████╗ ██╗    ██╗',
  '██╔════╝██║  ██║██╔══██╗██╔══██╗██╔═══██╗██║    ██║',
  '███████╗███████║███████║██║  ██║██║   ██║██║ █╗ ██║',
  '╚════██║██╔══██║██╔══██║██║  ██║██║   ██║██║███╗██║',
  '███████║██║  ██║██║  ██║██████╔╝╚██████╔╝╚███╔███╔╝',
  '╚══════╝╚═╝  ╚═╝╚═╝  ╚═╝╚═════╝  ╚═════╝  ╚══╝╚══╝ ',
];

/** Radial snowflake for terminals too narrow for the full banner. */
export const SHADOW_ICON_ART: string[] = ICON_ART;

/** Compact mark components let callers style the symbol and name separately. */
export const SHADOW_COMPACT_MARK = '✻';
export const SHADOW_COMPACT_NAME = 'shadow';
export const SHADOW_COMPACT = `${SHADOW_COMPACT_MARK} ${SHADOW_COMPACT_NAME}`;

/** Dimensions always follow the artwork, including the compact fallback. */
export const SHADOW_LOGOTYPE_WIDTH: number = Math.max(...SHADOW_LOGOTYPE.map((l) => [...l].length));
export const SHADOW_LOGOTYPE_HEIGHT: number = SHADOW_LOGOTYPE.length;
export const SHADOW_ICON_WIDTH: number = Math.max(...SHADOW_ICON_ART.map((l) => [...l].length));
export const SHADOW_ICON_HEIGHT: number = SHADOW_ICON_ART.length;

/**
 * Choose logotype → icon → compact as the available width shrinks.
 * An empty result asks the caller to draw the one-line compact mark.
 * minGutter matches renderBrand's stacked layout so both agree on what fits.
 */
export function degradeArt(preferred: string[], cols: number, minGutter = 2): string[] {
  if (!preferred.length) return [];
  const preferredW = Math.max(...preferred.map((l) => [...l].length));
  if (preferredW + minGutter <= cols) return preferred;
  if (SHADOW_ICON_WIDTH + minGutter <= cols) return SHADOW_ICON_ART;
  return [];
}
