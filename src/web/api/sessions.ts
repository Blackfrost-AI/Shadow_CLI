import { basename } from 'node:path';
import { readJsonBody, type ApiContext, type RouteFn } from '../router.js';
import { resolveJail } from '../projects.js';
import { AUTONOMY_LEVELS } from '../../safety/permissions.js';
import type { AutonomyLevel } from '../../safety/permissions.js';
import type { ApprovalDecision, UserAnswer } from '../../agent/approval.js';
import { SessionLog } from '../../state/session.js';
import { resumeSession, listResumableSessions } from '../../state/resume.js';
import { loadConfig } from '../../config.js';
import { readLatestWorkCenterSnapshot } from '../../state/workCenterPersistence.js';

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
  // Persisted CLI sessions a companion may attach to (newest first). Returns id/ts/title only —
  // never absolute paths — so the surface stays safe to expose to a remote companion later.
  route('GET', /^\/api\/resumable$/, (req) => {
    const url = new URL(req.url ?? '/', 'http://127.0.0.1');
    const projectRoot = url.searchParams.get('projectRoot');
    if (!projectRoot) return { status: 400, body: { error: 'projectRoot query parameter is required' } };
    let jail;
    try {
      jail = resolveJail(projectRoot);
    } catch (e) {
      return { status: 403, body: { error: e instanceof Error ? e.message : String(e) } };
    }
    const sessions = listResumableSessions(jail.workspaceRoot).map(({ id, ts, title }) => ({ id, ts, title }));
    return { status: 200, body: { sessions } };
  });

  route('GET', /^\/api\/sessions$/, () => ({
    status: 200,
    body: { sessions: ctx.registry.list() },
  }));

  // Create a browser session, or attach to a persisted CLI session when `resumeSessionId` is set.
  // 403 before it exists if the project is not currently allowlisted — UX + storage hygiene;
  // resolveJail at BUILD time (fresh re-read) is the real boundary.
  route('POST', /^\/api\/sessions$/, async (req) => {
    const body = (await readJsonBody(req)) as {
      projectRoot?: unknown;
      title?: unknown;
      model?: unknown;
      resumeSessionId?: unknown;
    } | null;
    if (!body || typeof body.projectRoot !== 'string') {
      return { status: 400, body: { error: 'projectRoot (string) is required' } };
    }
    let jail;
    try {
      jail = resolveJail(body.projectRoot); // throws if the path is not a currently-allowlisted project
    } catch (e) {
      return { status: 403, body: { error: e instanceof Error ? e.message : String(e) } };
    }
    const title = typeof body.title === 'string' ? body.title : undefined;
    const model = typeof body.model === 'string' ? body.model : undefined;

    // Companion resume: the SAME persisted-session attach the ACP editor uses (acp/server.ts
    // session/load). The owning CLI process remains the sole writer of the workspace JSONL; this
    // only hydrates a live registry session from it. resumeSession() authenticates the owner-only
    // harness binding and FAILS CLOSED if it is missing or mismatched — never a silent bypass.
    if (typeof body.resumeSessionId === 'string' && body.resumeSessionId.trim()) {
      const wanted = body.resumeSessionId.trim();
      const path = SessionLog.list(jail.workspaceRoot).find((candidate) => {
        const id = SessionLog.sessionIdFromPath(candidate);
        return id === wanted || id.endsWith(wanted) || candidate === wanted;
      });
      if (!path) return { status: 404, body: { error: `unknown persisted session: ${wanted}` } };
      const storedId = SessionLog.sessionIdFromPath(path);
      // Sole-writer guard: the workspace JSONL must have exactly one live writer. If a live session
      // already owns this log, attaching a second would corrupt snapshot baseOffsets — refuse.
      let owned = false;
      ctx.registry.each((s) => {
        if (s.status === 'closed') return;
        if (s.resumeSessionPath === path || s.agent?.sessionLog.path === path) owned = true;
      });
      if (owned) return { status: 409, body: { error: 'session log is already owned by a live session' } };
      const cfg = loadConfig(jail.workspaceRoot);
      let hydrated;
      try {
        hydrated = resumeSession(path, {
          contextBudget: cfg.contextBudget,
          triggerRatio: cfg.summarizeTriggerRatio,
          keepLastTurns: cfg.keepLastTurns,
        });
      } catch (e) {
        return { status: 403, body: { error: e instanceof Error ? e.message : String(e) } };
      }
      let session;
      try {
        session = ctx.registry.create({
          id: storedId,
          projectRoot: jail.workspaceRoot,
          title: title ?? hydrated.meta.title ?? basename(jail.workspaceRoot),
          model,
          resumeSessionPath: path,
        });
      } catch (e) {
        // A live session already owns this id (e.g. resumed twice) — the companion should open it.
        return { status: 409, body: { error: e instanceof Error ? e.message : String(e) } };
      }
      session.workCenter.restore(readLatestWorkCenterSnapshot(path));
      // Replay history for display BEFORE the lazy build wires bus→recordEvent, so the transcript
      // shows the prior conversation without re-recording it into the sole-writer log.
      for (const message of hydrated.context.messages()) {
        const text = message.content.filter((block) => block.type === 'text').map((block) => block.text).join('\n');
        if (!text) continue;
        session.bus.emit(message.role === 'user' ? { type: 'user', text } : { type: 'assistant_done', text });
      }
      return { status: 200, body: { id: session.id, resumed: true } };
    }

    const session = ctx.registry.create({ projectRoot: body.projectRoot, title, model });
    // The sidebar refetches GET /api/sessions after each action, so returning the id is enough.
    return { status: 200, body: { id: session.id } };
  });

  // Send a prompt. 202 immediately; the turn builds + runs in the background, streaming on SSE.
  route('POST', /^\/api\/sessions\/([^/]+)\/chat$/, async (req, _res, m) => {
    const id = m[1]!;
    const body = (await readJsonBody(req)) as { prompt?: unknown; mission?: unknown } | null;
    if (!body || typeof body.prompt !== 'string' || !body.prompt.trim()) {
      return { status: 400, body: { error: 'prompt (non-empty string) is required' } };
    }
    const mission = typeof body.mission === 'string' ? body.mission.trim() : '';
    if (mission.length > 2000) {
      return { status: 400, body: { error: 'mission must be at most 2000 characters' } };
    }
    const r = await ctx.registry.submit(id, body.prompt, mission ? { mission } : undefined);
    if (r.ok) return { status: 202, body: { accepted: true } };
    return { status: r.code, body: { error: r.reason } };
  });

  // Compact the session's context without a task turn. 202 accepted; 409 while busy; 503 when
  // the host was built without a compaction runner (older composition roots).
  route('POST', /^\/api\/sessions\/([^/]+)\/compact$/, async (_req, _res, m) => {
    const r = await ctx.registry.compact(m[1]!);
    if (r.ok) return { status: 202, body: { accepted: true } };
    return { status: r.code, body: { error: r.reason } };
  });

  // Interrupt an in-flight turn — always safe (it only ever reduces authority). Revocation-style:
  // never fails when the target is active; returns whether there was something to interrupt.
  route('POST', /^\/api\/sessions\/([^/]+)\/interrupt$/, (_req, _res, m) => {
    const id = m[1]!;
    return { status: 200, body: { interrupted: ctx.registry.interrupt(id) } };
  });

  route('GET', /^\/api\/sessions\/([^/]+)\/work$/, (_req, _res, m) => {
    const session = ctx.registry.get(m[1]!);
    if (!session) return { status: 404, body: { error: 'unknown session' } };
    return { status: 200, body: { items: session.workCenter.list(), capturedAt: Date.now() } };
  });

  route('GET', /^\/api\/sessions\/([^/]+)\/work\/([^/]+)$/, (_req, _res, m) => {
    const session = ctx.registry.get(m[1]!);
    if (!session) return { status: 404, body: { error: 'unknown session' } };
    const item = session.workCenter.get(m[2]!);
    return item ? { status: 200, body: { item } } : { status: 404, body: { error: 'unknown work item' } };
  });

  route('POST', /^\/api\/sessions\/([^/]+)\/work\/([^/]+)\/(cancel|kill|pause|resume)$/, (_req, _res, m) => {
    const session = ctx.registry.get(m[1]!);
    if (!session) return { status: 404, body: { error: 'unknown session' } };
    const item = session.workCenter.get(m[2]!);
    if (!item) return { status: 404, body: { error: 'unknown work item' } };
    const action = m[3]!;
    if (action === 'kill') {
      if (item.type !== 'bgshell' || item.status !== 'running') return { status: 409, body: { error: 'item is not a running background shell' } };
      return session.agent?.bg.kill(item.id)
        ? { status: 200, body: { accepted: true } }
        : { status: 409, body: { error: 'shell is unavailable' } };
    }
    if (item.type !== 'subagent' || !item.background) return { status: 409, body: { error: 'item is not a controllable background subagent' } };
    if (action === 'cancel' && !['queued', 'running', 'paused'].includes(item.status)) return { status: 409, body: { error: `cannot cancel ${item.status} subagent` } };
    if (action === 'pause' && !['queued', 'running'].includes(item.status)) return { status: 409, body: { error: `cannot pause ${item.status} subagent` } };
    if (action === 'resume' && item.status !== 'paused' && item.currentActivity !== 'pause requested') return { status: 409, body: { error: 'subagent is not paused' } };
    if (action === 'cancel') session.bus.emit({ type: 'cancel_subagent', taskId: item.id });
    if (action === 'pause') session.bus.emit({ type: 'pause_subagent', taskId: item.id });
    if (action === 'resume') session.bus.emit({ type: 'resume_subagent', taskId: item.id });
    return { status: 200, body: { accepted: true } };
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
