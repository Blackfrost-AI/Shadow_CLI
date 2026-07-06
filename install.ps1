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
function Die  ($m) {
  # remove any unverified download before aborting (no exit trap in PowerShell)
  if ($script:CleanupPaths) { foreach ($p in $script:CleanupPaths) { Remove-Item -Force -Recurse -ErrorAction SilentlyContinue $p } }
  Write-Host 'shadow ' -ForegroundColor Red -NoNewline; Write-Host $m; exit 1
}
$script:CleanupPaths = @()

# ── verify: signature over SHASUMS256.txt, then the binary's SHA-256 ───────────
# Fails CLOSED: the signature must verify against the pinned key (needs PowerShell 7.1+),
# then the binary's SHA-256 must match the signed manifest. Set SHADOW_INSECURE_SKIP_VERIFY=1
# to bypass entirely (don't, except to debug on a runtime without signature support).
function Verify-Download($binPath, $assetName, $baseUrl) {
  if ($env:SHADOW_INSECURE_SKIP_VERIFY -eq '1') {
    Warn 'WARNING: SHADOW_INSECURE_SKIP_VERIFY=1 - skipping signature + checksum verification.'
    return
  }
  $vtmp = Join-Path ([IO.Path]::GetTempPath()) ('shadow-verify-' + [IO.Path]::GetRandomFileName())
  New-Item -ItemType Directory -Force -Path $vtmp | Out-Null
  $script:CleanupPaths += $vtmp   # Die removes it too (finally may not run under `exit`)
  try {
    $sumsPath = Join-Path $vtmp 'SHASUMS256.txt'
    $sigPath  = Join-Path $vtmp 'SHASUMS256.txt.sig'
    try { Invoke-WebRequest -Uri "$baseUrl/SHASUMS256.txt"     -OutFile $sumsPath -UseBasicParsing } catch { Die "cannot fetch SHASUMS256.txt from $baseUrl" }
    try { Invoke-WebRequest -Uri "$baseUrl/SHASUMS256.txt.sig" -OutFile $sigPath  -UseBasicParsing } catch { Die "cannot fetch SHASUMS256.txt.sig - this release is unsigned; refusing to install unverified." }

    # 1) authenticity: SHASUMS256.txt must be signed by Shadow's release key.
    # ImportFromPem + the DSASignatureFormat overload are .NET 5+, i.e. PowerShell 7.1+.
    # PowerShell 7.0 (.NET Core 3.1) and Windows PowerShell 5.1 lack them → abort (fail closed).
    $v = $PSVersionTable.PSVersion
    $sigCapable = ($v.Major -gt 7) -or ($v.Major -eq 7 -and $v.Minor -ge 1)
    if ($sigCapable) {
      $sumsBytes = [IO.File]::ReadAllBytes($sumsPath)
      $sigBytes  = [IO.File]::ReadAllBytes($sigPath)
      $ok = $false
      try {
        $ec = [System.Security.Cryptography.ECDsa]::Create()
        $ec.ImportFromPem($ShadowPubKey)
        $ok = $ec.VerifyData($sumsBytes, $sigBytes, [System.Security.Cryptography.HashAlgorithmName]::SHA256, [System.Security.Cryptography.DSASignatureFormat]::Rfc3279DerSequence)
      } catch {
        # any error here (bad key/sig/DER) on a capable runtime = treat as failure, fail closed
        Die "signature verification error: $($_.Exception.Message) - aborting (possible tampering)."
      }
      if (-not $ok) { Die "SIGNATURE VERIFICATION FAILED for SHASUMS256.txt - the download host may be compromised. Aborting." }
    } else {
      # FAIL CLOSED: checksum-only would verify the binary against an attacker-controlled
      # manifest (a compromised host rewrites SHASUMS too), which is no protection at all.
      Die "signature verification requires PowerShell 7.1+ (this is PowerShell $v).`n       install PowerShell 7 (https://aka.ms/powershell) and re-run:`n         irm https://raw.githubusercontent.com/Blackfrost-AI/Shadow_CLI/main/install.ps1 | iex`n       or, ONLY if you accept an unverified download:  `$env:SHADOW_INSECURE_SKIP_VERIFY=1"
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

    # only reachable once the signature verified (PS < 7.1 aborts above)
    Say 'verified signature + checksum ✓'
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
# passes. Signature verification needs PowerShell 7.1+ (.NET 5+); on older PowerShell the install
# ABORTS (checksum-only against an attacker-controlled manifest is no protection) unless the user
# explicitly sets SHADOW_INSECURE_SKIP_VERIFY=1.
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
$script:CleanupPaths += $tmp   # so any Die removes the unverified download
try {
  Invoke-WebRequest -Uri $url -OutFile $tmp -UseBasicParsing
} catch {
  Die "download failed: $url`n       - check your network connection`n       - confirm the platform asset exists at that URL`n       $($_.Exception.Message)"
}
if (-not (Test-Path $tmp) -or (Get-Item $tmp).Length -eq 0) {
  Die "downloaded file is empty: $url"
}

# ── verify BEFORE trusting the binary (fails closed) ──────────────────────────
Verify-Download $tmp $asset $base
$script:CleanupPaths = @($script:CleanupPaths | Where-Object { $_ -ne $tmp })  # verified — keep it

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
