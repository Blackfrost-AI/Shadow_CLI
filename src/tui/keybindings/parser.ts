/**
 * Keybinding parser — turns human strings ("ctrl+x", "ctrl+x ctrl+k", "shift+tab")
 * into comparable {@link ParsedKeystroke} / {@link Chord} values, and back into
 * canonical / display strings. Pure, no I/O.
 */
import { SPECIAL_KEYS, type Chord, type ParsedKeystroke } from './types.js';

/** Recognized modifier spellings → the single canonical flag they set. */
const MODIFIERS: Record<string, 'ctrl' | 'shift' | 'meta'> = {
  ctrl: 'ctrl',
  control: 'ctrl',
  shift: 'shift',
  alt: 'meta',
  opt: 'meta',
  option: 'meta',
  meta: 'meta',
  // cmd/super/win rarely survive the terminal intact (most terminals eat them),
  // but accept the spellings so configs don't error. They map onto meta since
  // that is the only bit the terminal can actually deliver.
  cmd: 'meta',
  command: 'meta',
  super: 'meta',
  win: 'meta',
};

function isModifier(tok: string): tok is keyof typeof MODIFIERS {
  return tok in MODIFIERS;
}

/**
 * Parse a single keystroke string. Returns null on an unparseable token (caller
 * surfaces a warning rather than throwing). The KEY (last `+`-segment) may itself
 * be a multi-char name ('tab', 'pageup') or a single character ('k', '/').
 */
export function parseKeystroke(raw: string): ParsedKeystroke | null {
  const s = raw.trim();
  if (!s) return null;
  const parts = s.toLowerCase().split('+').map((p) => p.trim()).filter(Boolean);
  if (!parts.length) return null;

  const keyTok = parts[parts.length - 1]!;
  const modToks = parts.slice(0, -1);

  const out: ParsedKeystroke = { key: '', ctrl: false, shift: false, meta: false };
  for (const m of modToks) {
    if (!isModifier(m)) return null;
    out[MODIFIERS[m]] = true;
  }

  // The key token: either a known special name or a single character.
  let key: string;
  if (keyTok in SPECIAL_KEYS) {
    key = SPECIAL_KEYS[keyTok]!;
  } else if (keyTok.length === 1) {
    key = keyTok;
  } else {
    // Reject multi-char unknown tokens (e.g. "ctrl+foobar").
    return null;
  }
  out.key = key;

  // A literal capital letter like "K" implies shift; "k" does not. We already
  // lowercased, so a 'shift+' prefix is the only way shift reaches us — which is
  // the correct canonical form (terminals deliver shift+letter, not uppercase).
  return out;
}

/**
 * Parse a chord string (whitespace-separated keystrokes). The standalone token
 * "space" is a key, not a separator, because parseKeystroke handles it.
 */
export function parseChord(raw: string): Chord | null {
  const s = raw.trim();
  if (!s) return null;
  const chord: Chord = [];
  for (const tok of s.split(/\s+/)) {
    const ks = parseKeystroke(tok);
    if (!ks) return null;
    chord.push(ks);
  }
  return chord.length ? chord : null;
}

/** Canonical string for a keystroke: modifiers (sorted) + key, e.g. "ctrl+shift+k". */
export function keystrokeToString(ks: ParsedKeystroke): string {
  const mods: string[] = [];
  if (ks.ctrl) mods.push('ctrl');
  if (ks.shift) mods.push('shift');
  if (ks.meta) mods.push('meta');
  return [...mods, ks.key].join('+');
}

/** Canonical string for a chord: keystrokes joined by single spaces. */
export function chordToString(chord: Chord): string {
  return chord.map(keystrokeToString).join(' ');
}

/**
 * Display string: macOS shows "opt" for meta, elsewhere "alt". Used in the
 * `/keybindings` listing and hint text.
 */
export function keystrokeToDisplay(ks: ParsedKeystroke, platform: NodeJS.Platform = process.platform): string {
  const mods: string[] = [];
  if (ks.ctrl) mods.push('ctrl');
  if (ks.shift) mods.push('shift');
  if (ks.meta) mods.push(platform === 'darwin' ? 'opt' : 'alt');
  return [...mods, ks.key].join('+');
}
