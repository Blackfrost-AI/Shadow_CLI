import type { IncomingMessage, ServerResponse } from 'node:http';
import { readJsonBody, type ApiContext, type RouteFn } from '../router.js';
import { loadGlobalMcpServers, saveGlobalMcpServers, type McpServerConfig, type McpServers } from '../../mcp/manage.js';

/**
 * Phase E: MCP server management. The read side uses `loadGlobalMcpServers`; the write side
 * calls `saveGlobalMcpServers` (global config only — project-file mcpServers are dropped for
 * security per config.ts:299-313, and the UI must respect that split).
 *
 * manage.ts only ships `enableContextCooler` (hardwired) + `disableMcpServer`; this adds the
 * generic add/replace/delete the UI needs, by composing the same loadGlobalMcpServers /
 * saveGlobalMcpServers pair. No secrets handling beyond what config.json already permits — MCP
 * headers can carry bearer tokens, and those follow config.json's existing 0600 perms.
 */

const NAME_RE = /^[a-z0-9][a-z0-9._-]{0,63}$/;

function validateServer(name: string, body: Record<string, unknown>): { ok: true; cfg: McpServerConfig } | { ok: false; message: string } {
  if (!NAME_RE.test(name)) return { ok: false, message: 'name must be lowercase, start with letter/digit, max 64 chars (a-z0-9._-)' };
  // Must be exactly one of: stdio (command) or http (url).
  const command = typeof body.command === 'string' ? body.command : undefined;
  const url = typeof body.url === 'string' ? body.url : undefined;
  if (!command && !url) {
    return { ok: false, message: 'either command (stdio) or url (http) is required' };
  }
  if (command && url) {
    return { ok: false, message: 'specify command OR url, not both' };
  }
  if (url) {
    try {
      const u = new URL(url);
      if (u.protocol !== 'http:' && u.protocol !== 'https:') return { ok: false, message: 'url must be http(s)://…' };
    } catch {
      return { ok: false, message: 'url is not a valid URL' };
    }
  }
  const cfg: McpServerConfig = {};
  if (command) {
    cfg.command = command;
    if (Array.isArray(body.args)) cfg.args = body.args.map(String);
    if (body.env && typeof body.env === 'object') cfg.env = body.env as Record<string, string>;
  } else {
    cfg.url = url;
    if (body.headers && typeof body.headers === 'object') cfg.headers = body.headers as Record<string, string>;
  }
  return { ok: true, cfg };
}

function maskConfig(cfg: McpServerConfig): Record<string, unknown> {
  // Headers/env values may be bearer tokens; show keys only, never values.
  const out: Record<string, unknown> = {};
  if (cfg.command) out.command = cfg.command;
  if (cfg.args) out.args = cfg.args;
  if (cfg.url) out.url = cfg.url;
  if (cfg.env) out.envKeys = Object.keys(cfg.env);
  if (cfg.headers) out.headerKeys = Object.keys(cfg.headers);
  return out;
}

export function registerMcpRoutes(route: RouteFn, ctx: ApiContext): void {
  // ── GET /api/mcp ───────────────────────────────────────────────────────────

  route('GET', /^\/api\/mcp$/, async () => {
    const servers = loadGlobalMcpServers();
    const masked: Record<string, unknown> = {};
    for (const [name, cfg] of Object.entries(servers)) masked[name] = maskConfig(cfg);
    return { status: 200, body: { servers: masked } };
  });

  // ── POST /api/mcp ──────────────────────────────────────────────────────────
  // Body: { name, command?, args?, env?, url?, headers? }

  route('POST', /^\/api\/mcp$/, async (req: IncomingMessage) => {
    const body = (await readJsonBody(req)) as Record<string, unknown> | null;
    if (!body) return { status: 400, body: { error: 'invalid body' } };
    const name = String(body.name ?? '').trim();
    const v = validateServer(name, body);
    if (!v.ok) return { status: 400, body: { error: v.message } };

    const existing = loadGlobalMcpServers();
    if (name in existing) return { status: 409, body: { error: `MCP server "${name}" already exists. Use PUT to replace it.` } };
    const next: McpServers = { ...existing, [name]: v.cfg };
    saveGlobalMcpServers(next);
    return { status: 201, body: { name, server: maskConfig(v.cfg) } };
  });

  // ── PUT /api/mcp/:name ─────────────────────────────────────────────────────
  // Full replace of an existing server's config.

  route('PUT', /^\/api\/mcp\/(.+)$/, async (req: IncomingMessage, _res: ServerResponse, match: RegExpMatchArray) => {
    const name = decodeURIComponent(match[1] ?? '');
    const body = (await readJsonBody(req)) as Record<string, unknown> | null;
    if (!body) return { status: 400, body: { error: 'invalid body' } };
    const v = validateServer(name, body);
    if (!v.ok) return { status: 400, body: { error: v.message } };

    const existing = loadGlobalMcpServers();
    if (!(name in existing)) return { status: 404, body: { error: `No MCP server named "${name}".` } };
    const next: McpServers = { ...existing, [name]: v.cfg };
    saveGlobalMcpServers(next);
    return { status: 200, body: { name, server: maskConfig(v.cfg) } };
  });

  // ── DELETE /api/mcp/:name ──────────────────────────────────────────────────

  route('DELETE', /^\/api\/mcp\/(.+)$/, async (_req: IncomingMessage, _res: ServerResponse, match: RegExpMatchArray) => {
    const name = decodeURIComponent(match[1] ?? '');
    if (!NAME_RE.test(name)) return { status: 400, body: { error: 'invalid name' } };
    const existing = loadGlobalMcpServers();
    if (!(name in existing)) return { status: 404, body: { error: `No MCP server named "${name}".` } };
    const next = { ...existing };
    delete next[name];
    saveGlobalMcpServers(next);
    return { status: 200, body: { name } };
  });
}
