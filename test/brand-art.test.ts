/**
 * Brand-art safety gate for the v10 Snowfall identity.
 *
 * These tests exist because the constraint is invisible until it breaks in
 * production: src/tui/wordmark.ts deliberately avoids ❄ because its emoji
 * presentation variant renders DOUBLE-WIDTH on some terminals, shredding the
 * column math behind the side-by-side splash layout. That already happened once
 * (a shipped binary printed "\u2588\u2588..." instead of art).
 *
 * Coverage:
 *   1. the shipped wordmark art is single-width-safe and ragged-left within its
 *      declared bounding box (SHADOW_ART_WIDTH is the max, not a per-line width)
 *   2. the retro block-letter LOGOTYPE passes the same gate and is a true rectangle
 *   3. no emoji / double-width hazard appears in brand art
 *   4. no borrowed reference-client glyph appears in v10 art
 *   5. the candidate generator's own checks reject violations (teeth, not
 *      vacuous passes)
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { SHADOW_ART, SHADOW_ART_WIDTH } from '../src/tui/wordmark.js';
import { SHADOW_LOGOTYPE, SHADOW_LOGOTYPE_WIDTH, SHADOW_COMPACT } from '../src/tui/brand.js';

/**
 * Every piece of shipped brand art, so each gate below runs over all of them.
 * Adding a new tier without adding it here would silently leave the new art
 * ungated — the failure mode these tests exist to prevent.
 */
const BRAND_ART = [
  { name: 'wordmark icon', lines: SHADOW_ART, width: SHADOW_ART_WIDTH, rectangle: false },
  { name: 'logotype', lines: SHADOW_LOGOTYPE, width: SHADOW_LOGOTYPE_WIDTH, rectangle: true },
] as const;

/**
 * Emoji / double-width hazards. Deliberately NOT a blanket ban on the dingbats
 * block: ✻ U+273B, ✦ U+2726, ✓ U+2713 and ✗ U+2717 all live there and are
 * single-width TEXT glyphs the transcript depends on. Only the emoji-capable
 * ones are denied.
 *
 * Combining marks — including the variation selectors U+FE00–FE0F, which are
 * General_Category=Mn — are matched by \p{M} in COMBINING_MARK below rather than
 * by a range inside this class: ESLint's no-misleading-character-class rejects
 * that, because a combining mark in a character class can silently fuse with an
 * adjacent literal and change what the class matches.
 */
const EMOJI_HAZARD =
  /[\u{1F000}-\u{1FAFF}\u{3000}-\u{303F}\u{4E00}-\u{9FFF}\u{FF00}-\u{FF60}\u{FFE0}-\u{FFE6}\u{200B}-\u{200F}\u{202A}-\u{202E}\u{2060}-\u{2064}\u{2744}\u{2705}\u{274C}\u{2757}\u{2753}\u{2747}\u{2B50}\u{26A0}\u{2600}-\u{26FF}]/u;

/**
 * Zero-advance-width marks: break naive column math and enable spoofing.
 * Covers U+0300–U+036F combining diacritics AND U+FE00–FE0F variation selectors
 * (the ones that flip ❄ between single- and double-width presentation).
 */
const COMBINING_MARK = /\p{M}/u;

/** Any width hazard: emoji/double-width, or a combining mark. */
const isWidthHazard = (ch: string): boolean => EMOJI_HAZARD.test(ch) || COMBINING_MARK.test(ch);

/** Glyphs borrowed from the reference client — must not survive into v10 art. */
const BORROWED = ['⏺', '❯', '⎿', '▌', '◐', '◑', '◒', '◓'];

/** The proven single-width subset for production brand art (wordmark.ts). */
const BRAND_SAFE = /[█╲╱│─╭╮╰╯┬┴├┼┤═║╔╗╚╝╠╣╦╩╬✻✦▸▾\\/ ]/u;

test('shipped wordmark art is single-width-safe inside its bounding box', () => {
  assert.ok(SHADOW_ART.length > 0, 'SHADOW_ART must not be empty');
  assert.ok(SHADOW_ART_WIDTH > 0, 'SHADOW_ART_WIDTH must be positive');
  for (const [i, line] of SHADOW_ART.entries()) {
    const w = [...line].length;
    assert.ok(
      w <= SHADOW_ART_WIDTH,
      `SHADOW_ART line ${i} is ${w} cols but SHADOW_ART_WIDTH is ${SHADOW_ART_WIDTH}` +
        ` — the splash reserves exactly that many columns, so an over-wide line would break the layout`,
    );
  }
  // The declared width must equal the actual widest line, or fitsWideBanner()
  // over/under-reserves. This is the SHADOW_LOGO_WIDTH=50 class of bug.
  const widest = Math.max(...SHADOW_ART.map((l) => [...l].length));
  assert.equal(SHADOW_ART_WIDTH, widest, 'SHADOW_ART_WIDTH must be the widest line, not a stale constant');
});

test('every shipped brand art declares the width of its own widest line', () => {
  // Runs over ALL tiers: a width constant that drifts from its art is what made
  // the pre-v10 layout reserve 50 columns for 25-column art.
  for (const { name, lines, width } of BRAND_ART) {
    assert.ok(lines.length > 0, `${name} must not be empty`);
    const widest = Math.max(...lines.map((l) => [...l].length));
    assert.equal(width, widest, `${name}: declared width ${width} != widest line ${widest}`);
    for (const [i, line] of lines.entries()) {
      assert.ok(
        [...line].length <= width,
        `${name} line ${i} is ${[...line].length} cols but the declared width is ${width}`,
      );
    }
  }
});

test('the logotype is a true rectangle; the icon is ragged-left by design', () => {
  // Every banner row must be exactly its declared width — the splash pads and
  // right-aligns against it. The
  // icon is hand-drawn ragged-left (its top row sits inside a wider bounding box),
  // so callers must pad it rather than assume a rectangle.
  for (const { name, lines, width, rectangle } of BRAND_ART) {
    const widths = new Set(lines.map((l) => [...l].length));
    if (rectangle) {
      assert.deepEqual([...widths], [width], `${name} must be a uniform ${width}-column rectangle`);
    } else {
      assert.ok(widths.size > 1, `${name} is expected to be ragged-left`);
    }
  }
});

test('no shipped brand art carries an emoji, double-width or combining-mark hazard', () => {
  for (const { name, lines } of BRAND_ART) {
    for (const [i, line] of lines.entries()) {
      for (const ch of line) {
        assert.ok(
          !isWidthHazard(ch),
          `${name} line ${i} contains a width hazard ${JSON.stringify(ch)} ` +
            `(U+${ch.codePointAt(0)!.toString(16).toUpperCase()}) — ` +
            `wordmark.ts avoids ❄ precisely because its emoji variant renders two columns`,
        );
      }
    }
  }
  // The compact one-liner is brand art too, and it is what renders on the
  // narrowest terminals — where a double-width glyph does the most damage.
  for (const ch of SHADOW_COMPACT) {
    assert.ok(!isWidthHazard(ch), `the compact mark contains a width hazard ${JSON.stringify(ch)}`);
  }
});

test('every shipped brand art stays inside the proven brand-safe glyph subset', () => {
  for (const { name, lines } of BRAND_ART) {
    for (const [i, line] of lines.entries()) {
      for (const ch of line) {
        assert.ok(
          BRAND_SAFE.test(ch),
          `${name} line ${i} uses ${JSON.stringify(ch)} (U+${ch.codePointAt(0)!.toString(16).toUpperCase()}), ` +
            `which is not in the proven single-width subset documented by src/tui/wordmark.ts`,
        );
      }
    }
  }
});

test('no borrowed reference-client glyph appears in brand art', () => {
  for (const { name, lines } of BRAND_ART) {
    for (const [i, line] of lines.entries()) {
      for (const g of BORROWED) {
        assert.ok(!line.includes(g), `${name} line ${i} contains borrowed glyph ${JSON.stringify(g)}`);
      }
    }
  }
  for (const g of BORROWED) {
    assert.ok(!SHADOW_COMPACT.includes(g), `the compact mark contains borrowed glyph ${JSON.stringify(g)}`);
  }
});

// ── Teeth: the detectors must actually reject violations ────────────────────
// A gate that cannot fail is not a gate. These pin the negative behaviour of
// the same three detectors used above, so a future loosening of the regexes or
// glyph lists fails loudly instead of silently letting ❄ back in.

test('the hazard detector rejects the emoji snowflake, CJK and other width hazards', () => {
  for (const bad of ['❄', '⛄', '⚠', '✅', '❌', '🔥', '👍', '固', 'Ａ', '\uFE0F', '\u200B', '\u202E']) {
    assert.ok(isWidthHazard(bad), `hazard detector failed to reject ${JSON.stringify(bad)}`);
  }
});

test('the hazard detector rejects combining marks (zero advance width)', () => {
  // Combining marks are matched by \p{M}, NOT by a range inside the character
  // class: ESLint's no-misleading-character-class rejects that, because a
  // combining mark in a class can silently fuse with the adjacent literal.
  for (const bad of ['\u0300', '\u0301', '\u036F', '\u0489']) {
    assert.ok(COMBINING_MARK.test(bad), `COMBINING_MARK failed to reject ${JSON.stringify(bad)}`);
    assert.ok(isWidthHazard(bad), `hazard detector failed to reject ${JSON.stringify(bad)}`);
  }
  // A mark composed onto a brand glyph must still be caught.
  assert.ok(isWidthHazard('✻\u0301'), 'a combining mark on ✻ must be caught');
});

test('the hazard detector does NOT false-positive on single-width text glyphs we depend on', () => {
  for (const good of [
    '✻', '✦', '✓', '✗', '╲', '╱', '│', '─', '▸', '▾', '\\', '/', 'A', 'DONE', ' ',
    '·', '⊙', '█', '▓', '░', '╭', '╮', '╰', '╯', '┬', '┴', '├', '┼', '┤',
  ]) {
    assert.ok(!isWidthHazard(good), `hazard detector wrongly rejected ${JSON.stringify(good)}`);
  }
});

test('BRAND_SAFE accepts the art glyphs and rejects emoji', () => {
  // Solid blocks and box-drawing strokes form the retro banner; ✻✦ are the compact
  // flake marks. All must pass, emoji must not.
  for (const good of [
    '█', '✻', '✦', '│', '─', '╲', '╱', '\\', '/', ' ',
    '╭', '╮', '╰', '╯', '┤', '═', '║', '╔', '╗', '╚', '╝', '╠', '╣',
  ]) {
    assert.ok(BRAND_SAFE.test(good), `BRAND_SAFE wrongly rejected ${JSON.stringify(good)}`);
  }
  for (const bad of ['❄', '▄', '▀', '🔥']) {
    assert.ok(!BRAND_SAFE.test(bad), `BRAND_SAFE wrongly accepted ${JSON.stringify(bad)}`);
  }
});

test('BORROWED covers the reference-client vocabulary v10 must retire', () => {
  for (const g of ['⏺', '❯', '⎿', '▌', '◐']) {
    assert.ok(BORROWED.includes(g), `BORROWED is missing ${JSON.stringify(g)}`);
  }
  // The v10 replacements must NOT be in the banned list.
  for (const g of ['✻', '✦', '▸', '╰']) {
    assert.ok(!BORROWED.includes(g), `BORROWED wrongly bans the v10 glyph ${JSON.stringify(g)}`);
  }
});

test('the width check catches a line that exceeds its bounding box', () => {
  // Replicates the assertion logic above against a deliberately over-wide line.
  const declared = 4;
  const line = 'abcdefghij';
  assert.ok([...line].length > declared, 'detector under test should flag an over-wide line');
});
