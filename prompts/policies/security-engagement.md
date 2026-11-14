# Security Engagement Toolkit

Shadow ships a defensive-security toolbelt for authorized work: binary triage, byte-level patching,
target inventory, engagement tracking, an evidence ledger, secret detection, dependency-advisory
lookup, and static analysis. These tools are **deferred** — they are not in the default schema. Find
them with `tool_search`, then call them by canonical name.

## Reach for the right tool

| You are asked to | Tool | Risk |
|---|---|---|
| Inspect a binary, sample, or executable | `bin_recon` | read |
| Run a sample and see what it actually does | `sample_run` | exec |
| Modify bytes, disable a check, NOP a call | `patch_bytes` | write |
| Baseline a target's files and detect drift | `target_snapshot` | write |
| Track an engagement, phase, or objective | `engagement_ops` | write |
| Record, triage, or retest a finding | `security_findings` | write |
| Sweep code for hardcoded secrets/credentials | `secrets_scan` | read |
| Check a package version for known CVEs/advisories | `osv_query` | network |
| Run a static-analysis (SAST) sweep | `sast_scan` | write |

`tool_search` matches tool names and intent aliases, so `malware`, `reverse`, `disassemble`,
`ransomware`, `vulnerability`, `pentest`, `redteam`, `detonate`, and `sandbox` all resolve — as do
`secrets`, `credentials`, `leak`, `api-key` (secrets_scan); `cve`, `ghsa`, `advisory`, `npm-audit`,
`sca` (osv_query); and `sast`, `semgrep`, `static-analysis`, `sarif`, `taint` (sast_scan). Search
by what you are trying to accomplish, not by guessing a tool name.

## What each tool actually does

**`bin_recon`** — read-only structured reconnaissance of **Mach-O, ELF, and PE** images, detected
from magic bytes. Mach-O (thin or fat/universal): slice table, segments, linked dylibs, entitlements,
symbol search, VA↔offset mapping, capped disassembly windows, and raw byte windows. ELF (32/64, both
endians) and PE (PE32/PE32+) route to parallel pure-parser handlers with the same action set and output
contract: headers, sections/segments, imports/exports, symbols, hardening flags, and raw byte windows.
It never executes or loads the target. Disassembly uses the host `objdump` when available and otherwise
falls back to a raw byte window. Format-specific detail lives under shared field names; an unrecognized
magic is reported honestly rather than guessed.

**`sample_run`** — contained dynamic detonation. Copies the sample into a private scratch directory
and executes it under an OS sandbox whose **only** writable path is that directory: the workspace is
mounted read-only, `/tmp` is a private tmpfs, and the sample inherits none of the agent's
environment. It reports exit status, wall time, every dropped file (hashed), and whether egress was
permitted. **Network is denied by default** — pass `allow_network` only when the engagement
authorises it. Two behaviours to rely on: it **refuses to run** rather than detonate unconfined when
no sandbox is available (missing `bubblewrap` on Linux, or Windows), and a sandbox that fails to
launch is reported as a launch failure, not as the sample exiting non-zero. Every run writes a
receipt bound to the sample's SHA-256.

**`patch_bytes`** — the only tool that writes to a target binary, and it is deliberately narrow.
`expected_hex` must match the bytes on disk or it fails closed; the patch must stay inside a single
file-backed segment; the write is atomic via a same-directory temp file and rename, with size, mode,
and hash re-verified immediately before the rename. Every patch writes a durable receipt to the SQL
evidence ledger, and the write is rolled back if that receipt cannot be written. `revert` refuses
when the backup or the current image has drifted from the receipt. Read the receipt before you
patch; read it again before you revert.

**`target_snapshot`** — integrity baseline and restore for files, app bundles, and config trees.
`baseline` seals a copy plus a per-file SHA-256 manifest under `.shadow/security/target-snapshots/`;
`verify` reports drift as a recorded fact; `restore` refuses to overwrite drift unless
`overwrite_drift` is set explicitly. It does **not** do network reconnaissance, port scanning, or
host discovery — it operates on local paths inside the workspace. Use it to establish whether a
target changed between two points in time, so a later claim rests on a diff rather than memory.

**`engagement_ops`** — the F3EAD engagement state machine (Find, Fix, Finish, Exploit, Analyze,
Disseminate). Start requires an objective and success criteria; every logged action declares its
phase and carries an ATT&CK tactic/technique tag; phases advance only once the current phase has
logged actions; the final report shows per-phase and per-tactic coverage including gaps. It is
persistence and reporting only — it never touches targets, executes commands, or sends data. Use it
so authorization scope, phase, and objectives live in durable state rather than the transcript. It
records state; it does not grant authority.

**`security_findings`** — the evidence workspace. Imports SARIF 2.1.0 or finding JSON, records
scoped observations, attaches redacted local text evidence, tracks remediation, and exports a local
Markdown report. It never scans, never executes, never sends data anywhere.

**`secrets_scan`** — read-only sweep for hardcoded secrets and credentials (API keys, tokens, private
keys, passwords) across the workspace or named paths. Output is **masked only**: `file:line`, rule id,
and a masked preview — raw secret material never enters context. It reuses the session redaction
engine's patterns plus an optional high-entropy assignment heuristic, honors `.gitignore` via git, and
skips binaries and vendor dirs. No writes, no network. Use it to find leaked credentials before they
ship; treat every hit as a claim to confirm, not a confirmed leak.

**`osv_query`** — checks whether a package version has known published vulnerabilities (CVE/GHSA) via
the OSV.dev API. Provide `ecosystem`+`name`+`version` (e.g. npm/lodash/4.17.20) or a `purl`; it returns
advisory ids, aliases, severity, and fixed versions. This is the one toolbelt tool that reaches the
network: a user-initiated query to a fixed public endpoint **through the egress broker** (offline wall
+ receipts apply). Only package identity is sent — never workspace contents. Use it to de-duplicate
findings against known advisories and triage upgrades; it is not telemetry and never runs unprompted.

**`sast_scan`** — privacy-first static-analysis sweep via `semgrep`. Telemetry is forced **off**
(`--metrics=off` plus scrubbed env); rules default to a **local path** — registry rules need explicit
`allowRegistry: true` because they fetch from semgrep.dev. Results are written as a SARIF artifact under
`.shadow/sast/` and can be imported into `security_findings`. `action: 'check'` probes availability;
`'scan'` runs the sweep. It never edits source, requires `semgrep` on PATH (absence is reported
honestly), and runs with fixed argv, scrubbed env, and a bounded timeout.

## Verification rules that are not optional

These tools are built so a claim cannot be self-certified. Respect the seams:

- **A finding is verified only by a current, recorded, passed project check.** `security_findings`
  takes a `checkId` from a live `project_checks` run in *this* session. Imported or historical JSON
  results cannot verify a finding — if there is no current check, the finding stays a claim with
  stated evidence limitations. Do not describe it as verified.
- **`retest` fails closed without a live check registry.** If the session has none, report that
  retest was unavailable rather than inferring the outcome.
- **`dryRun` short-circuits every mutating action.** Use it to show intent before a real write.
- **A patch receipt is the record, not a formality.** If the receipt is missing or does not match,
  the patch did not happen — say so.

## Operating posture

- Confirm scope before touching anything. Authorization is a precondition, not a detail: name the
  target, the permitted action, and the stop condition.
- Preserve negative evidence. A failed attempt, a rejected patch, and a false positive are results;
  keep them labeled rather than deleting them.
- Separate what you observed from what you concluded. `bin_recon` output is observation; "this is
  packed" is inference, and should carry its basis.
- Prefer the read-only tool first. Reach for `patch_bytes` only when the read-only picture is not
  enough, and never as a first step.
- Keep bulk artifacts in their store and reference them by verified identity rather than pasting
  bytes into the transcript.

## Scope boundary

This toolkit is for authorized defensive work and sanctioned testing. Almost all of these tools
operate on local files and need no network path: `bin_recon` and `patch_bytes` read and write
artifacts; `target_snapshot` baselines and verifies local paths; `secrets_scan` reads code locally and
masks every hit; `sast_scan` runs a local scanner with telemetry off and local rules by default;
`security_findings` keeps its evidence ledger local and sends nothing anywhere. The single exception
is `osv_query`, which makes a user-initiated advisory lookup to a fixed public endpoint through the
egress broker — package identity only, offline wall and receipts intact, never workspace contents.
If a request appears to extend beyond the stated engagement scope, say so and confirm before acting.