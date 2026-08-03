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

# --- web UI assets must not be stale -----------------------------------------------------
# src/web/bundledAssets.ts is generated from src/web/ui/. In dev the server prefers the
# on-disk tree, so a stale map is invisible locally and only shows up in the compiled binary
# — which serves the map exclusively. Regenerate and fail if the result differs from what is
# committed.
if [ -f scripts/check-webui-assets.mjs ]; then
  if ! node scripts/check-webui-assets.mjs; then
    echo "RELEASE BLOCKED: embedded web UI assets are stale." >&2
    exit 1
  fi
fi

# --- the packaged Node distribution must match source -----------------------------------
# package.json publishes dist/, not src/. A green source typecheck is therefore insufficient:
# stale tracked JavaScript can otherwise ship even though the current TypeScript is correct.
# The checker snapshots the current dist/, runs the real production build, and compares before
# versus after. It does not use `git diff`, so unrelated or intentionally uncommitted work does
# not make the gate impossible to run. The build script itself does not invoke this gate, so this
# cannot recurse.
if [ -f scripts/check-dist-fresh.mjs ]; then
  if ! node scripts/check-dist-fresh.mjs; then
    exit 1
  fi
fi

# --- the test script must run the WHOLE suite ---------------------------------------------
# npm runs scripts with `sh`, which has no globstar: an UNQUOTED `test/**/*.test.ts` expands to
# `test/*/*.test.ts`. Today that matches nothing, so the literal reaches node and node's own
# runner globs it correctly — but the moment any .test.ts lands in a test/ subdirectory, sh
# matches it and node receives exactly ONE file. Measured: 1 test, exit 0, release looks green
# while 1078 never ran. Quoting hands the pattern to node deliberately instead of by luck.
# Checked as INVARIANTS, not as an exact string: the script legitimately grows flags (it gained
# --test-timeout), and an exact-match gate turns every such change into a false "release blocked".
if [ -f package.json ]; then
  TEST_SCRIPT=$(node -p "require('./package.json').scripts.test || ''" 2>/dev/null || echo "")
  case "$TEST_SCRIPT" in
    *'"test/**/*.test.ts"'*) : ;;
    *)
      echo "RELEASE BLOCKED: package.json test script must QUOTE its glob." >&2
      echo "  found:    $TEST_SCRIPT" >&2
      echo "  required: the literal \"test/**/*.test.ts\" (with quotes) somewhere in the script" >&2
      echo "  unquoted, sh silently collapses the run to a single file and still exits 0." >&2
      exit 1
      ;;
  esac
  case "$TEST_SCRIPT" in
    *'"test/**/*.test.tsx"'*) : ;;
    *)
      echo "RELEASE BLOCKED: package.json test script omits TSX tests." >&2
      echo "  found:    $TEST_SCRIPT" >&2
      echo "  required: the literal \"test/**/*.test.tsx\" (with quotes) somewhere in the script" >&2
      echo "  otherwise component tests such as composer-render.test.tsx silently never run." >&2
      exit 1
      ;;
  esac
  # A hung test must FAIL, not wedge the suite forever. Without a timeout, one TUI test awaiting a
  # promise that can no longer settle blocks the whole run with zero output — indistinguishable
  # from "still working", and it never reports a failure at all.
  case "$TEST_SCRIPT" in
    *--test-timeout=*) : ;;
    *)
      echo "RELEASE BLOCKED: package.json test script must set --test-timeout." >&2
      echo "  found: $TEST_SCRIPT" >&2
      echo "  a hung test would otherwise stall the suite indefinitely instead of failing." >&2
      exit 1
      ;;
  esac
  echo "release-gate OK: test script globs all TS + TSX tests (quoted for node, not sh) with a timeout."
fi
