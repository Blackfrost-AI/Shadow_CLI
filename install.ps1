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

# ── resolve source URL + install location ─────────────────────────────────────
$base  = if ($env:SHADOW_INSTALL_BASE) { $env:SHADOW_INSTALL_BASE } else { 'https://shadow.redpillreader.com/bin' }
$asset = 'shadow-windows-x64'
$url   = "$base/$asset"

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
