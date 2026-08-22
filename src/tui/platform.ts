// Platform facts shared across the TUI — placeholder/hint strings must name the key the user's
// terminal ACTUALLY sends, not a macOS-only default. (F07/T1: the composer placeholder and the
// /help lines used to hardcode Option+Enter, which Linux terminals never send — the user pressed
// a key that did nothing, or worse sent the message instead of inserting a newline.)
export const IS_DARWIN = process.platform === 'darwin';

// The composer's newline branch (composerOwner §8) fires on key.meta-return — Option+Enter on
// macOS, Alt+Enter on terminals that send an ESC prefix (most Linux emulators do). Shift+Enter
// is deliberately NOT advertised: without CSI-u configured it arrives as a bare \r and SENDS the
// message instead of breaking the line. Alt+Enter matches the implemented path.
export const NEWLINE_HINT = IS_DARWIN ? 'Option+Enter' : 'Alt+Enter';
