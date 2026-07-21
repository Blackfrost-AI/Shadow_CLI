import type { IncomingMessage, ServerResponse } from 'node:http';
import { readJsonBody, type ApiContext, type RouteFn } from '../router.js';
import {
  loadAgentDefs,
  saveAgentDef,
  deleteAgentDef,
  isValidAgentName,
  type AgentDef,
} from '../../agent/defs.js';

/**
 * Phase C: sub-agent preset management. The read side reuses `loadAgentDefs` (which merges
 * built-ins + ~/.shadow/agents + workspace/.shadow/agents); the write side uses the new
 * `saveAgentDef` / `deleteAgentDef` in defs.ts, which write to ~/.shadow/agents/<name>.md.
 *
 * Built-ins (explore, reviewer) are listed with builtin:true and cannot be modified or deleted.
 */

/**
 * Serialize a def for the API. `systemPrompt` is included deliberately: the editor does a full
 * replace (PUT), so a client that cannot read the current prompt cannot preserve it. Omitting
 * it meant the edit form bound `undefined` into its textarea and saved the literal string
 * "undefined" over the real prompt — changing an agent's description silently destroyed it.
 *
 * It is not a secret: these defs are plain markdown in ~/.shadow/agents, already fully readable
 * by anyone holding the session token.
 */
function mask(def: AgentDef): Record<string, unknown> {
  return {
    name: def.name,
    description: def.description,
    tools: def.tools,
    systemPrompt: def.systemPrompt,
    model: def.model ?? null,
    maxIterations: def.maxIterations ?? null,
    builtin: def.builtin === true,
  };
}

export function registerAgentsRoutes(route: RouteFn, ctx: ApiContext): void {
  // ── GET /api/agents ────────────────────────────────────────────────────────

  route('GET', /^\/api\/agents$/, async () => {
    // loadAgentDefs merges both dirs + built-ins; the UI shows the resolved view a sub-agent
    // invocation actually sees.
    const defs = loadAgentDefs(ctx.workspaceRoot);
    return { status: 200, body: { agents: defs.map(mask) } };
  });

  // ── POST /api/agents ───────────────────────────────────────────────────────
  // Body: { name, description, tools[], model?, maxIterations?, systemPrompt }

  route('POST', /^\/api\/agents$/, async (req: IncomingMessage) => {
    const body = (await readJsonBody(req)) as Record<string, unknown> | null;
    if (!body || typeof body !== 'object') return { status: 400, body: { error: 'invalid body' } };
    const name = String(body.name ?? '').trim();
    const description = String(body.description ?? '').trim();
    const systemPrompt = String(body.systemPrompt ?? '').trim();
    const tools = Array.isArray(body.tools) ? body.tools.map(String) : [];
    if (!isValidAgentName(name)) {
      return { status: 400, body: { error: 'name must be lowercase, start with a letter/digit, max 64 chars (a-z0-9._-)' } };
    }
    if (!description) return { status: 400, body: { error: 'description is required' } };
    if (!systemPrompt) return { status: 400, body: { error: 'systemPrompt is required' } };
    if (tools.length === 0) return { status: 400, body: { error: 'at least one tool is required' } };

    const def: AgentDef = {
      name,
      description,
      tools,
      systemPrompt,
      ...(typeof body.model === 'string' && body.model ? { model: body.model } : {}),
      ...(typeof body.maxIterations === 'number' && Number.isFinite(body.maxIterations)
        ? { maxIterations: body.maxIterations }
        : {}),
    };
    try {
      saveAgentDef(def);
    } catch (e) {
      // Builtin-name collision → 409; validation → 400.
      const msg = e instanceof Error ? e.message : String(e);
      const status = /built-in/i.test(msg) ? 409 : 400;
      return { status, body: { error: msg } };
    }
    return { status: 201, body: { agent: mask(def) } };
  });

  // ── PUT /api/agents/:name ──────────────────────────────────────────────────
  // Full replace of an existing agent (same validation as POST).

  route('PUT', /^\/api\/agents\/(.+)$/, async (req: IncomingMessage, _res: ServerResponse, match: RegExpMatchArray) => {
    const name = decodeURIComponent(match[1] ?? '');
    const body = (await readJsonBody(req)) as Record<string, unknown> | null;
    if (!body) return { status: 400, body: { error: 'invalid body' } };

    // PUT is a full replace, so it needs POST's validation — without this a body that omits
    // systemPrompt (or sends an empty one) overwrote the stored prompt with "".
    const description = String(body.description ?? '').trim();
    const systemPrompt = String(body.systemPrompt ?? '').trim();
    const tools = Array.isArray(body.tools) ? body.tools.map(String) : [];
    if (!description) return { status: 400, body: { error: 'description is required' } };
    if (!systemPrompt) return { status: 400, body: { error: 'systemPrompt is required' } };
    if (tools.length === 0) return { status: 400, body: { error: 'at least one tool is required' } };

    const def: AgentDef = {
      name,
      description,
      tools,
      systemPrompt,
      ...(typeof body.model === 'string' && body.model ? { model: body.model } : {}),
      ...(typeof body.maxIterations === 'number' && Number.isFinite(body.maxIterations)
        ? { maxIterations: body.maxIterations }
        : {}),
    };
    try {
      saveAgentDef(def);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      const status = /built-in/i.test(msg) ? 409 : 400;
      return { status, body: { error: msg } };
    }
    return { status: 200, body: { agent: mask(def) } };
  });

  // ── DELETE /api/agents/:name ───────────────────────────────────────────────

  route('DELETE', /^\/api\/agents\/(.+)$/, async (_req: IncomingMessage, _res: ServerResponse, match: RegExpMatchArray) => {
    const name = decodeURIComponent(match[1] ?? '');
    try {
      const removed = deleteAgentDef(name);
      if (!removed) return { status: 404, body: { error: `No custom agent named "${name}".` } };
      return { status: 200, body: { name } };
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      const status = /built-in/i.test(msg) ? 409 : 400;
      return { status, body: { error: msg } };
    }
  });
}
