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
# Fails CLOSED: the signature must verify against the pinned key, then the binary's
# SHA-256 must match the signed manifest. PowerShell 7.1+ verifies via ImportFromPem;
# Windows PowerShell 5.1 (.NET Framework 4.7+) and PS 7.0 (.NET Core 3.1) verify the
# same ECDSA P-256 signature natively (the pinned key + DER signature are decoded below).
# Runtimes with neither abort (fail closed). Set SHADOW_INSECURE_SKIP_VERIFY=1 to bypass
# entirely (don't, except to debug on a runtime without signature support).

# Decode an RFC 3279 ECDSA signature (SEQUENCE { INTEGER r, INTEGER s }) into the IEEE
# P1363 r||s form (32 bytes each, big-endian, left-padded) that .NET Framework's
# ECDsaCng.VerifyData expects. Strict on purpose: any deviation throws (fail closed).
function ConvertTo-P1363Signature([byte[]]$der) {
  $i = 0
  if ($der.Length -lt 8 -or $der[$i] -ne 0x30) { throw 'sig: not a DER SEQUENCE' }; $i++
  $seqLen = $der[$i]; $i++
  if ($seqLen -ge 0x80) { throw 'sig: long-form SEQUENCE length not allowed' }
  if ($i + $seqLen -ne $der.Length) { throw 'sig: trailing garbage after SEQUENCE' }
  $end = $i + $seqLen
  $parts = @()
  foreach ($n in 1..2) {
    if ($i -ge $end -or $der[$i] -ne 0x02) { throw 'sig: expected INTEGER' }; $i++
    if ($i -ge $end) { throw 'sig: INTEGER length missing' }
    $intLen = $der[$i]; $i++
    if ($intLen -ge 0x80 -or $intLen -eq 0) { throw 'sig: bad INTEGER length' }
    if ($i + $intLen -gt $end) { throw 'sig: INTEGER overruns SEQUENCE' }
    [byte[]]$intBytes = $der[$i..($i + $intLen - 1)]; $i += $intLen
    # strict DER: reject negative INTEGERs and redundant sign padding
    if ($intBytes[0] -band 0x80) { throw 'sig: negative INTEGER not allowed' }
    if ($intBytes.Length -gt 1 -and $intBytes[0] -eq 0 -and ($intBytes[1] -band 0x80) -eq 0) { throw 'sig: non-canonical INTEGER padding' }
    $z = 0
    if ($intBytes.Length -gt 1 -and $intBytes[0] -eq 0) { $z = 1 }   # drop the single canonical sign pad
    [byte[]]$mag = $intBytes[$z..($intBytes.Length - 1)]
    if ($mag.Length -gt 32) { throw 'sig: INTEGER larger than the P-256 order' }
    [byte[]]$pad = New-Object byte[] (32 - $mag.Length)
    $parts += ,([byte[]]($pad + $mag))
  }
  if ($i -ne $end) { throw 'sig: trailing garbage inside SEQUENCE' }
  return ,([byte[]]($parts[0] + $parts[1]))
}

# Extract the pinned P-256 public point from the SPKI PEM. Strict on purpose: a P-256
# SubjectPublicKeyInfo is exactly 91 bytes with a fixed 26-byte header.
function Get-PinnedEcPoint {
  $b64 = ($ShadowPubKey -split '\r?\n' | Where-Object { $_ -and $_ -notmatch '^-----' }) -join ''
  [byte[]]$der = [Convert]::FromBase64String($b64)
  [byte[]]$prefix = 0x30,0x59,0x30,0x13,0x06,0x07,0x2a,0x86,0x48,0xce,0x3d,0x02,0x01,0x06,0x08,0x2a,0x86,0x48,0xce,0x3d,0x03,0x01,0x07,0x03,0x42,0x00,0x04
  if ($der.Length -ne 91) { throw 'pubkey: not a 91-byte P-256 SubjectPublicKeyInfo' }
  for ($k = 0; $k -lt 27; $k++) { if ($der[$k] -ne $prefix[$k]) { throw 'pubkey: not the pinned P-256 key header' } }
  $pt = New-Object System.Security.Cryptography.ECPoint
  $pt.X = [byte[]]$der[27..58]
  $pt.Y = [byte[]]$der[59..90]
  return $pt
}

# Verify SHASUMS256.txt on runtimes without ImportFromPem (Windows PowerShell 5.1 on
# .NET Framework 4.7+, PS 7.0 on .NET Core 3.1) using their native ECDSA. Throws on
# any problem, and the caller fails closed on throw.
function Verify-ShadowSigNative([byte[]]$data, [byte[]]$sigDer) {
  $params = New-Object System.Security.Cryptography.ECParameters
  $params.Curve = [System.Security.Cryptography.ECCurve+NamedCurves]::nistP256
  $params.Q = Get-PinnedEcPoint
  $ec = [System.Security.Cryptography.ECDsa]::Create()
  try {
    $ec.ImportParameters($params)
    [byte[]]$raw = ConvertTo-P1363Signature $sigDer
    return [bool]$ec.VerifyData($data, $raw, [System.Security.Cryptography.HashAlgorithmName]::SHA256)
  } finally { $ec.Dispose() }
}

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
    try {
      $sumsBytes = [IO.File]::ReadAllBytes($sumsPath)
      $sigBytes  = [IO.File]::ReadAllBytes($sigPath)
    } catch {
      Die "cannot read the downloaded manifest/signature: $($_.Exception.Message)"
    }
    $v = $PSVersionTable.PSVersion
    $ok = $false
    if (($v.Major -gt 7) -or ($v.Major -eq 7 -and $v.Minor -ge 1)) {
      # ImportFromPem + the DSASignatureFormat overload are .NET 5+, i.e. PowerShell 7.1+.
      $ec = [System.Security.Cryptography.ECDsa]::Create()
      try {
        $ec.ImportFromPem($ShadowPubKey)
        $ok = $ec.VerifyData($sumsBytes, $sigBytes, [System.Security.Cryptography.HashAlgorithmName]::SHA256, [System.Security.Cryptography.DSASignatureFormat]::Rfc3279DerSequence)
      } catch {
        # any error here (bad key/sig/DER) on a capable runtime = treat as failure, fail closed
        Die "signature verification error: $($_.Exception.Message) - aborting (possible tampering)."
      } finally { $ec.Dispose() }
    } else {
      # Windows PowerShell 5.1 (.NET Framework) / PS 7.0 (.NET Core 3.1) lack ImportFromPem +
      # DSASignatureFormat. Stock Windows ships 5.1, so this is the default Windows path:
      # .NET Framework 4.7+ — bundled with every current Windows — verifies ECDSA P-256
      # natively once the pinned key and the DER signature are decoded (helpers above).
      try {
        $ok = Verify-ShadowSigNative $sumsBytes $sigBytes
      } catch {
        $msg = $_.Exception.Message
        if ($msg -match 'Cannot find type') {
          # runtime older than .NET Framework 4.7 — missing APIs, NOT tampering
          Die "signature verification is not supported on PowerShell $v (its .NET is older than 4.7).`n       install PowerShell 7.1+ (https://aka.ms/powershell) and re-run,`n       or, ONLY if you accept an unverified download:  `$env:SHADOW_INSECURE_SKIP_VERIFY=1"
        }
        Die "signature verification error on PowerShell $v : $msg - aborting (possible tampering)."
      }
    }
    if (-not $ok) { Die "SIGNATURE VERIFICATION FAILED for SHASUMS256.txt - the download host may be compromised. Aborting." }

    # 2) integrity: our binary's hash must match the signed list
    $expected = $null
    foreach ($line in [IO.File]::ReadAllLines($sumsPath)) {
      $parts = ($line.Trim() -split '\s+')
      if ($parts.Length -ge 2 -and $parts[1] -eq $assetName) { $expected = $parts[0].ToLower(); break }
    }
    if (-not $expected) { Die "no checksum entry for '$assetName' in the signed SHASUMS256.txt." }
    $actual = (Get-FileHash -Algorithm SHA256 -Path $binPath).Hash.ToLower()
    if ($actual -ne $expected) { Die "CHECKSUM MISMATCH for $assetName`n       expected (signed): $expected`n       actual (download): $actual`n       aborting (corrupted or tampered)." }

    # only reachable once the signature verified (every failure path above aborts)
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
# passes. Verification uses ImportFromPem on PowerShell 7.1+ and native .NET Framework 4.7+
# ECDSA on Windows PowerShell 5.1 / PS 7.0 (stock Windows works); on runtimes with NEITHER the
# install ABORTS (checksum-only against an attacker-controlled manifest is no protection)
# unless the user explicitly sets SHADOW_INSECURE_SKIP_VERIFY=1.
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
