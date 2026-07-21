import type { IncomingMessage, ServerResponse } from 'node:http';
import { loadGlobalConfig } from '../state/globalStore.js';
import { loadAgentDefs } from '../agent/defs.js';
import { loadGlobalMcpServers } from '../mcp/manage.js';
import type { AutonomyLevel } from '../safety/permissions.js';
import type { ModelEntry } from '../config.js';
import { registerModelsRoutes, mask as maskModel } from './api/models.js';
import { registerAgentsRoutes } from './api/agents.js';
import { registerMcpRoutes } from './api/mcp.js';
import { registerSessionsRoutes } from './api/sessions.js';
import { registerProjectsRoutes } from './api/projects.js';
import type { SessionRegistry } from './registry.js';

/**
 * The API router for `shadow web`. Every request here has ALREADY passed `authorizeRequest`
 * (Host → Origin → token) in server.ts — this layer is purely dispatch + JSON I/O.
 *
 * Built per server via `createApiRouter(ctx)` rather than as a module-level array. The old
 * shape registered routes at import time into a shared array, which meant: handlers had no way
 * to reach per-server state (a session registry, the workspace) beyond module globals, two
 * servers in one process would share and double-register routes, and route state leaked
 * between tests in whatever order they imported things. Chat, approvals and sessions all need
 * server-scoped state, so the context has to be threaded rather than reached for.
 *
 * Convention: handlers return `{ status, body? }` and the caller writes the response with
 * SEC_HEADERS. Errors are caught and returned as 400 JSON; secrets are never serialized
 * (see mask in api/models.ts).
 */

export interface ApiResponse {
  status: number;
  body?: unknown;
  headers?: Record<string, string>;
}

export type Handler = (
  req: IncomingMessage,
  res: ServerResponse,
  match: RegExpMatchArray,
) => Promise<ApiResponse> | ApiResponse;

/** Server-scoped state available to every route. */
export interface ApiContext {
  /**
   * The workspace this server acts on. The web server runs in-process with the CLI, so this
   * is wherever the user ran `shadow web` — but it is passed in rather than read from
   * process.cwd() at call time, so a future per-session workspace is a context change and
   * not a global one.
   */
  workspaceRoot: string;
  /** The server's session registry — the reserved 'cli' session plus any browser-created ones. */
  registry: SessionRegistry;
}

/** Registers one route. Patterns match against the path (no query string). */
export type RouteFn = (method: string, pattern: RegExp, handler: Handler) => void;

export type Dispatch = (
  method: string,
  path: string,
  req: IncomingMessage,
  res: ServerResponse,
) => Promise<ApiResponse | null>;

interface Route {
  method: string;
  pattern: RegExp;
  handler: Handler;
}

/** Read and parse a JSON body, capped at 1 MB. Returns null on empty, throws on bad JSON / too big. */
export async function readJsonBody(req: IncomingMessage, maxBytes = 1 << 20): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on('data', (c: Buffer) => {
      size += c.length;
      if (size > maxBytes) {
        req.destroy();
        reject(new Error('body too large'));
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8');
      // The `return` here is load-bearing: without it an empty body resolved(null) and then
      // fell through to JSON.parse('') and called reject() on an already-settled promise. The
      // rejection was swallowed (a settled promise ignores it), so it was invisible — until a
      // route that legitimately takes an empty body starts getting hit constantly.
      if (raw === '') {
        resolve(null);
        return;
      }
      try {
        resolve(JSON.parse(raw));
      } catch (e) {
        reject(e);
      }
    });
    req.on('error', reject);
  });
}

// ── /api/state ───────────────────────────────────────────────────────────────

function registerStateRoutes(route: RouteFn, ctx: ApiContext): void {
  route('GET', /^\/api\/state$/, async () => {
    const cfg = loadGlobalConfig();
    const agents = loadAgentDefs(ctx.workspaceRoot).map((a) => ({
      name: a.name,
      description: a.description,
      tools: a.tools,
      model: a.model,
      maxIterations: a.maxIterations,
      builtin: a.builtin === true,
    }));
    const mcpServers = loadGlobalMcpServers();
    const models = Array.isArray(cfg.models) ? (cfg.models as Array<Record<string, unknown>>) : [];
    return {
      status: 200,
      body: {
        model: cfg.model ?? null,
        fallbackModel: cfg.fallbackModel ?? null,
        provider: cfg.provider ?? null,
        autonomy: (cfg.autonomy as AutonomyLevel | undefined) ?? null,
        // Reuse the exact masking the models API uses, so the home view and the models view
        // never disagree about whether a secret is present.
        models: models.map((m) => maskModel(m as ModelEntry)),
        mcpServers,
        agents,
      },
    };
  });
}

/**
 * Build a dispatcher for one server. Each surface is a self-contained set of handlers; this is
 * the single place that ties them together. New surfaces (chat, approvals, sessions) get one
 * line here and receive the same context.
 */
export function createApiRouter(ctx: ApiContext): Dispatch {
  const routes: Route[] = [];
  const route: RouteFn = (method, pattern, handler) => {
    routes.push({ method, pattern, handler });
  };

  registerStateRoutes(route, ctx);
  registerModelsRoutes(route, ctx);
  registerAgentsRoutes(route, ctx);
  registerMcpRoutes(route, ctx);
  registerSessionsRoutes(route, ctx);
  registerProjectsRoutes(route, ctx);

  return async (method, path, req, res) => {
    for (const r of routes) {
      if (r.method !== method) continue;
      const m = path.match(r.pattern);
      if (!m) continue;
      try {
        return await r.handler(req, res, m);
      } catch (e) {
        const message = e instanceof Error ? e.message : String(e);
        return { status: 400, body: { error: message } };
      }
    }
    return null;
  };
}
