---
description: Draft, validate, and package a reusable learned-skill candidate from real session evidence.
when_to_use: When the operator asks to capture a reusable workflow, learn a skill, or when /learn or skill_manage candidate drafting is involved.
disable-model-invocation: false
user-invocable: true
---

# Skill Creator — evidence-first learned-skill authoring

Load this skill whenever you are about to draft, update, validate, or package a
learned-skill candidate (the `skill_manage` tool, `/learn`, or `/skills` candidate
review). Its purpose is to make every shipped skill auditable: every reusable claim
must trace to local evidence and a passing validation or replay.

## Operating rules

1. **Never activate.** Activation belongs to the operator alone via `/skills activate`.
   Your job ends at a complete, inspectable candidate.
2. **No activation, no exception.** Even if the operator says "just turn it on" in
   passing, respond with the candidate plus the explicit instruction to review it with
   `/skills show <name>` and activate it themselves.
3. **Evidence or drop the claim.** For every reusable claim in the candidate, either
   point at concrete local evidence (session record, artifact file, test run, review)
   or mark it UNTESTED. Do not write "works" without a receipt.
4. **Fail closed.** If validation cannot run (missing checker, broken harness), the
   candidate is NOT ready — say what is missing and stop. A failed validation is a
   result, not a reason to soften the wording.

## Candidate structure (SKILL.md body)

- **Scope line first.** State exactly when the skill applies and, more importantly,
  when it does not.
- **Procedure as numbered steps**, each grounded in what was actually observed this
  session — not what the docs said should work.
- **Evidence table**: claim → evidence ref (file:line, command, receipt id).
- **Limits section**: environment, scope, and the exact conditions under which the
  procedure was verified. One-off success is not proof of general correctness.
- **No secrets, no credentials, no endpoint URLs with keys** anywhere in the body.

## Validation receipts

A validation must be a real, current run: the named checker executed in this
session, with its output captured and referenced by id. A benchmark from another
session, model, or repo is not a receipt. If the candidate's claims cannot be
validated now, record them as UNTESTED with the reason.

## Anti-patterns

- Copying a sibling model's recipe as ground truth (every checkpoint is a distinct product).
- Inventing evidence refs that look plausible but were not observed.
- Generalizing a one-off fix into a universal procedure without replay.
