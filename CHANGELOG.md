# Shadow release notes

## 10.4.0 — 2026-10-18

Six capabilities adapted from DeepSeek Harness (MIT — see `THIRD_PARTY_NOTICES.md`).

- **Read-only confinement is now real on macOS and Linux.** The `read-only` sandbox mode threads
  through both the Seatbelt profile and the bwrap flags, so it is an enforced boundary rather than
  a label. Use it for detonation work, where the code under test is hostile.
- **A Landlock backend for Linux.** Shadow can confine `run_shell` with the Landlock LSM, which
  needs no unprivileged user namespaces — so it works in containers and on hardened Kali images
  where bubblewrap cannot start. It is preferred when read confinement is requested and falls back
  to bubblewrap otherwise.
- **The model is told its own confinement every request.** The effective sandbox mode, workspace
  root, granted roots and offline state ride in the system prompt. When confinement was requested
  but no backend exists, the prompt says so explicitly instead of claiming a boundary the kernel is
  not providing.
- **Oversized tool output is spilled, not discarded.** A large `grep` or build log now lands in a
  private file under the session tree and the model gets a preview plus a locator, so it can read
  the rest instead of re-running the command or guessing. Any failure to write falls back to the
  previous truncation.
- **Waterfall hook chains.** In-process middleware with `next()` — short-circuit, wrap, and rewrite
  — for transforms the shell-hook runner cannot express, such as redacting a tool result before the
  model sees it.

## 10.3.2 — 2026-10-18

- Fix `shadow update` reporting a DNS timeout as a missing host. Every lookup ran under a 1.5s
  budget and the timeout was swallowed, so a cold resolver (fresh Linux install, VPN, container
  DNS) could report the release bucket as permanently gone while it was reachable — the error read
  `could not be resolved`, indistinguishable from NXDOMAIN.
- The budget is now 5s and overridable with `SHADOW_EGRESS_DNS_BUDGET_MS`, and the two failures
  are distinct: a timeout names the budget and the override, a genuine empty answer reports no
  A/AAAA records. Both still fail closed.

## 10.3.1 — 2026-10-18

- Add a working indicator to the terminal tab title: a braille frame leads the title while a turn
  is in flight, and the title is rewritten bare the moment it ends, so an idle tab is completely
  still. The glyph leads because tab strips truncate on the right. `--reduced-motion` shows a
  single static `●` that still reads as busy.
- Settle `running` and the title inside a `finally` so a failing display helper can never leave the
  tab animating forever, and route mid-turn renames through the activity path so the spinner is not
  dropped.
- Add a pty test that drives the real interactive TUI against a mock streaming provider and asserts
  the frame changes mid-turn and the last title written is idle.

## 10.3.0 — 2026-10-18

- Add contained detonation (`sample_run`): run an untrusted sample under an OS sandbox whose only
  writable path is a private scratch directory — workspace read-only, `/tmp` a private tmpfs, no
  inherited environment, network denied unless the engagement authorises it. Every dropped file is
  enumerated and hashed and the receipt is bound to the sample's SHA-256. With no sandbox
  available it refuses to run rather than detonating unconfined.
- Thread an exclusive write root through both the seatbelt and bwrap backends so containment is the
  same guarantee on macOS and Linux.
- Fix `tool_search`: it now matches intent aliases and natural language, returns the full argument
  schema, and promotes what it finds into the active tool list. Previously it ignored aliases,
  returned a bare name and never promoted, so a model could discover a tool it could not call.
- Fix a detonation shell argument off-by-one and validate containment before the sample runs rather
  than after.

## 10.2.0 — 2026-10-17

- Make the security toolkit discoverable: `tool_search` resolves `malware`, `ransomware`,
  `shellcode`, `c2`, `ioc`, `reverse`, `pentest`, `redteam`, `vuln`, `sarif`, `drift` and
  `triage` to the right tool, where `bin_recon` was previously reachable only by already knowing
  the word "recon".
- Add a security engagement policy covering when to reach for each security tool and which
  verification rules are not optional: a finding is verified only by a current recorded
  `project_checks` run, `retest` fails closed without a live registry, and a patch receipt is the
  record.

## 10.1.0 — 2026-10-12

- Add reusable project checks and bounded completion corrections under existing permissions,
  cancellation and budgets. Shell and shared-workspace agent mutations invalidate earlier checks.
- Add a context inspector with persistent file pins, exact managed-source exclusions, and clear
  captured-request versus provisional estimates.
- Add previewed file/hunk stage, unstage and restore, stale-state protection, retained backups,
  guarded rewind, and scoped review-to-fix prompts.
- Add local session search across explicitly selected projects, pins, tags and lineage;
  cross-project results provide a launch command without changing the active workspace.
- Add versioned executable workflows with typed inputs, no-call previews and local provenance.
  Existing Markdown runbooks remain inspectable.
- Add versioned JSON/JSONL automation, final JSON-schema validation, stable exit codes and
  ephemeral transcripts. Schema failure never replays completed tool actions.
- Add optional post-save onboarding capability probes and dated exact-endpoint capability history.
  Skips, cancellation and failures preserve setup and users' endpoint choice.
- Add local security findings, SARIF/JSON import, evidence history and redacted report export.
  Verification requires current host-recorded check results, not model claims or imported passes.
- Add extension and learned-skill review menus. No telemetry or hosted coordination is added.
- Add local tmux discovery, autocomplete, scrollback and Codex terminal controls; detach preserves
  the external session. Deliver queued follow-ups at the next safe boundary during active work.

## 10.0.4 — 2026-10-09

- Add native ChatGPT subscription sign-in and an official Claude Code CLI connection. Preserve the
  selected account across model/profile changes and refuse silent fallback to API billing.
- Rework onboarding for subscription, cloud, self-hosted server and local-file connections with
  bounded checks, cancellation, retry, editable failures and tool-response verification before save.
- Make the default Shadow role a provider-neutral Security foundation. Add trusted local harness
  packages whose instructions, skills, tool scope, version and digest are fixed per new session.
- Add `/learn` and `/skills` for evidence-linked local skill candidates with explicit activation,
  revision history and rollback. No telemetry or callback service is added.
- Add trusted profiles that pair a global model preset with harnesses and runtime limits without
  allowing a profile to carry endpoints or credentials.
- Add an explicit self-hosted SGLang/Qwen chat-template thinking switch; never infer it from model
  names or send it to cloud providers.
- Collapse completed reasoning, omit empty reasoning panels and group repeated grep activity.
- Harden tool-response fidelity, output-budget handling, read pagination and first-run `--base-url`.

Harness selection applies to new sessions; live mid-session switching is not included in this release.

## 10.0.3 — 2026-10-09

- Add Snowfall browsers for active work, persistent jobs and local project rooms, with attempts,
  dependency blockers, directed messages, replies and unread history.
- Retain worker worktrees and patches for explicit apply, keep, discard or interrupted-work recovery.
  Add scoped code review with file/hunk navigation and structured findings when supplied by the model.
- Add independent read-only consultations using complete model profiles, with resumable follow-ups.
- Add bounded second-opinion, implement-and-review, parallel-team, pipeline, debate and plan/solve
  workflows. Carry permissions, hooks, cancellation and budgets through child work; record check
  evidence and acceptance separately from execution status and model claims.
- Restore plans, tasks, work history and recorded tool activity when resuming sessions. Preview
  rewind file changes and require explicit retries for interrupted jobs.
- Add ranked source excerpts, repository maps and semantic navigation with labeled lexical fallback;
  expose scoped instruction origins, skill sources and user/generated/legacy memory provenance.
- Add live MCP management in Snowfall, configurable deadlines, progress, cancellation requests,
  tool selection and bounded retrieval of large results. Remote cancellation remains best effort.
- Improve footer spacing, elapsed-time formatting, effort choices and thinking separation. Preserve
  structured provider content, tool calls and partial results with explicit termination states.
- Recognize managed Windows Git worktrees across path aliases and separator differences.
- Keep update discovery off by default and restrict opt-in to trusted user configuration. Project
  configuration cannot enable it. Store collaboration records locally without analytics or
  automatic uploads.

See the [collaboration guide](docs/COLLABORATION.md) for controls and limits. Workers do not survive
application exit; unknown provider usage remains unknown. Update with `shadow update`, then restart.

## 10.0.1 — 2026-10-05

- Rebuild terminal onboarding in the shared retro style with compact provider menus, arrow/number
  selection, searchable lists, model multi-selection, editable drafts, and a final review.
- Keep a single input owner across masked key prompts; bound and cancel endpoint checks, clear
  completed timers, and offer retry/edit/manual-model recovery without losing setup entries.
- Add Cerebras, Fireworks, DeepInfra, Hugging Face, NVIDIA NIM, vLLM, SGLang, and llama.cpp presets.
- Save endpoint-specific credentials, preserve previous provider keys, support existing encrypted
  vaults, and keep keyless endpoints from inheriting another provider's key.
- Save local-file setup on confirmation and defer model loading and optional extensions until needed.
- Automatically name sessions from their opening prompt, with persistent `/rename` overrides.
- Show session names in `/resume`, its searchable completions, `/sessions` and the terminal title.
- Preserve the prior named conversation when starting `/new` or resuming another session.
- Recover readable names from older logs without rewriting their transcripts.

## 10.0.0 — 2026-10-04

- Made Snowfall the default interactive terminal, with a full-width conversation, pinned composer,
  compact status bar, and the original thick cyan SHADOW banner.
- Added full-screen transcript navigation, search, selection/copy, folded details, responsive
  layouts and restoration to normal terminal scrollback on exit.
- Completed shared commands, custom commands, permission/question dialogs, queued follow-ups,
  external-editor access, accessible themes and supported terminal image placements.
- Preserved v9 Work Center tracking, persisted history and controls across terminal, web and ACP.
- Retained the Ink compatibility renderer for Vim, round-table, custom status lines and key maps.
- Preserved headless, REPL, web and editor entrypoints and the signed Blackfrost update channel.
- Retried transient Windows config replacement failures without deleting the previous complete file.
- Made source test fixtures portable and independent of a developer’s installed MLX packages.
- Updated development-only brace-expansion dependencies; runtime and full dependency audits are clean.
- Fixed Node 22 / Undici 8 dispatcher compatibility and bundled the complete Undici implementation
  in standalone binaries built with Bun 1.4.2.


## 9.0.0 — 2026-09-30

- Added Work Center across terminal, web and a versioned ACP extension: agents, background shells,
  plan items, bounded activity, ownership, elapsed time, filters and read-only persisted history.
- Added safe-boundary background pause/resume, queued priority, explicit cancellation/owned-shell
  termination and confirmed linked retries. Active foreground and historical work remain inspect-only.
- Restored the full two-tone SHADOW wordmark with responsive stacked and compact layouts.
- Kept Ink as the supported default terminal and pi as an opt-in experimental preview. Unified
  command claims and dispatch, corrected session transitions and documented the remaining Ink-only
  commands and key mappings.
- Made hostile controls visible in approval displays while preserving raw tool inputs and answers.
- Improved model-switch barriers, context compaction, resumed exports and session state ownership.
- Retained the signed Blackfrost download/update channel and native PowerShell 5.1/7 compatibility.

## 8.7.1 — 2026-09-29

- Moved installer entrypoints to Blackfrost and standalone updates to its signed release bucket.
- Preserved the old-host update bridge, mandatory signature/checksum verification and offline refusal.
- Qualified native Windows PowerShell 5.1 and 7 installation and standalone self-update without
  a PowerShell executable on PATH.
