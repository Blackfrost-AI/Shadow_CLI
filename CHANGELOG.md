# Shadow release notes

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
