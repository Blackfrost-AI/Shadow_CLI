/**
 * Keybinding engine — pure types. No React, no Ink import: the engine operates on
 * a normalized {@link KeyEvent} (built from Ink's `(input, key)` at the React seam)
 * so the parser/matcher/resolver are unit-testable in isolation.
 *
 * Design mirrors the reverse-engineered the reference client keybinding contract:
 *  - action ids are namespaced strings (`chat:submit`, `app:redraw`, …);
 *  - a binding is a chord (a sequence of one or more keystrokes) → action;
 *  - bindings are scoped to a context; the resolver consults active contexts in
 *    priority order (most-specific first, Global last) and resolves chords with a
 *    prefix-shadowing rule (a longer chord always shadows a single-key prefix).
 *
 * Zero telemetry: nothing here observes or reports what keys are pressed.
 */

/**
 * A normalized key event derived from the terminal. Mirrors the subset of Ink's
 * `Key` we care about. `meta` covers Alt/Option (terminals cannot distinguish the
 * two, so they fold into one bit — same as the reference implementation).
 */
export interface KeyEvent {
  /** The typed character(s), e.g. 'k', '\r', ' '. Empty for pure control keys. */
  input: string;
  ctrl: boolean;
  shift: boolean;
  meta: boolean;
  upArrow?: boolean;
  downArrow?: boolean;
  leftArrow?: boolean;
  rightArrow?: boolean;
  return?: boolean;
  escape?: boolean;
  backspace?: boolean;
  delete?: boolean;
  tab?: boolean;
  space?: boolean;
  pageUp?: boolean;
  pageDown?: boolean;
  home?: boolean;
  end?: boolean;
}

/**
 * A single comparable keystroke: a canonical key name plus modifier flags.
 * Two keystrokes are equal iff key (case-insensitive) and all three modifiers match.
 */
export interface ParsedKeystroke {
  /** Canonical key: a single lowercased char, or a named special key. */
  key: string;
  ctrl: boolean;
  shift: boolean;
  meta: boolean;
}

/** A chord is an ordered sequence of keystrokes (length ≥ 1). */
export type Chord = ParsedKeystroke[];

/**
 * A keybinding: a chord resolves to an action id (or `null`, meaning "explicitly
 * unbound" — a user can null-out a default to free a key).
 */
export interface ParsedBinding {
  context: ContextName;
  chord: Chord;
  /** Action id like `chat:submit`, or `null` to explicitly disable a default. */
  action: string | null;
}

/** Contexts the resolver can be in. Most-specific first when resolving. */
export type ContextName =
  | 'Global'
  | 'Chat'
  | 'Autocomplete'
  | 'Confirmation'
  | 'ModelPicker'
  | 'QuestionDialog'
  | 'MessageActions'
  | 'Transcript';

export const KEYBINDING_CONTEXTS: readonly ContextName[] = [
  'Global',
  'Chat',
  'Autocomplete',
  'Confirmation',
  'ModelPicker',
  'QuestionDialog',
  'MessageActions',
  'Transcript',
] as const;

/**
 * Canonical names for special keys. The parser maps many spellings onto these.
 * Single-character keys are lowercased letters / symbols and are NOT in this set.
 */
export const SPECIAL_KEYS: Record<string, string> = {
  up: 'up',
  down: 'down',
  left: 'left',
  right: 'right',
  arrowup: 'up',
  arrowdown: 'down',
  arrowleft: 'left',
  arrowright: 'right',
  enter: 'enter',
  return: 'enter',
  cr: 'enter',
  esc: 'escape',
  escape: 'escape',
  tab: 'tab',
  space: 'space',
  spc: 'space',
  backspace: 'backspace',
  bs: 'backspace',
  delete: 'delete',
  del: 'delete',
  pageup: 'pageup',
  pgup: 'pageup',
  pagedown: 'pagedown',
  pgdn: 'pagedown',
  home: 'home',
  end: 'end',
};

/** The result of resolving one key event against the binding set. */
export type ResolveResult =
  | { type: 'match'; action: string; context: ContextName }
  | { type: 'chord_started'; pending: Chord }
  | { type: 'chord_cancelled' }
  | { type: 'none' };

/** One raw entry from a user's keybindings.json (pre-parse). */
export interface RawUserBinding {
  context: string;
  bindings: Record<string, string | null>;
}

/** User config file shape: `{ bindings: RawUserBinding[] }`. */
export interface UserKeybindingsFile {
  bindings?: RawUserBinding[];
}

/** A validation warning (never throws — bad input degrades to a warning + skip). */
export interface KeybindingWarning {
  kind: 'parse_error' | 'invalid_context' | 'invalid_keystroke' | 'duplicate' | 'reserved';
  message: string;
}

/** A loaded binding set: the merged defaults+user bindings plus any warnings. */
export interface LoadedBindings {
  bindings: ParsedBinding[];
  warnings: KeybindingWarning[];
}
