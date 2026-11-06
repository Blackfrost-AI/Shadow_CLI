# m-3 Mutation Journal — Audit and Completion Evidence

Worktree: `/Users/craigmac/.shadow/worktrees/daily-upgrade` (branch `shadow/daily-upgrade`, HEAD `df0ba8e3e8a500251325be2f5266544f8f941db4` — the shipped v11.2.0 merge).
Files: `src/tools/mutation.ts` (new, 451 lines), `test/mutation.test.ts` (new, 223 lines).

## Implementation audit (src/tools/mutation.ts)

Verbatim plan gate: "Audit and complete the mutation journal with native tests for approval binding, failure recovery and no replay."

1. **Approval binding**: `prepare()` re-reads every target, rejects drift (`Recorded precondition does not match the file`), re-resolves and rejects symlink escapes, rejects >1 MiB payloads, and binds the exact bytes as base64 (`bindPreview`). `approvalDigest = sha256(JSON(files))` over the bound bytes, checked with `timingSafeEqual` at approve/apply/rollback (`assertDigest`) — a different-content approval is always rejected. State machine: `prepared → approved → applying → applied` and `applied → rolling-back → rolled-back`; every other transition refused.
2. **Failure recovery**: an fsynced `applying`/`rolling-back` marker is durably persisted BEFORE the first target write (fsync of file + parent directory, atomic rename). On any mid-operation failure the state is set to `unknown` and persisted before rethrowing. `reconcile()` never replays and never throws on a single corrupted record; it returns per-file truth (`matches-before`/`matches-after`/`drifted/missing`) for every `applying`/`rolling-back`/`unknown` record so the operator can judge effect, and surfaces corrupted records with `recordProblem`.
3. **No replay**: `apply()` refuses unless state is `approved` and rejects re-apply after `applied`; `rollBack()` only from `applied` and refuses re-rollback after `rolled-back`. Advisory cross-process lock (`acquireLock`) keyed by pid: fail-closed when the holder is live; reclaimed exactly once when the holder is provably dead (ESRCH); unreadable holder fails closed.
4. **Hardening**: journal directory must be real directories created by us (never symlinks, mode 0o700); records must be real files; strict schema validation on read (version 2, UUID id, SHA-256 digests, ISO timestamps, base64 payloads, unique targets); journal files cannot be mutation targets (reserved prefix); workspace-confinement via `realpath` comparisons; targets revalidated immediately before EVERY write; reject absolute paths, `..` escapes, NUL bytes; post-crash state is honestly labeled `unknown`, never silently resolved.

## Test evidence (test/mutation.test.ts, node --import tsx/esm --test)

10 native tests, all passing:

| # | Test | Verifies |
|---|------|----------|
| 1 | prepare binds exact bytes and refuses drifted preconditions | approval binding |
| 2 | approval is bound to exact content and state | approval binding |
| 3 | apply refuses wrong digest → writes → refuses re-apply | no replay |
| 4 | apply marks unknown on injected write failure and never replays | failure recovery |
| 5 | rollback refuses wrong digest, restores exact bytes, deletes created files | rollback integrity |
| 6 | rollback marks unknown on injected failure and reports per-file truth | per-file truth |
| 7 | applying marker is visible to reconcile before writes complete | marker visibility |
| 8 | live lock holder blocks; provably dead holder is reclaimed once | lock semantics |
| 9 | tampered journal records are reported per record without hiding others | reconcile isolation |
| 10 | symlinked targets and journal records are rejected | path hardening |

Commands run and results:
```sh
cd /Users/craigmac/.shadow/worktrees/daily-upgrade
npm run typecheck   # PASS (both this worktree and /Users/craigmac/shadow-oss)
node --import tsx/esm --test test/mutation.test.ts
# ℹ tests 10  ℹ pass 10  ℹ fail 0
npm test
# ℹ tests 3818  ℹ pass 3818  ℹ fail 0  ℹ cancelled 0
```

## Test-fixture corrections during hardening (negative evidence, retained)

- The first crash simulation threw inside `journalWrite` before the record existed on disk (ENOENT in reconcile) — unrealistic; replaced with failure injection into the target writer at the actual crash point.
- Rollback failure was injected into `targetWrite`, but file 2 in that scenario is a created file whose rollback is an `unlink` — moved the injection to `targetUnlink`.
- The lock test assumed pid 2 exists; on macOS it doesn't (ESRCH) so the journal correctly reclaimed the lock — replaced with a real spawned child process (`sleep 30`) as a genuinely live holder, then killed to test reclamation.
- These were test bugs, not journal bugs; the journal behaved correctly in every case.

## Integration status

- `src/tools/mutation.ts` is NOT yet wired into any policy pipeline or tool surface. It is a standalone, tested library that passes m-3's gate as written. m-4+ (shell escape), m-5 (LSP), and m-9 (AST previews) will consume it through their own pipelines.
- Full-suite regression gate: `npm test` → **3818/3818 pass, 0 fail, 0 cancelled** (includes the 10 new mutation tests).

