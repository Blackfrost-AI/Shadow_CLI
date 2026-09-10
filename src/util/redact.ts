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
  // AWS SECRET access keys are 40 base64-ish characters with no distinguishing prefix, so shape
  // matching cannot reach them — but the assignment that introduces one always names it, and
  // `AWS_SECRET_ACCESS_KEY=` slipped past the KEY=VALUE pass below (its group must END with one of
  // the listed suffixes, and this key ends in `KEY`).
  [/((?:aws[_-]?)?secret[_-]?access[_-]?key\s*[:=]\s*["']?)([A-Za-z0-9/+=]{16,})/gi, '$1[REDACTED]'],
  // Private-key blocks (PEM / OpenSSH / PKCS#8). The header line is not the secret, but the base64
  // body beneath it IS the key — a `.pem` or `id_rsa` read inside the workspace would otherwise be
  // written verbatim into `.shadow/sessions/*.jsonl` and exported transcripts.
  [
    /-----BEGIN[A-Z ]*PRIVATE KEY-----[\s\S]*?-----END[A-Z ]*PRIVATE KEY-----/g,
    '-----BEGIN PRIVATE KEY-----[REDACTED]-----END PRIVATE KEY-----',
  ],
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
 * Config/JSON keys whose VALUE is a credential regardless of what it looks like.
 *
 * Shape matching is not enough here. `/config get` printed `apiKey` verbatim, and a locally-served
 * key ("lm-studio", a bare hex string, a LAN token) matches none of the PATTERNS above — so the
 * shape-based scrubber returned it untouched onto a screen that gets shared and recorded. When the
 * KEY says credential, the value is masked whatever its shape.
 */
const SECRET_KEY_RE =
  /^(?:.*[_-])?(?:api_?key|auth_?token|access_?token|refresh_?token|secret|client_?secret|password|passwd|pwd|private_?key|credential|bearer|token)s?$/i;

/** True when a config/JSON key names a credential. */
export function isSecretKey(key: string): boolean {
  return SECRET_KEY_RE.test(key);
}

/** Mask a value for display, keeping a short prefix so the user can still tell two keys apart. */
export function maskSecret(value: unknown): string {
  const s = typeof value === 'string' ? value : JSON.stringify(value);
  if (!s) return '(unset)';
  if (s.length <= 8) return '[REDACTED]';
  return `${s.slice(0, 4)}…[REDACTED]`;
}

/**
 * Deep-clone `value`, masking any entry whose KEY names a credential (whatever the value looks
 * like) and shape-scrubbing every remaining string. This is what display paths should use for
 * config: `redact()` alone only catches recognised shapes.
 */
export function redactConfig<T>(value: T): T {
  return redactConfigValue(value, new WeakMap<object, unknown>()) as T;
}

/**
 * The traversal records each container in `built` BEFORE descending into it, so the map answers two
 * different questions correctly: a shared reference (the same object appearing twice — a DAG, not a
 * cycle) gets the already-redacted copy, and a genuine cycle gets the container currently being
 * filled, which is itself redacted by the time the walk finishes. The previous guard could not tell
 * the two apart and returned the RAW original for every revisit, i.e. anything appearing twice was
 * written to the session log unredacted.
 */
function redactConfigValue(value: unknown, built: WeakMap<object, unknown>): unknown {
  if (typeof value === 'string') return redactString(value);
  if (value === null || typeof value !== 'object') return value;
  if (value instanceof Date) return new Date(value.getTime());
  const cached = built.get(value);
  if (cached !== undefined) return cached;
  if (Array.isArray(value)) {
    const out: unknown[] = [];
    built.set(value, out);
    for (const v of value) out.push(redactConfigValue(v, built));
    return out;
  }
  const out: Record<string, unknown> = {};
  built.set(value, out);
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    out[k] = isSecretKey(k) && v != null && v !== '' ? maskSecret(v) : redactConfigValue(v, built);
  }
  return out;
}

/**
 * Deep-clone `value`, masking every string it contains (in nested objects and
 * arrays). Non-string primitives pass through unchanged; Dates are cloned. A
 * best-effort cycle guard returns the original reference on a revisit rather
 * than recursing forever.
 */
export function redact<T>(value: T): T {
  return redactValue(value, new WeakMap<object, unknown>()) as T;
}

/** See `redactConfigValue` — a revisit must yield the redacted copy, never the raw original. */
function redactValue(value: unknown, built: WeakMap<object, unknown>): unknown {
  if (typeof value === 'string') return redactString(value);
  if (value === null || typeof value !== 'object') return value;
  if (value instanceof Date) return new Date(value.getTime());
  const cached = built.get(value);
  if (cached !== undefined) return cached;
  if (Array.isArray(value)) {
    const out: unknown[] = [];
    built.set(value, out);
    for (const v of value) out.push(redactValue(v, built));
    return out;
  }
  const out: Record<string, unknown> = {};
  built.set(value, out);
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    out[k] = redactValue(v, built);
  }
  return out;
}
