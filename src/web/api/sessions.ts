import { readJsonBody, type ApiContext, type RouteFn } from '../router.js';
import { resolveJail } from '../projects.js';
import { AUTONOMY_LEVELS } from '../../safety/permissions.js';
import type { AutonomyLevel } from '../../safety/permissions.js';
import type { ApprovalDecision, UserAnswer } from '../../agent/approval.js';

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

  // E2 — close a session: aborts any in-flight turn, stops its MCP stdio children and frees the
  // replay ring. registry.remove() existed but had ZERO production callers, so every
  // "+ new session" was permanent: contexts, child processes and 2 MB rings accumulated for the
  // life of the server with no way to shed one. Revocation-style, like interrupt: 200 with
  // removed:false for an unknown id or the reserved mirror. The pattern is single-segment so it
  // cannot also match /api/sessions/<id>/chat.
  route('DELETE', /^\/api\/sessions\/([^/]+)$/, async (_req, _res, m) => ({
    status: 200,
    body: { removed: await ctx.registry.remove(m[1]!) },
  }));

  // --- the browser's approval decision channel -----------------------------------------------
  //
  // The ask itself arrives as an `approval_request` LoopEvent on the session's SSE (and is parked
  // on the session by the WebApprovalGate); this route is the answer half. Body:
  //   { decision: 'approve' | 'deny' | 'session' }            — permission asks
  //   { decision: { answers: [{ question, selected: [] }] } } — user_question asks
  // 'session' maps to approveForSession (the session's SessionApprovals holds the grant).
  // 409 not-pending on a late/duplicate/unknown id — never an error that hides the real state.
  route('POST', /^\/api\/sessions\/([^/]+)\/approvals\/([^/]+)$/, async (req, _res, m) => {
    const body = (await readJsonBody(req)) as { decision?: unknown } | null;
    const decision = parseApprovalDecision(body?.decision);
    if (!decision) {
      return { status: 400, body: { error: "decision must be 'approve' | 'deny' | 'session' | { answers }" } };
    }
    const accepted = ctx.registry.decide(m[1]!, m[2]!, decision);
    return accepted
      ? { status: 200, body: { accepted: true } }
      : { status: 409, body: { accepted: false, reason: 'not-pending' } };
  });

  // Access pill: change this session's autonomy for LATER turns (the running turn keeps its own
  // level — autonomy is read once per loop run). Widening here only changes what the NEXT
  // approval gate consults; the jail, denylist and deny-gauntlet are unaffected.
  route('POST', /^\/api\/sessions\/([^/]+)\/autonomy$/, async (req, _res, m) => {
    const body = (await readJsonBody(req)) as { level?: unknown } | null;
    if (typeof body?.level !== 'string' || !AUTONOMY_LEVELS.includes(body.level as AutonomyLevel)) {
      return { status: 400, body: { error: `level must be one of ${AUTONOMY_LEVELS.join(' | ')}` } };
    }
    const ok = ctx.registry.setAutonomy(m[1]!, body.level as AutonomyLevel);
    return ok ? { status: 200, body: { level: body.level } } : { status: 409, body: { error: 'session autonomy is read-only' } };
  });
}

/** Validate the decision payload off the wire — never trust the shape straight to the gate. */
function parseApprovalDecision(raw: unknown): ApprovalDecision | null {
  if (raw === 'approve' || raw === 'deny' || raw === 'session') {
    return raw === 'session' ? { approveForSession: true } : raw;
  }
  if (raw && typeof raw === 'object' && Array.isArray((raw as { answers?: unknown }).answers)) {
    const answers: UserAnswer[] = [];
    for (const a of (raw as { answers: unknown[] }).answers) {
      if (
        a &&
        typeof a === 'object' &&
        typeof (a as { question?: unknown }).question === 'string' &&
        Array.isArray((a as { selected?: unknown }).selected) &&
        (a as { selected: unknown[] }).selected.every((s) => typeof s === 'string')
      ) {
        answers.push({
          question: (a as { question: string }).question,
          selected: (a as { selected: string[] }).selected,
        });
      }
    }
    if (answers.length) return { answers };
  }
  return null;
}
