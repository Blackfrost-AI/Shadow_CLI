#!/usr/bin/env bash
# Build Shadow as a SINGLE self-contained binary via Bun — no Node/npm needed to RUN it.
# This is how Claude Code ships. The TS codebase is unchanged; Bun bundles + embeds the runtime.
#
# Usage:
#   bash scripts/build-binary.sh [outfile] [target]
#     outfile  default: dist-bin/shadow
#     target   bun cross-compile target (default: host). One of:
#              bun-linux-x64  bun-linux-x64-baseline  bun-linux-arm64
#              bun-darwin-x64  bun-darwin-arm64  bun-windows-x64
#
# Requires bun (curl -fsSL https://bun.sh/install | bash) and node_modules installed.
set -euo pipefail
cd "$(dirname "$0")/.."

BUN="${BUN:-bun}"
if ! command -v "$BUN" >/dev/null 2>&1; then
  # fall back to the default install location
  [ -x "$HOME/.bun/bin/bun" ] && BUN="$HOME/.bun/bin/bun" || {
    echo "error: bun not found. Install with: curl -fsSL https://bun.sh/install | bash" >&2; exit 1; }
fi

VERSION="$(node -p "require('./package.json').version")"
OUT="${1:-dist-bin/shadow}"
TARGET="${2:-}"
mkdir -p "$(dirname "$OUT")"

echo "→ embedding prompts (binary has no prompts/ dir on disk)…"
node scripts/embed-prompts.mjs

# Ink's reconciler only `import('./devtools.js')` when DEV=true (never in production), but the
# bundler must still resolve the static `import 'react-devtools-core'` inside it. Drop in an empty
# stub so the build is offline + lean (the real DevTools package never runs in a shipped binary).
STUB="node_modules/react-devtools-core"
if [ ! -e "$STUB/index.js" ]; then
  echo "→ stubbing react-devtools-core (Ink dev-only dep)…"
  mkdir -p "$STUB"
  printf '{"name":"react-devtools-core","version":"0.0.0-stub","type":"module","main":"index.js"}\n' > "$STUB/package.json"
  printf 'export default { connectToDevTools() {} };\nexport function connectToDevTools() {}\n' > "$STUB/index.js"
fi

TARGET_ARGS=()
[ -n "$TARGET" ] && TARGET_ARGS=(--target "$TARGET")

echo "→ compiling v$VERSION ${TARGET:+($TARGET) }→ $OUT"
"$BUN" build ./src/index.ts \
  --compile \
  ${TARGET_ARGS[@]+"${TARGET_ARGS[@]}"} \
  --define "process.env.SHADOW_BUILD_VERSION=\"$VERSION\"" \
  --outfile "$OUT"

chmod +x "$OUT" 2>/dev/null || true
SIZE="$(du -h "$OUT" 2>/dev/null | cut -f1)"
if [ -z "$TARGET" ]; then
  echo "✓ built $OUT ($SIZE) — $("$OUT" --version 2>/dev/null || echo 'run failed')"
else
  echo "✓ built $OUT ($SIZE) for $TARGET (cross-compiled; not run on host)"
fi
