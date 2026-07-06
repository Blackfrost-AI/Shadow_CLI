// Best-effort secret masking. This is a defense-in-depth convenience, NOT a
// security guarantee: it pattern-matches common credential SHAPES (provider
// keys, bearer tokens, AWS access keys, JWTs, shell KEY=VALUE pairs) plus the
// live VALUES of sensitive `process.env` entries. Novel or unusual secret
// formats can slip through, and aggressive matching could in theory scrub a
// benign string that merely looks like a secret. Treat it as a helpful scrubber
// for logs and session files — never as the reason it is safe to log something.

/** Env var names whose VALUES are treated as secrets and masked wherever seen. */
const ENV_KEY_RE = /(_KEY|_SECRET|_TOKEN|_PASS|_PWD|_CRED|_CREDENTIAL|PASSWORD|API_KEY|PRIVATE_KEY)$/i;

/**
 * Resolved secret VALUES registered at runtime (e.g. the API key/auth token loaded
 * from ~/.shadow/credentials.json, which is NOT in process.env and has no fixed
 * shape). Masked verbatim wherever they appear — the most reliable redaction.
 */
const KNOWN_SECRETS = new Set<string>();

/** Register a resolved secret value so it is masked in all logs/output. No-op for trivially short values. */
export function registerSecret(value: string | undefined | null): void {
  if (value && value.length >= 6) KNOWN_SECRETS.add(value);
}

/** Ordered [pattern, replacement] passes applied to every string. */
const PATTERNS: Array<[RegExp, string]> = [
  // Provider API keys: sk-…, sk-ant-… (Anthropic / OpenAI), sk-or-… (OpenRouter), sk_live_… (Stripe).
  [/sk-[A-Za-z0-9_-]{12,}/g, '[REDACTED]'],
  [/[rs]k_(?:live|test)_[A-Za-z0-9]{16,}/g, '[REDACTED]'],
  // Bearer tokens in Authorization headers — keep the scheme, drop the token.
  [/Bearer\s+[A-Za-z0-9._-]{8,}/gi, 'Bearer [REDACTED]'],
  // GitHub tokens: PATs (ghp_/gho_/ghs_/ghu_/ghr_) and fine-grained (github_pat_…).
  [/gh[posur]_[A-Za-z0-9]{20,}/g, '[REDACTED]'],
  [/github_pat_[A-Za-z0-9_]{20,}/g, '[REDACTED]'],
  // Slack tokens (xoxb-/xoxp-/xoxa-/xoxr-…) and GitLab PATs (glpat-…).
  [/xox[baprs]-[A-Za-z0-9-]{10,}/g, '[REDACTED]'],
  [/glpat-[A-Za-z0-9_-]{16,}/g, '[REDACTED]'],
  // Google API keys (AIza…).
  [/AIza[A-Za-z0-9_-]{30,}/g, '[REDACTED]'],
  // AWS access key ids (long-term AKIA + temporary STS ASIA).
  [/A(?:KIA|SIA)[0-9A-Z]{16}/g, '[REDACTED]'],
  // JSON Web Tokens: header.payload.signature.
  [/eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{6,}/g, '[REDACTED]'],
  // Credentials embedded in a connection-string URL: scheme://user:PASS@host.
  [/([a-z][a-z0-9+.-]*:\/\/[^:@\s/]+:)([^@\s/]+)(@)/gi, '$1[REDACTED]$3'],
  // Shell-style KEY=VALUE where the key names a credential.
  [/\b([A-Za-z0-9_]*(?:API_KEY|SECRET|TOKEN|PASSWORD|PASS|PWD|CRED|CREDENTIAL|PRIVATE_KEY))=(\S+)/gi, '$1=[REDACTED]'],
];

/**
 * Mask known secret shapes — and the live values of sensitive environment
 * variables — in a single string. Best-effort (see file header).
 */
export function redactString(s: string): string {
  if (!s) return s;
  let out = s;

  // 0. Redact registered secret values (resolved keys/tokens, incl. from the
  //    credentials store) — verbatim, shape-independent, most reliable.
  for (const secret of KNOWN_SECRETS) {
    if (out.includes(secret)) out = out.split(secret).join('[REDACTED]');
  }

  // 1. Redact the literal values of sensitive environment variables. Skip
  //    empty/trivial values: a 1–3 char value (e.g. "1", "on") would otherwise
  //    cause pathological over-redaction of ordinary text.
  for (const [key, value] of Object.entries(process.env)) {
    if (!value || value.length < 4) continue;
    if (!ENV_KEY_RE.test(key)) continue;
    if (out.includes(value)) out = out.split(value).join('[REDACTED]');
  }

  // 2. Redact common credential patterns.
  for (const [re, repl] of PATTERNS) out = out.replace(re, repl);

  return out;
}

/**
 * Deep-clone `value`, masking every string it contains (in nested objects and
 * arrays). Non-string primitives pass through unchanged; Dates are cloned. A
 * best-effort cycle guard returns the original reference on a revisit rather
 * than recursing forever.
 */
export function redact<T>(value: T): T {
  return redactValue(value, new WeakSet<object>()) as T;
}

function redactValue(value: unknown, seen: WeakSet<object>): unknown {
  if (typeof value === 'string') return redactString(value);
  if (value === null || typeof value !== 'object') return value;
  if (value instanceof Date) return new Date(value.getTime());
  if (seen.has(value)) return value; // best-effort cycle guard
  seen.add(value);
  if (Array.isArray(value)) return value.map((v) => redactValue(v, seen));
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    out[k] = redactValue(v, seen);
  }
  return out;
}
