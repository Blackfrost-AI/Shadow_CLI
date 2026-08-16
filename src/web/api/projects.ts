import { readJsonBody, type ApiContext, type RouteFn } from '../router.js';
import { listProjects, addProject, removeProject, normalizeProjectPath } from '../projects.js';
import { contains } from '../../safety/workspaceJail.js';

/**
 * The project allowlist surface. Routes key on the opaque entry `id` (in the body for remove),
 * NEVER a percent-encoded absolute path in the URL — a decoding mismatch on a security boundary
 * is a bug generator. Revocation ALWAYS succeeds; a removal must never 409, or it would fail
 * exactly when the offending session is the one that is active.
 */
export function registerProjectsRoutes(route: RouteFn, ctx: ApiContext): void {
  route('GET', /^\/api\/projects$/, () => ({ status: 200, body: { projects: listProjects() } }));

  route('POST', /^\/api\/projects$/, async (req) => {
    const body = (await readJsonBody(req)) as { path?: unknown; label?: unknown } | null;
    if (!body || typeof body.path !== 'string') {
      return { status: 400, body: { error: 'path (string) is required' } };
    }
    try {
      const project = addProject(body.path, typeof body.label === 'string' ? body.label : undefined);
      return { status: 200, body: { project } };
    } catch (e) {
      // A deny-gauntlet refusal is 403 (forbidden), not 400 — the request is well-formed, the
      // path is simply not allowlistable.
      return { status: 403, body: { error: e instanceof Error ? e.message : String(e) } };
    }
  });

  route('POST', /^\/api\/projects\/remove$/, async (req) => {
    const body = (await readJsonBody(req)) as { id?: unknown } | null;
    if (!body || typeof body.id !== 'string') {
      return { status: 400, body: { error: 'id (string) is required' } };
    }
    // E1 — revocation must CASCADE. Removing the entry alone edited config.json and returned 200
    // while every already-open session kept its frozen jail and carried on reading and writing
    // the directory at auto-edit. Look the entry up BEFORE deleting (removeProject returns only a
    // boolean), then close every externally-driven session (web AND acp) rooted at or under it.
    const entry = listProjects().find((e) => e.id === body.id);
    const removed = removeProject(body.id);
    let closed = 0;
    if (removed && entry) {
      let root: string | null = null;
      try {
        root = normalizeProjectPath(entry.path);
      } catch {
        root = null; // an unresolvable path can't contain anything — nothing to cascade to
      }
      if (root) {
        // Collect ids first: each() walks the live map, and remove() mutates it.
        const doomed: string[] = [];
        ctx.registry.each((s) => {
          // Enumerate the RESERVED origins (never the CLI mirror/local session, which may
          // legitimately sit inside a removed project) — so any FUTURE externally-driven origin
          // is closed by default instead of silently skipped.
          if (s.origin === 'mirror' || s.origin === 'local') return;
          try {
            if (contains(root!, normalizeProjectPath(s.displayPath))) doomed.push(s.id);
          } catch {
            /* unresolvable session path — leave it alone */
          }
        });
        for (const id of doomed) if (await ctx.registry.remove(id)) closed++;
      }
    }
    return { status: 200, body: { removed, sessionsClosed: closed } };
  });
}
