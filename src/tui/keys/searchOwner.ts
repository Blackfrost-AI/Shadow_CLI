/**
 * P3-01 — focus-owner router: the reverse-history SEARCH owner (old onKey §2.9).
 *
 * While open it OWNS typing, backspace, Enter and Esc. The Ctrl-R chord that OPENS it is the
 * owner's WAKE: it resolves at this slot's precedence — ABOVE vim — exactly as the old
 * §2.9-before-§2.92 ordering required (a focus owner has to be consulted before a MODE that
 * merely reinterprets keys; vim's block claims `key.escape`, so if vim ran first Esc could
 * never close an open search and every later keystroke was eaten as a NORMAL-mode motion).
 */
import { hasSgrMouse, searchHistoryBack } from '../composer.js';
import type { FocusOwnerHandler, InkKey, KeyEnv } from './types.js';

function handleSearch(env: KeyEnv, ch: string, key: InkKey): boolean {
  const st = env.searchRef.current;
  if (st) {
    if (key.escape) {
      const saved = st.saved;
      env.applySearch(null);
      env.setLine(saved); // Esc restores exactly what was there before the search opened
      // P1A-15: if a turn is running under an open search, one Esc closes the search AND
      // interrupts — otherwise the user's reflexive "Esc to stop" was eaten by the search
      // owner and the turn kept going with no visible reason.
      if (env.runningRef.current) {
        env.controllerRef.current?.abort();
        env.loopRef.current?.requestSteer();
      }
      return true;
    }
    if (key.return) {
      env.applySearch(null); // accept the hit that is already in the composer
      return true;
    }
    if (key.ctrl && ch === 'r') {
      const next = searchHistoryBack(env.historyRef.current, st.query, st.index - 1);
      env.applySearch({ ...st, index: next >= 0 ? next : st.index }); // stick at the oldest hit
      return true;
    }
    if (key.backspace || key.delete) {
      const query = st.query.slice(0, -1);
      env.applySearch({ ...st, query, index: searchHistoryBack(env.historyRef.current, query, env.historyRef.current.length - 1) });
      return true;
    }
    if (!key.ctrl && !key.meta && ch && !hasSgrMouse(ch)) {
      const query = st.query + ch;
      env.applySearch({ ...st, query, index: searchHistoryBack(env.historyRef.current, query, env.historyRef.current.length - 1) });
      return true;
    }
    return true; // swallow everything else while the search owns the line
  }
  // WAKE chord (search not open). P1A-15: do NOT open reverse-search while a turn is running —
  // an open search OWNS Esc and Enter, so opening it mid-turn captured the very keys the user
  // needs to interrupt or steer.
  if (key.ctrl && ch === 'r' && env.historyRef.current.length > 0 && !env.runningRef.current) {
    env.applySearch({ query: '', index: -1, saved: env.inputRef.current });
    return true;
  }
  return false; // search closed and not the wake chord — let the next owner try
}

export const searchOwner: FocusOwnerHandler = {
  id: 'search',
  active: (env, ch, key) =>
    env.searchRef.current !== null ||
    (key.ctrl && ch === 'r' && env.historyRef.current.length > 0 && !env.runningRef.current),
  handle: handleSearch,
};
