import { spawn, type ChildProcess } from 'node:child_process';
import type { ToolRegistry } from '../tools/registry.js';
import type { Tool, ToolResult, ToolRisk } from '../tools/types.js';
import { z } from 'zod';
import { ok, fail } from '../tools/types.js';

interface McpServerConfig {
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  url?: string; // Streamable-HTTP endpoint (alternative to command/stdio)
  headers?: Record<string, string>;
}

/** Shared surface of the stdio and HTTP MCP clients. */
interface McpConnection {
  start(): Promise<void>;
  listTools(): Promise<McpToolInfo[]>;
  callTool(name: string, args: unknown, risk: ToolRisk): Promise<ToolResult>;
  stop(): void;
}

/** MCP tool annotations (spec hints) — used to pick a permission risk tier. */
interface McpToolAnnotations {
  readOnlyHint?: boolean;
  destructiveHint?: boolean;
  idempotentHint?: boolean;
  openWorldHint?: boolean;
  title?: string;
}

interface McpToolInfo {
  name: string;
  description?: string;
  inputSchema?: unknown;
  annotations?: McpToolAnnotations;
}

interface JsonRpcRequest {
  jsonrpc: '2.0';
  id?: number; // omitted for NOTIFICATIONS (a notification is a request with no id per JSON-RPC 2.0)
  method: string;
  params?: unknown;
}

interface JsonRpcResponse {
  jsonrpc: '2.0';
  id: number;
  result?: unknown;
  error?: { code: number; message: string };
}

/**
 * Minimal MCP stdio client — lists tools and proxies calls (Claude MCP parity baseline).
 * Each MCP tool is registered as mcp_<server>_<toolname> in the registry.
 */
export class McpClient implements McpConnection {
  private child: ChildProcess | null = null;
  private buf = '';
  private nextId = 1;
  private pending = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void }>();

  constructor(
    private readonly name: string,
    private readonly cfg: McpServerConfig,
  ) {}

  async start(): Promise<void> {
    if (this.child) return;
    if (!this.cfg.command) throw new Error('stdio MCP server requires a `command`');
    this.child = spawn(this.cfg.command, this.cfg.args ?? [], {
      env: { ...process.env, ...this.cfg.env },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    // Never let a stdio MCP child keep the process alive past the work: unref the child and its
    // pipes so a one-shot (--task), piped-stdin, or REPL run still exits cleanly by natural drain
    // (the agent loop's own refs keep the loop alive while it is actually running). Without this a
    // configured stdio MCP server hangs every non-TTY exit. stop() still kills it explicitly.
    this.child.unref();
    this.child.stdout?.on('data', (d: Buffer) => this.onData(d.toString()));
    this.child.stderr?.on('data', () => {});
    // child stdio pipes are Sockets (have unref) though TS types them as Readable/Writable.
    const unref = (s: unknown): void => (s as { unref?: () => void } | null)?.unref?.();
    unref(this.child.stdout);
    unref(this.child.stderr);
    unref(this.child.stdin);
    this.child.on('close', () => {
      this.child = null;
      // A child that exits (e.g. dies on spawn) must not leave requests hanging until the 60s
      // timeout — reject everything in flight immediately so start() fails fast and is skipped.
      this.failAllPending('MCP server process exited');
    });
    this.child.on('error', (e) => {
      this.child = null;
      this.failAllPending(`MCP server failed to start: ${e.message}`);
    });
    // `clientInfo` is REQUIRED by the MCP initialize schema — a spec-compliant stdio server (e.g.
    // one built on the official SDK) rejects the connection without it. (The HTTP client already
    // sends it; the stdio client used to omit it, so compliant stdio servers never connected.)
    await this.request('initialize', {
      protocolVersion: '2024-11-05',
      capabilities: {},
      clientInfo: { name: 'shadow', version: '0' },
    });
    await this.notify('notifications/initialized', {});
  }

  async listTools(): Promise<McpToolInfo[]> {
    const res = (await this.request('tools/list', {})) as { tools?: McpToolInfo[] };
    return res.tools ?? [];
  }

  async callTool(name: string, args: unknown, risk: ToolRisk): Promise<ToolResult> {
    const start = Date.now();
    try {
      const res = (await this.request('tools/call', { name, arguments: args })) as {
        content?: Array<{ type: string; text?: string; resource?: { uri?: string; text?: string } }>;
        isError?: boolean;
      };
      const parts = res.content ?? [];
      const text = parts.map((c) => c.text ?? c.resource?.text ?? '').filter(Boolean).join('\n');
      // Non-text MCP content (image/audio/resource) has no `.text`. Surface its PRESENCE instead of
      // reporting an empty 'ok' — otherwise the model acts as if the tool returned nothing (a lost
      // screenshot / fetched resource). Include a resource uri when the server gives one.
      const nonText = parts.filter((c) => c.type !== 'text' && !c.resource?.text);
      const noteTail = nonText.map((c) => `[${c.type}${c.resource?.uri ? ` ${c.resource.uri}` : ''}]`).join(' ');
      const body = [text, noteTail].filter(Boolean).join('\n');
      if (res.isError) return fail(`mcp_${this.name}_${name}`, risk, Date.now() - start, 'mcp_error', body || 'MCP tool error');
      return ok(`mcp_${this.name}_${name}`, risk, Date.now() - start, body || (parts.length ? 'tool returned non-text content' : 'ok'), { content: body });
    } catch (e) {
      return fail(`mcp_${this.name}_${name}`, risk, Date.now() - start, 'mcp_failed', (e as Error).message);
    }
  }

  registerTools(registry: ToolRegistry): void {
    // populated by registerMcpServers after listTools
    void registry;
  }

  private onData(chunk: string): void {
    this.buf += chunk;
    // A broken/malicious server that writes megabytes with no newline would grow `buf` unbounded → OOM.
    // Cap it: on overflow, fail every pending request with a framing error and kill the child rather
    // than accumulating forever.
    if (this.buf.length > 16 * 1024 * 1024) {
      this.buf = '';
      for (const [, p] of this.pending) p.reject(new Error(`MCP server "${this.name}" framing error: response exceeded 16MB with no newline`));
      this.pending.clear();
      try {
        this.child?.kill();
      } catch {
        /* already gone */
      }
      return;
    }
    let nl: number;
    while ((nl = this.buf.indexOf('\n')) >= 0) {
      const line = this.buf.slice(0, nl).trim();
      this.buf = this.buf.slice(nl + 1);
      if (!line) continue;
      try {
        const msg = JSON.parse(line) as JsonRpcResponse;
        const p = this.pending.get(msg.id);
        if (!p) continue;
        this.pending.delete(msg.id);
        if (msg.error) p.reject(new Error(msg.error.message));
        else p.resolve(msg.result);
      } catch {
        // ignore non-json
      }
    }
  }

  private notify(method: string, params: unknown): Promise<void> {
    // A JSON-RPC NOTIFICATION must NOT carry an `id` (an id-bearing message is a request; a strict
    // server may reply to or error on it, breaking the handshake). Omit id and do not burn a counter.
    this.send({ jsonrpc: '2.0', method, params });
    return Promise.resolve();
  }

  private request(method: string, params: unknown): Promise<unknown> {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        if (this.pending.has(id)) {
          this.pending.delete(id);
          reject(new Error(`MCP request timeout: ${method}`));
        }
      }, 60_000);
      // Always clear this timer on settle (previously it lingered for 60s after every request,
      // keeping the event loop alive and delaying a one-shot run's exit). We do NOT unref it: during
      // the startup handshake it is the only handle keeping the loop alive while we await a response,
      // so unref-ing it makes Node exit 0 mid-startup on a slow server.
      const clearAnd = (fn: (v: unknown) => void) => (v: unknown): void => {
        clearTimeout(timer);
        fn(v);
      };
      this.pending.set(id, { resolve: clearAnd(resolve), reject: clearAnd(reject) });
      this.send({ jsonrpc: '2.0', id, method, params });
    });
  }

  private send(msg: JsonRpcRequest): void {
    if (!this.child?.stdin) throw new Error('MCP not started');
    this.child.stdin.write(`${JSON.stringify(msg)}\n`);
  }

  /** Reject every in-flight request (used when the child dies) so callers fail fast. */
  private failAllPending(msg: string): void {
    for (const { reject } of this.pending.values()) reject(new Error(msg));
    this.pending.clear();
  }

  stop(): void {
    this.child?.kill();
    this.child = null;
  }
}

/** Extract the first JSON-RPC result from an SSE response body (Streamable HTTP). */
export function parseSseResult(body: string): unknown {
  for (const raw of body.split('\n')) {
    const line = raw.trim();
    if (!line.startsWith('data:')) continue;
    const payload = line.slice(5).trim();
    if (!payload) continue;
    let msg: JsonRpcResponse;
    try {
      msg = JSON.parse(payload) as JsonRpcResponse;
    } catch {
      continue; // keepalive / non-JSON frame
    }
    if (msg.error) throw new Error(msg.error.message);
    if ('result' in msg) return msg.result;
  }
  throw new Error('no JSON-RPC result in MCP SSE response');
}

/**
 * MCP over Streamable HTTP — POST JSON-RPC to one endpoint; the server replies with
 * either application/json or an SSE stream. Session continuity via `Mcp-Session-Id`.
 * Operator-configured URL (trusted source), so it is NOT routed through the SSRF
 * netguard — that would block the common localhost MCP server.
 */
export class McpHttpClient implements McpConnection {
  private sessionId: string | null = null;
  private nextId = 1;

  constructor(
    private readonly name: string,
    private readonly url: string,
    private readonly headers: Record<string, string> = {},
  ) {}

  async start(): Promise<void> {
    await this.rpc('initialize', {
      protocolVersion: '2024-11-05',
      capabilities: {},
      clientInfo: { name: 'shadow', version: '0' },
    });
    await this.notify('notifications/initialized', {});
  }

  async listTools(): Promise<McpToolInfo[]> {
    const res = (await this.rpc('tools/list', {})) as { tools?: McpToolInfo[] };
    return res.tools ?? [];
  }

  async callTool(name: string, args: unknown, risk: ToolRisk): Promise<ToolResult> {
    const start = Date.now();
    try {
      const res = (await this.rpc('tools/call', { name, arguments: args })) as {
        content?: Array<{ type: string; text?: string }>;
        isError?: boolean;
      };
      const text = (res.content ?? []).map((c) => c.text ?? '').join('\n');
      if (res.isError) return fail(`mcp_${this.name}_${name}`, risk, Date.now() - start, 'mcp_error', text || 'MCP tool error');
      return ok(`mcp_${this.name}_${name}`, risk, Date.now() - start, text || 'ok', { content: text });
    } catch (e) {
      return fail(`mcp_${this.name}_${name}`, risk, Date.now() - start, 'mcp_failed', (e as Error).message);
    }
  }

  stop(): void {
    /* stateless HTTP — nothing to tear down */
  }

  private hdrs(): Record<string, string> {
    const h: Record<string, string> = {
      'content-type': 'application/json',
      accept: 'application/json, text/event-stream',
      ...this.headers,
    };
    if (this.sessionId) h['mcp-session-id'] = this.sessionId;
    return h;
  }

  private async rpc(method: string, params: unknown): Promise<unknown> {
    const resp = await fetch(this.url, {
      method: 'POST',
      headers: this.hdrs(),
      body: JSON.stringify({ jsonrpc: '2.0', id: this.nextId++, method, params }),
    });
    const sid = resp.headers.get('mcp-session-id');
    if (sid) this.sessionId = sid;
    if (!resp.ok) throw new Error(`MCP HTTP ${resp.status} ${resp.statusText}`);
    const ct = resp.headers.get('content-type') ?? '';
    if (ct.includes('text/event-stream')) return parseSseResult(await resp.text());
    const json = (await resp.json()) as JsonRpcResponse;
    if (json.error) throw new Error(json.error.message);
    return json.result;
  }

  private async notify(method: string, params: unknown): Promise<void> {
    await fetch(this.url, {
      method: 'POST',
      headers: this.hdrs(),
      body: JSON.stringify({ jsonrpc: '2.0', method, params }),
    }).catch(() => {
      /* notifications are best-effort */
    });
  }
}

/** Connect timeout for MCP startup — a slow/broken server is skipped, not allowed to hang launch. */
const MCP_CONNECT_TIMEOUT_MS = 10_000;

/** Reject `p` if it hasn't settled within `ms`. */
function withTimeout<T>(p: Promise<T>, ms: number, msg: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    // Do NOT unref this timer — during MCP startup it may be the only handle keeping the event loop
    // alive while we await the connect, so unref-ing it would make Node exit 0 mid-startup.
    const t = setTimeout(() => reject(new Error(msg)), ms);
    p.then(
      (v) => {
        clearTimeout(t);
        resolve(v);
      },
      (e) => {
        clearTimeout(t);
        reject(e as Error);
      },
    );
  });
}

/** Register MCP tools from configured servers into the tool registry. */
export async function registerMcpServers(
  registry: ToolRegistry,
  servers: Record<string, McpServerConfig>,
  workspaceRoot: string,
): Promise<McpConnection[]> {
  const clients: McpConnection[] = [];
  // Connect all servers in PARALLEL, each bounded by MCP_CONNECT_TIMEOUT_MS, so one slow/broken stdio
  // server can't hang `shadow` startup. (Previously: sequential + a 60s per-request timeout, so a
  // single unresponsive server blocked launch for a full minute.) A server that fails or times out is
  // skipped with a warning; the rest still load.
  await Promise.all(
    Object.entries(servers).map(async ([name, cfg]) => {
      const client: McpConnection = cfg.url ? new McpHttpClient(name, cfg.url, cfg.headers) : new McpClient(name, cfg);
      const connect = (async () => {
        await client.start();
        return client.listTools();
      })();
      connect.catch(() => {}); // swallow a late rejection if the timeout already fired
      try {
        const tools = await withTimeout(connect, MCP_CONNECT_TIMEOUT_MS, `did not respond within ${MCP_CONNECT_TIMEOUT_MS / 1000}s`);
        for (const t of tools) {
          const toolName = `mcp_${name}_${t.name}`;
          // An MCP tool is auto-approvable only if the server marks it read-only;
          // anything else is treated as `exec` (needs approval until `full`), since we
          // can't know what it does. Without this every MCP tool auto-ran at auto-read.
          const risk = mcpRisk(t.annotations);
          const tool: Tool = {
            name: toolName,
            description: t.description ?? `MCP tool ${t.name} from server ${name}`,
            risk,
            inputSchema: jsonSchemaToZod(t.inputSchema),
            async run(input, ctx) {
              void ctx;
              void workspaceRoot;
              return client.callTool(t.name, input, risk);
            },
          };
          registry.register(tool);
        }
        clients.push(client);
      } catch (e) {
        client.stop();
        process.stderr.write(`shadow: MCP server "${name}" unavailable — skipped (${(e as Error).message}).\n`);
      }
    }),
  );
  return clients;
}

/**
 * Permission tier for an MCP tool. Always `exec` — needs approval until `full`.
 * We deliberately DO NOT trust a server's self-declared `readOnlyHint` to auto-approve: a malicious or
 * compromised MCP server could label a destructive tool (`delete_files`) `readOnlyHint:true` and have it
 * run with no prompt at `auto-read` autonomy. The hint is advisory only; the operator confirms (or sets
 * `full`). (A future per-server operator allowlist could re-enable the fast path for trusted servers.)
 */
export function mcpRisk(_annotations?: McpToolAnnotations): ToolRisk {
  return 'exec';
}

interface JsonSchemaNode {
  type?: string | string[];
  properties?: Record<string, unknown>;
  required?: string[];
  items?: unknown;
  enum?: unknown[];
  anyOf?: unknown[];
  oneOf?: unknown[];
}

/**
 * Pragmatic JSON-Schema → Zod for MCP tool inputs, so the loop actually validates
 * a model's arguments before proxying the call (the old stub accepted anything).
 * Covers the common shapes (object/string/number/boolean/array/enum/union); unknown
 * constructs degrade to `z.unknown()` (permissive) rather than rejecting valid input,
 * and objects `.passthrough()` so server-accepted extra fields survive.
 */
export function jsonSchemaToZod(schema: unknown): z.ZodTypeAny {
  if (!schema || typeof schema !== 'object') return z.unknown();
  const s = schema as JsonSchemaNode;

  if (Array.isArray(s.enum) && s.enum.length > 0 && s.enum.every((v) => typeof v === 'string')) {
    return z.enum(s.enum as [string, ...string[]]);
  }
  const variants = s.anyOf ?? s.oneOf;
  if (Array.isArray(variants) && variants.length > 0) {
    const opts = variants.map(jsonSchemaToZod);
    return opts.length === 1
      ? opts[0]!
      : z.union(opts as [z.ZodTypeAny, z.ZodTypeAny, ...z.ZodTypeAny[]]);
  }

  const type = Array.isArray(s.type) ? s.type[0] : s.type;
  switch (type) {
    case 'string':
      return z.string();
    case 'number':
    case 'integer':
      return z.number();
    case 'boolean':
      return z.boolean();
    case 'null':
      return z.null();
    case 'array':
      return z.array(s.items ? jsonSchemaToZod(s.items) : z.unknown());
    case 'object':
      return objectSchema(s);
    default:
      return s.properties ? objectSchema(s) : z.unknown();
  }
}

function objectSchema(s: JsonSchemaNode): z.ZodTypeAny {
  const shape: Record<string, z.ZodTypeAny> = {};
  const required = new Set(s.required ?? []);
  for (const [key, prop] of Object.entries(s.properties ?? {})) {
    const child = jsonSchemaToZod(prop);
    shape[key] = required.has(key) ? child : child.optional();
  }
  return z.object(shape).passthrough();
}