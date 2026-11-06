# Browser relay (opt-in authenticated attachment)

Mission m-11. Status: **policy core implemented and unit-tested; browser-side transport
not implemented** — see [Limitations](#limitations).

## What this is

`src/web/browserRelay.ts` is an **opt-in** authenticated channel between Shadow and a
browser extension / native messaging host. It brokers exactly **one** selected tab or
profile — the one the operator explicitly attached — and nothing else.

It is not a browsing tool, it is not registered anywhere, and it does not change any
default. Isolated browsing remains the default posture (see below). The relay exists
only for the case where the operator deliberately wants Shadow to act inside one real,
already-running browser context, one action at a time, under explicit approval.

## What remains isolated by default

Everything. Concretely:

- **Isolated browsing is the default and stays the default.** Shadow's browser automation
  is the pinned Playwright MCP preset (`shadow mcp enable browser`), which drives an
  isolated, throwaway Chrome profile. The web research tools (`web_fetch`, `web_search`)
  run sandboxed. None of that imports, calls, or is affected by the relay module.
- **The relay is disabled by construction.** It is not registered in any tool registry
  and no module in `src/` imports it. An integration slice that wants to expose it must
  do so explicitly. Until then the code is inert: creating one changes nothing.
- **No port exists until an operator approves an attach.** Before attachment the relay
  has no listener, no port, and answers every request with a generic refusal.
- **No telemetry.** The relay opens exactly one loopback listener and talks to nothing
  else. There is no outbound traffic of any kind.

## The opt-in flow

```
operator picks a tab/profile
        │
        ▼
operator.attach(target)  ── ask(): operator shown {kind: attach, target, digest}
        │                        approval = returning that exact digest
        ▼
listener binds 127.0.0.1 (ephemeral port)   [no grant exists yet]
        │
        ▼
operator.grant('navigate') ── ask(): operator shown {kind: grant, target, action, digest}
        │                        each of navigate/click/form-fill/read-dom is separate
        ▼
host sends POST /action/navigate {targetId, detail}
        │  Host → Origin → Referer → token → attached → fresh → scope → grant
        ▼
dispatch seam forwards to the browser host; result redacted before return
```

Every step is operator-initiated. There is no path where the relay asks for anything or
opens anything on its own.

## Authentication

- **Per-session bearer token**: 256 bits from `crypto.randomBytes`, minted at relay
  creation, handed to the messaging host out of band (`operator.token()`).
- **Required on every request**, extracted from the `Authorization: Bearer` header only —
  never from a URL or query string, which end up in logs.
- **Constant-time comparison** (`timingSafeEqual`) that cannot throw on length
  mismatch; a wrong token is indistinguishable from a missing one.
- **The token is never logged and never persisted.** It is registered with the global
  redaction machinery (`registerSecret`) so even an accidental echo is masked, and
  `close()` destroys it. Nothing re-mints it.
- **Missing/wrong token → 401 `{error: refused}`**, byte-identical for both cases.

## Origin validation (same-origin policy on the loopback listener)

All three headers are checked against the listener's own literal identity, in this order:

1. `Host` must be exactly `127.0.0.1:<port>`. This is the DNS-rebinding defense: a
   rebound page still sends the attacker's hostname, so it cannot pass. `localhost`,
   `[::1]`, a missing port, and any other name are refused.
2. `Origin` must be **present and exactly** `http://127.0.0.1:<port>`. Unlike the web
   console (which tolerates absent Origin for non-browser clients), the relay refuses a
   missing Origin: its only legitimate client is the messaging host, which can assert
   its origin explicitly, while a rebound page or a sandboxed iframe (`Origin: null`)
   cannot. All other values — `evil.com`, wrong port, `https`, `null` — are refused.
3. `Referer`, when present, must match the loopback origin.

Every failure is the same generic **403 `{error: refused}`**: no detail leak, no way to
distinguish hostile-origin from bad-host from anything else. Additionally, the listener
binds the **literal `127.0.0.1`** — never `0.0.0.0`, never a resolvable hostname — and
only exists while a target is attached.

## Scoped targets

The relay is bound to the exact tab/profile chosen at attach time. Every request must
name that target (`targetId`), and any other value — including another live tab, a
profile id, or an empty string — is refused with `scoped target mismatch`. Grants never
transfer: each grant digest is computed over `(target kind, id, label, action)`, so an
approval obtained for one target cannot be replayed against another. A re-attach (even
to the same target) clears all grants — nothing survives the attach boundary.

## The grant model

There are **four independent grants — `navigate`, `click`, `form-fill`, `read-dom` —
and no blanket grant.** Each one:

- is requested separately through the operator gate (`ask()`), which is shown the exact
  target and action plus a SHA-256 digest;
- is approved only by the operator **returning that exact digest** — the same
  approval-digest binding as `src/tools/mutation.ts`, applied to `(target, action)`
  instead of file bytes;
- is **re-derived and re-compared on every later use**, so a grant cannot silently
  cover a different action or a different target;
- can be individually withdrawn (`operator.revoke()`).

Reusing a granted action does not re-prompt. Granting a new action always prompts. A
`navigate` grant does not allow `click`; nothing allows anything but its own action.

## Redaction guarantees

Raw cookies and credentials are never exposed:

- Any key naming credential material — `cookie`, `authorization`, `token`, `secret`,
  `password`, `api key`, `session`, … — is replaced with `[redacted]` **whatever its
  value looks like**. Shape matching is not trusted here, because a tab snapshot can
  carry credentials in arbitrary forms.
- Every other string passes the house shape-based scrubber (`redactString`), which also
  masks the relay token itself and known credential shapes (`Bearer …`,
  URLs with embedded passwords, JWTs, provider keys).
- Redaction applies to **the audit log, every tool result, and every error path**,
  including broker failures — the failure record stores the redacted detail, never the
  raw one. The dispatch transport alone sees raw detail (it must, to act); everything
  Shadow keeps or returns is redacted regardless of what comes back.
- Key names remain visible for auditability; values do not.
- **No raw credential storage**: the audit log keeps at most 512 entries, in memory
  only, and `close()` clears it.

## Stale attachment and disconnect

- When the messaging host reports the target gone (`POST /disconnect`), the relay marks
  the attachment **stale**, clears every grant, and refuses all further actions with an
  explicit `410 stale attachment` error. New grants are also refused on a stale
  attachment — a dead target accrues nothing.
- Recovery requires a **fresh explicit attach**: the operator gate runs again, and no
  previous grant survives.
- `operator.close()` is terminal teardown: it kills the listener and every open socket,
  clears all grants, the attachment, the audit log, and the token. A closed relay
  answers nothing and reattaches nothing (`401 refused`).

## Failure behaviour

| Situation | Result |
|---|---|
| Hostile/missing Origin or Host, foreign Referer | `403 {error: refused}` (identical shape) |
| Missing or wrong token | `401 {error: refused}` (identical shape) |
| No attachment / relay closed | generic refusal |
| Action without its grant | `403 no operator grant for <action>` |
| Request names another target | `403 scoped target mismatch` |
| Target disconnected | `410 stale attachment` |
| Operator refused an approval | `409 operator refused …` |
| No browser transport wired | `503 no broker transport` (never pretends to act) |
| Broker transport failed | `502 broker failure` (audited, redacted) |

## Limitations

- **The browser-side transport is not implemented.** The `dispatch` seam is injectable
  and unimplemented in this slice; with no transport, every authorized action fails
  closed with `503 no broker transport` rather than pretending to succeed. Until a
  native messaging host / extension integration exists and is tested end-to-end, the
  relay is a verified policy core, not a working browser control.
- **The relay validates and audits; it does not sandbox the browser.** Actions inside
  the attached tab run with that tab's privileges. Redaction protects Shadow's logs and
  tool output, not the live page: attaching a logged-in tab grants that tab's power to
  Shadow action-by-action.
- **Disconnect detection is host-reported.** A lying host can keep a dead attachment
  looking alive; the operator's re-attach gate and `close()` are the backstops.
- **Loopback stops remote hosts, not local processes.** Any process in the same user
  session could attempt a connection; the token and the operator gate are the inner
  defenses. On a shared machine, keep the relay closed.
- **Shape-based redaction is best-effort** for credentials under innocuous keys in
  novel shapes — the same documented limitation as `src/util/redact.ts`.
