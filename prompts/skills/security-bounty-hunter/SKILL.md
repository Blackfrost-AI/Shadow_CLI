---
description: Hunt for exploitable, bounty-worthy vulnerabilities — remotely reachable, user-controlled paths that qualify for real reports, not noisy local-only findings.
when_to_use: When scanning a repository for reportable vulnerabilities, triaging "does this actually pay?", or preparing a responsible-disclosure or bounty submission.
disable-model-invocation: false
user-invocable: true
---

# Security Bounty Hunter

Practical vulnerability discovery for authorized testing, responsible disclosure, or
bounty submission — not a broad best-practices review. Adapted for Shadow from the
local ECC plugin pack; every step below uses Shadow's shipped toolbelt.

## Scope gate (first, always)

1. Confirm authorization: program rules, SECURITY.md, disclosure channel, exclusions.
   No scope, no hunt — ask the operator.
2. For a multi-phase engagement, track it: `engagement_ops` (objective, success
   criteria, F3EAD phases, ATT&CK tags) so scope and findings live in durable state,
   not the transcript.
3. Baseline the target before touching anything: `target_snapshot` gives you a
   per-file SHA-256 manifest so later claims rest on a diff, not memory.

## In-scope patterns (consistently reportable)

| Pattern | CWE | Typical impact |
| --- | --- | --- |
| SSRF through user-controlled URLs | CWE-918 | internal network access, metadata theft |
| Auth bypass in middleware/API guards | CWE-287 | unauthorized account or data access |
| Deserialization / upload-to-RCE paths | CWE-502 | code execution |
| SQL injection in reachable endpoints | CWE-89 | exfiltration, auth bypass |
| Command injection in request handlers | CWE-78 | code execution |
| Path traversal in file-serving paths | CWE-22 | arbitrary file read/write |
| Auto-triggered XSS | CWE-79 | session theft, admin compromise |

## Skip these (low-signal unless the program says otherwise)

- Local-only `pickle.loads` / `torch.load` with no remote path
- `eval()` / `exec()` in CLI-only tooling; `shell=True` on fully hardcoded commands
- Missing security headers alone; generic rate-limit complaints without impact
- Self-XSS requiring manual paste; CI/CD injection outside program scope
- Demo, example, fixture, or test-only code

## Workflow (Shadow toolbelt)

1. **Map entrypoints.** `repository_context` (semantic navigation, honest lexical
   fallback) for HTTP handlers, uploads, webhooks, background jobs, parsers.
2. **Triage with static tooling — as input only.** `sast_scan` (semgrep bridge:
   metrics off, local rules by default; registry rules need explicit opt-in).
   Filter its SARIF: drop tests/demos/vendored code and non-reachable paths; keep
   findings with a clear network or user-controlled route.
3. **Sweep for planted credentials.** `secrets_scan` — masked output only; a leaked
   key with a reachable service is often the highest-value finding in the repo.
4. **Check dependency reachability.** `osv_query` for known CVEs/GHSAs in the exact
   versions in use — a known advisory is a duplicate, not a bounty.
5. **Read the real code path end to end.** `read_file` / `grep`; prove user control
   reaches a meaningful sink. Never report a sink you have not traced to a source.
6. **Prove it, minimally and safely.** Smallest PoC that demonstrates impact inside
   the engagement's authorization. For binaries: `bin_recon` (read-only triage of
   Mach-O/ELF/PE) before anything else; `sample_run` detonates under an OS sandbox
   with network denied by default; `patch_bytes` only with explicit authorization,
   expected-hex gating, and its durable receipt.
7. **Record as you go.** `security_findings` — scoped observations, redacted local
   evidence, remediation tracking. A finding is *verified* only by a current,
   recorded, passed `project_checks` run; everything else stays a labeled claim.
8. **De-duplicate.** Check advisories (`osv_query`), CHANGELOGs, and open tickets
   before drafting.

## Report structure

```markdown
## Description
[What the vulnerability is and why it matters]
## Vulnerable Code
[File path, line range, small snippet — redact any secret material]
## Proof of Concept
[Minimal working request or script]
## Impact
[What the attacker can achieve]
## Affected Version
[Version, commit, or deployment target tested]
```

Export the evidence-backed writeup via `security_findings` (local Markdown report).
Nothing is ever uploaded — the operator submits through the program's channel.

## Quality gate before submitting

- Code path reachable from a real user/network boundary; input genuinely controlled
- Sink meaningful and exploitable; PoC actually executed and observed
- Not already covered by an advisory, CVE, or open ticket
- Target in scope; evidence (commands, receipts, hashes) attached
- No secret material in the report — masked forms or pointers only