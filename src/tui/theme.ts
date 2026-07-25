// src/tui/theme.ts — the palette: every theme, the active `C` singleton, and the OS-background
// escape a theme may assert.
//
// Extracted from tui.tsx (T2-1 step 3). A pure MOVE: no behavior change. This is a data table
// plus three functions over one mutable module-level singleton — zero React, zero refs — which is
// exactly the kind of thing that should not live inside a 6000-line component file.

// ── Theme ────────────────────────────────────────────────────────────────────
// Ink/chalk color names + hex. These are passed as Ink `color` PROPS (never as
// raw ANSI escapes embedded in text — Ink does its own styling). The plain
// headless renderer below uses raw ANSI because it writes straight to stdout.
/**
 * Color palette. `C` is a MUTABLE singleton: `/theme` mutates it in place via
 * Object.assign and forces a re-render. Because every `C.xxx` is read at render
 * time (never captured), all ~85 call sites pick up the new palette on the next
 * paint without threading a context through the tree.
 */
// ACCESSIBILITY (WCAG 2.1 AA): primary text `fg` is WHITE for maximum legibility, and `dim` is an
// EXPLICIT readable gray (NOT Ink's `dimColor` faint attribute, which terminals render unpredictably
// and which routinely fails the 4.5:1 contrast floor). Every `fg`/`dim` here clears 4.5:1 on a black or
// dark-gray terminal; accents (cyan/green/yellow/purple/red) are chosen to clear it too.
//
// Role tokens beyond the six accents:
//   body   — transcript prose tier (softer than `bright` so bold/headers can pop above it)
//   bright — the pop tier (bold text, header cells, tool names)
//   user   — the ▌ gutter bar marking every line of a user turn (shape + color cue)
//   accent — the ⏺ assistant-turn bullet
//   codeBg — inline-code chip background (must contrast the theme's implied terminal bg)
// `user` vs `accent` are chosen per-theme to stay distinguishable under color-vision
// deficiency — and the cue is never color-alone: user turns carry the ▌ bar SHAPE.
export const THEMES = {
  og: {
    fg: '#ffffff', // white — high contrast
    body: '#c9d2da', // transcript prose — soft, readable tier under bright
    bright: '#ffffff',
    dim: '#b6bcc3', // ~9:1 on black — readable secondary text
    cyan: '#38dbf5',
    green: '#22d38f', // emerald, brightened for contrast
    red: '#ff6b6b', // red, brightened past AA
    yellow: '#f5b62e', // amber
    purple: '#b9a3ff', // violet, brightened
    user: '#22d38f',
    accent: '#d97757', // warm turn-bullet orange
    codeBg: '#2d333b',
    bg: null,
    menuBg: '#1b2331',
    menuSelBg: '#31465f',
  },
  // Backward-compatible alias for configs saved before the OG name existed.
  dark: {
    fg: '#ffffff',
    body: '#c9d2da',
    bright: '#ffffff',
    dim: '#b6bcc3',
    cyan: '#38dbf5',
    green: '#22d38f',
    red: '#ff6b6b',
    yellow: '#f5b62e',
    purple: '#b9a3ff',
    user: '#22d38f',
    accent: '#d97757',
    codeBg: '#2d333b',
    bg: null,
    menuBg: '#1b2331',
    menuSelBg: '#31465f',
  },
  pipboy: {
    fg: '#e6ffcf', // bright green-white
    body: '#cde8ad',
    bright: '#e6ffcf',
    dim: '#a9cf86',
    cyan: '#9be07a',
    green: '#b6f58a',
    red: '#ff8a7a',
    yellow: '#ecd977',
    purple: '#c8ea86',
    user: '#b6f58a',
    accent: '#ecd977',
    codeBg: '#1e2a14',
    bg: null,
    menuBg: '#16210d',
    menuSelBg: '#2b3f1c',
  },
  cyberpunk: {
    fg: '#f7fbff',
    body: '#d7deea',
    bright: '#f7fbff',
    dim: '#b3bccb',
    cyan: '#4fe0ff',
    green: '#4ff0b3',
    red: '#ff6f93',
    yellow: '#ffdc80',
    purple: '#e08cff',
    user: '#4fe0ff',
    accent: '#e08cff',
    codeBg: '#2a2438',
    bg: null,
    menuBg: '#1d1830',
    menuSelBg: '#38265c',
  },
  'coder-chick': {
    fg: '#fff7fb',
    body: '#eedbe5',
    bright: '#fff7fb',
    dim: '#dcc3cf',
    cyan: '#9fdcff',
    green: '#7fe0a0',
    red: '#ff7ba6',
    yellow: '#ffd485',
    purple: '#ff9fd4',
    user: '#7fe0a0',
    accent: '#ff9fd4',
    codeBg: '#382631',
    bg: null,
    menuBg: '#281a22',
    menuSelBg: '#4a2f3d',
  },
  light: {
    fg: '#0a0a0a', // near-black (for light terminals)
    body: '#1f2328',
    bright: '#000000',
    dim: '#565656', // ~6:1 on a light background
    cyan: '#0369a1', // sky-700
    green: '#047857', // emerald-700
    red: '#b91c1c', // red-700
    yellow: '#b45309', // amber-700
    purple: '#6d28d9', // violet-700
    user: '#047857',
    accent: '#c2410c', // orange-700 — AA on white
    codeBg: '#eaeef2',
    bg: null,
    menuBg: '#e4e9ef',
    menuSelBg: '#c9d6e6',
  },
  matrix: {
    fg: '#5cff9f', // brighter phosphor green
    body: '#54e893',
    bright: '#c9ffdf',
    dim: '#3fbf7a',
    cyan: '#33ffd6',
    green: '#5cff9f',
    red: '#ff5f7d',
    yellow: '#d6ff33',
    purple: '#7fffbf',
    user: '#33ffd6',
    accent: '#d6ff33',
    codeBg: '#06210f',
    bg: null,
    menuBg: '#04160a',
    menuSelBg: '#0b3d1c',
  },
  mono: {
    fg: '#f4f4f4', // bright grayscale — minimal color, terminal-default friendly
    body: '#d6d6d6',
    bright: '#ffffff',
    dim: '#b4b4b4', // ~8:1 on black
    cyan: '#cfd3d8',
    green: '#d6d6d6',
    red: '#ff8a8a',
    yellow: '#ededed',
    purple: '#c4c4c4',
    user: '#ffffff', // mono relies on the ▌ bar shape — bar goes full bright
    accent: '#e2e2e2',
    codeBg: '#2e2e2e',
    bg: null,
    menuBg: '#1e1e1e',
    menuSelBg: '#3a3a3a',
  },
  // Okabe–Ito palette: every accent pair stays distinguishable under deuteranopia,
  // protanopia, AND tritanopia (the standard colorblind-safe set, lightness-tuned for
  // dark terminals to clear WCAG AA). user (sky blue) vs accent (orange) is the
  // strongest CVD-safe pairing — and the ▌ bar shape marks user turns regardless.
  colorblind: {
    fg: '#ffffff',
    body: '#ccd4dc',
    bright: '#ffffff',
    dim: '#b6bcc3',
    cyan: '#56b4e9', // OI sky blue
    green: '#00c092', // OI bluish-green, brightened
    red: '#e8763b', // OI vermillion, brightened
    yellow: '#f0e442', // OI yellow
    purple: '#d98cbb', // OI reddish-purple, brightened
    user: '#56b4e9', // sky bar …
    accent: '#e69f00', // … vs orange bullet: blue/orange survives all three CVD axes
    codeBg: '#2d333b',
    bg: null,
    menuBg: '#1b2331',
    menuSelBg: '#31465f',
  },
  // Maximum-contrast mode: pure white text, loud accents, brighter "quiet" tier —
  // for low vision, glare, or projector terminals. Everything clears AAA (7:1).
  'high-contrast': {
    fg: '#ffffff',
    body: '#ffffff',
    bright: '#ffffff',
    dim: '#dcdcdc', // quiet tier stays ~15:1 — de-emphasis by role, never by illegibility
    cyan: '#00ffff',
    green: '#00ff7f',
    red: '#ff5555',
    yellow: '#ffff00',
    purple: '#e0b0ff',
    user: '#00ff7f',
    accent: '#ffa347',
    codeBg: '#262626',
    bg: null,
    menuBg: '#161616',
    menuSelBg: '#3d3d3d',
  },
  // The only theme that ASSERTS a background. `bg` is pushed to the terminal itself via OSC 11
  // (see backgroundSequence) rather than painted per cell — in the stock renderer the app writes
  // into the terminal's normal buffer and does not own the screen, so a per-<Text> background
  // would leave a ragged edge everywhere a line is shorter than the window.
  //
  // Accents are Okabe–Ito-derived (as `colorblind` is) so the focused look costs nothing under
  // deuteranopia/protanopia/tritanopia, and every tier is measured against TRUE black rather than
  // an assumed one: body 15.3:1, dim 9.6:1, sky 8.5:1, orange 8.4:1 — all AAA for body text.
  shadow: {
    fg: '#ffffff',
    body: '#d5dbe1', // 15.3:1 on #000 — soft enough not to bloom on a pure-black field
    bright: '#ffffff',
    dim: '#a7b0b9', // 9.6:1 — de-emphasis by role, never by illegibility
    cyan: '#5cb8ec', // OI sky blue
    green: '#00c99a', // OI bluish-green
    red: '#ef7a45', // OI vermillion
    yellow: '#f0e442', // OI yellow
    purple: '#dd93c0', // OI reddish-purple
    // The ▌user bar vs the ⏺ turn bullet is the most load-bearing color pair in the transcript.
    // OI sky/orange survives deuteranopia, protanopia and tritanopia on HUE — but at their stock
    // values the two sit 0.011 apart in luminance (the `colorblind` theme has the same collision,
    // and leans on the bar's SHAPE for it). On true black there is headroom to lift the sky, so
    // this pair is separated on luminance too (0.158) and stays legible in grayscale and under
    // achromatopsia — belt and braces, at no cost to either hue.
    user: '#8ed0f5', // sky bar, brightened — 12.5:1 …
    accent: '#e69f00', // … vs orange bullet — 9.3:1
    codeBg: '#141414', // barely-lifted charcoal: a code chip reads as a panel, not a hole
    bg: '#000000',
    menuBg: '#101010',
    menuSelBg: '#2b2b2b',
  },
} as const;
export type ThemeName = keyof typeof THEMES;
export const THEME_NAMES = ['og', 'shadow', 'pipboy', 'cyberpunk', 'coder-chick', 'matrix', 'mono', 'light', 'colorblind', 'high-contrast'] as const;
export type CanonicalThemeName = (typeof THEME_NAMES)[number];

export const THEME_DESCRIPTIONS: Record<CanonicalThemeName, string> = {
  og: 'Original Shadow palette: calm dark terminal with cyan/violet accents.',
  shadow: 'True black. Sets the terminal background itself for a focused session; colorblind-safe accents.',
  pipboy: 'Soft green phosphor with amber warnings; retro but low-glare.',
  cyberpunk: 'Cyan, magenta, and yellow accents on a high-contrast dark base.',
  'coder-chick': 'Rose/pink accent palette with neutral text and readable status colors.',
  matrix: 'Green phosphor mode with sharper signal colors.',
  mono: 'Minimal grayscale for plain terminal focus.',
  light: 'Near-black text and restrained color for light terminals.',
  colorblind: 'Okabe–Ito accessible palette — accents stay distinct under deuteranopia, protanopia, and tritanopia.',
  'high-contrast': 'Maximum contrast (WCAG AAA): pure white text, loud accents, brighter quiet tier.',
};

export const THEME_ALIASES: Record<string, CanonicalThemeName> = {
  dark: 'og',
  black: 'shadow',
  oled: 'shadow',
  focus: 'shadow',
  pink: 'coder-chick',
  coderchick: 'coder-chick',
  chick: 'coder-chick',
  pip: 'pipboy',
  cb: 'colorblind',
  a11y: 'colorblind',
  accessible: 'colorblind',
  'okabe-ito': 'colorblind',
  hc: 'high-contrast',
  contrast: 'high-contrast',
  highcontrast: 'high-contrast',
};

/**
 * The active palette. Every theme defines EVERY field — including `bg: null` for the ones that
 * leave the terminal's own background alone — because `applyTheme` is an in-place Object.assign:
 * a field missing from the incoming theme would keep the outgoing theme's value.
 */
export interface Palette {
  fg: string;
  body: string;
  bright: string;
  dim: string;
  cyan: string;
  green: string;
  red: string;
  yellow: string;
  purple: string;
  user: string;
  accent: string;
  codeBg: string;
  /** Terminal background this theme asserts via OSC 11, or null to inherit the user's own. */
  bg: string | null;
  menuBg: string;
  menuSelBg: string;
}

export const C: Palette = { ...THEMES.og };

export function normalizeThemeName(name: string | undefined): CanonicalThemeName | null {
  if (!name) return null;
  const raw = name.toLowerCase();
  if ((THEME_NAMES as readonly string[]).includes(raw)) return raw as CanonicalThemeName;
  return THEME_ALIASES[raw] ?? null;
}

/** Swap the active palette in place. Caller must trigger a re-render to repaint. */
export function applyTheme(name: ThemeName | string): void {
  const theme = normalizeThemeName(name) ?? 'og';
  Object.assign(C, THEMES[theme]);
}

/** Test seam: a copy of the active palette (colors change in place via applyTheme). */
export function paletteSnapshot(): Palette {
  return { ...C };
}

/**
 * The escape that asks the TERMINAL to change its default background (OSC 11), or resets it to the
 * user's own (OSC 111) when a theme asserts no background. Pure so the sequencing is unit-tested.
 *
 * Why the terminal and not per-cell painting: in the stock renderer Shadow writes into the normal
 * screen buffer and does not own the screen, so `backgroundColor` on a <Text> paints only as far
 * as that line's characters — every short line would end in a ragged edge against the real
 * background, and the margins would never fill at all. OSC 11 colors the whole window, costs
 * nothing per frame, and leaves native scrollback intact.
 *
 * It is WINDOW-WIDE and persists until reset, so runTui must restore it on exit exactly as it
 * already does for the window title. `SHADOW_NO_BG=1` opts out (tmux without passthrough, or a
 * terminal whose background you never want an app to touch).
 */
export function backgroundSequence(bg: string | null, isTTY: boolean, env: NodeJS.ProcessEnv = process.env): string {
  if (!isTTY || env.SHADOW_NO_BG === '1') return '';
  return bg ? `\x1b]11;${bg}\x07` : '\x1b]111\x07';
}

/** The background the named theme asserts (null = inherit the terminal's own). */
export function themeBackground(name: string | undefined): string | null {
  const theme = normalizeThemeName(name) ?? 'og';
  return THEMES[theme].bg;
}
