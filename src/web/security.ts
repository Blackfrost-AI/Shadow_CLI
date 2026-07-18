import { timingSafeEqual } from 'node:crypto';

/**
 * Request authorization for Shadow's loopback web server.
 *
 * Binding to 127.0.0.1 is NOT a security boundary on its own. A remote page can reach a
 * loopback server via DNS rebinding: `evil.com` resolves to a real address on first load,
 * then re-resolves to 127.0.0.1, and the browser happily sends requests to the local
 * server. Same-origin policy does not stop this — it keys on hostname, not on the IP the
 * hostname currently points at.
 *
 * The defense is the `Host` header. In a rebinding attack the browser still sends
 * `Host: evil.com`, because that is the name in the URL bar. A server that accepts only
 * literal loopback names cannot be reached that way.
 *
 * (Both of Shadow's closest comparables get this wrong: OpenClaw shipped a rebinding hole
 * in its browser-control server — issue #4949, rated P0, arbitrary JS execution via the
 * evaluate endpoint — and closed it "not planned"; hermes-webui defaults auth off on
 * localhost.)
 */

/** Host header values that cannot be produced by DNS rebinding. */
const LOOPBACK_NAMES = new Set(['127.0.0.1', 'localhost', '[::1]', '::1']);

export interface AuthContext {
  /** The port the server is actually listening on. */
  port: number;
  /** The session token minted at startup. */
  token: string;
}

export interface AuthFailure {
  ok: false;
  status: 403 | 401;
  error: string;
}
export type AuthResult = { ok: true } | AuthFailure;

/** Split a `Host`/`Origin` authority into name + port, tolerating IPv6 brackets. */
function splitAuthority(authority: string): { name: string; port?: string } {
  if (authority.startsWith('[')) {
    const close = authority.indexOf(']');
    if (close === -1) return { name: authority };
    const name = authority.slice(0, close + 1);
    const rest = authority.slice(close + 1);
    return { name, port: rest.startsWith(':') ? rest.slice(1) : undefined };
  }
  const colon = authority.lastIndexOf(':');
  if (colon === -1) return { name: authority };
  return { name: authority.slice(0, colon), port: authority.slice(colon + 1) };
}

/**
 * True when the `Host` header names loopback on our port. A missing Host is rejected:
 * HTTP/1.1 requires it, and letting it through would reopen the rebinding path.
 */
export function isAllowedHost(hostHeader: string | undefined, port: number): boolean {
  if (!hostHeader) return false;
  const { name, port: p } = splitAuthority(hostHeader.trim().toLowerCase());
  if (!LOOPBACK_NAMES.has(name)) return false;
  // The port must match ours. An absent port would mean :80, which we never listen on.
  return p === String(port);
}

/**
 * True when `Origin` is one of our own loopback origins. Absence is allowed — non-browser
 * clients (curl, scripts) legitimately omit it, and those requests are still gated by the
 * token. Browsers send Origin on every POST, including cross-site form posts, so a
 * *present and wrong* Origin is a real cross-site attempt and is refused.
 */
export function isAllowedOrigin(originHeader: string | undefined, port: number): boolean {
  if (originHeader === undefined) return true;
  const origin = originHeader.trim().toLowerCase();
  if (origin === 'null') return false; // sandboxed iframe / opaque origin
  let url: URL;
  try {
    url = new URL(origin);
  } catch {
    return false;
  }
  if (url.protocol !== 'http:') return false;
  const name = url.hostname.includes(':') ? `[${url.hostname}]` : url.hostname;
  return LOOPBACK_NAMES.has(name) && url.port === String(port);
}

/** Constant-time token comparison that never throws on length mismatch. */
export function tokenMatches(got: string | undefined, expected: string): boolean {
  if (!got) return false;
  const a = Buffer.from(got);
  const b = Buffer.from(expected);
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

/** Pull the session token from the `Authorization: Bearer` header or a `?t=` query param. */
export function extractToken(headers: Record<string, string | string[] | undefined>, url: string | undefined): string | undefined {
  const auth = headers['authorization'];
  const raw = Array.isArray(auth) ? auth[0] : auth;
  if (raw?.toLowerCase().startsWith('bearer ')) return raw.slice(7).trim();
  if (url) {
    const q = url.indexOf('?');
    if (q !== -1) {
      const t = new URLSearchParams(url.slice(q + 1)).get('t');
      if (t) return t;
    }
  }
  return undefined;
}

/**
 * The single gate every request passes through. Order matters: Host first, because a
 * rebinding request should be refused before it can probe whether a token is valid.
 */
export function authorizeRequest(
  req: { headers: Record<string, string | string[] | undefined>; url?: string },
  ctx: AuthContext,
): AuthResult {
  const host = req.headers['host'];
  if (!isAllowedHost(Array.isArray(host) ? host[0] : host, ctx.port)) {
    return { ok: false, status: 403, error: 'bad host' };
  }
  const origin = req.headers['origin'];
  if (!isAllowedOrigin(Array.isArray(origin) ? origin[0] : origin, ctx.port)) {
    return { ok: false, status: 403, error: 'bad origin' };
  }
  if (!tokenMatches(extractToken(req.headers, req.url), ctx.token)) {
    return { ok: false, status: 401, error: 'unauthorized' };
  }
  return { ok: true };
}

/** Response headers for every reply: no framing, no sniffing, no referrer, no outbound anything. */
export const SEC_HEADERS: Record<string, string> = {
  'X-Content-Type-Options': 'nosniff',
  'X-Frame-Options': 'DENY',
  'Referrer-Policy': 'no-referrer',
  'Cache-Control': 'no-store',
  // No remote origins of any kind — the page is fully self-contained, which is also what
  // makes "watch it phone home to no one" checkable rather than a claim.
  'Content-Security-Policy':
    "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data:; connect-src 'self'; form-action 'none'; base-uri 'none'; frame-ancestors 'none'",
};
