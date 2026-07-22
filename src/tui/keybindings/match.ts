/**
 * Keybinding matcher — converts a terminal {@link KeyEvent} into the canonical
 * comparable {@link ParsedKeystroke}, and compares keystrokes/chords. Pure.
 *
 * The terminal cannot distinguish Alt from Option (both arrive as Ink's `meta`),
 * so both map to the single `meta` bit — matching the reference implementation.
 * `ctrl`/`shift`/`meta` all require an exact match; there is no fuzzy modifier.
 */
import {
  type Chord,
  type KeyEvent,
  type ParsedKeystroke,
} from './types.js';

/** The structural shape of Ink's `Key` (we accept it loosely, no Ink import). */
export interface InkKeyLike {
  upArrow?: boolean;
  downArrow?: boolean;
  leftArrow?: boolean;
  rightArrow?: boolean;
  return?: boolean;
  enter?: boolean;
  escape?: boolean;
  backspace?: boolean;
  delete?: boolean;
  tab?: boolean;
  ctrl?: boolean;
  shift?: boolean;
  meta?: boolean;
  pageUp?: boolean;
  pageDown?: boolean;
  home?: boolean;
  end?: boolean;
}

/** Build a normalized KeyEvent from Ink's `(input, key)` callback args. */
export function fromInkKey(input: string, key: InkKeyLike): KeyEvent {
  return {
    input,
    ctrl: !!key.ctrl,
    shift: !!key.shift,
    meta: !!key.meta,
    upArrow: key.upArrow,
    downArrow: key.downArrow,
    leftArrow: key.leftArrow,
    rightArrow: key.rightArrow,
    return: key.return || key.enter,
    escape: key.escape,
    backspace: key.backspace,
    delete: key.delete,
    tab: key.tab,
    space: input === ' ',
    pageUp: key.pageUp,
    pageDown: key.pageDown,
    home: key.home,
    end: key.end,
  };
}

/**
 * Reduce a key event to its canonical comparable keystroke. Special keys win over
 * the raw char; otherwise the char (letters lowercased) is the key name, carrying
 * the shift flag so `shift+k` ≠ `k`.
 */
export function eventToKeystroke(ev: KeyEvent): ParsedKeystroke {
  const mods = { ctrl: ev.ctrl, shift: ev.shift, meta: ev.meta };
  if (ev.escape) return { key: 'escape', ...mods };
  if (ev.return) return { key: 'enter', ...mods };
  if (ev.tab) return { key: 'tab', ...mods };
  if (ev.backspace) return { key: 'backspace', ...mods };
  if (ev.delete) return { key: 'delete', ...mods };
  if (ev.upArrow) return { key: 'up', ...mods };
  if (ev.downArrow) return { key: 'down', ...mods };
  if (ev.leftArrow) return { key: 'left', ...mods };
  if (ev.rightArrow) return { key: 'right', ...mods };
  if (ev.pageUp) return { key: 'pageup', ...mods };
  if (ev.pageDown) return { key: 'pagedown', ...mods };
  if (ev.home) return { key: 'home', ...mods };
  if (ev.end) return { key: 'end', ...mods };
  if (ev.space || ev.input === ' ') return { key: 'space', ...mods };
  if (ev.input.length === 1) {
    const ch = ev.input;
    // Ink/terminals often deliver Ctrl+Letter as a C0 control byte (Ctrl+A=0x01 … Ctrl+Z=0x1a)
    // WITH or WITHOUT key.ctrl set. Map those back to the letter so bindings like `ctrl+t`
    // match real keypresses (without this, Ctrl+T arrives as key='\x14' and never fires).
    const code = ch.charCodeAt(0);
    if (code >= 1 && code <= 26) {
      return { key: String.fromCharCode(96 + code), ctrl: true, shift: false, meta: false };
    }
    const key = /^[a-z]$/i.test(ch) ? ch.toLowerCase() : ch;
    return { key, ...mods };
  }
  // Multi-char input with no recognized special flag: not matchable as a binding.
  return { key: '', ...mods };
}

/** Two keystrokes match iff the canonical key and all three modifiers agree. */
export function keystrokesEqual(a: ParsedKeystroke, b: ParsedKeystroke): boolean {
  return (
    a.key === b.key &&
    a.ctrl === b.ctrl &&
    a.shift === b.shift &&
    a.meta === b.meta &&
    a.key !== ''
  );
}

/** True if `chord` begins with every keystroke in `prefix` (prefix is a leading run). */
export function chordStartsWith(chord: Chord, prefix: Chord): boolean {
  if (prefix.length > chord.length) return false;
  for (let i = 0; i < prefix.length; i++) {
    if (!keystrokesEqual(chord[i]!, prefix[i]!)) return false;
  }
  return true;
}

/** True if `chord` and `prefix` match keystroke-for-keystroke (same length). */
export function chordEquals(chord: Chord, prefix: Chord): boolean {
  return chord.length === prefix.length && chordStartsWith(chord, prefix);
}
