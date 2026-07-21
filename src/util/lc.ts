/**
 * Line colors for plain (non-Ink) CLI output — startup banners, fail-fast messages, the
 * things printed before or outside the TUI.
 *
 * Extracted from index.ts so `src/agent/bootstrap.ts` can share it rather than keeping a
 * second copy of the same escape codes.
 */
export const lc = {
  bold: (s: string) => `\x1b[1m${s}\x1b[0m`,
  green: (s: string) => `\x1b[32m${s}\x1b[0m`,
  red: (s: string) => `\x1b[31m${s}\x1b[0m`,
  yellow: (s: string) => `\x1b[33m${s}\x1b[0m`,
  gray: (s: string) => `\x1b[90m${s}\x1b[0m`,
};

/** Strip SGR color codes so a message can be redacted/logged plainly. Mirrors the private
 *  copy at onboard/onboard.ts:46; exported here so bootstrap/web can share one impl. */
export const stripAnsi = (s: string): string => s.replace(/\x1b\[[0-9;]*m/g, '');
