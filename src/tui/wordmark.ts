// src/tui/wordmark.ts — the full SHADOW wordmark, the session's opening mark.
//
// Keep the wide block-letter art instead of substituting the narrow snowflake. The snowflake fit
// more side-by-side layouts, but visually collapsed the header and removed the two-tone depth the
// wordmark gives the TUI. renderBrand remains responsible for responsive layout: side-by-side
// when both columns fit, stacked while the 51-column mark fits, and compact only below that.
//
// Single source of truth: the Ink shell commits it into scrollback and the pi shell draws it in
// the live-frame splash, so it lives here rather than in either renderer.
//
// MUST stay a PLAIN template literal, NOT String.raw: Bun's --compile bundler ASCII-escapes the
// box glyphs to \uXXXX, and String.raw would then keep that escape LITERAL (the binary printed
// "\u2588\u2588…" instead of the art). A plain template evaluates the escapes back to the real
// characters, so it renders under both Bun and Node.
export const SHADOW_ART = `███████╗██╗  ██╗ █████╗ ██████╗  ██████╗ ██╗    ██╗
██╔════╝██║  ██║██╔══██╗██╔══██╗██╔═══██╗██║    ██║
███████╗███████║███████║██║  ██║██║   ██║██║ █╗ ██║
╚════██║██╔══██║██╔══██║██║  ██║██║   ██║██║███╗██║
███████║██║  ██║██║  ██║██████╔╝╚██████╔╝╚███╔███╔╝
╚══════╝╚═╝  ╚═╝╚═╝  ╚═╝╚═════╝  ╚═════╝  ╚══╝╚══╝`.split('\n');

/** Rendered width of the art — used to decide the layout before rendering it. */
export const SHADOW_ART_WIDTH = Math.max(...SHADOW_ART.map((l) => l.length));
