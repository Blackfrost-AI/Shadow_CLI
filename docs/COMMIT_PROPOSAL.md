# Git commit proposals (m6) — scoped, approval-bound, hook-preserving

Status: **module + tests complete (worktree-local)**. No registry wiring —
integration is a main-checkout decision (m14/m15).

## What this guarantees

`src/tools/gitCommitProposal.ts` builds an operator-approved commit that:

1. **Scopes to explicit target paths only.** The proposal lists exactly the
   target paths with their staged statuses; pathspec validation rejects magic
   pathspecs (`:!`, `:!^`, `:(…)`, globs), `..` traversal, absolute paths, empty
   and NUL-containing paths. Only named staged changes are committed.
2. **Preserves unrelated staged changes.** An unrelated staged change survives a
   scoped commit byte-for-byte — only the target is committed. A staged deletion
   commits alone without touching other staged state.
3. **Retains Git hooks.** The pre-commit hook RUNS as part of the proposal; a
   rejecting hook aborts the commit with its output surfaced verbatim, and
   refs/index are untouched by the abort.
4. **No replay.** The approval is a single-use digest bound to
   (treeHash, message, targetPaths); after a hook abort the approval is spent —
   only an explicit fresh approval can retry.
5. **Refuses drift.** Hook tampering between preview and execution is refused by
   name; index drift between preview and execution is refused and recovers once
   the original state is restored.

## Verification

- `npm run typecheck` — **PASS**
- `node --import tsx/esm --test test/git-commit-proposal.test.ts` — **8/8 PASS**
  with REAL git repositories (real hooks, real index manipulation, real commits),
  covering every guarantee above.

## Honest limits

- Module-only: no tool registry entry invokes this yet; the TUI approval seam is
  integration-scope.
- Commit signing, `--amend`, and post-commit hooks are out of scope.
