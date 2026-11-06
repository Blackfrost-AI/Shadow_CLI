# AST edits (scoped, deterministic, journal-bound)

Mission m-9. Status: **module complete and unit-tested; no registry wiring — the
module is a preview/journal seam only.**

## Scope

`src/tools/astEdits.ts` supports exactly `.ts`, `.tsx`, `.js`, `.jsx`. Any other
extension (including `.TS` case variants, which normalize to the supported set)
is refused with `unsupported-language` before any parsing. Binary files (NUL
sniff), empty files, and files over 1 MiB are refused pre-parse.

## What this is — and is not

This is a **syntactic source-range replacement** tool. It is NOT a refactoring
engine and NOT a rename tool: it never resolves bindings and never rewrites
call sites. Every preview's description says so ("syntactic replacement of 1
source range …; NOT a semantic rename").

## Guarantees

1. **Deterministic matches.** A selector (`{kind:'method'|'identifier', name}`)
   resolves against the real parsed AST. A proposal exists ONLY when exactly
   one node matches. Zero matches → `no-match`. More than one → `ambiguous-match`
   listing EVERY candidate (1-based line/column, 0-based offsets, snippet),
   sorted by offset — the first match is never silently picked.
2. **Byte preservation.** Edits are computed by splicing the ORIGINAL text at
   `[start, end)`. The AST is never re-printed; every byte outside the replaced
   range — comments, formatting, unrelated code — is preserved exactly and this
   is asserted in tests.
3. **Post-parse gate.** The spliced after-text is re-parsed; any parse error the
   ORIGINAL did not already have (multiset comparison of code+message keys) is
   refused pre-write as `invalid-syntax` with the offending diagnostics listed.
4. **Replacement-shape gate.** TS's error-tolerant parser accepts many
   semantically-wrong programs as syntactically clean, so shape is checked
   independently: identifier replacements must scan as exactly one identifier
   token (rejecting keywords like `await`, and multi-token/multi-node inputs);
   method replacements must parse as exactly one MethodDeclaration covering its
   own bytes. Both gates are required; each rejects cases the other misses.
5. **Verifiable checksums.** SHA-256 of the whole before-text, the original
   slice, the replacement, and the whole after-text — independently
   recomputable with `node:crypto`.
6. **No writes from this module.** `previewAstEdit` performs no filesystem I/O.
   `prepareAstEdit` is the only seam to a write: it hands the exact previewed
   bytes to the mutation journal, which re-reads the target and refuses drift,
   binds approval digests, refuses replay, and restores exact bytes on rollback.
   Journal errors surface verbatim.

## Honest limits

- Getters, setters, and constructors are not `MethodDeclaration` nodes — the
  method selector reports an honest zero-match for them rather than
  approximating.
- String/numeric/computed property names are not identifier-backed and are
  reported as no-match rather than silently skipped.
- Replacing one identifier token does not rename anything else: other
  occurrences of the same name are separate candidates and make the selector
  ambiguous. This is by design — a syntactic tool must not pretend to be a
  semantic renamer.

## Verification

- `node --import tsx/esm --test test/ast-edits.test.ts` — **17/17 PASS**
  (scope refusals, binary/oversize refusals, zero/ambiguous-match refusals with
  full candidate listings, byte preservation, both gate orders, checksum
  recomputation, journal drift refusal, positive `.js` case, selector
  validation, getter/setter honesty).
- `node --import tsx/esm --test test/mutation.test.ts` — **10/10 PASS** (the
  shared journal regression, unaffected).
- `npm run typecheck` — **PASS**.

## Limitations

- No registry wiring: no tool entry invokes this module yet (integration is a
  main-checkout decision, m14/m15).
- No full-suite run in this worktree.
