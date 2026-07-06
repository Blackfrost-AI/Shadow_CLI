#!/bin/sh
# Shadow installer — fetches the single self-contained binary (no Node/npm needed to run it).
#
#   curl -fsSL https://shadow.redpillreader.com/install.sh | sh
#
# Optional env overrides:
#   SHADOW_INSTALL_BASE  base URL for binaries  (default: https://shadow.redpillreader.com/bin)
#   SHADOW_INSTALL_DIR   install location       (default: /usr/local/bin if writable, else ~/.local/bin)
set -eu

BASE="${SHADOW_INSTALL_BASE:-https://shadow.redpillreader.com/bin}"

say()  { printf '\033[1;36mshadow\033[0m %s\n' "$*"; }
warn() { printf '\033[1;33mshadow\033[0m %s\n' "$*" >&2; }
die()  { printf '\033[1;31mshadow\033[0m %s\n' "$*" >&2; exit 1; }

# ── detect platform → binary name ─────────────────────────────────────────────
os="$(uname -s)"
arch="$(uname -m)"

case "$os" in
  Darwin) os_tag="darwin" ;;
  Linux)  os_tag="linux"  ;;
  MINGW*|MSYS*|CYGWIN*|Windows_NT)
    die "looks like native Windows. Shadow ships a native Windows binary — install it from PowerShell instead:

      irm https://shadow.redpillreader.com/install.ps1 | iex

      (this install.sh targets macOS and Linux; inside a Linux WSL distro it works as-is.)" ;;
  *) die "unsupported OS: $os — Shadow ships macOS (Darwin), Linux, and Windows binaries.
      On Windows, install from PowerShell:  irm https://shadow.redpillreader.com/install.ps1 | iex" ;;
esac

case "$arch" in
  arm64|aarch64) arch_tag="arm64" ;;
  x86_64|amd64)  arch_tag="x64"   ;;
  *) die "unsupported architecture: $arch — Shadow ships arm64 and x64 binaries only." ;;
esac

asset="shadow-${os_tag}-${arch_tag}"
url="${BASE}/${asset}"

# ── downloader (curl preferred, wget fallback) ────────────────────────────────
if command -v curl >/dev/null 2>&1; then
  fetch() { curl -fsSL "$1" -o "$2"; }
elif command -v wget >/dev/null 2>&1; then
  fetch() { wget -qO "$2" "$1"; }
else
  die "need either curl or wget installed to download Shadow."
fi

# ── pick an install dir: /usr/local/bin if writable, else ~/.local/bin ────────
if [ -n "${SHADOW_INSTALL_DIR:-}" ]; then
  dir="$SHADOW_INSTALL_DIR"
elif [ -d /usr/local/bin ] && [ -w /usr/local/bin ]; then
  dir="/usr/local/bin"
else
  dir="$HOME/.local/bin"
fi
mkdir -p "$dir" || die "cannot create install directory: $dir"
target="$dir/shadow"

# ── download to a temp file ───────────────────────────────────────────────────
say "detected ${os_tag}-${arch_tag} — downloading ${asset} …"
tmp="$(mktemp "${TMPDIR:-/tmp}/shadow.XXXXXX")" || die "cannot create a temp file."
trap 'rm -f "$tmp"' EXIT INT TERM

if ! fetch "$url" "$tmp"; then
  die "download failed: $url
      - check your network connection
      - confirm the platform asset exists at that URL"
fi
[ -s "$tmp" ] || die "downloaded file is empty: $url"
chmod +x "$tmp"

# ── install into place ────────────────────────────────────────────────────────
if ! mv "$tmp" "$target" 2>/dev/null && ! cp "$tmp" "$target" 2>/dev/null; then
  die "cannot write $target (permission denied).
      retry with a writable dir:  SHADOW_INSTALL_DIR=\"\$HOME/.local/bin\" sh install.sh
      or with elevated rights:     curl -fsSL $url -o /tmp/shadow && sudo install -m 0755 /tmp/shadow /usr/local/bin/shadow"
fi
chmod 0755 "$target" 2>/dev/null || true
say "installed → $target"

# ── post-install notes ────────────────────────────────────────────────────────
case ":$PATH:" in
  *":$dir:"*) ;;
  *) warn "note: $dir is not on your PATH. Add it:  export PATH=\"$dir:\$PATH\"" ;;
esac

# The Linux run_shell OS sandbox (guardrails ON by default) needs bubblewrap.
if [ "$os_tag" = "linux" ] && ! command -v bwrap >/dev/null 2>&1; then
  warn "note: bubblewrap (bwrap) not found — the run_shell OS sandbox needs it."
  warn "      install it:  sudo apt install bubblewrap   (Debian/Ubuntu/Kali)"
fi

ver="$("$target" --version 2>/dev/null || true)"
[ -n "$ver" ] && say "verified: $ver"
say "done — run:  shadow"
