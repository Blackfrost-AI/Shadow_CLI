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
    up: 'confirm:previous',
    down: 'confirm:next',
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
  MessageActions: {
    c: 'message:copy',
    p: 'message:copyInput',
    enter: 'message:expand',
    up: 'message:previous',
    down: 'message:next',
    k: 'message:previous',
    j: 'message:next',
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
