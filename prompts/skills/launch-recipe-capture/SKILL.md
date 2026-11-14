---
description: Capture a verified launch/build recipe into a per-project skill so future sessions reuse it instead of re-deriving it.
when_to_use: After a launch, build, or serve sequence has been verified end-to-end and the operator wants it captured for reuse, or when repeated failing retries of the same launch sequence are observed.
disable-model-invocation: false
user-invocable: true
---

# Launch Recipe Capture — verified-sequence reuse (anti-loop)

Load this skill when a launch/build/serve sequence has just been VERIFIED end-to-end and
the operator asks to capture it, or when you observe repeated failed retries of the
same launch command — the exact pattern the loop guard eventually halts.

## Why this exists

A verified launch sequence is expensive to produce: wrong paths, wrong env, wrong
command shape, several failed attempts, then finally success. Without capture, the
next session starts from zero and re-derives it — sometimes many times in a row
(observed: 27 consecutive identical failing attempts in one session on a remote device).
Capture converts that one-time cost into a reusable, auditable artifact.

## Capture procedure

1. **Verify before capture.** Only capture a sequence whose final state you have
   actually observed working this session — a boot log is not a ready service. If the
   sequence did not succeed, stop and say so; do not capture a failing recipe.
2. **Record the exact commands** that worked, in order, with the working directory,
   environment variables (names only — never values of secrets), and the success
   check that proved readiness (the response, port, file, or test that was observed).
3. **Record the failure branches** you actually hit and their fixes — these are worth
   more than the happy path. Label each as OBSERVED with the evidence.
4. **Scope it to this project.** The recipe is per-project: name it after the project,
   not the machine, so it travels with the repo.
5. **File it as a candidate through skill_manage** (`/learn` machinery): claims
   grounded in this session's receipts, a replay-style validation that re-runs the
   sequence's cheap parts, and full limits (host, ports, exact versions).
6. **Never activate.** The operator reviews and activates via `/skills activate`.

## Anti-loop rule

If a session finds itself retrying the same launch command that failed before, it must
load this recipe first (or ask the operator to run it) instead of retrying blind.
Retrying a captured-and-failing recipe means the recipe is stale — report that and
update the candidate, do not retry harder.

## Red lines

- No secrets, tokens, or endpoint URLs with embedded credentials in the recipe body.
- Never capture a sequence you did not observe succeeding.
- The recipe never grants itself authority; it is data the operator chose to keep.
