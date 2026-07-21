import { readJsonBody, type ApiContext, type RouteFn } from '../router.js';
import { listProjects, addProject, removeProject } from '../projects.js';

/**
 * The project allowlist surface. Routes key on the opaque entry `id` (in the body for remove),
 * NEVER a percent-encoded absolute path in the URL — a decoding mismatch on a security boundary
 * is a bug generator. Revocation ALWAYS succeeds; a removal must never 409, or it would fail
 * exactly when the offending session is the one that is active.
 */
export function registerProjectsRoutes(route: RouteFn, _ctx: ApiContext): void {
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
    return { status: 200, body: { removed: removeProject(body.id) } };
  });
}
