import { realpathSync, existsSync } from 'node:fs';
import { resolve, join, parse, sep, dirname, isAbsolute, relative } from 'node:path';

/**
 * The filesystem jail. Every path a tool touches is run through `resolveWithin`,
 * which guarantees the result sits inside one of the allowed roots — even across
 * `..` segments and symlinks, and even for files that do not exist yet (so a
 * writeFile to a brand-new path cannot escape).
 *
 * The first root is the workspace (relative paths resolve against it); any extra
 * roots come from `additionalDirectories` / `--add-dir`, so a user can deliberately
 * grant read/write outside the workspace without disabling the jail. Resolution walks
 * the path component by component, realpath-ing as it goes (`resolvePhysical`), so a
 * symlink that points out is caught — including when it is followed by `..`.
 */

/** Is `target` equal to, or nested inside, `root`? (compares post-realpath paths) */
export function contains(root: string, target: string): boolean {
  if (target === root) return true;
  const rel = relative(root, target);
  return rel.length > 0 && !rel.startsWith('..') && !isAbsolute(rel);
}

/**
 * Resolve `requested` against `base` the way the OS does — following symlinks AND resolving `..`
 * against the PHYSICAL parent — instead of `path.resolve`, which collapses `a/..` lexically.
 *
 * POSIX resolves `link/..` by following `link` FIRST, so those two disagree exactly when a
 * component is a symlink. That made `<ws>/linkout/../outside/secret.txt` read as
 * `<ws>/outside/secret.txt` (inside) while the shell opened `/elsewhere/outside/secret.txt`.
 * A symlink can ship inside a cloned repo, so the escape needed no cooperation from the model —
 * and it also defeated the session/prefix-grant demotion, which shares this resolver.
 *
 * Components below the deepest path that exists cannot be symlinks (nothing there exists to link
 * from), so they are kept literal and appended — which is what `resolve` already did for the
 * not-yet-created tail this function replaces.
 */
function resolvePhysical(base: string, requested: string): string {
  const from = isAbsolute(requested) ? requested : `${base}${sep}${requested}`;
  const root = parse(from).root;
  const parts = from.slice(root.length).split(sep === '\\' ? /[\\/]/ : sep);
  let current = root;
  const pending: string[] = [];
  for (const part of parts) {
    if (part === '' || part === '.') continue;
    if (part === '..') {
      // `..` is the parent of where we PHYSICALLY are, not of the lexical spelling.
      if (pending.length > 0) pending.pop();
      else if (current !== root) current = dirname(current);
      continue;
    }
    if (pending.length > 0) {
      pending.push(part);
      continue;
    }
    try {
      current = realpathSync(join(current, part));
    } catch {
      pending.push(part); // does not exist (or is unreadable) — nothing below can be a symlink
    }
  }
  return pending.length > 0 ? join(current, ...pending) : current;
}

/**
 * Resolve `requested` to an absolute path guaranteed to live inside
 * `workspaceRoot`, or throw an Error describing the escape.
 *
 * Symlink-aware: we walk up to the deepest path that actually exists, resolve
 * it through `realpath` (collapsing any symlinks), then re-append the
 * not-yet-existing tail. This means a symlink inside the workspace that points
 * outside it is caught, AND a path to a file that will be created is validated
 * against where it would *actually* land on disk.
 *
 * @param roots     one root, or a list — the workspace first, then any additional
 *                  granted dirs. Relative paths resolve against the first root.
 * @param requested path from the model; relative paths resolve against the workspace.
 * @returns the absolute, symlink-collapsed path inside one of the roots.
 * @throws  Error if the path is empty, or resolves outside every root.
 */
export function resolveWithin(roots: string | string[], requested: string): string {
  if (typeof requested !== 'string' || requested.trim() === '') {
    throw new Error('path must be a non-empty string');
  }
  const list = (Array.isArray(roots) ? roots : [roots]).filter((r) => typeof r === 'string' && r.length > 0);
  if (list.length === 0) throw new Error('no workspace root configured');

  // Realpath each root so containment checks are honest even when a root is
  // reached through a symlink (e.g. macOS /tmp → /private/tmp). We keep the
  // ORIGINAL spelling alongside (`list`) so the returned path matches how the
  // caller named the workspace instead of being silently rewritten through a
  // root-level symlink (e.g. /var → /private/var).
  const reals = list.map((r) => (existsSync(r) ? realpathSync(r) : resolve(r)));
  const primaryReal = reals[0]!;

  // Physically, not lexically: `resolve()` would collapse `link/..` before the symlink is
  // followed, which is the opposite of what the OS does (see resolvePhysical).
  const real = resolvePhysical(primaryReal, requested);

  // Containment is decided against the canonical (realpath) roots so a symlink
  // that escapes is still caught. The return value, however, is re-anchored
  // onto the matched root's ORIGINAL spelling: only the inner segments that
  // the symlink walk actually rewrote are kept canonical.
  const idx = reals.findIndex((r) => contains(r, real));
  if (idx === -1) {
    const extra = reals.length > 1 ? `, nor any granted dir (${reals.slice(1).join(', ')})` : '';
    throw new Error(
      `path "${requested}" resolves outside the workspace ` +
        `(would land at ${real}, not under ${primaryReal}${extra}). ` +
        `Grant it with --add-dir <dir> or the "additionalDirectories" config.`,
    );
  }
  const within = relative(reals[idx]!, real);
  return within === '' ? resolve(list[idx]!) : resolve(list[idx]!, within);
}
