# Shadow release notes

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
