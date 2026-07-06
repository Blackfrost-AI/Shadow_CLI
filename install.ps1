# Shadow installer for Windows (PowerShell) — fetches the single self-contained
# binary (no Node/npm needed to run it).
#
#   irm https://shadow.redpillreader.com/install.ps1 | iex
#
# Optional environment overrides:
#   SHADOW_INSTALL_BASE  base URL for binaries  (default: https://shadow.redpillreader.com/bin)
#   SHADOW_INSTALL_DIR   install location       (default: %LOCALAPPDATA%\Programs\shadow)
#
# Safe to re-run: it replaces any prior copy and never duplicates your PATH entry.

$ErrorActionPreference = 'Stop'

# Hide the progress bar — Invoke-WebRequest is ~10x slower with it on large files.
$ProgressPreference = 'SilentlyContinue'

# Force TLS 1.2+ on older Windows PowerShell (5.1) where it is not the default.
try {
  [Net.ServicePointManager]::SecurityProtocol =
    [Net.ServicePointManager]::SecurityProtocol -bor [Net.SecurityProtocolType]::Tls12
} catch {}

function Say  ($m) { Write-Host 'shadow ' -ForegroundColor Cyan   -NoNewline; Write-Host $m }
function Warn ($m) { Write-Host 'shadow ' -ForegroundColor Yellow -NoNewline; Write-Host $m }
function Die  ($m) { Write-Host 'shadow ' -ForegroundColor Red    -NoNewline; Write-Host $m; exit 1 }

# ── verify: signature over SHASUMS256.txt, then the binary's SHA-256 ───────────
# Fails CLOSED on macOS/Linux; on Windows the checksum always runs and the signature
# runs when the runtime supports it (PowerShell 7+). Set SHADOW_INSECURE_SKIP_VERIFY=1
# to bypass entirely (don't, except to debug).
function Verify-Download($binPath, $assetName, $baseUrl) {
  if ($env:SHADOW_INSECURE_SKIP_VERIFY -eq '1') {
    Warn 'WARNING: SHADOW_INSECURE_SKIP_VERIFY=1 - skipping signature + checksum verification.'
    return
  }
  $vtmp = Join-Path ([IO.Path]::GetTempPath()) ('shadow-verify-' + [IO.Path]::GetRandomFileName())
  New-Item -ItemType Directory -Force -Path $vtmp | Out-Null
  try {
    $sumsPath = Join-Path $vtmp 'SHASUMS256.txt'
    $sigPath  = Join-Path $vtmp 'SHASUMS256.txt.sig'
    try { Invoke-WebRequest -Uri "$baseUrl/SHASUMS256.txt"     -OutFile $sumsPath -UseBasicParsing } catch { Die "cannot fetch SHASUMS256.txt from $baseUrl" }
    try { Invoke-WebRequest -Uri "$baseUrl/SHASUMS256.txt.sig" -OutFile $sigPath  -UseBasicParsing } catch { Die "cannot fetch SHASUMS256.txt.sig - this release is unsigned; refusing to install unverified." }

    # 1) authenticity: SHASUMS256.txt must be signed by Shadow's release key
    $sigChecked = $false
    try {
      $sumsBytes = [IO.File]::ReadAllBytes($sumsPath)
      $sigBytes  = [IO.File]::ReadAllBytes($sigPath)
      $ec = [System.Security.Cryptography.ECDsa]::Create()
      $ec.ImportFromPem($ShadowPubKey)   # .NET 5+ / PowerShell 7+
      $ok = $ec.VerifyData($sumsBytes, $sigBytes, [System.Security.Cryptography.HashAlgorithmName]::SHA256, [System.Security.Cryptography.DSASignatureFormat]::Rfc3279DerSequence)
      if (-not $ok) { Die "SIGNATURE VERIFICATION FAILED for SHASUMS256.txt - the download host may be compromised. Aborting." }
      $sigChecked = $true
    } catch [System.Management.Automation.RuntimeException] {
      Warn "signature verification needs PowerShell 7+ (this is Windows PowerShell). Falling back to checksum-only."
      Warn "for full tamper protection install PowerShell 7 (https://aka.ms/powershell) and re-run."
    }

    # 2) integrity: our binary's hash must match the signed list
    $expected = $null
    foreach ($line in [IO.File]::ReadAllLines($sumsPath)) {
      $parts = ($line.Trim() -split '\s+')
      if ($parts.Length -ge 2 -and $parts[1] -eq $assetName) { $expected = $parts[0].ToLower(); break }
    }
    if (-not $expected) { Die "no checksum entry for '$assetName' in the signed SHASUMS256.txt." }
    $actual = (Get-FileHash -Algorithm SHA256 -Path $binPath).Hash.ToLower()
    if ($actual -ne $expected) { Die "CHECKSUM MISMATCH for $assetName`n       expected (signed): $expected`n       actual (download): $actual`n       aborting (corrupted or tampered)." }

    if ($sigChecked) { Say 'verified signature + checksum ✓' } else { Say 'verified checksum ✓ (signature not checked - see warning above)' }
  } finally {
    Remove-Item -Recurse -Force -ErrorAction SilentlyContinue $vtmp
  }
}

# ── resolve source URL + install location ─────────────────────────────────────
$base  = if ($env:SHADOW_INSTALL_BASE) { $env:SHADOW_INSTALL_BASE } else { 'https://shadow.redpillreader.com/bin' }
$asset = 'shadow-windows-x64.exe'   # must match the served file + its SHASUMS256.txt entry
$url   = "$base/$asset"

# Pinned ECDSA P-256 public key for Shadow's OFFLINE release-signing key. SHASUMS256.txt is
# signed with the matching private key (never on the server); the installer verifies that
# signature before trusting any hash, so a compromised host can't ship a tampered binary that
# passes. Full signature verification needs PowerShell 7+ (.NET 5+); on Windows PowerShell 5.1
# it falls back to the checksum check with a warning.
$ShadowPubKey = @'
-----BEGIN PUBLIC KEY-----
MFkwEwYHKoZIzj0CAQYIKoZIzj0DAQcDQgAE+5WMu9iMUEp0j1eehkH/xGts2NHZ
zxxbBkvBdSkayLtegXgAQ8v8s5ulVnTFQxsX8IKnYfuStdHEn9JbQSkOMg==
-----END PUBLIC KEY-----
'@

$localAppData = if ($env:LOCALAPPDATA) { $env:LOCALAPPDATA } else { Join-Path $env:USERPROFILE 'AppData\Local' }
$dir    = if ($env:SHADOW_INSTALL_DIR) { $env:SHADOW_INSTALL_DIR } else { Join-Path $localAppData 'Programs\shadow' }
$target = Join-Path $dir 'shadow.exe'

# ── ensure install dir ────────────────────────────────────────────────────────
try { New-Item -ItemType Directory -Force -Path $dir | Out-Null }
catch { Die "cannot create install directory: $dir`n       $($_.Exception.Message)" }

# ── download to a temp file first, then move into place ───────────────────────
Say "downloading $asset ..."
$tmp = Join-Path ([System.IO.Path]::GetTempPath()) ('shadow-' + [System.IO.Path]::GetRandomFileName() + '.exe')
try {
  Invoke-WebRequest -Uri $url -OutFile $tmp -UseBasicParsing
} catch {
  Die "download failed: $url`n       - check your network connection`n       - confirm the platform asset exists at that URL`n       $($_.Exception.Message)"
}
if (-not (Test-Path $tmp) -or (Get-Item $tmp).Length -eq 0) {
  Remove-Item -Force $tmp -ErrorAction SilentlyContinue
  Die "downloaded file is empty: $url"
}

# ── verify BEFORE trusting the binary ─────────────────────────────────────────
try {
  Verify-Download $tmp $asset $base
} catch {
  Remove-Item -Force $tmp -ErrorAction SilentlyContinue
  throw
}

# ── install into place ────────────────────────────────────────────────────────
# Windows won't OVERWRITE a running exe, but it WILL let you RENAME it. So when
# `shadow update` re-runs this installer, move the running shadow.exe aside to
# .old (which frees the name), then drop the new build in. The old process keeps
# using the .old copy until it exits; the next install/update clears the leftover.
$old = "$target.old"
Remove-Item -Force -ErrorAction SilentlyContinue $old
try {
  if (Test-Path $target) { Move-Item -Force -Path $target -Destination $old }
  Move-Item -Force -Path $tmp -Destination $target
} catch {
  Remove-Item -Force $tmp -ErrorAction SilentlyContinue
  if ((Test-Path $old) -and -not (Test-Path $target)) { Move-Item -Force -Path $old -Destination $target -ErrorAction SilentlyContinue }
  Die "cannot write $target`n       (close any running shadow and re-run)`n       $($_.Exception.Message)"
}
Remove-Item -Force -ErrorAction SilentlyContinue $old
Say "installed -> $target"

# ── add install dir to the USER PATH if not already present (idempotent) ──────
$userPath = [Environment]::GetEnvironmentVariable('Path', 'User')
if (-not $userPath) { $userPath = '' }

$onPath = $false
foreach ($p in $userPath.Split(';')) {
  if ($p -and ($p.TrimEnd('\') -ieq $dir.TrimEnd('\'))) { $onPath = $true; break }
}

if (-not $onPath) {
  $newPath = if ($userPath -eq '') { $dir } else { ($userPath.TrimEnd(';') + ';' + $dir) }
  [Environment]::SetEnvironmentVariable('Path', $newPath, 'User')
  Say "added $dir to your user PATH"
} else {
  Say "$dir already on your user PATH"
}

# make `shadow` runnable in THIS session too (registry change only affects new shells)
$sessionDirs = $env:Path.Split(';') | ForEach-Object { $_.TrimEnd('\') }
if ($sessionDirs -notcontains $dir.TrimEnd('\')) {
  $env:Path = $env:Path.TrimEnd(';') + ';' + $dir
}

Say 'done.'
Say 'open a new terminal and run:  shadow'
