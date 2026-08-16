/**
 * Default keybindings — mirrors Shadow’s existing key behavior so that migrating
 * the imperative `onKey` chain onto the resolver is behavior-preserving. A user
 * `~/.shadow/keybindings.json` is merged ON TOP of these (last write wins per
 * context+chord), so every default here is user-overridable except the hardcoded
 * ones in reserved.ts (ctrl+c / ctrl+d / ctrl+m).
 *
 * Only discrete ACTIONS live here. Character-level composer editing (caret move,
 * backspace, typing) and modal vim are intentionally NOT keybindings — they are
 * continuous text manipulation, not discrete actions, and stay in the composer.
 */
import { parseChord } from './parser.js';
import type { ContextName, KeybindingWarning, ParsedBinding } from './types.js';

/** Compact, readable source: context → { keystroke string → action id }. */
const RAW_DEFAULTS: Record<ContextName, Record<string, string>> = {
  // Global stays EMPTY on purpose. `app:redraw` has a registered handler (so the documented
  // user-config example works) but is deliberately NOT a default: it re-flushes the entire
  // transcript on every press, which is O(transcript) — a perf footgun nobody should get by
  // accident. Opt in explicitly with {"ctrl+l": "app:redraw"} if you want it.
  Global: {},
  Chat: {
    enter: 'chat:submit',
    'shift+tab': 'chat:cycleMode',
    up: 'chat:historyPrevious',
    down: 'chat:historyNext',
    escape: 'chat:cancel',
    // Paste from the SYSTEM clipboard (pbpaste / wl-paste / xclip). Terminal-native paste
    // still works; this is the explicit in-app path (and the only one on odd terminals).
    'ctrl+v': 'chat:pasteClipboard',
  },
  Autocomplete: {
    tab: 'menu:accept',
    up: 'menu:previous',
    down: 'menu:next',
    enter: 'menu:run',
    escape: 'menu:dismiss',
  },
  Confirmation: {
    y: 'confirm:yes',
    n: 'confirm:no',
    a: 'confirm:always',
    s: 'confirm:session',
    f: 'confirm:prefix',
    enter: 'confirm:yes',
    escape: 'confirm:no',
  },
  ModelPicker: {
    up: 'picker:previous',
    down: 'picker:next',
    enter: 'picker:accept',
    escape: 'picker:dismiss',
  },
  QuestionDialog: {
    escape: 'question:skip',
    enter: 'question:confirm',
    left: 'question:prev',
    right: 'question:next',
  },
  Transcript: {
    'ctrl+o': 'transcript:toggleFoldLatest', // all folds (name is historical; behavior = all)
    // NOT ctrl+shift+o: terminals send the same byte (0x0F) for Ctrl+O and Ctrl+Shift+O, so Ink
    // reports both as ctrl+o (shift=false) and the shift binding can never match — it would just
    // fire toggle-all. Alt/Option+O is a distinct sequence that actually reaches this action.
    'meta+o': 'transcript:toggleFoldOne', // latest collapsible only (Alt/Option+O)
    'ctrl+t': 'transcript:toggleTaskList',
    // Alt/Option+C — copy the last assistant answer (same as /copy). NOT ctrl+c (reserved:
    // interrupt/quit) and NOT ctrl+shift+c (indistinguishable from ctrl+c in most terminals).
    'meta+c': 'transcript:copyLastAnswer',
  },
};

/**
 * Parse RAW_DEFAULTS into the comparable binding list. Hardcoded defaults should
 * always parse cleanly; any defect is collected as a warning rather than thrown.
 */
export function buildDefaultBindings(): { bindings: ParsedBinding[]; warnings: KeybindingWarning[] } {
  const bindings: ParsedBinding[] = [];
  const warnings: KeybindingWarning[] = [];
  for (const [ctx, map] of Object.entries(RAW_DEFAULTS) as [ContextName, Record<string, string>][]) {
    for (const [stroke, action] of Object.entries(map)) {
      const chord = parseChord(stroke);
      if (!chord) {
        warnings.push({ kind: 'invalid_keystroke', message: `default ${ctx} ${stroke} did not parse` });
        continue;
      }
      bindings.push({ context: ctx, chord, action });
    }
  }
  return { bindings, warnings };
}

/** All action ids the engine knows about (for the /keybindings listing). */
export const KEYBINDING_ACTIONS: readonly string[] = Object.values(RAW_DEFAULTS).flatMap((m) => Object.values(m));

/**
 * Action ids registered in the TUI (via kbRegister) that are deliberately NOT defaults — see the
 * Global comment above. The loader needs the FULL known-id set to warn on typo'd actions instead
 * of accepting them silently; the keybinding-liveness test pins this list to the actual
 * kbRegister sites so it cannot drift from the truth.
 */
export const REGISTERED_NON_DEFAULT_ACTIONS: readonly string[] = ['app:redraw'];

/** Every action id the loader accepts without an unknown-action warning. */
export const KNOWN_ACTION_IDS: ReadonlySet<string> = new Set([...KEYBINDING_ACTIONS, ...REGISTERED_NON_DEFAULT_ACTIONS]);

/**
 * Action ids still dispatched by KEY in the legacy inline handler rather than through the
 * resolver (B6).
 *
 * `consume()` deliberately returns false for a matched-but-unregistered action so the inline
 * chain keeps working — that is what made incremental migration safe. The cost is that these ids
 * are LISTED and REBINDABLE while a rebind cannot take effect: the inline branch keys on
 * `key.return` / `key.upArrow` / … , not on the action. Before this list, that failed silently —
 * the config parsed, warned about nothing, and simply did not work.
 *
 * The loader warns when a USER config rebinds one of these. Remove an entry the moment its
 * handler is registered via `kbRegister`.
 */
export const UNMIGRATED_ACTIONS: ReadonlySet<string> = new Set([
  'chat:submit',
  'chat:cycleMode',
  'chat:historyPrevious',
  'chat:historyNext',
  'chat:cancel',
  'menu:accept',
  'menu:previous',
  'menu:next',
  'menu:run',
  'menu:dismiss',
  'picker:previous',
  'picker:next',
  'picker:accept',
  'picker:dismiss',
]);
