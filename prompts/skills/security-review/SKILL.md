---
description: Comprehensive security checklist and patterns for auth, user input, secrets, APIs, and sensitive features.
when_to_use: When adding authentication, handling user input or uploads, working with secrets/credentials, creating API endpoints, or implementing payment/sensitive features.
disable-model-invocation: false
user-invocable: true
---

# Security Review

Ensure code follows security best practices and surface potential vulnerabilities
before they ship. Adapted for Shadow from the local ECC plugin pack: verification
steps use Shadow's shipped toolbelt, and nothing here authorizes network activity
beyond what the task explicitly requires.

## When to activate

- Implementing authentication or authorization
- Handling user input, file uploads, or deserialization
- Creating API endpoints or integrating third-party APIs
- Working with secrets, credentials, or sensitive data storage/transmission
- Implementing payment or other high-value features

## Shadow toolbelt hooks

- `secrets_scan` — sweep the tree for planted credentials before review; output is
  masked-only, so it is safe to run and quote in findings.
- `sast_scan` — semgrep bridge for a first-pass static sweep (metrics off, local
  rules by default). Treat its SARIF as triage input, never as the review itself.
- `osv_query` — check dependency versions against known advisories (brokered,
  receipts logged; a finding already covered by a CVE is an upgrade task).
- `security_findings` — record observations with redacted local evidence; a finding
  is *verified* only by a current passed `project_checks` run.

## Checklist

### 1. Secrets management

- No hardcoded keys/tokens/passwords; load from env or a secret store and fail fast
  when missing.
- `.env*` ignored by Git; no secrets in history, logs, error text, or model context.
- Verify with `secrets_scan` (masked previews + file:line) and a Git-history check
  for anything it flags. Rotate anything ever committed.

### 2. Input validation

- Validate every external input at the boundary with a schema (zod or equivalent):
  types, lengths, ranges, formats; whitelist, never blacklist.
- File uploads: enforce size cap, content-type AND extension allowlist; never trust
  the client-declared type alone; store outside the web root with generated names.
- Error messages must not leak internals; detailed errors go to server logs only.

### 3. Injection prevention

- SQL: parameterized queries or a correct ORM/query builder — never string
  concatenation, including in ORDER BY/LIMIT fragments (allowlist those).
- Commands: argv arrays, never shell strings; if a shell is unavoidable, strict
  allowlist validation of every interpolated value.
- Path handling: resolve and prove containment (`..`, absolute paths, symlinks,
  sibling-prefix escapes); reject before any filesystem side effect.
- Template/HTML: contextual auto-escaping; sanitize user HTML with a maintained
  sanitizer and a minimal tag/attr allowlist.

### 4. Authentication & authorization

- Password hashing: argon2id or bcrypt with sane cost; never homemade crypto.
- Session tokens in `HttpOnly; Secure; SameSite` cookies — not localStorage.
- Authorization checked server-side on EVERY sensitive operation, against the
  authenticated principal and the exact resource (IDOR check: can user A read
  user B's object by changing an id?).
- Row-level security where the database supports it; deny by default.

### 5. XSS & CSRF

- Content-Security-Policy: start strict (`default-src 'self'`, `object-src 'none'`,
  `frame-ancestors 'none'`); no `unsafe-inline`/`unsafe-eval` without a documented
  removal plan.
- CSRF tokens (or SameSite=Strict plus origin checks) on every state-changing
  request; never rely on cookies alone for cross-site protection.

### 6. Rate limiting & abuse

- Limit auth, search, and expensive endpoints per-IP and per-account; return 429
  with Retry-After. Lockouts/backoff on credential endpoints.

### 7. Sensitive data exposure

- Redact before logging (never log passwords, tokens, card data, full request
  bodies of auth endpoints). Shadow's own `redactString` is the pattern: shape-based
  masking before any sink.
- Generic client errors; stack traces server-side only; TLS everywhere in prod.

### 8. Dependency security

- Lock files committed; `npm ci` in CI. Known-vulnerability check: `osv_query` per
  package/version (or `npm audit` where appropriate) — triage by reachability, not
  just severity score.
- No new dependency without review: maintenance, install scripts, transitive tree.

## Security tests to write

- Unauthenticated request → 401; wrong-role request → 403; cross-user object → 403/404.
- Invalid input (bad types, oversized, traversal-shaped) → 400 with no side effect.
- Rate limit trips at the configured threshold.
- A planted sentinel secret never appears in logs, errors, or exported artifacts.

## Pre-deployment gate

Secrets clean (`secrets_scan` + history) · inputs validated · queries parameterized ·
XSS/CSRF covered · authn/authz enforced server-side · rate limits on · HTTPS +
security headers · errors/log redaction · dependencies advisory-checked · uploads
bounded · CORS least-privilege. Record the gate result with evidence — a checklist
without executed verification is a claim, not a pass.