---
description: Audit the local skill stack — index cost, unused entries, stale candidates, and disabled-state coherence.
when_to_use: When the operator asks to audit skills, asks why context is heavy, or before shipping a skills-related change.
disable-model-invocation: false
user-invocable: true
---

# Skills Doctor — local skill-stack audit

Load this skill when the operator asks for a skills audit, a context-cost review, or
when you are about to change anything in the skills system itself.

## What to measure (all local, no egress)

1. **Index cost.** Enumerate the discovered catalog and measure the rendered index block:
   number of skills, total rendered line count, and whether the hard cap truncated it.
   Report the measured cost, not an estimate.
2. **Invocation surface.** For each entry: does it declare `when_to_use`? Is it excluded
   from model invocation (`disable-model-invocation: true`) or user invocation
   (`user-invocable: false`)? Flag entries that are invisible to BOTH surfaces.
3. **Operator-disabled list.** Read `skillsDisabled` from global config and report each
   name — a disabled skill must not silently reappear through any source.
4. **Pending candidates.** List every candidate awaiting review (`/skills pending`) and
   flag any that reference validation receipts that no longer resolve locally.
5. **Shadowing.** Report every conflicts-list row: which copy won and why (precedence is
   workspace → global → plugin → harness → bundled). A repo that shadows a trusted
   skill with its own copy is a finding, not a footnote.

## Reporting rules

- Every number must come from something you ran this session. Say "not measured" when
  you did not measure it; never extrapolate from another session's numbers.
- Distinguish OBSERVED (command output) from INFERRED (your reading of it).
- End with the three cheapest removals (skills to disable or trim) and the measured
  token cost each would recover, per the index you just rendered.

## Red lines

- This audit never sends anything anywhere; all evidence is local.
- Do not edit the catalog during the audit — report first, let the operator decide.
