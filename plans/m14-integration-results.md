# m-14 — Full regression, build, compatibility and security checks

Integration branch `shadow/daily-upgrade` @ `d494fbe` (base `7677ac4` + 8 slice
merges). This file records the m-14 evidence; it is updated as each gate runs.

## Integrated slices (all previously verified in isolation)

| Slice | Commit | Isolated verification |
|---|---|---|
| m5 LSP edit actions | 46d244a | 15/15 new + 49/49 LSP regression |
| m6 commit proposals | 40a3daa | 8/8 real-git tests |
| m7 RPC hardening | bf25492 | 11/11 + 86/86 ACP regression |
| m8 crash restore | bf25492 | 8/8 tests |
| m9 AST edits | 942b520 | 17/17 new + 10/10 journal |
| m10 DAP debugging | fb41578 | 44/44 tests |
| m11 browser relay | 97771b2 | 25/25 tests |
| m12 SSH remote | ae36899 | 25/25 tests |
| m13 advisors | f801315 | 23/23 + 38/38 config + 23/23 budget |

## Gates

| Gate | Status |
|---|---|
| Integrated typecheck (`tsc --noEmit`) | **PASS** — 0 errors |
| Integrated typecheck:all (src+eval+test) | **PASS** — 0 errors after fixing 19 latent errors (see findings) |
| Full test suite (`npm test`) | **PASS — 4025/4025**, 0 fail, 0 skipped (includes 5 new R2/R3 security regression tests + re-scoped proto-pollution test; prior runs: 4016/4016 pre-fix, 3982 with 1 stale-test failure fixed by re-scoping its carrier key per the new `budget` strip) |
| Lint (eslint whole repo) | **PASS** — 0 findings after correct per-file fixes (see recovery record) |
| Touched-surface tests | **PASS** — 111/111 (all 6 modified test files incl. new genuine redaction tests) |
| Build (`npm run build`) | **PASS** — exit 0, dist/ fresh |
| Release gate (`check:release-gate`) | **PASS** — all 6 checks OK |
| Compatibility check (AC wire shapes, config schema) | **PASS** — additive-only (see findings F4) |
| Security review of integrated diff | **COMPLETE — all 3 reviews reported.** R1 (DAP/relay/SSH): 5 vulns fixed (a25fbc4). R2 (RPC/journal): 2 vulns fixed (baea645). R3 (edits/advisors/commits): 3 vulns fixed (baea645). Total **10 confirmed vulnerabilities, all fixed with regression tests**; 24 weaknesses recorded in `plans/m14-security-followups.md` (R1:12, R2:6, R3:6) |

## Lint recovery record (13 findings → 0)

Full-suite run 1 failed at build-hygiene: eslint reported 13 findings on the
integrated branch. Root cause: slices had been verified in isolation with
clean lint, but integration exposed cross-file lint interactions.

Recovery method: restored every edited file from its authoritative slice commit
(`git checkout <slice-commit> -- <file>`), then re-scanned for ground truth
before touching code.

Correct fixes applied and verified per file:

- `src/tools/advisor.ts`: removed unused `performance`/`ProviderEvent` imports;
  watchdog `const` (no `let`), controller declared before the abort call,
  `clearTimeout(watchdog)` unconditionally.
- `src/dap/inspection.ts`: removed stray no-effect `0;` expression.
- `src/tools/mutation.ts`: removed unused `existsSync` import and unused catch
  binding. **Kept** `chmodSync` — genuinely used.
- `src/tools/editTool.ts`: removed unused `MutationError` import.
- `test/mutation.test.ts`: removed `chmodSync` import, dead `MutationCrash`
  class. **Restored** `existsSync` — genuinely used at line 98.
- `test/crash-recovery.test.ts`: removed unused `CrashRecoveryError` import.
- `test/shell-escape.test.ts`: removed unused `readFileSync` import.
- `test/ssh-remote.test.ts`: removed unused `SshRemoteError` import.
  **Restored** `parseProbeOutput` — genuinely used (7 uses).
- `test/advisor.test.ts`: replaced `self = this` alias with
  `const { opts, script } = this`.

Cautionary record: an intermediate fix pass mis-applied fuzzy edits (removed
identifiers that were genuinely used), causing failures; all affected files were
restored from slice commits and re-fixed against accurate scan output. Files
were never hand-reconstructed.

Post-fix verification: eslint whole repo **0 findings**; touched tests **95/95
pass**; typecheck **exit 0**.

## Findings

### F1 — DAP frame redaction contract was NOT implemented (real security defect)

`src/agent/dap/inspection.ts` declares frames surface "only path basename +
line/column (no absolute paths, no home directories)" — in its own header, its
test header, and `docs/DAP_DEBUG.md:24`. The implementation passed the full
absolute `sourcePath` straight through to `DapStackFrame`. The m-10 test
asserting this was a TAUTOLOGY (`... === false || true` always true) that never
verified anything — the defect slipped through isolated slice verification
because slices only ran plain `typecheck`, which excludes tests.

**Fix (source):** `DapStackFrame.sourcePath: string | null` → `sourceBasename:
string | null`; new `redactSourcePath()` strips all directory components (both
`\` and `/` separators, Windows drives, traversal) before storage. No other
consumer of the old field exists (verified by grep).

**Fix (tests):** the tautology is replaced with a genuine end-to-end test that
runs the REAL `stackTrace()` production path against a stub transport carrying
hostile absolute paths (`/home/u/...`, `C:\Users\...`), asserts basename-only
output on the serialized frames, and asserts `sourcePath` no longer exists on
the interface. Also added `redactSourcePath` unit tests (POSIX, Windows,
mixed separators, bare filename, traversal) and a genuine MAX_STACK_FRAMES
truncation test (previously untested).

### F2 — 19 latent type errors in slice test files

`npm run typecheck` (src only) passed, but `typecheck:all` (which the release
gate runs and which includes test files) found 19 errors across 6 slice test
files. Slices were never type-checked including their tests. Root causes and
fixes:

- 8 import-path errors: slice tests used `.ts` extensions; repo convention is
  `.js` (tsx resolves at runtime). Fixed to `.js`.
- `advisor.test.ts`: helpers rejected `undefined` config (the genuine fail-closed
  scenario the tests exercise — an absent advisors block). Parameters widened to
  `| undefined`.
- `browser-relay.test.ts`: a provably-always-true comparison on a literal type
  (`RELAY_BIND_HOST` is `'127.0.0.1'`) — removed the redundant assertion; the
  adjacent strict-equality assertion on the same value remains.
- `dap-gating.test.ts`: adapter SPEC widened `DapAdapterId` to `string`;
  typed explicitly as `DapAdapterSpec`.
- `dap-protocol.test.ts`: used non-existent handler name `onReverseRequest`;
  real name is `onRequest`.
- `ast-edits.test.ts`: base selector objects widened the closed
  `AstEditSelectorKind` union to `string`; `as const`/explicit typing added;
  deliberately-invalid inputs use the file's established `as never` convention.

### F3 — Release gate caught stale dist/

First post-fix gate run refused ("RELEASE BLOCKED: dist/ stale") because the
F1 source change postdated the last build — the freshness check worked as
  designed. After rebuild the gate passed all 6 checks.

### F4 — Compatibility: additive-only, verified against the 7.0.0 baseline

ACP wire (`src/acp/protocol.ts` since 14181b7): no existing method renamed or
removed. New methods are `_shadow/*` (JSON-RPC extension-reserved namespace),
gated behind capability negotiation; new error codes sit in JSON-RPC 2.0's
implementation-defined -32000..-32099 range; `session/close` added. The m-7
peer-level cancellation surface (`tool_call`/`tool_cancel`) is pinned but dormant
(no production handler), so no live-wire behavior changed.

Config (`src/config.ts`): every new key is `.optional()` with safe defaults;
no key was removed; the provider enum was widened (`openai-compat`) with a
backward `.transform()` to the old value. Old config files parse unchanged.

### F5 — Production wiring audit (lead-agent check)

The new capability modules are **libraries with tests, not yet operator-facing
tools**: grep shows no production importer of `astEdits`, `sshRemote`,
`gitCommitProposal`, the LSP `editTool`/`editActions`, `browserRelay`,
`AdvisorService` or the DAP session outside their own modules/tests. The plan's
§10 wording ("independent opt-in integrations") and §11 ("integration and
delivery") requires slices to pass gates and be reviewed — which they now do
on the integrated branch — but does not require each slice to be wired into the
operator-facing tool catalog in this upgrade. Per §11's closing rule this is
recorded explicitly rather than claimed as delivered: **the capabilities are
verified libraries; wiring them into the interactive tool surface is
unfinished operator-facing work beyond this upgrade's verified scope.**

### F7 — Adversarial security review (DAP / browser relay / SSH remote) — COMPLETE

Verdict: **5 confirmed vulnerabilities, 12 weaknesses, 8 notes.** All 5
confirmed vulnerabilities fixed in commit a25fbc4, each with a regression test:

1. redactSourcePath separator bypass — returned the raw absolute path for
   separator-terminated paths. Fixed: strip trailing separators first;
   placeholder for separator-only input.
2. launch() wedge — failed initial breakpoints / refused configurationDone left
   a live adapter child in state `configuring`. Fixed: close-then-rethrow.
3. stderrTail leak — raw adapter stderr (absolute home paths as a matter of
   course) surfaced in summary(). Fixed: redactStderr() masks all
   path-shaped content then credential redaction.
4. Relay credential-array masking gap — `set-cookie: [SESSIONID=...]`-shaped
   values under credential-named keys reached the audit log. Fixed: mask the
   whole subtree when the key names a credential, whatever its shape.
5. SSH journal byte-swap — contentB64 never reconciled with the approved
   contentDigest; same-user payload swap under a valid approval. Fixed:
   decode() re-derives the digest and rejects mismatch.

The 12 weaknesses are recorded verbatim in `plans/m14-security-followups.md`.
Gates re-verified after the fixes: full suite **4016/4016**, typecheck:all
**0 errors**, lint **0 findings**.

### F6 — CLI/renderer/protocol smoke coverage

The plan's §11 requires CLI/renderer/protocol smoke tests. Coverage in the
passing suite: `test/acp-cli.test.ts` (arg parsing, stdin teardown, RPC-mode
stdout/stderr wire discipline), `test/tui-composer-keys.test.ts` +
`test/tui-steer-focus.test.ts` (renderer key routing/focus),
`test/tmux-client.test.ts` (renderer client), `test/web-cli-ux.test.ts`,
`test/cli-base-url-bootstrap.test.ts`, `test/harness-readiness-cli.test.ts`,
`test/legacy-resume-cli.test.ts`. All passed in the 4012/4012 run.
`scripts/smoke-release.mjs` is a CI-only signed-artifact installer smoke test
(requires disposable CI runners) — out of local scope by design.

### F8 — Adversarial security review R2 (ACP RPC / approval binding / mutation journal) — COMPLETE

Verdict: **2 confirmed vulnerabilities, 6 weaknesses, 10 notes.** Both fixed in
commit baea645 with regression tests:

1. Approval seal never rode the wire — the anti-spoofing control was inert;
   every real-editor approval failed closed to total-deny (the only test that
   passed fabricated an echo no real editor produces). Fixed: cli.ts sends
   `{ ...params, _meta: { approvalDigest } }` after sealing; the editor can
   now echo what it actually received. New test:
   `test/m14-security-acp-wire.test.ts` (non-echoing editor fails closed;
   echoing editor authorizes; digest mismatch refused; replay refused).
2. `session/close` during a lazy build wedged the in-flight `session/prompt`
   forever — repeatable to a permanent connection-wide backpressure DoS.
   Fixed: `drive()` emits a terminal frame on the closed return, mirroring the
   queued path. New tests in `test/web-registry.test.ts`.

Also fixed under R3's third finding (see F9): the journal's `bindPreview`
byte-exact re-encode check lives in `src/tools/mutation.ts`.

### F9 — Adversarial security review R3 (edits / advisors / commit proposals) — COMPLETE

Verdict: **3 confirmed vulnerabilities, 6 weaknesses, 8 notes.** All three fixed
in commit baea645 with regression tests:

1. Untrusted price-table injection disarmed every cost cap — project files
   could zero `priceTable`/`budget` and zod accepted 0/negative prices.
   Fixed: `priceTable` + `budget` added to `PROJECT_UNTRUSTED_KEYS`; every
   `ModelPriceSchema` field requires `.positive()`. Consequence test note:
   the old prototype-pollution test used `budget.maxCostUSD` as its
   legit-sibling carrier and now asserts the STRIP (re-scoped to `stream`,
   which remains project-mergeable). New tests:
   `test/m14-security-config.test.ts`.
2. Provider-reported usage trusted without non-negativity — a hostile endpoint
   returned negative usage and erased accrued spend, unbounding retries.
   Fixed: `Budget.recordUsage` rejects non-finite/negative components before
   accruing. New tests: `test/m14-security-budget.test.ts`.
3. astEdits byte-preservation failed on non-UTF-8-representable files — the
   journal compared lossy text views, so preserved regions could be silently
   destroyed. Fixed: `bindPreview` requires byte-exact re-encode
   (`Buffer.from(file.before,'utf8').equals(actualBytes)`) instead of
   comparing decoded views. New tests in `test/mutation.test.ts`.

### Post-fix gate status (final)

typecheck:all **0 errors**; lint **0 findings**; full suite **4025/4025**;
modified-surface tests **111/111**; build **exit 0**; release gate **all 6
checks OK**; compatibility **additive-only verified**. Security reviews
**complete (3/3)**: 10 confirmed vulnerabilities fixed across R1–R3, each with
a regression test; 24 weaknesses recorded for follow-up in
`plans/m14-security-followups.md`. No unfixed confirmed vulnerability remains
in the integrated diff.
