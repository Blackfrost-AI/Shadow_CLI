# LSP edit actions (m5) — preview-bound rename/format/codeActions

Status: **module + tests complete (worktree-local)**. No registry wiring yet —
integration into the live tool registry is a main-checkout decision (m14/m15).

## Components

- `src/agent/lsp/editActions.ts` — LSP EditAction wire adapter. LSP
  `WorkspaceEdit` payloads are normalized into per-file operations with
  individual before/after hashes and UTF-16 offset decoding (tested with
  emoji). Every operation must be workspace-local and non-duplicated;
  command-bearing code actions are refused outright (an LSP "command" is an
  untrusted execution surface); multi-operation edits with overlapping ranges
  are refused.
- `src/agent/lsp/editTool.ts` — the preview-bound tool wrapper:
  - `propose()` is read-only: it builds the exact before/after plan with
    per-file hashes and never writes.
  - `apply()` is approval-gated and journal-bound: the single-use approval
    digest covers the exact plan; the mutation journal re-reads each target and
    refuses drift, binds approval digests, refuses replay, and restores exact
    bytes on rollback.
  - A failed apply leaves state unknown and reconcile reports truth per file;
    re-apply is refused until reconciled.
  - Server errors (CreateFile/RenameFile/DeleteFile rejected) surface with the
    server's specific error, not a generic failure.

## Verification

- `node --import tsx/esm --test test/lsp-edit-actions.test.ts` — **15/15 PASS**
  (multi-file rename plans, server-refusal surfacing, command-action refusal,
  overlap refusal, UTF-16 offset decoding, per-file fail-closed hashes,
  out-of-workspace/duplicate-target refusal, every malformed-operation shape,
  stale-hash abort, full propose→approve→apply→rollback cycle, failed-apply
  reconciliation, drift refusal, propose read-only, apply approval-gated).
- LSP regression: `lsp.test.ts` 30/30, `lsp-loop.test.ts` +
  `lsp-service.test.ts` 19/19 — **49/49 PASS**, no regressions.
- `npm run typecheck` — **PASS**.

## Honest limits

- tsserver itself is exercised only via the loop's real spawn in
  `lsp-loop.test.ts` cases; adversarial server payloads are fakes (as above).
- Two truncated string literals in the test file (sub-agent stopped mid-write)
  were repaired before this verification; the tests' semantics were unchanged.
- No registry wiring: no tool entry invokes editTool yet.
