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

# Pinned ECDSA P-256 public key for the Shadow release-signing key. The published
# SHASUMS256.txt is signed OFFLINE with the matching private key (never on the
# server); the installer verifies that signature against THIS key before trusting
# any hash. A compromised download host cannot forge the signature, so it cannot
# ship a tampered binary that passes verification. Distribute this installer from a
# trusted origin (the GitHub repo) so the pinned key itself can't be swapped.
SHADOW_PUBKEY='-----BEGIN PUBLIC KEY-----
MFkwEwYHKoZIzj0CAQYIKoZIzj0DAQcDQgAE+5WMu9iMUEp0j1eehkH/xGts2NHZ
zxxbBkvBdSkayLtegXgAQ8v8s5ulVnTFQxsX8IKnYfuStdHEn9JbQSkOMg==
-----END PUBLIC KEY-----'

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

# ── verify: signature over SHASUMS256.txt, then the binary's hash ──────────────
# Fails CLOSED — any missing tool, missing signature, bad signature, or hash
# mismatch aborts the install. Set SHADOW_INSECURE_SKIP_VERIFY=1 to bypass (do NOT,
# except to debug on a host with no openssl).
sha256_of() {
  if command -v sha256sum >/dev/null 2>&1; then sha256sum "$1" | awk '{print $1}'
  elif command -v shasum   >/dev/null 2>&1; then shasum -a 256 "$1" | awk '{print $1}'
  else die "need 'sha256sum' or 'shasum' to verify the download's checksum."; fi
}

verify_download() {
  # $1 = path to the downloaded binary
  if [ "${SHADOW_INSECURE_SKIP_VERIFY:-}" = "1" ]; then
    warn "⚠ SHADOW_INSECURE_SKIP_VERIFY=1 — skipping signature + checksum verification. You are trusting the network."
    return 0
  fi
  command -v openssl >/dev/null 2>&1 || die "openssl is required to verify the release signature.
      install it (Debian/Ubuntu/Kali: sudo apt install openssl; macOS ships it) and re-run,
      or bypass at your own risk: SHADOW_INSECURE_SKIP_VERIFY=1"

  # vtmp is script-global; the outer EXIT trap removes it (so a die here still cleans up).
  vtmp="$(mktemp -d "${TMPDIR:-/tmp}/shadow-verify.XXXXXX")" || die "cannot create a temp dir for verification."
  sums="$vtmp/SHASUMS256.txt"; sig="$vtmp/SHASUMS256.txt.sig"; pub="$vtmp/shadow.pub"

  fetch "${BASE}/SHASUMS256.txt"     "$sums" || die "cannot fetch SHASUMS256.txt from ${BASE}."
  fetch "${BASE}/SHASUMS256.txt.sig" "$sig"  || die "cannot fetch SHASUMS256.txt.sig — this release is unsigned; refusing to install unverified."
  printf '%s\n' "$SHADOW_PUBKEY" > "$pub"

  # 1) authenticity: the SHASUMS list must be signed by Shadow's release key
  if ! openssl dgst -sha256 -verify "$pub" -signature "$sig" "$sums" >/dev/null 2>&1; then
    die "SIGNATURE VERIFICATION FAILED for SHASUMS256.txt.
      the checksum list is not signed by Shadow's release key — the download host may be compromised.
      aborting without installing."
  fi

  # 2) integrity: our binary's hash must match the (now-trusted) signed list
  expected="$(awk -v a="$asset" '$2 == a {print $1}' "$sums")"
  [ -n "$expected" ] || die "no checksum entry for '${asset}' in the signed SHASUMS256.txt."
  actual="$(sha256_of "$1")"
  if [ "$actual" != "$expected" ]; then
    die "CHECKSUM MISMATCH for ${asset}
      expected (signed): $expected
      actual (download): $actual
      the binary does not match the signed manifest — aborting (corrupted or tampered)."
  fi

  rm -rf "$vtmp"; vtmp=""
  say "verified signature + checksum ✓"
}

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
vtmp=""
tmp="$(mktemp "${TMPDIR:-/tmp}/shadow.XXXXXX")" || die "cannot create a temp file."
trap 'rm -rf "$tmp" "$vtmp"' EXIT INT TERM

if ! fetch "$url" "$tmp"; then
  die "download failed: $url
      - check your network connection
      - confirm the platform asset exists at that URL"
fi
[ -s "$tmp" ] || die "downloaded file is empty: $url"

# ── verify BEFORE trusting the binary ─────────────────────────────────────────
verify_download "$tmp"
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
