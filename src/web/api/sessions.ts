import { readJsonBody, type ApiContext, type RouteFn } from '../router.js';
import { resolveJail } from '../projects.js';

/**
 * Session management surface.
 *
 * ⚠ This ships as ONE piece with the WebDenyGate (built in C6): a chat route without a decided
 * approval gate is a hang. Q1 posture is auto-edit + WebDenyGate — reads and in-jail writes
 * auto-approve; run_shell/network deny immediately with a visible finding, never a silent wait.
 *
 * Routes key on the OPAQUE session id in the path, NEVER a percent-encoded absolute path — this is
 * a security boundary and a decode mismatch between a proxy and the server is the classic bug.
 * The chat route returns 202 immediately; progress and the guaranteed terminal frame stream on
 * that session's SSE (the registry emits a terminal error frame on a build/turn failure, and the
 * loop emits `stop` on success — either way the browser spinner stops).
 */
export function registerSessionsRoutes(route: RouteFn, ctx: ApiContext): void {
  route('GET', /^\/api\/sessions$/, () => ({
    status: 200,
    body: { sessions: ctx.registry.list() },
  }));

  // Create a browser session. 403 before it exists if the project is not currently allowlisted —
  // UX + storage hygiene; resolveJail at BUILD time (fresh re-read) is the real boundary.
  route('POST', /^\/api\/sessions$/, async (req) => {
    const body = (await readJsonBody(req)) as { projectRoot?: unknown; title?: unknown; model?: unknown } | null;
    if (!body || typeof body.projectRoot !== 'string') {
      return { status: 400, body: { error: 'projectRoot (string) is required' } };
    }
    try {
      resolveJail(body.projectRoot); // throws if the path is not a currently-allowlisted project
    } catch (e) {
      return { status: 403, body: { error: e instanceof Error ? e.message : String(e) } };
    }
    const session = ctx.registry.create({
      projectRoot: body.projectRoot,
      title: typeof body.title === 'string' ? body.title : undefined,
      model: typeof body.model === 'string' ? body.model : undefined,
    });
    // The sidebar refetches GET /api/sessions after each action, so returning the id is enough.
    return { status: 200, body: { id: session.id } };
  });

  // Send a prompt. 202 immediately; the turn builds + runs in the background, streaming on SSE.
  route('POST', /^\/api\/sessions\/([^/]+)\/chat$/, async (req, _res, m) => {
    const id = m[1]!;
    const body = (await readJsonBody(req)) as { prompt?: unknown } | null;
    if (!body || typeof body.prompt !== 'string' || !body.prompt.trim()) {
      return { status: 400, body: { error: 'prompt (non-empty string) is required' } };
    }
    const r = await ctx.registry.submit(id, body.prompt);
    if (r.ok) return { status: 202, body: { accepted: true } };
    return { status: r.code, body: { error: r.reason } };
  });

  // Interrupt an in-flight turn — always safe (it only ever reduces authority). Revocation-style:
  // never fails when the target is active; returns whether there was something to interrupt.
  route('POST', /^\/api\/sessions\/([^/]+)\/interrupt$/, (_req, _res, m) => {
    const id = m[1]!;
    return { status: 200, body: { interrupted: ctx.registry.interrupt(id) } };
  });
}
