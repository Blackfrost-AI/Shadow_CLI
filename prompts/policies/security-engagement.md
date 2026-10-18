# Security Engagement Toolkit

Shadow ships a defensive-security toolbelt for authorized work: binary triage, byte-level patching,
target inventory, engagement tracking, and an evidence ledger. These tools are **deferred** — they
are not in the default schema. Find them with `tool_search`, then call them by canonical name.

## Reach for the right tool

| You are asked to | Tool | Risk |
|---|---|---|
| Inspect a binary, sample, or executable | `bin_recon` | read |
| Run a sample and see what it actually does | `sample_run` | exec |
| Modify bytes, disable a check, NOP a call | `patch_bytes` | write |
| Baseline a target's files and detect drift | `target_snapshot` | write |
| Track an engagement, phase, or objective | `engagement_ops` | write |
| Record, triage, or retest a finding | `security_findings` | write |

`tool_search` matches tool names and intent aliases, so `malware`, `reverse`, `disassemble`,
`ransomware`, `vulnerability`, `pentest`, `redteam`, `detonate`, and `sandbox` all resolve. Search
by what you are trying to accomplish, not by guessing a tool name.

## What each tool actually does

**`bin_recon`** — read-only structured reconnaissance of a **Mach-O** binary (thin or
fat/universal): slice table, segments, linked dylibs, entitlements, symbol search, VA↔offset
mapping, capped disassembly windows, and raw byte windows. It never executes or loads the target.
Disassembly uses the host `objdump` when available and otherwise falls back to a raw byte window.
It is Mach-O only — do not claim ELF or PE support it does not have.

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

This toolkit is for authorized defensive work and sanctioned testing. None of these tools needs a
network path — they all operate on local files. `bin_recon` and `patch_bytes` read and write
artifacts; `target_snapshot` baselines and verifies local paths; `security_findings` keeps its
evidence ledger local and sends nothing anywhere. If a request appears to extend beyond the stated
engagement scope, say so and confirm before acting.