import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  THEME_NAMES,
  applyTheme,
  paletteSnapshot,
  backgroundSequence,
  themeBackground,
  type Palette,
} from '../src/tui.js';

/** WCAG relative luminance + contrast ratio, so the ADA claims are measured, not asserted. */
function luminance(hex: string): number {
  const n = parseInt(hex.slice(1), 16);
  const chan = (c: number): number => {
    const s = c / 255;
    return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * chan((n >> 16) & 0xff) + 0.7152 * chan((n >> 8) & 0xff) + 0.0722 * chan(n & 0xff);
}
function contrast(a: string, b: string): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x) as [number, number];
  return (hi + 0.05) / (lo + 0.05);
}

const PALETTE_FIELDS: (keyof Palette)[] = [
  'fg', 'body', 'bright', 'dim', 'cyan', 'green', 'red', 'yellow',
  'purple', 'user', 'accent', 'codeBg', 'bg', 'menuBg', 'menuSelBg',
];

test('every theme defines every palette field', () => {
  // applyTheme is an in-place Object.assign: a field missing from one theme would silently keep
  // the PREVIOUS theme's value, so a partial palette is a real bug, not a style nit.
  for (const name of THEME_NAMES) {
    applyTheme(name);
    const p = paletteSnapshot();
    for (const f of PALETTE_FIELDS) {
      assert.ok(f in p, `theme ${name} is missing ${f}`);
      if (f !== 'bg') assert.equal(typeof p[f], 'string', `theme ${name} field ${f} must be a color`);
    }
  }
  applyTheme('og');
});

test('only the shadow theme asserts a terminal background', () => {
  for (const name of THEME_NAMES) {
    const bg = themeBackground(name);
    if (name === 'shadow') assert.equal(bg, '#000000');
    else assert.equal(bg, null, `${name} must leave the user's own background alone`);
  }
});

test('switching themes swaps the menu panel too (no hardcoded slate on black)', () => {
  applyTheme('shadow');
  const dark = paletteSnapshot();
  applyTheme('og');
  const og = paletteSnapshot();
  assert.notEqual(dark.menuBg, og.menuBg, 'the shadow panel must not be the OG slate');
  assert.equal(dark.menuBg, '#101010');
  assert.equal(og.menuBg, '#1b2331');
  applyTheme('og');
});

test('the shadow palette clears WCAG AA on true black — including the quiet tier', () => {
  applyTheme('shadow');
  const p = paletteSnapshot();
  const bg = '#000000';
  // Body text and the "dim" role both carry meaning, so both are held to AA (4.5:1); the
  // brightest tier is expected to be far past AAA.
  assert.ok(contrast(p.fg, bg) >= 7, `fg ${contrast(p.fg, bg).toFixed(1)}:1`);
  assert.ok(contrast(p.body, bg) >= 7, `body ${contrast(p.body, bg).toFixed(1)}:1`);
  assert.ok(contrast(p.dim, bg) >= 4.5, `dim ${contrast(p.dim, bg).toFixed(1)}:1`);
  for (const role of ['cyan', 'green', 'red', 'yellow', 'purple', 'accent', 'user'] as const) {
    assert.ok(contrast(p[role], bg) >= 4.5, `${role} ${contrast(p[role], bg).toFixed(1)}:1 must clear AA`);
  }
  applyTheme('og');
});

test('shadow keeps the blue/orange axis that survives every CVD type', () => {
  applyTheme('shadow');
  const p = paletteSnapshot();
  // The user bar and the turn bullet must stay distinguishable without hue discrimination, so
  // they are separated by LUMINANCE as well as hue (the Okabe–Ito sky/orange pairing).
  const sep = Math.abs(luminance(p.user) - luminance(p.accent));
  assert.ok(sep > 0.05, `user vs accent luminance separation too small: ${sep.toFixed(3)}`);
  applyTheme('og');
});

test('backgroundSequence: OSC 11 to set, OSC 111 to reset, nothing when opted out', () => {
  assert.equal(backgroundSequence('#000000', true, {}), '\x1b]11;#000000\x07');
  assert.equal(backgroundSequence(null, true, {}), '\x1b]111\x07');
  // Never touch a terminal we do not own.
  assert.equal(backgroundSequence('#000000', false, {}), '');
  // The documented opt-out (tmux without passthrough, or "never touch my background").
  assert.equal(backgroundSequence('#000000', true, { SHADOW_NO_BG: '1' }), '');
  assert.equal(backgroundSequence(null, true, { SHADOW_NO_BG: '1' }), '');
});

test('themeBackground resolves aliases and unknown names', () => {
  for (const alias of ['black', 'oled', 'focus']) {
    assert.equal(themeBackground(alias), '#000000', `${alias} should alias to shadow`);
  }
  assert.equal(themeBackground('dark'), null, 'dark aliases to og, which asserts nothing');
  assert.equal(themeBackground('nonsense'), null, 'an unknown name falls back to og');
  assert.equal(themeBackground(undefined), null);
});
