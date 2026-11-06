# Mission m-9 — Scoped AST edit previews (deterministic matches + mutation journal)

Worktree: /Users/craigmac/.shadow/worktrees/m9-ast-edits @ 7677ac4 (isolated; no other dirs touched)

## Gate (plan §8 — Structural editing)
Narrowly declared language scope: TypeScript/JavaScript only. Deterministic AST-backed
previews with match counts and checksums. Source-range edits preserve unrelated
formatting/comments. Reject unsupported syntax/ambiguous matches. Reuse mutation
approvals, drift checks, recovery. Never call a syntactic transform a semantic rename.

## Empirically verified parser facts (scratch-probe*.mjs, TS 5.9.3)
- `[node.getStart(sf), node.end)` = first real token (incl. modifiers) .. closing brace;
  leading/trailing comments and newlines are OUTSIDE the range (byte-preserved).
- `sf.parseDiagnostics` exists at runtime but is NOT in the public d.ts → access via a
  narrow structural view; fail closed if missing/unusable.
- Getters/setters/constructors are NOT MethodDeclaration → honest zero-match for the
  method selector. Object-literal methods ARE MethodDeclaration.
- Identifier nodes exist only for real identifier tokens; strings/comments never match.
- `getLineAndCharacterOfPosition` works for all kinds; UTF-16 offsets.
- TS error recovery is aggressive: `const await = 1;` parses CLEAN. Broken splices
  (truncated declarations, `x.y` for an identifier) DO produce parse errors.
  → TWO independent syntax gates are required (post-parse + replacement-shape).

## Design decisions

1. **Scope**: extensions exactly `.ts .tsx .js .jsx` (exact lowercase match). Anything
   else → `unsupported-language` refusal naming the extension and the supported set.
   No graceful degradation, no other language attempted.
2. **Selectors (closed set)**: `{kind:'method', name}` matches MethodDeclaration nodes
   whose property-name text equals `name`; `{kind:'identifier', name}` matches
   Identifier/PrivateIdentifier tokens by text. ALL matching nodes are collected; a
   proposal exists ONLY when exactly one candidate exists. Zero → `no-match`;
   >1 → `ambiguous-match` listing EVERY candidate (file, 1-based line/character,
   0-based [start,end) offsets), sorted by offset. Never picks the first silently.
3. **Splice, never reprint**: after-text = before[0..start) + replacement + before[end..).
   Untouched regions are byte-identical by construction and asserted in tests.
4. **Gate order**: (a) selector/path/scope validation, (b) deterministic match resolution,
   (c) splice, (d) POST-PARSE validation — multiset comparison of (code|message) keys so
   pre-existing errors that shift position are not misclassified; any residual error →
   `invalid-syntax` pre-write, (e) replacement-shape validation — methods must parse
   (same script kind) as exactly ONE MethodDeclaration covering the replacement bytes;
   identifiers must scan as exactly one token of the same kind. Empty method
   replacement = explicit deletion (parse gate still applies).
5. **Journal integration**: the module performs NO writes. The proposal carries
   `journalFiles` in the journal's exact StoredMutationFile shape; every write goes
   through createMutationJournal (prepare re-reads disk and refuses drift; approve binds
   the digest; apply refuses replay; rollBack restores exact bytes; reconcile reports
   per-file truth). prepareAstEdit(journal, proposal) is the binding seam and surfaces
   MutationError VERBATIM. No new approval machinery.
6. **Checksums**: SHA-256 of whole before-text, original slice, replacement, whole
   after-text — independently recomputable (tested against node:crypto).
7. **Honest labeling**: description = "syntactic replacement of 1 source range (…)";
   "rename" appears only negated ("NOT a semantic rename").
8. **Fail-closed parsing**: if parseDiagnostics is missing/unusable, the edit is refused.
   Binary files (NUL sniff) and >1 MiB files (journal's own cap) refused pre-parse.

## Files
- src/tools/astEdits.ts (new) — the module (no writes, journal-bound proposal)
- test/ast-edits.test.ts (new) — spec's 8 cases + shape-gate case + positive .js case
- docs/AST_EDITS.md (new) — scope/determinism/rejection/journal/labeling/limitations

## Verification
- node --import tsx/esm --test test/ast-edits.test.ts → all pass
- npm run typecheck → clean
- No full npm test suite. No commit.

## Status
- [x] Orient: worktree at 7677ac4, journal API read in full, parser probed
- [ ] Implement src/tools/astEdits.ts
- [ ] Tests
- [ ] Docs
- [ ] Green runs + report
