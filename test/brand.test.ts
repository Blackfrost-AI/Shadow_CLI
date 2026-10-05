/**
 * v10 "Snowfall" brand module — src/tui/brand.ts.
 *
 * The identity is the logotype + icon + compact ladder, and the whole point of
 * the module is that its geometry is derived and its art has one source of truth.
 * The restored retro banner is shared by onboarding, Ink and Snowfall; the icon
 * and compact mark remain available when the full banner cannot fit.
 *
 * These tests are what make "cannot drift" a property rather than an intention.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  SHADOW_LOGOTYPE,
  SHADOW_LOGOTYPE_WIDTH,
  SHADOW_LOGOTYPE_HEIGHT,
  SHADOW_ICON_ART,
  SHADOW_ICON_WIDTH,
  SHADOW_ICON_HEIGHT,
  SHADOW_COMPACT,
  SHADOW_COMPACT_MARK,
  SHADOW_COMPACT_NAME,
  degradeArt,
} from '../src/tui/brand.js';
import { SHADOW_ART as WORDMARK_ART } from '../src/tui/wordmark.js';

// ── the logotype ─────────────────────────────────────────────────────────────

test('the retro logotype is six rows with a consistent rendered width', () => {
  assert.equal(SHADOW_LOGOTYPE_HEIGHT, 6, 'the original banner has six rows');
  assert.equal(SHADOW_LOGOTYPE.length, 6, 'logotype array must have six rows');
  const expected = SHADOW_LOGOTYPE_WIDTH;
  for (const [i, line] of SHADOW_LOGOTYPE.entries()) {
    assert.equal(
      [...line].length,
      expected,
      `logotype row ${i} is ${[...line].length} cols, expected exactly ${expected}: ${JSON.stringify(line)}`,
    );
  }
});

test('the original block-letter banner is 51 columns wide', () => {
  assert.equal(SHADOW_LOGOTYPE_WIDTH, 51);
});

test('the restored logotype uses solid block letters and terminal shadows', () => {
  const joined = SHADOW_LOGOTYPE.join('\n');
  assert.ok(joined.includes('███████╗'), 'filled strokes give the banner its retro weight');
  assert.ok(joined.includes('╚══════╝'), 'the original shaded baseline survives');
  assert.doesNotMatch(joined, /\\u[0-9a-f]{4}/i, 'Unicode escapes must never print literally');
});

// ── the icon ─────────────────────────────────────────────────────────────────

test('the icon is the REAL wordmark art, not a restated copy', () => {
  // The first draft of brand.ts re-typed the icon from memory and got it wrong
  // (13 invented rows where the real art has 15, and a missing middle row).
  // Identity by reference is the only way that mistake cannot recur.
  assert.equal(SHADOW_ICON_ART, WORDMARK_ART, 'the icon must be wordmark.ts by identity');
});

test('the icon geometry is derived, not hardcoded', () => {
  assert.equal(SHADOW_ICON_HEIGHT, SHADOW_ICON_ART.length, 'the height must be the row count');
  assert.equal(SHADOW_ICON_HEIGHT, 15, 'the icon is fifteen rows tall');
  assert.equal(
    SHADOW_ICON_WIDTH,
    Math.max(...SHADOW_ICON_ART.map((l) => [...l].length)),
    'the icon width must be its widest line',
  );
});

test('the icon is ragged-left but never exceeds its bounding box', () => {
  for (const [i, line] of SHADOW_ICON_ART.entries()) {
    const w = [...line].length;
    assert.ok(
      w <= SHADOW_ICON_WIDTH,
      `icon row ${i} is ${w} cols but the bounding box is ${SHADOW_ICON_WIDTH}`,
    );
  }
  // It IS ragged (the top row is shorter than the horizontal arm), which is why
  // callers must pad rather than assume a rectangle.
  const widths = new Set(SHADOW_ICON_ART.map((l) => [...l].length));
  assert.ok(widths.size > 1, 'the icon should be ragged-left, not a uniform rectangle');
});

// ── the degradation ladder ───────────────────────────────────────────────────

test('the ladder degrades logotype → icon → nothing as width shrinks', () => {
  // The pre-v10 ladder had only two tiers and jumped straight from the stacked art
  // to the one-line form, wasting every width in between. The icon tier is what
  // fills that hole, so its band must actually be reachable and non-empty.
  // minGutter is 2, matching renderBrand's stacked test.
  const at = (cols: number) => degradeArt(SHADOW_LOGOTYPE, cols);
  assert.equal(at(SHADOW_LOGOTYPE_WIDTH + 2), SHADOW_LOGOTYPE, 'logotype fits exactly → logotype');
  assert.equal(at(SHADOW_LOGOTYPE_WIDTH + 1), SHADOW_ICON_ART, 'one column short → the icon tier');
  assert.equal(at(SHADOW_ICON_WIDTH + 2), SHADOW_ICON_ART, 'icon fits exactly → icon');
  assert.deepEqual(at(SHADOW_ICON_WIDTH + 1), [], 'one column short of the icon → nothing (compact)');
  assert.deepEqual(at(20), []);
  assert.deepEqual(at(0), []);
  // The icon band must be wide enough to matter — it is the whole point of tier 2.
  assert.ok(
    SHADOW_LOGOTYPE_WIDTH - SHADOW_ICON_WIDTH >= 8,
    'the icon tier must cover a meaningful width band, not a 1-column sliver',
  );
});

test('the ladder returns an unchanged preferred art that already fits', () => {
  // A caller may prefer the icon directly (a narrow-only surface). Degrading must
  // not "upgrade" it to the logotype, and must not swap it for itself oddly.
  assert.equal(degradeArt(SHADOW_ICON_ART, 100), SHADOW_ICON_ART);
  assert.equal(degradeArt(SHADOW_ICON_ART, SHADOW_ICON_WIDTH + 2), SHADOW_ICON_ART);
  // A tiny custom mark survives untouched, so renderBrand's existing callers that
  // pass their own art keep working.
  const tiny = ['ab', 'cd'];
  assert.equal(degradeArt(tiny, 20), tiny);
  // And no art in → no art out, never an invented icon.
  assert.deepEqual(degradeArt([], 200), [], 'no preferred art must not conjure the icon');
});

test('the ladder honours a caller-supplied gutter', () => {
  // minGutter is a parameter because renderBrand's two branches need different
  // headroom; the ladder must agree with whichever the caller asks for.
  assert.equal(
    degradeArt(SHADOW_LOGOTYPE, SHADOW_LOGOTYPE_WIDTH + 1, 1),
    SHADOW_LOGOTYPE,
    'a 1-column gutter lets the logotype fit one column earlier',
  );
  assert.deepEqual(degradeArt(SHADOW_ICON_ART, SHADOW_ICON_WIDTH + 1, 10), []);
});

test('the compact mark is a single-width flake plus the word shadow', () => {
  assert.equal(SHADOW_COMPACT, '✻ shadow');
  assert.equal(SHADOW_COMPACT, `${SHADOW_COMPACT_MARK} ${SHADOW_COMPACT_NAME}`);
  assert.equal(SHADOW_COMPACT_MARK, '✻', 'the compact mark is the flake core, not a tip accent');
  assert.equal(SHADOW_COMPACT_NAME, 'shadow');
  // It must be one line and narrow enough for any terminal.
  assert.ok(!SHADOW_COMPACT.includes('\n'), 'the compact mark must be single-line');
  assert.ok([...SHADOW_COMPACT].length <= 20, 'the compact mark must stay narrow');
});

// ── the stale-constant fix ───────────────────────────────────────────────────

test('the layout width constant matches the art it describes', () => {
  // This is the regression guard for the actual bug: src/tui/layout.ts pinned
  // `SHADOW_LOGO_WIDTH = 50`, which matched the OLD figlet art while its comment
  // pointed at the snowflake. fitsWideBanner() then over-reserved by 25 columns
  // and suppressed the side-by-side layout on terminals that could have held it.
  //
  // layout.ts must now derive from the brand module instead of pinning a number.
  const layout = readFileSync(join(import.meta.dirname, '../src/tui/layout.ts'), 'utf8');
  assert.ok(
    !/const SHADOW_LOGO_WIDTH\s*=\s*\d+/.test(layout),
    'src/tui/layout.ts must not hardcode SHADOW_LOGO_WIDTH to a literal — derive it from src/tui/brand.js',
  );
  assert.ok(
    layout.includes('SHADOW_LOGOTYPE_WIDTH'),
    'src/tui/layout.ts must take the logo width from the brand module',
  );
});

test('the shared renderer applies the ladder, so both shells get three tiers', () => {
  // renderBrand is the layer both the Ink and pi shells draw through. Applying the
  // ladder there (rather than in either shell) is what stops one renderer being
  // left two-tiered — the divergence pattern this whole module exists to end.
  const rows = readFileSync(join(import.meta.dirname, '../src/tui/rows.ts'), 'utf8');
  assert.ok(
    rows.includes('degradeArt('),
    'src/tui/rows.ts must call degradeArt() so the icon tier is reachable in BOTH shells',
  );
});

test('brand.ts exports no dead ladder API', () => {
  // pickBrandTier / brandArtFor / fitsLogotypeBeside shipped in the first draft of
  // this module with ZERO consumers — a ladder nobody called, so the icon tier was
  // unreachable and the splash still jumped logotype → compact. A brand API must be
  // load-bearing or it must not exist.
  const brand = readFileSync(join(import.meta.dirname, '../src/tui/brand.ts'), 'utf8');
  for (const dead of ['pickBrandTier', 'brandArtFor', 'fitsLogotypeBeside']) {
    assert.ok(!brand.includes(dead), `src/tui/brand.ts must not export the dead API ${dead}`);
  }
});

// ── backwards-compatible aliases ─────────────────────────────────────────────

test('brand.ts exports no SHADOW_ART alias — the name stays unambiguous', () => {
  // In v10 the splash draws the LOGOTYPE and the icon is the middle tier. It is
  // tempting to export `SHADOW_ART` from brand.ts as a compat shim, but
  // wordmark.ts ALREADY exports `SHADOW_ART` meaning the icon. Two modules with
  // one name and different values is precisely the divergence that let the
  // pre-v10 brand drift, so brand.ts refuses the name and callers must say which
  // tier they mean.
  const brand = readFileSync(join(import.meta.dirname, '../src/tui/brand.ts'), 'utf8');
  assert.ok(
    !/export const SHADOW_ART\b/.test(brand),
    'src/tui/brand.ts must not export SHADOW_ART — wordmark.ts owns that name (the icon)',
  );
  // The tier names are the required vocabulary instead.
  for (const name of ['SHADOW_LOGOTYPE', 'SHADOW_ICON_ART', 'SHADOW_COMPACT']) {
    assert.ok(
      brand.includes(`export const ${name}`),
      `src/tui/brand.ts must export the tier name ${name}`,
    );
  }
});

// ── brand must not be restated anywhere else ─────────────────────────────────

test('no module restates its own SHADOW art', () => {
  // The bug this prevents: src/onboard/onboard.ts defined a second SHADOW_ART
  // (figlet block letters) that disagreed with wordmark.ts, so onboarding and the
  // session splash showed different marks. v10 requires ONE brand module, so the
  // consumers that used to draw art must now import it.
  const offenders = ['src/onboard/ui.ts', 'src/tui.tsx', 'src/app/app.ts'];
  for (const rel of offenders) {
    const src = readFileSync(join(import.meta.dirname, '..', rel), 'utf8');
    assert.ok(
      !/const SHADOW_ART\b/.test(src),
      `${rel} must not define its own SHADOW_ART — import a tier from src/tui/brand.js`,
    );
    assert.ok(
      src.includes('tui/brand.js'),
      `${rel} must take brand art from src/tui/brand.js`,
    );
    assert.ok(
      src.includes('SHADOW_LOGOTYPE'),
      `${rel} must draw the shared logotype`,
    );
  }
});

test('the block-letter banner stays centralized in the brand module', () => {
  const files = ['src/onboard/ui.ts', 'src/tui.tsx', 'src/app/app.ts'];
  for (const rel of files) {
    const src = readFileSync(join(import.meta.dirname, '..', rel), 'utf8');
    assert.ok(
      !src.includes('█'),
      `${rel} must import the shared block-letter banner instead of duplicating it`,
    );
  }
});
