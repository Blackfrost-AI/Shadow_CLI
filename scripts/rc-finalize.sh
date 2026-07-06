#!/usr/bin/env bash
# Finalize the synced RC into the sterile BETA build. Run IN the RC dir after every
# internal→RC rsync — the rsync re-clobbers both of these back to their dev values:
#   1. Version → a beta number. Testers see e.g. 0.9.0-beta.1, NOT the internal 0.9.0-dev.N.
#   2. DEV_UNRESTRICTED → false: guardrails (filesystem jail + OS sandbox) ON by default;
#      only --yolo or full autonomy drop them. (The internal dev build keeps it true.)
# No git commit/tag and no npm install — keeps the RC a clean staging mirror.
#
# Usage:  bash scripts/rc-finalize.sh 0.9.0-beta.1
set -euo pipefail
cd "$(dirname "$0")/.."

VER="${1:?usage: rc-finalize.sh <version, e.g. 0.9.0-beta.1>}"

# Set the version in package.json only (no commit, no tag, no lockfile churn).
npm version --no-git-tag-version --allow-same-version "$VER" >/dev/null

# Public/sterile build: guardrails ON by default.
sed -i 's/export const DEV_UNRESTRICTED = true;/export const DEV_UNRESTRICTED = false;/' \
  src/buildProfile.ts dist/buildProfile.js

echo "RC finalized: v$(node -p "require('./package.json').version") | $(grep -oE 'DEV_UNRESTRICTED = (true|false)' src/buildProfile.ts)"
