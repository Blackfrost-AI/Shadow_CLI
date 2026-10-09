import { spawn, type ChildProcess } from 'node:child_process';
import { StringDecoder } from 'node:string_decoder';
import type { ToolRegistry } from '../tools/registry.js';
import type { Tool, ToolResult, ToolRisk } from '../tools/types.js';
import { z } from 'zod';
import { ok, fail } from '../tools/types.js';
import { scrubbedEnv } from '../util/safeEnv.js';
import { shadowFetch } from '../safety/egress.js';
import { wrapMcpArgv } from '../safety/sandbox.js';
import { envelopUntrusted, fitPayload } from '../safety/envelope.js';
import type { McpServerConfig } from './manage.js';
import { McpLifecycle, mcpCallDeadline, type McpRuntimeOptions } from './lifecycle.js';
import { McpArtifactStore, makeMcpArtifactTool } from './artifacts.js';
export type { McpRuntimeOptions, McpProgress, McpCallEvent } from './lifecycle.js';
import { readCapped } from '../tools/webFetch.js';
import { SseAssembler, parseSseData, nonEmptyParts, type SseEvent } from '../provider/sse.js';

/** A server-authored JSON-RPC error reply (as opposed to our own transport/timeout/abort errors).
 *  Its message is untrusted text — callTool envelopes it before surfacing it as `mcp_failed`. */
export class McpServerReplyError extends Error {}

/** Parity with the stdio client's 16MB framing cap: an HTTP reply body is never read past this
 *  (previously unbounded — a hostile or broken endpoint could buffer an endless stream). */
const MCP_HTTP_MAX_BYTES = 16 * 1024 * 1024;

/** Fallback result budget when the loop doesn't plumb one through (matches config's maxToolResultChars default). */
const MCP_DEFAULT_RESULT_CAP = 16_384;

/** Sanitize server-controlled name text interpolated OUTSIDE the envelope markers — a CR/LF in the
 *  header line splits the framing (same class as a raw Location header). */
function nameSafe(s: string): string {
  return s.replace(/[\u0000-\u001f\u007f]+/g, ' ').trim().slice(0, 64);
}

/** One MCP tool-result content part — the fields both transports read. */
interface McpContentPart {
  type: string;
  text?: string;
  resource?: { uri?: string; text?: string };
}

/**
 * Flatten a tools/call result's content into the single text the model sees. Embedded resource
 * text (type 'resource' carrying a resource.text) is content; parts with no text at all
 * (image/audio, or a resource served by reference) surface their PRESENCE instead of vanishing —
 * otherwise the model acts as if the tool returned nothing (a lost screenshot / fetched
 * resource). Shared by the stdio and HTTP transports so a tool's result reads the same whichever
 * transport served it (the HTTP client used to drop all of the above and answer 'ok' with no
 * content at all).
 */
function mcpResultBody(parts: McpContentPart[]): string {
  const text = parts.map((c) => c.text ?? c.resource?.text ?? '').filter(Boolean).join('\n');
  const nonText = parts.filter((c) => c.type !== 'text' && !c.resource?.text);
  const noteTail = nonText.map((c) => `[${c.type}${c.resource?.uri ? ` ${c.resource.uri}` : ''}]`).join(' ');
  return [text, noteTail].filter(Boolean).join('\n');
}

/** Archive overflow without discarding a successful remote result if local storage fails. */
function resultArtifact(runtime: McpRuntimeOptions, body: string, cap: number, server: string, tool: string): unknown {
  if (body.length <= cap || !runtime.artifacts) return undefined;
  try {
    return { artifact: runtime.artifacts.save(body, mcpSafeNamePart(server), mcpSafeNamePart(tool)), truncated: true, retrieval: 'mcp_artifact' };
  } catch {
    return { truncated: true, artifactUnavailable: true, note: 'The full MCP result could not be saved locally; only the bounded excerpt is available.' };
  }
}

/**
 * F07-12: an MCP tool's NAME and DESCRIPTION are server-controlled and enter the tool schema —
 * the instruction surface the model reads on EVERY request, not only when a result arrives (the
 * P3-05 envelope covers tool RESULTS only). The name is therefore collapsed to the identifier
 * alphabet: a tool cannot be named "ignore previous instructions…", and providers that constrain
 * tool names to [A-Za-z0-9_-] never see an illegal character. Registration passes the EXACT
 * registered name (including any collision suffix) into callTool so result metadata matches; the
 * reconstruction inside callTool is the fallback for direct callers. The WIRE call still uses
 * the server's original name — only the display id is sanitized.
 */
export function mcpSafeNamePart(part: string): string {
  const s = part
    .replace(/[^A-Za-z0-9_-]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 64);
  return s || 'tool';
}

/** Retained budget for a server-supplied tool description inside its containment envelope. */
const MCP_DESCRIPTION_CAP = 8_192;

/**
 * Byte cap for a server-supplied input schema (BYPASS review, P2-07). The schema rides EVERY
 * request once converted, so a multi-MB schema is a context-bloat DoS; a legitimate tool schema
 * is a handful of KB at most. Enforced at registration — an oversized tool is skipped, not
 * truncated (a truncated schema would reject the server's own valid inputs).
 */
const MCP_SCHEMA_CAP = 32_768;

const CONTROL_CHARS = /[\u0000-\u001f\u007f]/;

/**
 * BYPASS review (P2-07): jsonSchemaToZod drops `description`/`title`, but object KEYS and ENUM
 * string values survive verbatim into the per-request tool schema — a residual server-controlled
 * text channel (plus a terminal-injection surface if the schema is ever printed). They cannot be
 * enveloped (the model must reproduce them verbatim to call the tool), so fail closed instead:
 * reject any schema carrying control characters in a key or an enum value.
 */
function mcpSchemaTextSafe(node: unknown): boolean {
  if (node == null || typeof node !== 'object') return true;
  if (Array.isArray(node)) return node.every(mcpSchemaTextSafe);
  for (const [k, v] of Object.entries(node as Record<string, unknown>)) {
    if (CONTROL_CHARS.test(k)) return false;
    if (k === 'enum' && Array.isArray(v)) {
      for (const item of v) if (typeof item === 'string' && CONTROL_CHARS.test(item)) return false;
    }
    if (!mcpSchemaTextSafe(v)) return false;
  }
  return true;
}

/**
 * P3-08 Phase 3 — the OS-jail inputs for stdio children. `enabled` is the session's sandbox
 * request state (sandbox !== 'off', not --yolo); per-server `network`/`sandbox` live on the
 * server config. Constructed once at registration and shared by every stdio client.
 */
export interface McpJail {
  workspaceRoot: string;
  additionalRoots?: string[];
  enabled: boolean;
  /**
   * P3-08: mirrors run_shell's `sandboxFailurePolicy` for the jail-unavailable case — when the
   * jail is REQUESTED but the host has no sandbox tool, 'fail-closed' refuses to start the child
   * unconfined instead of silently spawning it.
   */
  failurePolicy?: 'auto' | 'fail-closed' | 'warn';
}

/** Shared surface of the stdio and HTTP MCP clients. */
export interface McpConnection {
  start(): Promise<void>;
  listTools(): Promise<McpToolInfo[]>;
  /** `signal` (P2-01): user interrupt — aborting it cancels the in-flight MCP call.
   *  `resultCap` (P3-05): the loop's tool-result budget; the reply payload is clamped to it
   *  BEFORE enveloping so the envelope's END marker always survives into the context.
   *  `registeredName` (BYPASS review): the exact registry name the caller registered — including
   *  any collision suffix — so result metadata matches. Without it, callTool reconstructs the
   *  sanitized name, which cannot reproduce a disambiguation suffix. */
  callTool(
    name: string,
    args: unknown,
    risk: ToolRisk,
    signal?: AbortSignal,
    resultCap?: number,
    registeredName?: string,
  ): Promise<ToolResult>;
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

export interface McpToolInfo {
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
  // Holds a multi-byte UTF-8 sequence back until its remaining bytes arrive in a later chunk —
  // decoding each pipe chunk independently cannot do that (see onData).
  private decoder = new StringDecoder('utf8');
  private nextId = 1;
  private readonly lifecycle: McpLifecycle;
  private pending = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void }>();

  constructor(
    private readonly name: string,
    private readonly cfg: McpServerConfig,
    private readonly jail?: McpJail,
    private readonly runtime: McpRuntimeOptions = {},
  ) { this.lifecycle = new McpLifecycle(name, runtime); }

  async start(): Promise<void> {
    if (this.child) return;
    if (!this.cfg.command) throw new Error('stdio MCP server requires a `command`');
    // P3-08 Phase 3: confine the child (workspace+/tmp writes, credential stores denied,
    // network OFF unless granted). Stdio servers speak over their pipes — a server that needs
    // sockets gets `network: true`; a server that can't live in the jail gets `sandbox: false`.
    // The in-process broker can never see a child's sockets (THREAT_MODEL §3.8's honest
    // residual) — this OS layer is what actually closes it.
    const wrapped = wrapMcpArgv({
      command: this.cfg.command,
      args: this.cfg.args ?? [],
      workspaceRoot: this.jail?.workspaceRoot ?? process.cwd(),
      additionalRoots: this.jail?.additionalRoots,
      allowNetwork: Boolean(this.cfg.network),
      enabled: (this.jail?.enabled ?? true) && this.cfg.sandbox !== false,
    });
    if (this.jail?.enabled && this.cfg.sandbox !== false) {
      if (wrapped.sandboxed) {
        process.stderr.write(
          `shadow: MCP server "${nameSafe(this.name)}" confined` +
            `${this.cfg.network ? ' (network granted)' : ' (network off — grant with "network": true)'}\n`,
        );
      } else if (wrapped.note) {
        // Requested but no tool on this host — the unconfined state must not be silent.
        // P3-08: run_shell's fail-closed policy extends to MCP children — an auto-spawned child
        // that can't be jailed is REFUSED, not silently unconfined. (Explicit `sandbox: false`
        // or session-wide sandbox-off never reaches here: the jail wasn't requested then.)
        if (this.jail?.failurePolicy === 'fail-closed') {
          process.stderr.write(
            `shadow: MCP server "${nameSafe(this.name)}": refusing to start UNCONFINED — ${wrapped.note} (sandboxFailurePolicy: fail-closed)\n`,
          );
          return;
        }
        process.stderr.write(`shadow: MCP server "${nameSafe(this.name)}": ⚠ ${wrapped.note}\n`);
      }
    }
    this.child = spawn(wrapped.argv[0]!, wrapped.argv.slice(1), {
      // MCP config may explicitly opt individual variables in, but the child must
      // never inherit the agent process's provider credentials by default.
      env: scrubbedEnv(undefined, this.cfg.env),
      stdio: ['pipe', 'pipe', 'pipe'],
      cwd: this.jail?.workspaceRoot,
      detached: process.platform !== 'win32',
    });
    // Never let a stdio MCP child keep the process alive past the work: unref the child and its
    // pipes so a one-shot (--task), piped-stdin, or REPL run still exits cleanly by natural drain
    // (the agent loop's own refs keep the loop alive while it is actually running). Without this a
    // configured stdio MCP server hangs every non-TTY exit. stop() still kills it explicitly.
    this.child.unref();
    // Feed RAW Buffers to onData — it decodes across chunk boundaries (see onData).
    this.child.stdout?.on('data', (d: Buffer) => this.onData(d));
    this.child.stderr?.on('data', () => {});
    // child stdio pipes are Sockets (have unref) though TS types them as Readable/Writable.
    const unref = (s: unknown): void => (s as { unref?: () => void } | null)?.unref?.();
    unref(this.child.stdout);
    unref(this.child.stderr);
    unref(this.child.stdin);
    // A server that dies mid-handshake turns the next stdin write into an EPIPE 'error' event
    // on the stream — unhandled, that is a process-level uncaught exception (it took a verify
    // run down flakily: the error lands wherever the event loop happens to be). Treat it as
    // connection death: fail whatever is in flight. The close handler below does the same; this
    // simply gets there first, and a second failAllPending on an empty map is a no-op.
    this.child.stdin?.on('error', () => {
      this.failAllPending('MCP server stdin closed');
    });
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

  async callTool(
    name: string,
    args: unknown,
    risk: ToolRisk,
    signal?: AbortSignal,
    resultCap?: number,
    registeredName?: string,
  ): Promise<ToolResult> {
    const start = Date.now();
    // F07-12: registration passes the exact registered name (any collision suffix included); the
    // reconstruction is the fallback for direct callers. The WIRE request below uses `name`.
    const toolName = registeredName ?? `mcp_${mcpSafeNamePart(this.name)}_${mcpSafeNamePart(name)}`;
    // The envelope header/source sit OUTSIDE the markers — sanitize the server-controlled names
    // there too (a CR/LF would split the header line = framing forgery).
    const headerTool = nameSafe(toolName);
    const source = `mcp server "${nameSafe(this.name)}" · tool "${nameSafe(name)}"`;
    const cap = resultCap ?? MCP_DEFAULT_RESULT_CAP;
    try {
      const res = (await this.request('tools/call', { name, arguments: args }, signal)) as {
        content?: McpContentPart[];
        isError?: boolean;
      };
      const parts = res.content ?? [];
      // mcpResultBody folds embedded resource text in and surfaces non-text content's presence
      // (image/audio/resource-without-text) — shared with the HTTP client so both transports
      // render a tool result identically.
      const body = mcpResultBody(parts);
      const artifactData = resultArtifact(this.runtime, body, cap, this.name, name);
      // P3-05: a server's reply is untrusted content — a compromised or hostile MCP server can put
      // model-directed instructions in any response. Envelope it (payload byte-for-byte) on BOTH
      // the success and the isError path, and stop duplicating the body into data (the old
      // {content: body} leaked the same bytes into the context unwrapped). The payload is clamped
      // to the result budget BEFORE enveloping so the END marker always survives — a downstream
      // cut that severed it would hand a forged END inside the reply its escape wedge.
      if (res.isError) {
        const msg = body ? envelopUntrusted({ tool: headerTool, source, content: fitPayload(body, cap) }) : 'MCP tool error';
        return { ...fail(toolName, risk, Date.now() - start, 'mcp_error', msg), ...(artifactData ? { data: artifactData } : {}) };
      }
      if (!body) return ok(toolName, risk, Date.now() - start, parts.length ? 'tool returned non-text content' : 'ok');
      return ok(toolName, risk, Date.now() - start, envelopUntrusted({ tool: headerTool, source, content: fitPayload(body, cap) }), artifactData);
    } catch (e) {
      // A JSON-RPC error reply is server-authored — untrusted content too (it used to surface raw
      // via mcp_failed). Our own transport/timeout/abort messages stay plain.
      const detail =
        e instanceof McpServerReplyError
          ? envelopUntrusted({ tool: headerTool, source, content: fitPayload(e.message, cap) })
          : (e as Error).message;
      return fail(toolName, risk, Date.now() - start, 'mcp_failed', detail);
    }
  }

  registerTools(registry: ToolRegistry): void {
    // populated by registerMcpServers after listTools
    void registry;
  }

  private onData(chunk: Buffer | string): void {
    // Pipe 'data' chunks split on BYTE boundaries, not code points, so decoding each chunk in
    // isolation (the old `d.toString()`) emitted U+FFFD whenever a chunk ended mid-UTF-8-sequence.
    // Inside a JSON string value the message still parsed — with a silently corrupted payload;
    // inside structural JSON, JSON.parse threw and the catch dropped the response, stalling the
    // pending request to its 60s timeout. StringDecoder keeps the partial sequence buffered until
    // its tail arrives. Framing is safe across the boundary too: '\n' (0x0A) can never occur inside
    // a multi-byte sequence (lead + continuation bytes are all ≥ 0x80), so a split never hides or
    // fakes a line break. A sequence still incomplete at child death has no line terminator anyway.
    this.buf += typeof chunk === 'string' ? chunk : this.decoder.write(chunk);
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
        const msg = JSON.parse(line) as JsonRpcResponse & { method?: string; params?: unknown };
        if (msg.method === 'notifications/progress') { this.lifecycle.progress(msg.params); continue; }
        const p = this.pending.get(msg.id);
        if (!p) continue;
        if (msg.error) p.reject(new McpServerReplyError(String(msg.error.message)));
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

  private request(method: string, params: unknown, signal?: AbortSignal): Promise<unknown> {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      if (signal?.aborted) { reject(new Error(`MCP request aborted: ${method}`)); return; }
      const input = params as Record<string, unknown>;
      const token = method === 'tools/call' ? this.lifecycle.start(id, String(input.name ?? 'tool')) : undefined;
      const wireParams = token ? { ...input, _meta: { ...((input._meta as object | undefined) ?? {}), progressToken: token } } : params;
      const finish = (error: Error | null, value?: unknown, cancelled = false): void => {
        if (!this.pending.delete(id)) return;
        clearTimeout(timer);
        signal?.removeEventListener('abort', onAbort);
        this.lifecycle.finish(token, cancelled ? 'cancelled' : error || (value as { isError?: boolean } | undefined)?.isError ? 'failed' : 'completed');
        if (error) reject(error); else resolve(value);
      };
      const cancel = (reason: string): void => {
        if (!this.pending.has(id)) return;
        if (method !== 'initialize') {
          try { void this.notify('notifications/cancelled', { requestId: id, reason }); } catch { /* disconnected */ }
        }
        finish(new Error(`MCP request ${reason}: ${method}`), undefined, true);
      };
      const timer = setTimeout(() => cancel('timeout'), method === 'tools/call' ? mcpCallDeadline(this.cfg.callTimeoutMs) : 10_000);
      const onAbort = (): void => cancel('aborted');
      signal?.addEventListener('abort', onAbort, { once: true });
      this.pending.set(id, { resolve: (value) => finish(null, value), reject: (error) => finish(error) });
      try { this.send({ jsonrpc: '2.0', id, method, params: wireParams }); }
      catch (error) { finish(error as Error); }
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
    const child = this.child;
    this.failAllPending('MCP connection stopped');
    this.child = null;
    this.buf = '';
    this.decoder = new StringDecoder('utf8');
    if (!child) return;
    try {
      if (process.platform !== 'win32' && child.pid) process.kill(-child.pid, 'SIGTERM');
      else child.kill('SIGTERM');
    } catch { /* already exited */ }
    setTimeout(() => {
      try {
        if (process.platform !== 'win32' && child.pid) process.kill(-child.pid, 'SIGKILL');
        else if (child.exitCode === null) child.kill('SIGKILL');
      } catch { /* already exited */ }
    }, 1000).unref();
  }
}

/** Extract the first JSON-RPC result from an SSE response body (Streamable HTTP). */
export function parseSseResult(body: string): unknown {
  // P2-03 (F01-08): spec-compliant reassembly — one event's data field may span several `data:`
  // lines; they parse as a unit, with the per-line defensive fallback (see parseSseData).
  const asm = new SseAssembler();
  const events: SseEvent[] = [];
  for (const line of body.split('\n')) events.push(...asm.feed(line));
  events.push(...asm.flush());
  for (const ev of events) {
    if (ev.kind !== 'data') continue;
    const parts = nonEmptyParts(ev.parts);
    if (parts.length === 0) continue;
    for (const parsed of parseSseData(parts.join('\n'), parts)) {
      const msg = parsed as JsonRpcResponse;
      if (msg.error) throw new McpServerReplyError(String(msg.error.message));
      if ('result' in msg) return msg.result;
    }
  }
  throw new Error('no JSON-RPC result in MCP SSE response');
}

/**
 * MCP over Streamable HTTP — POST JSON-RPC to one endpoint; the server replies with
 * either application/json or an SSE stream. Session continuity via `Mcp-Session-Id`.
 * Operator-configured URL (trusted source), so it is NOT routed through the SSRF
 * netguard — that would block the common localhost MCP server. It IS routed through
 * the egress broker (P2-01): offline wall + cloud-metadata block + the egress receipt,
 * and every RPC now carries a timeout + abort signal (previously: none — a wedged
 * endpoint held the request open indefinitely).
 */
export class McpHttpClient implements McpConnection {
  private sessionId: string | null = null;
  private nextId = 1;
  private readonly lifecycle: McpLifecycle;
  private readonly active = new Set<AbortController>();

  constructor(
    private readonly name: string,
    private readonly url: string,
    private readonly headers: Record<string, string> = {},
    /** Per-RPC deadline. Parity with the stdio client's 60s request timeout. */
    private readonly timeoutMs: number = 180_000,
    private readonly runtime: McpRuntimeOptions = {},
  ) { this.lifecycle = new McpLifecycle(name, runtime); }

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

  async callTool(
    name: string,
    args: unknown,
    risk: ToolRisk,
    signal?: AbortSignal,
    resultCap?: number,
    registeredName?: string,
  ): Promise<ToolResult> {
    const start = Date.now();
    // F07-12: registration passes the exact registered name (wire call keeps the original name);
    // the reconstruction is the fallback for direct callers.
    const toolName = registeredName ?? `mcp_${mcpSafeNamePart(this.name)}_${mcpSafeNamePart(name)}`;
    const headerTool = nameSafe(toolName);
    const source = `mcp server "${nameSafe(this.name)}" · tool "${nameSafe(name)}"`;
    const cap = resultCap ?? MCP_DEFAULT_RESULT_CAP;
    try {
      const res = (await this.rpc('tools/call', { name, arguments: args }, signal)) as {
        content?: McpContentPart[];
        isError?: boolean;
      };
      // Same result mapping as the stdio transport (mcpResultBody) — embedded resource text and
      // non-text content used to be dropped here, so a screenshot-only reply read as an empty 'ok'.
      const parts = res.content ?? [];
      const body = mcpResultBody(parts);
      const artifactData = resultArtifact(this.runtime, body, cap, this.name, name);
      // P3-05: same containment as the stdio transport — the reply is untrusted content; envelope
      // it on both paths (payload clamped BEFORE enveloping so the END marker survives) and drop
      // the unwrapped data duplicate.
      if (res.isError) {
        const msg = body ? envelopUntrusted({ tool: headerTool, source, content: fitPayload(body, cap) }) : 'MCP tool error';
        return { ...fail(toolName, risk, Date.now() - start, 'mcp_error', msg), ...(artifactData ? { data: artifactData } : {}) };
      }
      if (!body) return ok(toolName, risk, Date.now() - start, parts.length ? 'tool returned non-text content' : 'ok');
      return ok(toolName, risk, Date.now() - start, envelopUntrusted({ tool: headerTool, source, content: fitPayload(body, cap) }), artifactData);
    } catch (e) {
      // Server-authored JSON-RPC errors are untrusted content too — envelope them; transport
      // failures (timeout/abort/HTTP status) stay plain.
      const detail =
        e instanceof McpServerReplyError
          ? envelopUntrusted({ tool: headerTool, source, content: fitPayload(e.message, cap) })
          : (e as Error).message;
      return fail(toolName, risk, Date.now() - start, 'mcp_failed', detail);
    }
  }

  stop(): void {
    for (const controller of this.active) controller.abort();
    this.active.clear();
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

  private async rpc(method: string, params: unknown, signal?: AbortSignal): Promise<unknown> {
    if (signal?.aborted) throw new Error(`MCP request aborted: ${method}`);
    const id = this.nextId++;
    const ac = new AbortController();
    this.active.add(ac);
    const deadline = setTimeout(() => ac.abort(), method === 'tools/call' ? mcpCallDeadline(this.timeoutMs) : Math.min(10_000, this.timeoutMs));
    const onAbort = (): void => ac.abort();
    signal?.addEventListener('abort', onAbort, { once: true });
    const input = params as Record<string, unknown>;
    const token = method === 'tools/call' ? this.lifecycle.start(id, String(input.name ?? 'tool')) : undefined;
    const wireParams = token ? { ...input, _meta: { ...((input._meta as object | undefined) ?? {}), progressToken: token } } : params;
    let status: 'completed' | 'failed' | 'cancelled' = 'failed';
    const onCancel = (): void => {
      if (method !== 'initialize') void this.notify('notifications/cancelled', { requestId: id, reason: signal?.aborted ? 'aborted' : 'cancelled or deadline exceeded' });
    };
    ac.signal.addEventListener('abort', onCancel, { once: true });
    try {
      const resp = await shadowFetch(this.url, {
        method: 'POST', headers: this.hdrs(),
        body: JSON.stringify({ jsonrpc: '2.0', id, method, params: wireParams }), signal: ac.signal,
      }, { purpose: 'mcp', origin: 'user' });
      const sid = resp.headers.get('mcp-session-id');
      if (sid) this.sessionId = sid;
      if (!resp.ok) throw new Error(`MCP HTTP ${resp.status} ${nameSafe(resp.statusText)}`);
      let result: unknown;
      if ((resp.headers.get('content-type') ?? '').includes('text/event-stream')) result = await this.streamResult(resp, id);
      else {
        const json = JSON.parse(await readCapped(resp, MCP_HTTP_MAX_BYTES)) as JsonRpcResponse;
        if (json.error) throw new McpServerReplyError(String(json.error.message));
        if (json.id !== id) throw new Error('MCP response request ID mismatch');
        result = json.result;
      }
      status = (result as { isError?: boolean } | undefined)?.isError ? 'failed' : 'completed';
      return result;
    } finally {
      if (ac.signal.aborted) status = 'cancelled';
      this.lifecycle.finish(token, status);
      clearTimeout(deadline);
      signal?.removeEventListener('abort', onAbort);
      ac.signal.removeEventListener('abort', onCancel);
      this.active.delete(ac);
    }
  }

  /** Process notifications as bytes arrive, rather than waiting for the stream to close. */
  private async streamResult(resp: Response, id: number): Promise<unknown> {
    const reader = resp.body?.getReader();
    if (!reader) throw new Error('Empty MCP SSE response');
    const decoder = new TextDecoder();
    const assembler = new SseAssembler();
    let pending = '';
    let bytes = 0;
    const accept = (events: SseEvent[]): { found: boolean; result?: unknown } => {
      for (const event of events) {
        if (event.kind !== 'data') continue;
        const parts = nonEmptyParts(event.parts);
        for (const value of parseSseData(parts.join('\n'), parts)) {
          const msg = value as JsonRpcResponse & { method?: string; params?: unknown };
          if (msg.method === 'notifications/progress') this.lifecycle.progress(msg.params);
          if (msg.id !== id) continue;
          if (msg.error) throw new McpServerReplyError(String(msg.error.message));
          if ('result' in msg) return { found: true, result: msg.result };
        }
      }
      return { found: false };
    };
    try {
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        bytes += value.length;
        if (bytes > MCP_HTTP_MAX_BYTES) throw new Error('MCP SSE response exceeded 16MB');
        pending += decoder.decode(value, { stream: true });
        let nl: number;
        while ((nl = pending.indexOf('\n')) >= 0) {
          const line = pending.slice(0, nl).replace(/\r$/, '');
          pending = pending.slice(nl + 1);
          const outcome = accept(assembler.feed(line));
          if (outcome.found) return outcome.result;
        }
      }
      pending += decoder.decode();
      const final = accept([...assembler.feed(pending), ...assembler.flush()]);
      if (final.found) return final.result;
      throw new Error('no JSON-RPC result in MCP SSE response');
    } finally { await reader.cancel().catch(() => {}); reader.releaseLock(); }
  }

  private async notify(method: string, params: unknown): Promise<void> {
    await shadowFetch(
      this.url,
      {
        method: 'POST',
        headers: this.hdrs(),
        body: JSON.stringify({ jsonrpc: '2.0', method, params }),
        signal: AbortSignal.timeout(Math.min(2000, this.timeoutMs)),
      },
      { purpose: 'mcp', origin: 'user' },
    ).then(async (response) => { await response.body?.cancel(); }).catch(() => {
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
  /** F06-09: receives each client the moment it is CONSTRUCTED (before connect), so the caller's
   *  shutdown handler can kill in-flight children even if the process exits mid-connect. */
  onClient?: (client: McpConnection) => void,
  /** P3-08 Phase 3: OS-jail inputs for stdio children (defaults: enabled, no extra roots). */
  jail?: Omit<McpJail, 'workspaceRoot'>,
  runtime: McpRuntimeOptions = {},
): Promise<McpConnection[]> {
  const clients: McpConnection[] = [];
  const artifacts = runtime.artifacts ?? new McpArtifactStore(workspaceRoot);
  if (!registry.get('mcp_artifact')) registry.register(makeMcpArtifactTool(artifacts));
  const options = { ...runtime, artifacts };
  // Connect all servers in PARALLEL, each bounded by MCP_CONNECT_TIMEOUT_MS, so one slow/broken stdio
  // server can't hang `shadow` startup. (Previously: sequential + a 60s per-request timeout, so a
  // single unresponsive server blocked launch for a full minute.) A server that fails or times out is
  // skipped with a warning; the rest still load.
  await Promise.all(
    Object.entries(servers).map(async ([name, cfg]) => {
      const client: McpConnection = cfg.url
        ? new McpHttpClient(name, cfg.url, cfg.headers, cfg.callTimeoutMs, options)
        : new McpClient(name, cfg, {
            workspaceRoot,
            additionalRoots: jail?.additionalRoots,
            enabled: jail?.enabled ?? true, // omitted jail = jail ON (fail closed)
            failurePolicy: jail?.failurePolicy,
          }, options);
      onClient?.(client);
      if (runtime.isActive && !runtime.isActive()) { client.stop(); return; }
      const connect = (async () => {
        await client.start();
        return client.listTools();
      })();
      connect.catch(() => {}); // swallow a late rejection if the timeout already fired
      try {
        const tools = await withTimeout(connect, MCP_CONNECT_TIMEOUT_MS, `did not respond within ${MCP_CONNECT_TIMEOUT_MS / 1000}s`);
        if (runtime.isActive && !runtime.isActive()) { client.stop(); return; }
        const safeServer = mcpSafeNamePart(name);
        for (const t of tools) {
          if (cfg.toolNames && !cfg.toolNames.includes(t.name)) continue;
          // BYPASS review (P2-07): a tool with no usable name cannot be called — skip it alone
          // instead of registering it as `mcp_<server>_tool` (or throwing, which would drop the
          // whole server's registration).
          if (typeof t.name !== 'string' || t.name.length === 0) {
            process.stderr.write(`shadow: MCP server "${nameSafe(name)}" listed a tool with no name — skipped.\n`);
            continue;
          }
          // F07-12: the tool NAME is server-controlled and enters the schema the model reads on
          // every request — collapse it to the identifier alphabet (mcpSafeNamePart). Sanitizing
          // can collide two distinct wire tools (`foo.bar` vs `foo_bar`); disambiguate with a
          // suffix instead of letting registry.register throw and abort the whole server.
          const safeTool = mcpSafeNamePart(t.name);
          // BYPASS review (P2-07): property KEYS and ENUM string values survive jsonSchemaToZod
          // into the per-request tool schema — the same every-request surface F07-12 closed for
          // names and descriptions. Enveloping is impossible there (the model must reproduce keys
          // and enum values VERBATIM to call the tool), so fail closed instead: skip tools whose
          // schema is oversized (context-bloat DoS — it rides every request) or carries control
          // characters. Instruction-shaped enum TEXT remains a residual surface — noted, and
          // bounded by the size cap.
          const schemaJson = JSON.stringify(t.inputSchema ?? {});
          if (schemaJson.length > MCP_SCHEMA_CAP || !mcpSchemaTextSafe(t.inputSchema)) {
            process.stderr.write(
              `shadow: MCP tool "${nameSafe(t.name)}" from server "${nameSafe(name)}" has an oversized or unsafe input schema — skipped.\n`,
            );
            continue;
          }
          let toolName = `mcp_${safeServer}_${safeTool}`;
          for (let n = 2; registry.get(toolName); n++) toolName = `mcp_${safeServer}_${safeTool}_${n}`;
          // Server annotations are untrusted hints. Every MCP tool remains `exec` (needs
          // approval until `full`) because a compromised server could label a destructive
          // browser/filesystem action read-only to bypass the operator.
          const risk = mcpRisk(t.annotations);
          // F07-12: the DESCRIPTION is untrusted text too, and it rode the schema into context on
          // EVERY request — the one injection surface the P3-05 result envelope never touched.
          // Envelop it with the same machinery (fitPayload clamp BEFORE enveloping so the END
          // marker always survives; description payloads never approach the cap in practice).
          const rawDescription = t.description ?? `MCP tool ${safeTool} from server ${name}`;
          const tool: Tool = {
            name: toolName,
            description: envelopUntrusted({
              tool: nameSafe(toolName),
              source: `mcp server "${nameSafe(name)}" — tool description (present on every request, not a result)`,
              content: fitPayload(rawDescription, MCP_DESCRIPTION_CAP),
            }),
            risk,
            deferred: cfg.deferTools === true,
            inputSchema: jsonSchemaToZod(t.inputSchema),
            async run(input, ctx) {
              void workspaceRoot;
              // Pass the EXACT registered name so a collision-suffixed tool's result metadata
              // matches its registry entry (BYPASS review — the reconstruction inside callTool
              // cannot know about the suffix).
              return client.callTool(t.name, input, risk, ctx.signal, ctx.maxToolResultChars, toolName);
            },
          };
          registry.register(tool);
          runtime.onRegistered?.(name, toolName);
        }
        clients.push(client);
      } catch (e) {
        client.stop();
        // Both the config key and the error message can be hostile text (a server may answer
        // tools/list with a crafted JSON-RPC error) — sanitize before writing to the terminal.
        process.stderr.write(`shadow: MCP server "${nameSafe(name)}" unavailable — skipped (${nameSafe((e as Error).message)}).\n`);
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
