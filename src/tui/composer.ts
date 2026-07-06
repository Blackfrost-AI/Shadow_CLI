// Pure composer-input helpers, split out of tui.tsx so they can be unit-tested without booting Ink.
import { existsSync } from 'node:fs';

/** True if a path exists on disk — lets us tell a real dir/file (/tmp, /etc/hosts) a user pasted or
 *  typed from a genuinely mistyped slash command. Never throws. */
export function pathExistsSafe(p: string): boolean {
  try {
    return existsSync(p);
  } catch {
    return false;
  }
}

/** A leading-'/' token that is a filesystem PATH (a nested '/' or a dot), not a command name — so a
 *  pasted/typed directory like /Users/craigmac/… or /etc/hosts is sent as a message, not rejected as
 *  an "unknown command". A bare /word (/tmp) is disambiguated by an on-disk check at the call site. */
export function isPathLikeSlashToken(token: string): boolean {
  return token.indexOf('/', 1) !== -1 || token.includes('.');
}

/** A pasted blob big enough to condense into a chip (3+ lines OR long) rather than dump it inline —
 *  the "clunky paste bar" fix. A short single-line paste (e.g. a path) stays inline. */
export function isBigPaste(s: string): boolean {
  return (s.match(/\n/g)?.length ?? 0) >= 2 || s.length > 300;
}

/** Replace `[Pasted text #N …]` chips with their stored content (the session paste registry), so the
 *  composer stays compact but the model receives the full pasted text on submit. Unmatched chips (a
 *  paste that was cleared) are left as-is. */
export function expandPastes(text: string, pastes: ReadonlyArray<{ id: number; content: string }>): string {
  if (!pastes.length || !text.includes('[Pasted text #')) return text;
  return text.replace(/\[Pasted text #(\d+)[^\]]*\]/g, (m, idStr: string) => {
    const p = pastes.find((x) => x.id === Number(idStr));
    return p ? p.content : m;
  });
}
