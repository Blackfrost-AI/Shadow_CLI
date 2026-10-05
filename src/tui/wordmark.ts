// src/tui/wordmark.ts — the Shadow logo: a large snowflake, the session's opening mark.
//
// Drawn in heavy box-drawing glyphs (╲ ╱ │ ─) with a ✻ center and ✦ tips: crisp on every
// terminal that renders the transcript's tables, and single-width everywhere (deliberately NO
// ❄ — it has an emoji presentation variant that some terminals render double-width, which would
// shred the column math). Fifteen rows by twenty-five columns: large enough to be a logo, narrow
// enough that the side-by-side layout still fits beside the meta block on ~80-column terminals.
//
// Single source of truth: the Ink shell commits it into scrollback and the pi shell draws it in
// the live-frame splash, so it lives here rather than in either renderer.
//
// MUST stay a PLAIN template literal, NOT String.raw: Bun's --compile bundler ASCII-escapes the
// box glyphs to \uXXXX, and String.raw would then keep that escape LITERAL (the binary printed
// "\u2588\u2588…" instead of the art). A plain template evaluates the escapes back to the real
// characters, so it renders under both Bun and Node.
export const SHADOW_ART = `     ✦      ✦      ✦
      ╲     │     ╱
       ╲    │    ╱
        ╲   │   ╱
         ╲  │  ╱
          ╲ │ ╱
     \\ \\ \\ ╲│╱ / / /
✦───────────✻───────────✦
     / / / ╱│╲ \\ \\ \\
          ╱ │ ╲
         ╱  │  ╲
        ╱   │   ╲
       ╱    │    ╲
      ╱     │     ╲
     ✦      ✦      ✦`.split('\n');

/** Rendered width of the art — used to decide the layout before rendering it. */
export const SHADOW_ART_WIDTH = Math.max(...SHADOW_ART.map((l) => l.length));
