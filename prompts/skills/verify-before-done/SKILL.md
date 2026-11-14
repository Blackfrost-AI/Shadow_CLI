---
description: Refuse to declare work done until the completion criteria are re-verified by execution against the real artifact.
when_to_use: Immediately before declaring any task complete, fixed, or passing — and whenever a completion claim is about to be made.
disable-model-invocation: false
user-invocable: true
---

# Verify Before Done — completion is a measured state

Load this skill immediately before you are about to declare a task complete, fixed,
shipped, or passing. If you are about to write "done", "works", "verified", or
"all tests pass", this skill applies.

## The rule

A task is complete only when its ORIGINAL completion criteria — not a weaker proxy —
have been re-verified by execution, in this session, against the real artifact. A
starting process is not readiness; an HTTP response is not correctness; a generated
file is not a release.

## Procedure before any completion claim

1. **Restate the original completion criteria** as something checkable. If they were
   never made checkable, make them checkable NOW and say what they are.
2. **Re-run the decisive checks yourself, now.** The gate is the real suite/gate
   command, executed this session, with its real output — not a summary of an earlier
   run, and not a different, weaker command that passes.
3. **Check identity and negative exposure**: the artifact is the intended one (right
   path, right version), it does what it should, and it does NOT do what it should not
   (forbidden exposure, unintended access, regressions elsewhere).
4. **Report faithfully.** If a gate fails, report the failure with the output — a
   failing check is a result, not an excuse to soften the claim. If a step was skipped,
   say it was skipped.
5. **Completion claim format**: what changed, the exact evidence that each criterion
   now passes, and anything still open. No hedged or partial claims presented as done.

## Common traps

- "The tests passed earlier" — re-run; state may have changed since.
- "It builds, so it works" — build success is a build gate, not a functional gate.
- "The type checker is clean" — types are necessary, not sufficient.
- Testing a nearby or easier command instead of the one that matters.
- Declaring done because time or patience ran out — that is an honest partial report,
  not a completion.
