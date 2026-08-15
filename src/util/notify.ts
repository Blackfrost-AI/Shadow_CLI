// Terminal notifications (P1B-04): ping the user when a long turn finishes or an approval has been
// waiting, so they can tab away during a slow self-hosted run and be called back. Pure detection +
// escape-sequence generation so it unit-tests without a terminal; the emit guard refuses to write
// into a pipe (a notification escape in captured output is corruption, not a ping).
//
// Zero-telemetry note: these are LOCAL terminal escape sequences the user's own terminal turns into
// a desktop notification / bell. Nothing leaves the machine.

export type NotifyChannel = 'auto' | 'iterm2' | 'kitty' | 'ghostty' | 'bell' | 'off';
export type ResolvedChannel = 'iterm2' | 'kitty' | 'ghostty' | 'bell';

/**
 * Pick the notification channel from the environment. iTerm2 / kitty / ghostty each have a native
 * desktop-notification escape; everything else falls back to the terminal bell (BEL), which every
 * terminal supports and most turn into a dock bounce / taskbar flash.
 */
export function detectNotifyChannel(env: NodeJS.ProcessEnv = process.env): ResolvedChannel {
  const tp = (env.TERM_PROGRAM ?? '').toLowerCase();
  const term = (env.TERM ?? '').toLowerCase();
  if (tp === 'iterm.app') return 'iterm2';
  if (tp === 'ghostty' || env.GHOSTTY_RESOURCES_DIR) return 'ghostty';
  if (tp === 'kitty' || term.includes('kitty') || env.KITTY_WINDOW_ID) return 'kitty';
  return 'bell';
}

/** Resolve a configured channel (`auto` → detect) to a concrete one, or null for `off`. */
export function resolveNotifyChannel(configured: NotifyChannel, env: NodeJS.ProcessEnv = process.env): ResolvedChannel | null {
  if (configured === 'off') return null;
  if (configured === 'auto') return detectNotifyChannel(env);
  return configured;
}

/** Strip control bytes from a notification field so a crafted title/body can't inject its own escapes. */
function clean(s: string): string {
  return s.replace(/[\x00-\x1f\x7f]/g, ' ').trim();
}

/**
 * The escape/byte sequence that raises a notification on `channel`. Empty string when there is
 * nothing to send. `bell` ignores the text (it is a plain BEL). Title/body are sanitized.
 */
export function notifySequence(channel: ResolvedChannel, title: string, body = ''): string {
  const t = clean(title);
  const b = clean(body);
  const msg = b ? `${t}: ${b}` : t;
  switch (channel) {
    case 'iterm2':
      // iTerm2 OSC 9 — a simple attention notification with a message.
      return `\x1b]9;${msg}\x07`;
    case 'ghostty':
      // Ghostty OSC 777 desktop notification (title;body), the same shape urxvt/others accept.
      return `\x1b]777;notify;${t};${b || t}\x07`;
    case 'kitty':
      // kitty OSC 99 desktop-notification protocol, minimal single-chunk form (ST-terminated).
      return `\x1b]99;;${msg}\x1b\\`;
    case 'bell':
      return '\x07';
  }
}

export interface NotifyOptions {
  /** Only write when the destination is a real TTY — never corrupt a pipe/redirect. */
  isTTY?: boolean;
  write?: (s: string) => void;
  env?: NodeJS.ProcessEnv;
}

/**
 * Emit a notification for the configured channel, guarded so it never writes into a non-TTY.
 * Returns the sequence written (for tests), or '' when nothing was emitted.
 */
export function emitNotification(configured: NotifyChannel, title: string, body: string, opts: NotifyOptions = {}): string {
  const isTTY = opts.isTTY ?? !!process.stdout.isTTY;
  if (!isTTY) return ''; // a notification escape in captured output is corruption, not a ping
  const channel = resolveNotifyChannel(configured, opts.env);
  if (!channel) return '';
  const seq = notifySequence(channel, title, body);
  if (!seq) return '';
  (opts.write ?? ((s: string) => process.stdout.write(s)))(seq);
  return seq;
}

/** Only notify for turns at least this long — a quick answer never needs a ping. */
export const NOTIFY_MIN_TURN_MS = 20_000;
/** Notify when an approval dialog has waited at least this long unanswered. */
export const NOTIFY_APPROVAL_WAIT_MS = 12_000;
