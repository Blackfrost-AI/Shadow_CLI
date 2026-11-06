import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import type { AddressInfo, Socket } from 'node:net';
import { redactString, registerSecret } from '../util/redact.js';

/**
 * OPT-IN authenticated browser relay — mission m-11.
 *
 * Shadow's default browsing posture is ISOLATED and stays that way: the pinned
 * Playwright MCP preset (`shadow mcp enable browser`) drives a throwaway Chrome
 * profile, and ordinary web research goes through the sandboxed web tools. This
 * module does not import, register, or modify any of that — it is a second,
 * narrower door that stays closed unless an operator explicitly attaches ONE
 * selected tab or profile through it, and then opens one action at a time.
 *
 * Shape of the door:
 *  - Loopback only. The listener binds the literal `127.0.0.1`, never
 *    `0.0.0.0` and never a resolvable name, and it exists only while a target
 *    is attached. Unattached, the relay has no port at all and refuses
 *    everything, fail-closed.
 *  - Per-session bearer token (256 bits from crypto.randomBytes), required on
 *    every request, compared constant-time, never logged, never persisted,
 *    never placed in a URL. Cleared by close().
 *  - Same-origin policy on the listener: `Host` must be exactly
 *    `127.0.0.1:<port>`; `Origin` must be present and exactly
 *    `http://127.0.0.1:<port>` — a missing Origin is REFUSED here, unlike the
 *    web console's rule, because the relay has exactly one legitimate client
 *    (the native messaging host) which can assert its origin explicitly, while
 *    a DNS-rebound page or a sandboxed iframe cannot; a present `Referer`
 *    must also match the loopback origin exactly. Every miss is one generic
 *    `refused` — no detail leak, no error taxonomy.
 *  - Scoped target: the relay is bound to the exact tab/profile chosen at
 *    attach time. Every request must name that target; anything else is
 *    refused.
 *  - Separate action grants: navigate / click / form-fill / read-dom are four
 *    INDEPENDENT grants. Each is approved only by the operator returning the
 *    exact digest shown to them — the approval-digest binding of
 *    src/tools/mutation.ts applied to (target, action) instead of file bytes —
 *    and the digest is re-derived and re-compared constant-time on every later
 *    use. There is no blanket grant, and no grant survives a re-attach or a
 *    disconnect.
 *  - Redaction: cookie values, Authorization headers, and anything else whose
 *    key names credential material are replaced by `[redacted]` in the audit
 *    log and in every result, whatever their shape. No raw credential is ever
 *    stored.
 *  - Stale attachment: when the host reports the attached target gone, all
 *    grants are cleared and every action is refused with an explicit
 *    stale-attachment error until a fresh explicit attach.
 *
 * Honest limitations (kept for reviewers, mirrored in docs/BROWSER_RELAY.md):
 *  - The relay validates and audits requests; it does not sandbox the browser.
 *    Actions inside the attached tab run with that tab's own privileges.
 *    Redaction protects Shadow's LOGS and RESULTS, not the live page.
 *  - The transport to the browser (native messaging host / extension) is an
 *    injectable `dispatch` seam and is NOT implemented in this slice. With no
 *    transport, an authorized action fails closed with an explicit error —
 *    the relay never pretends to act.
 *  - The relay learns of a disconnect only when the host reports it. A host
 *    that lies can keep a dead attachment looking alive; the operator's
 *    re-attach gate and close() are the backstops.
 *  - Loopback binding stops remote hosts, not other local processes. The token
 *    is only as private as the machine's user boundary; on a shared box the
 *    relay should stay closed.
 */

/** The only address the relay will ever bind — a literal, never a resolvable name. */
export const RELAY_BIND_HOST = '127.0.0.1';

/** The four action classes. Each is a SEPARATE grant; there is no blanket grant. */
export type RelayAction = 'navigate' | 'click' | 'form-fill' | 'read-dom';
export const RELAY_ACTIONS: readonly RelayAction[] = ['navigate', 'click', 'form-fill', 'read-dom'];

/** What got attached: exactly one tab or one profile — never both, never a set. */
export type RelayTargetKind = 'tab' | 'profile';
export interface RelayTarget {
  kind: RelayTargetKind;
  /** Opaque host-supplied identifier of the exact tab/profile. */
  id: string;
  /** Human-readable label shown to the operator at approval time. */
  label: string;
}

/** Everything the operator sees when an approval is requested. No credential material. */
export interface RelayApprovalRequest {
  kind: 'attach' | 'grant';
  target: RelayTarget;
  /** null for attach; the exact requested action for a grant. */
  action: RelayAction | null;
  /** The digest the operator must return verbatim to approve. */
  digest: string;
}

export class BrowserRelayError extends Error {
  constructor(
    message: string,
    readonly status: 401 | 403 | 404 | 405 | 409 | 410 | 413 | 502 | 503,
    /** true: post-authentication policy failures, where the operator needs the exact
     *  reason. false: pre-authentication failures, which must all look identical. */
    readonly expose: boolean,
  ) {
    super(message);
  }
}

/** A redacted, log-safe record of one relayed request. Contains no credential material. */
export interface RelayLogEntry {
  at: string;
  /** The action requested; null for the disconnect report. */
  action: RelayAction | null;
  targetId: string;
  /** Request detail after redaction — empty when nothing was retained. */
  detail: Record<string, unknown>;
  /** 'executed' | 'refused: <reason>' | 'broker-failure' | 'disconnect reported'. */
  outcome: string;
}

export interface RelayStatus {
  attached: boolean;
  target: RelayTarget | null;
  /** Actions currently granted, each bound to its own digest. */
  grantedActions: RelayAction[];
  /** True once the attached target has disconnected — everything is refused. */
  stale: boolean;
  /** The bound loopback port, or null while the relay is not attached. */
  port: number | null;
  listening: boolean;
  /** close() is terminal; a closed relay answers nothing and reattaches nothing. */
  closed: boolean;
}

export interface RelayResponse {
  status: number;
  headers: Record<string, string>;
  body: unknown;
}

/** Response headers for every relay reply: no framing, no sniffing, no referrer, no cache. */
const SEC_HEADERS: Record<string, string> = {
  'X-Content-Type-Options': 'nosniff',
  'X-Frame-Options': 'DENY',
  'Referrer-Policy': 'no-referrer',
  'Cache-Control': 'no-store',
};

const REDACTED = '[redacted]';
/** Any key matching this names credential material and is masked unconditionally. */
const CREDENTIAL_KEY_RE = /cookie|authorization|credential|secret|token|password|passwd|api[-_]?key|session/i;
const MAX_BODY_BYTES = 256 * 1024;
const MAX_LOG_ENTRIES = 512;
/** Namespaced into every digest so a relay approval can never collide with any other hash. */
const GRANT_NAMESPACE = 'shadow-browser-relay-v1';

/**
 * Digest binding an operator's ATTACH approval to exactly the target they saw.
 * Mirrors mutation.ts: the operator approves a digest, never a description,
 * and the digest is re-derived and re-compared on every later use.
 */
export function attachDigest(target: RelayTarget): string {
  return createHash('sha256')
    .update(JSON.stringify({ v: GRANT_NAMESPACE, kind: 'attach', target, action: null }))
    .digest('hex');
}

/** Digest binding an action GRANT to exactly one (target, action) pair. */
export function grantDigest(target: RelayTarget, action: RelayAction): string {
  return createHash('sha256')
    .update(JSON.stringify({ v: GRANT_NAMESPACE, kind: 'grant', target, action }))
    .digest('hex');
}

/** Constant-time equality that never throws on length mismatch. */
function constantTimeEqual(a: string, b: string): boolean {
  const left = Buffer.from(a, 'utf8');
  const right = Buffer.from(b, 'utf8');
  if (left.length !== right.length) return false;
  return timingSafeEqual(left, right);
}

/**
 * Deep credential redaction for relay detail and dispatch results. Two layers:
 *  1. any key naming credential material (cookies, Authorization, tokens, …) is
 *     replaced by `[redacted]` WHATEVER its value looks like — shape matching is
 *     not trusted here, because a tab snapshot can carry credentials in any form;
 *  2. every remaining string passes the shape-based scrubber (`redactString`),
 *     which also masks the relay token itself (registered at construction) and
 *     known credential shapes such as `Bearer …` or URLs with embedded passwords.
 *
 * Documented limitation: a credential in a novel shape under an innocuous key can
 * still slip through layer 2 — the same honest limitation util/redact.ts carries.
 */
export function redactRelayValue(value: unknown): unknown {
  return redactValue(value, new WeakSet<object>());
}

function redactValue(value: unknown, seen: WeakSet<object>): unknown {
  if (typeof value === 'string') return redactString(value);
  if (value === null || typeof value !== 'object') return value;
  if (seen.has(value as object)) return REDACTED; // cycle: fail toward redaction, never toward raw
  seen.add(value as object);
  if (Array.isArray(value)) return value.map((entry) => redactValue(entry, seen));
  const out: Record<string, unknown> = {};
  for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
    out[key] = entry != null && typeof entry !== 'object' && CREDENTIAL_KEY_RE.test(key)
      ? REDACTED
      : redactValue(entry, seen);
  }
  return out;
}

export interface BrowserRelayOptions {
  /**
   * The operator approval gate — the ONLY way anything opens. Called for attach
   * and for each action grant. The operator sees the exact target (and action)
   * plus the digest; approval means RETURNING that digest verbatim, anything
   * else means refusal. Never called with credential material.
   */
  ask: (request: RelayApprovalRequest) => Promise<string | undefined>;
  /**
   * Transport seam to the native messaging host / extension. NOT implemented in
   * this slice: an integration layer injects it. Absent, an authorized action
   * fails closed with an explicit error — the relay never pretends to act.
   * It receives the RAW detail (it must, to act); everything Shadow stores or
   * returns is redacted regardless of what comes back.
   */
  dispatch?: (request: { action: RelayAction; target: RelayTarget; detail: Record<string, unknown> }) =>
    Promise<unknown>;
  /** Test hook: deterministic token source (length preserved). */
  tokenSource?: (length: number) => Buffer;
  /** Test hook: clock — used for timestamps only, never for security decisions. */
  now?: () => Date;
}

/** In-memory request shape handed to the dispatcher. Headers use the lower-cased
 *  keys Node produces, so fixtures and live sockets are checked identically. */
export interface RelayRequest {
  path: string;
  method?: string;
  headers: Record<string, string | string[] | undefined>;
  body?: unknown;
}

/**
 * The relay. All policy flows through one dispatcher (`handle`): the loopback
 * listener forwards raw requests into it, and every check runs in the same
 * order there — Host, Origin, Referer, token, attachment, freshness, scope,
 * grant, transport. The operator surface is in-process only: the network can
 * never reach attach, grants, status, the audit log, or close.
 */
export function createBrowserRelay(options: BrowserRelayOptions) {
  const random = options.tokenSource ?? randomBytes;
  const now = options.now ?? (() => new Date());

  // Per-session token: minted at construction, masked by every redaction pass,
  // never logged, never persisted. close() nulls it; nothing re-mints it.
  let token: string | null = random(32).toString('base64url');
  registerSecret(token);

  let server: Server | null = null;
  let port: number | null = null;
  let attachedTarget: RelayTarget | null = null;
  let stale = false;
  let closed = false;
  const grants = new Map<RelayAction, { digest: string; targetId: string; approvedAt: string }>();
  const sockets = new Set<Socket>();
  const log: RelayLogEntry[] = [];

  function selfHost(): string { return `${RELAY_BIND_HOST}:${port}`; }
  function selfOrigin(): string { return `http://${RELAY_BIND_HOST}:${port}`; }

  function refuse(status: 401 | 403 | 404 | 405 | 413): RelayResponse {
    return { status, headers: { ...SEC_HEADERS }, body: { error: 'refused' } };
  }

  function header(req: RelayRequest, name: string): string | undefined {
    const value = req.headers[name] ?? req.headers[name.toLowerCase()];
    const first = Array.isArray(value) ? value[0] : value;
    return typeof first === 'string' && first.length > 0 ? first : undefined;
  }

  /** Bearer extraction from the Authorization header only — never a URL or a
   *  query string, which end up in access logs. */
  function bearerToken(req: RelayRequest): string | undefined {
    const auth = header(req, 'authorization');
    if (auth === undefined || !auth.toLowerCase().startsWith('bearer ')) return undefined;
    return auth.slice(7).trim();
  }

  /** Pre-authentication gate. Every failure here looks IDENTICAL: no error
   *  taxonomy, no echo of what was sent. Exactly two observable outcomes:
   *  403 — the request is not from this listener/origin (including the
   *  fail-closed case where no listener exists at all), and 401 — the channel
   *  is legitimate but the token is missing or wrong. */
  function authorize(req: RelayRequest): void {
    if (!token || port === null) throw new BrowserRelayError('refused', 403, false);
    if (header(req, 'host') !== selfHost()) throw new BrowserRelayError('refused', 403, false);
    // Origin is REQUIRED here, unlike the web console: the relay has exactly one
    // legitimate client, the native messaging host, which can assert its origin
    // explicitly. A DNS-rebound page cannot produce this header on our listener,
    // and neither can a sandboxed iframe (`null`).
    if (header(req, 'origin') !== selfOrigin()) throw new BrowserRelayError('refused', 403, false);
    // Referer is never sent by the legitimate client; if one appears it must be ours.
    const referer = header(req, 'referer');
    if (referer !== undefined && referer !== selfOrigin()) throw new BrowserRelayError('refused', 403, false);
    const presented = bearerToken(req);
    if (typeof presented !== 'string' || !presented) throw new BrowserRelayError('refused', 401, false);
    if (!constantTimeEqual(presented, token)) throw new BrowserRelayError('refused', 401, false);
  }

  /** Post-authentication scope guards. Explicit by design: the caller is
   *  authenticated, and the operator's audit trail needs the exact reason. */
  function requireAttached(): RelayTarget {
    if (!attachedTarget) throw new BrowserRelayError('no attachment', 409, true);
    return attachedTarget;
  }

  function requireFresh(): void {
    if (stale) throw new BrowserRelayError('stale attachment', 410, true);
  }

  function requireTargetScope(requested: unknown, target: RelayTarget): void {
    if (typeof requested !== 'string' || requested !== target.id) {
      throw new BrowserRelayError('scoped target mismatch', 403, true);
    }
  }

  function validateAction(value: unknown): RelayAction {
    if (typeof value !== 'string') throw new BrowserRelayError('refused', 404, false);
    const action = value as RelayAction;
    if (!(RELAY_ACTIONS as readonly string[]).includes(action)) {
      throw new BrowserRelayError('refused', 404, false);
    }
    return action;
  }

  /** Re-derive and re-compare the stored grant on EVERY use, exactly as
   *  mutation.ts re-asserts its approval digest before applying. A grant can
   *  never be replayed against another action or another target. */
  function requireGrant(action: RelayAction, target: RelayTarget): void {
    const stored = grants.get(action);
    if (!stored) throw new BrowserRelayError(`no operator grant for ${action}`, 403, true);
    if (stored.targetId !== target.id || !constantTimeEqual(stored.digest, grantDigest(target, action))) {
      throw new BrowserRelayError(`grant does not bind to this target and action: ${action}`, 403, true);
    }
  }

  /** The single operator approval primitive: approval = returning the exact
   *  digest that was shown; anything else is refusal. */
  async function askApproval(request: RelayApprovalRequest): Promise<void> {
    const answer = await options.ask(request);
    if (typeof answer !== 'string' || !constantTimeEqual(answer, request.digest)) {
      throw new BrowserRelayError(
        request.kind === 'attach' ? 'operator refused attach' : `operator refused grant: ${request.action}`,
        409,
        true,
      );
    }
  }

  function recordLog(entry: RelayLogEntry): void {
    log.push(entry);
    if (log.length > MAX_LOG_ENTRIES) log.shift();
  }

  /** Bind the loopback listener: literal 127.0.0.1, ephemeral port. Called only
   *  from inside an approved attach — the port never exists before attachment. */
  function openListener(): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      const created = createServer((req, res) => {
        void serveHttp(req, res).catch(() => { /* the handler always answers */ });
      });
      created.on('connection', (socket) => {
        sockets.add(socket);
        socket.on('close', () => sockets.delete(socket));
      });
      created.on('error', reject);
      created.listen(0, RELAY_BIND_HOST, () => {
        server = created;
        port = (created.address() as AddressInfo).port;
        // The relay must die with the process: it never keeps the event loop
        // alive on its own, and close() tears it down eagerly.
        created.unref?.();
        resolve();
      });
    });
  }

  /** The HTTP edge of the relay: byte cap, header normalization, then the same
   *  dispatcher every entry funnels into. Answers exactly once per request. */
  function serveHttp(req: IncomingMessage, res: ServerResponse): Promise<void> {
    return new Promise<void>((resolve) => {
      const chunks: Buffer[] = [];
      let size = 0;
      let oversized = false;
      let settled = false;
      let ended = false;
      const answer = (status: number): void => {
        if (settled) return;
        settled = true;
        try {
          res.writeHead(status, { 'Content-Type': 'application/json', ...SEC_HEADERS });
          res.end(JSON.stringify({ error: 'refused' }));
        } catch { /* socket already gone */ }
        resolve();
      };
      req.on('data', (chunk: Buffer) => {
        size += chunk.length;
        if (size > MAX_BODY_BYTES) {
          oversized = true;
          req.destroy();
          answer(413);
          return;
        }
        chunks.push(chunk);
      });
      req.on('end', () => {
        // The body is complete: from here the dispatcher alone owns the answer.
        ended = true;
        const headers: Record<string, string | string[] | undefined> = {};
        for (const [key, value] of Object.entries(req.headers)) {
          headers[key.toLowerCase()] = value as string | string[] | undefined;
        }
        let body: unknown;
        try {
          body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : undefined;
        } catch {
          body = undefined;
        }
        void handle({ path: req.url ?? '/', method: req.method, headers, body }).then(
          (response) => {
            if (settled) return;
            settled = true;
            try {
              res.writeHead(response.status, { 'Content-Type': 'application/json', ...response.headers });
              res.end(JSON.stringify(response.body ?? {}));
            } catch { /* socket already gone */ }
            resolve();
          },
          () => answer(500),
        );
      });
      req.on('close', () => {
        // Aborted mid-body, or an oversized stream we destroyed. A request whose
        // body completed is owned by the dispatcher — never double-answer.
        if (ended) return;
        answer(oversized ? 413 : 400);
      });
    });
  }

  /**
   * The dispatcher. Order is load-bearing: authentication first (one identical
   * generic refusal for every miss), then the explicit post-auth policy errors
   * the operator needs to see.
   */
  async function handle(req: RelayRequest): Promise<RelayResponse> {
    if (closed) return refuse(401);
    try {
      authorize(req);
    } catch (error) {
      return refuse((error as BrowserRelayError).status as 401 | 403);
    }
    try {
      const path = (req.path ?? '/').split('?')[0]!.replace(/\/+$/, '') || '/';
      const method = (req.method ?? 'POST').toUpperCase();
      if (method !== 'POST') return refuse(405);

      // --- action execution: the only effectful route. ----------------------
      const actionMatch = /^\/action\/([a-z-]+)$/.exec(path);
      if (actionMatch) {
        let action: RelayAction;
        try {
          action = validateAction(actionMatch[1]);
        } catch {
          return refuse(404); // unknown action class: generic, unaudited
        }
        // Every real policy refusal is AUDITED with its reason; no raw payload
        // is ever retained in a refusal record.
        let target: RelayTarget;
        try {
          target = requireAttached();
          requireFresh();
          requireTargetScope((req.body as { targetId?: unknown } | undefined)?.targetId, target);
          requireGrant(action, target);
        } catch (error) {
          const e = error as BrowserRelayError;
          recordLog({
            at: now().toISOString(), action, targetId: attachedTarget?.id ?? 'none', detail: {},
            outcome: `refused: ${e.message}`,
          });
          return { status: e.status, headers: { ...SEC_HEADERS }, body: { error: e.message } };
        }
        const detail = (req.body as { detail?: unknown } | undefined)?.detail;
        const rawDetail: Record<string, unknown> =
          detail && typeof detail === 'object' && !Array.isArray(detail)
            ? { ...(detail as Record<string, unknown>) }
            : {};
        if (!options.dispatch) {
          recordLog({
            at: now().toISOString(), action, targetId: target.id,
            detail: redactRelayValue(rawDetail) as Record<string, unknown>,
            outcome: 'refused: no broker transport',
          });
          return { status: 503, headers: { ...SEC_HEADERS }, body: { error: 'no broker transport' } };
        }
        let result: unknown;
        try {
          // The transport needs the RAW detail to act; everything Shadow keeps
          // or returns is redacted below regardless of what comes back.
          result = await options.dispatch({ action, target, detail: rawDetail });
        } catch {
          recordLog({
            at: now().toISOString(), action, targetId: target.id,
            detail: redactRelayValue(rawDetail) as Record<string, unknown>,
            outcome: 'broker-failure',
          });
          return { status: 502, headers: { ...SEC_HEADERS }, body: { error: 'broker failure' } };
        }
        recordLog({
          at: now().toISOString(), action, targetId: target.id,
          detail: redactRelayValue(rawDetail) as Record<string, unknown>,
          outcome: 'executed',
        });
        return {
          status: 200,
          headers: { ...SEC_HEADERS },
          body: { ok: true, action, targetId: target.id, result: redactRelayValue(result) },
        };
      }

      // --- host-reported disconnect: the only stale trigger. ----------------
      if (path === '/disconnect') {
        let target: RelayTarget;
        try {
          target = requireAttached();
          requireTargetScope((req.body as { targetId?: unknown } | undefined)?.targetId, target);
        } catch (error) {
          const e = error as BrowserRelayError;
          recordLog({
            at: now().toISOString(), action: null, targetId: attachedTarget?.id ?? 'none', detail: {},
            outcome: `refused: ${e.message}`,
          });
          return { status: e.status, headers: { ...SEC_HEADERS }, body: { error: e.message } };
        }
        stale = true;
        grants.clear();
        recordLog({
          at: now().toISOString(), action: null, targetId: target.id,
          detail: {}, outcome: 'disconnect reported',
        });
        return { status: 200, headers: { ...SEC_HEADERS }, body: { ok: true, stale: true } };
      }

      return refuse(404);
    } catch (error) {
      if (error instanceof BrowserRelayError) {
        if (error.expose) return { status: error.status, headers: { ...SEC_HEADERS }, body: { error: error.message } };
        return refuse(error.status as 401 | 403 | 404);
      }
      throw error;
    }
  }

  /**
   * OPERATOR surface — in-process only, never reachable over the network. This
   * is the approval story: attach and every grant go through the same ask()
   * gate, and there is exactly one implementation of each.
   */
  const operator = {
    /** Explicitly attach ONE selected tab/profile. Requires the operator's
     *  digest-bound approval; binds the loopback listener; clears every grant. */
    async attach(target: RelayTarget): Promise<void> {
      if (closed) throw new BrowserRelayError('relay is closed', 409, true);
      if (!target || typeof target.id !== 'string' || !target.id
        || (target.kind !== 'tab' && target.kind !== 'profile')) {
        throw new BrowserRelayError('attach requires one exact tab or profile', 409, true);
      }
      const normalized: RelayTarget = {
        kind: target.kind,
        id: target.id,
        label: typeof target.label === 'string' && target.label ? target.label : target.id,
      };
      await askApproval({ kind: 'attach', target: normalized, action: null, digest: attachDigest(normalized) });
      if (!server) await openListener(); // first bind only; a re-attach keeps the port the host already knows
      attachedTarget = normalized;
      stale = false;
      grants.clear(); // no grant ever survives an attach boundary
    },
    /** Grant ONE action for the attached target. Digest-bound, one at a time.
     *  Refused while stale: a dead target accrues no new grants. */
    async grant(action: RelayAction): Promise<void> {
      if (closed) throw new BrowserRelayError('relay is closed', 409, true);
      const validated = validateAction(action);
      const target = requireAttached();
      requireFresh();
      if (grants.has(validated)) return; // already granted: never re-prompt, never widen
      await askApproval({ kind: 'grant', target, action: validated, digest: grantDigest(target, validated) });
      grants.set(validated, {
        digest: grantDigest(target, validated), targetId: target.id, approvedAt: now().toISOString(),
      });
    },
    /** Withdraw one grant. */
    revoke(action: RelayAction): boolean {
      return grants.delete(action);
    },
    /** The relay token, for handing to the native messaging host out of band.
     *  Call only for the handoff; never log it (redaction masks it anyway). */
    token(): string | null {
      return token;
    },
    /** The address the listener actually bound, straight from the socket — the
     *  verifiable evidence for the loopback-only claim. */
    boundAddress(): { address: string; port: number } | null {
      if (!server || port === null) return null;
      const address = server.address() as AddressInfo | null;
      return address ? { address: address.address, port: address.port } : null;
    },
    status(): RelayStatus {
      return {
        attached: !!attachedTarget,
        target: attachedTarget ? { ...attachedTarget } : null,
        grantedActions: [...grants.keys()].sort(),
        stale,
        port,
        listening: !!server && port !== null,
        closed,
      };
    },
    /** The redacted audit trail. Values here are already `[redacted]`. */
    auditLog(): RelayLogEntry[] {
      return log.map((entry) => ({ ...entry, detail: { ...entry.detail } }));
    },
    /** Terminal teardown: kill the listener and every open socket, clear all
     *  grants, the attachment, the audit trail, and the token. Nothing recovers. */
    async close(): Promise<void> {
      closed = true;
      attachedTarget = null;
      stale = false;
      grants.clear();
      log.length = 0;
      token = null;
      port = null;
      const victim = server;
      server = null;
      for (const socket of sockets) {
        try { socket.destroy(); } catch { /* already gone */ }
      }
      sockets.clear();
      if (victim) {
        try { (victim as unknown as { closeAllConnections?: () => void }).closeAllConnections?.(); } catch { /* n/a */ }
        await new Promise<void>((resolve) => victim.close(() => resolve()));
      }
    },
  };

  return { handle, operator };
}
