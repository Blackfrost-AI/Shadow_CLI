/**
 * Terminal display width — the ONE measure for the whole TUI.
 *
 * Why this file exists: width was implemented three separate times (composer.ts for the input box,
 * util/markdown.ts for table borders, and flatten.ts not at all — it counted UTF-16 code units).
 * The transcript flattener therefore produced rows of `cols` CHARACTERS, which for CJK is 2×`cols`
 * COLUMNS; every transcript row renders inside `<Text wrap="truncate">` (tui.tsx:1383), so the
 * overflow was not wrapped to the next line — it was DELETED, unrecoverably, mid-sentence. A CJK
 * answer lost roughly its right-hand half with no visible marker.
 *
 * A local implementation rather than `string-width`: that package is only a TRANSITIVE dependency
 * of ink, and the release artifact is a Bun single-file binary — an undeclared dep is exactly the
 * kind of thing that survives `npm test` and dies in the binary.
 *
 * NOTE: `src/web/ui/vendor/markdown.js` carries its own copy of this logic on purpose — it runs in
 * the browser and cannot import from `src/tui/`. That duplicate is legitimate; this one was not.
 */

/** Zero-width: combining marks, joiners, variation selectors, BOM. */
function isZeroWidth(cp: number): boolean {
  return (
    (cp >= 0x0300 && cp <= 0x036f) || // combining diacriticals
    (cp >= 0x1ab0 && cp <= 0x1aff) || // combining extended
    (cp >= 0x20d0 && cp <= 0x20ff) || // combining for symbols
    (cp >= 0x200b && cp <= 0x200f) || // ZWSP/ZWNJ/ZWJ + bidi marks
    cp === 0xfe0f ||
    cp === 0xfe0e || // variation selectors
    cp === 0xfeff || // BOM
    (cp >= 0xe0100 && cp <= 0xe01ef) // variation selectors supplement
  );
}

/**
 * Terminal columns occupied by one code point.
 *
 * The BMP emoji cases are enumerated rather than range-swept: the old composer table used a plain
 * ">= 0x1f300" rule and missed every BMP emoji-presentation symbol (✅ U+2705, ⚠ U+26A0, ⏩ U+23E9),
 * which is what made status columns render crooked.
 */
export function charWidth(cp: number): number {
  if (isZeroWidth(cp)) return 0;
  if (cp < 0x20 || (cp >= 0x7f && cp < 0xa0)) return 0; // C0/C1 control
  if (
    (cp >= 0x1100 && cp <= 0x115f) || // Hangul Jamo
    cp === 0x231a || cp === 0x231b || cp === 0x2329 || cp === 0x232a ||
    (cp >= 0x23e9 && cp <= 0x23f3) || (cp >= 0x25fd && cp <= 0x25fe) ||
    (cp >= 0x2614 && cp <= 0x2615) || (cp >= 0x2648 && cp <= 0x2653) ||
    cp === 0x267f || cp === 0x2693 || cp === 0x26a1 || (cp >= 0x26aa && cp <= 0x26ab) ||
    (cp >= 0x26bd && cp <= 0x26be) || (cp >= 0x26c4 && cp <= 0x26c5) || cp === 0x26ce ||
    cp === 0x26d4 || cp === 0x26ea || (cp >= 0x26f2 && cp <= 0x26f3) || cp === 0x26f5 ||
    cp === 0x26fa || cp === 0x26fd || cp === 0x2705 || (cp >= 0x270a && cp <= 0x270b) ||
    cp === 0x2728 || cp === 0x274c || cp === 0x274e || (cp >= 0x2753 && cp <= 0x2755) ||
    cp === 0x2757 || (cp >= 0x2795 && cp <= 0x2797) || cp === 0x27b0 || cp === 0x27bf ||
    (cp >= 0x2b1b && cp <= 0x2b1c) || cp === 0x2b50 || cp === 0x2b55 ||
    (cp >= 0x2e80 && cp <= 0x303e) || // CJK radicals, punctuation
    (cp >= 0x3041 && cp <= 0x33ff) || // kana, CJK symbols
    (cp >= 0x3400 && cp <= 0x4dbf) || (cp >= 0x4e00 && cp <= 0x9fff) || // CJK ideographs
    (cp >= 0xa000 && cp <= 0xa4cf) || (cp >= 0xa960 && cp <= 0xa97f) || // Yi, Hangul Jamo ext-A
    (cp >= 0xac00 && cp <= 0xd7a3) || // Hangul syllables
    (cp >= 0xf900 && cp <= 0xfaff) || // compat ideographs
    (cp >= 0xfe10 && cp <= 0xfe19) || (cp >= 0xfe30 && cp <= 0xfe6f) || // vertical + compat forms
    (cp >= 0xff00 && cp <= 0xff60) || (cp >= 0xffe0 && cp <= 0xffe6) || // fullwidth forms
    (cp >= 0x1f000 && cp <= 0x1fffd) || // supplementary emoji/symbol planes
    (cp >= 0x20000 && cp <= 0x3fffd) // CJK ext B-G
  ) {
    return 2;
  }
  return 1;
}

// Intl.Segmenter is in Node 18+ and Bun; the fallback keeps this pure-JS testable anywhere.
const segmenter: { segment(s: string): Iterable<{ index: number; segment: string }> } | null =
  typeof Intl !== 'undefined' && 'Segmenter' in Intl
    ? new (Intl as unknown as { Segmenter: new (l?: string, o?: object) => never }).Segmenter(undefined, {
        granularity: 'grapheme',
      })
    : null;

/** Split into grapheme clusters (Intl.Segmenter when present, else code points). */
export function graphemes(s: string): string[] {
  if (segmenter) return Array.from(segmenter.segment(s), (g) => g.segment);
  return Array.from(s);
}

/** The grapheme cluster starting at UTF-16 index `i` (never splits a surrogate pair or a ZWJ run). */
export function nextCluster(text: string, i: number): string {
  if (!segmenter) {
    const cp = text.codePointAt(i);
    return cp === undefined ? '' : String.fromCodePoint(cp);
  }
  for (const g of segmenter.segment(text.slice(i))) return g.segment;
  return text.slice(i, i + 1);
}

/**
 * Terminal columns a string occupies. A grapheme CLUSTER is measured by its widest code point, so
 * an emoji built from a ZWJ sequence (👨‍👩‍👧) counts once, not once per component. SGR escapes are
 * stripped — they occupy no columns but do occupy characters, which is how a styled row could
 * measure "too wide" and get needlessly split.
 */
export function displayWidth(s: string): number {
  let w = 0;
  for (const g of graphemes(s.replace(/\x1b\[[0-9;]*m/g, ''))) {
    let gw = 0;
    for (const ch of g) gw = Math.max(gw, charWidth(ch.codePointAt(0) ?? 0));
    w += gw;
  }
  return w;
}

/**
 * Split `s` at the last grapheme boundary that keeps the head within `cols` COLUMNS.
 *
 * Never splits a cluster, and never emits a head wider than `cols` — the two properties the
 * `.slice(0, room)` it replaces could not offer. When even the first cluster is too wide (a 2-column
 * character with `cols === 1`), `head` comes back empty so the caller can wrap instead of looping;
 * callers that cannot wrap must handle the empty head explicitly.
 */
export function takeByWidth(s: string, cols: number): { head: string; rest: string; width: number } {
  if (cols <= 0) return { head: '', rest: s, width: 0 };
  let w = 0;
  let i = 0;
  while (i < s.length) {
    const cluster = nextCluster(s, i);
    if (cluster === '') break;
    const cw = displayWidth(cluster);
    if (w + cw > cols) break;
    w += cw;
    i += cluster.length;
  }
  return { head: s.slice(0, i), rest: s.slice(i), width: w };
}

/** Hard-split into chunks of at most `cols` columns each. Always returns ≥ 1 chunk. */
export function chunksByWidth(s: string, cols: number): string[] {
  const w = Math.max(1, cols);
  const out: string[] = [];
  let rest = s;
  while (rest !== '') {
    const { head, rest: tail } = takeByWidth(rest, w);
    if (head === '') {
      // A single cluster wider than the whole budget: emit it alone rather than spin forever.
      const cluster = nextCluster(rest, 0) || rest.slice(0, 1);
      out.push(cluster);
      rest = rest.slice(cluster.length);
      continue;
    }
    out.push(head);
    rest = tail;
  }
  return out.length ? out : [''];
}
