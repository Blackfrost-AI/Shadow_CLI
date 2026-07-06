#!/usr/bin/env bash
# Release gate (P0-4): refuse to publish if the safety guardrails would ship OFF.
#
# `DEV_UNRESTRICTED` controls whether a run drops the filesystem jail + OS sandbox.
# It MUST default to a safe (false) value — dropping guardrails is opt-in via
# SHADOW_DEV_UNRESTRICTED=1. If shipped code hard-codes it to an always-true value
# (`DEV_UNRESTRICTED = true;` / `= 1;` / `= !!1;` / `= Boolean(true);`), every default
# install runs unsandboxed. Catch that here and abort the publish.
#
# Scans BOTH src/ (source of truth) and dist/ (what actually ships). Portable: uses
# POSIX-ish BSD grep so it works on macOS and Linux.
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$REPO_ROOT"

# Match an always-true assignment statement for DEV_UNRESTRICTED:
#   <non-word>DEV_UNRESTRICTED = <true|1|!!1|Boolean(true)> ;
# The leading (^|[^A-Za-z0-9_]) keeps `SHADOW_DEV_UNRESTRICTED` (the safe env read) from
# matching, and the trailing `;` keeps the human-readable diagnostic string in doctor.ts
# ("buildProfile DEV_UNRESTRICTED=true)") from matching. The safe default
# (`= process.env.SHADOW_DEV_UNRESTRICTED === '1'`) never matches.
PATTERN='(^|[^A-Za-z0-9_])DEV_UNRESTRICTED[[:space:]]*=[[:space:]]*(true|1|!!1|Boolean\(true\))[[:space:]]*;'

dirs=()
[ -d src ] && dirs+=(src)
[ -d dist ] && dirs+=(dist)

if [ ${#dirs[@]} -eq 0 ]; then
  echo "release-gate: nothing to scan (no src/ or dist/)" >&2
  exit 0
fi

if hits="$(grep -REn "$PATTERN" "${dirs[@]}" 2>/dev/null)"; then
  echo "RELEASE BLOCKED (P0-4): guardrails would ship OFF." >&2
  echo "DEV_UNRESTRICTED is hard-coded to an always-true value in shipped code:" >&2
  echo "$hits" >&2
  echo "Fix: DEV_UNRESTRICTED must default safe, e.g." >&2
  echo "  export const DEV_UNRESTRICTED = process.env.SHADOW_DEV_UNRESTRICTED === '1';" >&2
  exit 1
fi

echo "release-gate OK: DEV_UNRESTRICTED defaults safe (filesystem jail + OS sandbox ON by default)."
