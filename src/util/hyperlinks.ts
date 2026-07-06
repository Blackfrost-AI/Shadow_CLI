/**
 * OSC 8 terminal hyperlinks — detection + escape wrapper.
 *
 * Many modern terminals (iTerm2, Ghostty, Kitty, WezTerm, GNOME Terminal, …)
 * render `ESC ]8;;<url> BEL <text> ESC ]8;; BEL` as a clickable hyperlink. This is
 * a ZERO-telemetry nicety: the URL is rendered client-side by the user's own
 * terminal; Shadow makes no network call to "shorten" or "track" anything.
 *
 * Detection is conservative: unless the terminal is known to support OSC 8 we
 * render plain text, so a link never shows raw escape codes. Ported (and slimmed)
 * from the reverse-engineered Claude Code `supports-hyperlinks` helper.
 */

const HYPERLINK_TERMINALS = new Set([
  'ghostty',
  'Hyper',
  'kitty',
  'alacritty',
  'iTerm.app',
  'iTerm2',
  'WezTerm',
  'vscode',
]);

export interface HyperlinkOpts {
  env?: NodeJS.ProcessEnv;
  isTTY?: boolean;
}

/** True if stdout is a TTY on a terminal known to render OSC 8 hyperlinks. */
export function supportsHyperlinks(opts: HyperlinkOpts = {}): boolean {
  const isTTY = opts.isTTY ?? !!process.stdout.isTTY;
  if (!isTTY) return false;
  const env = opts.env ?? process.env;

  // TERM_PROGRAM is the common signal; LC_TERMINAL survives inside tmux (where
  // TERM_PROGRAM is overwritten to 'tmux'). Kitty advertises via TERM.
  const tp = env.TERM_PROGRAM;
  if (tp && HYPERLINK_TERMINALS.has(tp)) return true;
  const lc = env.LC_TERMINAL;
  if (lc && HYPERLINK_TERMINALS.has(lc)) return true;
  const term = env.TERM ?? '';
  if (term.includes('kitty') || term.includes('wezterm') || term.includes('ghostty')) return true;
  // tmux passthrough can forward OSC 8 to a capable outer terminal; be optimistic
  // only when the outer terminal is identifiable via LC_TERMINAL.
  if (tp === 'tmux' && lc && HYPERLINK_TERMINALS.has(lc)) return true;
  return false;
}

/**
 * Wrap `text` as an OSC 8 hyperlink to `url`. Callers MUST gate on
 * {@link supportsHyperlinks} first; this emits raw escapes unconditionally.
 * `url` is sanitized (control chars stripped) so a malicious value can't inject
 * a second OSC sequence.
 */
export function hyperlink(text: string, url: string): string {
  const safeUrl = url.replace(/[\x00-\x1f\x7f]/g, '');
  return `\x1b]8;;${safeUrl}\x07${text}\x1b]8;;\x07`;
}
