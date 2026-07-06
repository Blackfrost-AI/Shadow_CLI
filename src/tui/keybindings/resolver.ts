/**
 * Keybinding resolver — the chord state machine. Given the current keystroke, the
 * ordered set of active contexts (most-specific first, Global last), the merged
 * binding list, and any pending chord, decide what to do.
 *
 * Resolution rule (matches the reference impl): a longer chord always shadows a
 * single-key prefix. So if `ctrl+x` could start `ctrl+x ctrl+k`, pressing `ctrl+x`
 * enters a chord-wait rather than firing a single-key `ctrl+x` binding — unless the
 * only longer chord is explicitly null-unbound.
 *
 * Within one context, the LAST binding for a given chord wins (so user overrides,
 * appended after defaults, take precedence). The first context (in priority order)
 * with an exact match wins over lower-priority contexts.
 *
 * Pure: no React, no I/O, no side effects.
 */
import { chordEquals, chordStartsWith, eventToKeystroke } from './match.js';
import type {
  Chord,
  ContextName,
  KeyEvent,
  ParsedBinding,
  ParsedKeystroke,
  ResolveResult,
} from './types.js';

const NONE: ResolveResult = { type: 'none' };

/**
 * Core resolver operating on an already-parsed keystroke. Exposed for tests that
 * don't want to build a full {@link KeyEvent}.
 */
export function resolveKeystroke(
  ks: ParsedKeystroke,
  contexts: readonly ContextName[],
  bindings: readonly ParsedBinding[],
  pending: Chord,
): ResolveResult {
  // An unmatchable event (e.g. multi-char paste with no special flag) can't extend
  // or complete a chord; if we were mid-chord, cancel it.
  if (ks.key === '') {
    return pending.length ? { type: 'chord_cancelled' } : NONE;
  }

  const testChord: Chord = [...pending, ks];

  // Walk contexts in PRIORITY order. The first context that has any stake in
  // testChord — an exact match OR a longer non-null chord prefix — is the "top
  // context" and decides ALONE. This is what makes a higher-priority exact
  // binding win over a lower-priority chord prefix (Chat's `up` beats Global's
  // `up up`): the prefix in the lower context is never consulted once a higher
  // context claimed the keystroke.
  for (const ctx of contexts) {
    let winner: ParsedBinding | undefined; // last exact match in this context (user override wins)
    let hasPrefix = false;
    for (const b of bindings) {
      if (b.context !== ctx) continue;
      if (chordEquals(b.chord, testChord)) {
        winner = b;
      } else if (
        b.chord.length > testChord.length &&
        chordStartsWith(b.chord, testChord) &&
        b.action !== null
      ) {
        hasPrefix = true;
      }
    }
    if (winner || hasPrefix) {
      // Within the winning context, a longer chord shadows a single-key prefix
      // (the same-context rule). An exact match with action null consumes the key
      // without dispatching (explicit disable / unbind).
      if (hasPrefix) return { type: 'chord_started', pending: testChord };
      return winner!.action === null
        ? NONE
        : { type: 'match', action: winner!.action, context: ctx };
    }
  }

  // No context claimed the keystroke: if we were mid-chord, the chord dies.
  return pending.length ? { type: 'chord_cancelled' } : NONE;
}

/** Resolve an Ink key event (convenience: parses the keystroke first). */
export function resolveAction(
  ev: KeyEvent,
  contexts: readonly ContextName[],
  bindings: readonly ParsedBinding[],
  pending: Chord,
): ResolveResult {
  return resolveKeystroke(eventToKeystroke(ev), contexts, bindings, pending);
}
