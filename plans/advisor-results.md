# m13 — Opt-in Bounded Advisors: Results

**Status: COMPLETE (slice-local)** — worktree `m13-bounded-advisors`, base `c99c7e1`
(+ merged m3/m4 commits through `7677ac4`). Not yet integrated into the main checkout.

## What shipped

`src/agent/advisor.ts` — `AdvisorService`: a second-opinion channel with all six
invariants enforced structurally:

| # | Invariant | Enforcement |
|---|-----------|-------------|
| 1 | Default disabled | No `advisors` config block ⇒ every consultation refused pre-I/O (`advisors-disabled`) |
| 2 | Explicit selection | Allowlist of named provider+model pairs; only caller-supplied context; request type has no session-context field |
| 3 | Hard bounds | Caps from config only (all three required); pre-flight estimate check; per-axis mid-flight checks via real `Budget`; wall-clock watchdog abort |
| 4 | Visible egress | `announce()` before any bytes leave (veto ⇒ no egress); `record()` always fires with the honest outcome |
| 5 | No mutation authority | Request carries `tools: []`; result frozen; compile-time `AssertNoAuthority` assertion; stray tool traffic discarded unread |
| 6 | Cancellation | Composite abort signal; classification by which signal fired; honest spent-wall-clock; nothing refunded |

`src/config.ts` — `advisors` schema (default disabled, caps required, endpoints
allowlist, `maxAttempts` bounded 1..3) + `advisors` added to
`PROJECT_UNTRUSTED_KEYS` so a cloned repo cannot open an egress channel.

## Defects found and fixed during verification

1. **`advice` never reached the result** (real defect): `attemptLoop` computed the
   joined advice but `settle()` had no parameter for it — every `completed`
   result returned `advice: undefined`. Fixed by threading advice through
   `settle()` (empty ⇒ `undefined`).
2. **Project-config egress hole**: `advisors` was missing from
   `PROJECT_UNTRUSTED_KEYS`, so a project-local `shadow.config.json` could
   enable the advisor egress channel despite the schema comment claiming
   global-only. Fixed + regression test with the real `loadConfig`.

## Verification (all in `m13-bounded-advisors`)

- `npm run typecheck` — **PASS** (0 errors)
- `node --import tsx/esm --test test/advisor.test.ts` — **23/23 PASS**
  - All 6 invariants individually; refusal paths (empty request, disabled,
    no endpoints, incomplete caps, endpoint not allowed, factory error,
    cost-not-verifiable, operator veto); pre-flight token/cost caps;
    mid-flight tokens/cost/wall-clock caps with per-axis reasons;
    external-abort classification; unrecoverable-error retry bound; frozen
    result; project-config strip via real `loadConfig`.
- Touched-surface regression — **38/38 config tests PASS**
  (`config-atomic`, `config-gate`, `config-security`, `p0-config-untrusted`,
  `budget-guard`) and **23/23 budget tests PASS** (`p3-09-subagent-budget`,
  `context-budget`).

## Limitations

- No production wiring yet: `AdvisorService` is exported but nothing in the
  TUI/CLI invokes it — the integration seam (announce → renderer notice,
  record → transcript, endpoint factory → real `createProvider`) is left to
  m14/m15 integration. The hooks interface is the contract for that seam.
- No full-suite run in this worktree yet (deferred to m14).
- No commit made in this worktree yet — changes are working-tree only.
