#requires -Version 5
<#
.SYNOPSIS
  Local CI - runs the same checks as .github/workflows/ci.yml on this machine.

.DESCRIPTION
  While the repo is PRIVATE, PR validation runs here instead of GitHub Actions
  (decision D-060) to save Windows-runner minutes and tighten the loop. The
  cloud workflow stays as a clean-room backstop on push to main.

  Run this (default/full mode) as the pre-merge gate. Steps:
    Frontend : typecheck, lint, build, npm audit --audit-level=high
    Rust     : cargo build/test --locked --all-targets, cargo audit, cargo deny

  NOTE on `npm ci`: the default run does NOT wipe node_modules - it checks the
  existing install, which is fast and avoids Windows file-lock (EPERM) flakiness
  on native modules. The true clean-room install (npm ci on a fresh checkout) is
  what the cloud backstop on `main` verifies. Use -CleanInstall to force it
  locally (e.g. after the lockfile changed).

  cargo-audit / cargo-deny are installed automatically if missing.

  ASCII-only on purpose: Windows PowerShell 5.1 reads unmarked .ps1 files as
  ANSI, so non-ASCII characters (em-dashes, smart quotes) break parsing.

.PARAMETER Quick
  Skip the security-audit steps (npm audit, cargo audit, cargo deny) for a fast
  inner-loop check. Use the full run (default) as the pre-merge gate.

.PARAMETER CleanInstall
  Also run `npm ci` first (full parity with the cloud). Retries once on a
  transient EPERM lock.

.EXAMPLE
  # Windows PowerShell 5.1 (this box) - full CI parity (pre-merge gate):
  powershell -ExecutionPolicy Bypass -File scripts\ci.ps1
  # fast inner-loop check:
  powershell -ExecutionPolicy Bypass -File scripts\ci.ps1 -Quick
  # force a clean npm install too:
  powershell -ExecutionPolicy Bypass -File scripts\ci.ps1 -CleanInstall
#>
param(
  [switch]$Quick,
  [switch]$CleanInstall
)

$ErrorActionPreference = "Stop"
$repoRoot = Split-Path -Parent $PSScriptRoot
$srcTauri = Join-Path $repoRoot "src-tauri"
$started = Get-Date

# Native commands don't throw on failure, so each step checks $LASTEXITCODE and
# aborts the whole run on the first non-zero exit (a real gate, like CI).
function Step {
  param([string]$Name, [scriptblock]$Cmd)
  Write-Host "`n=== $Name ===" -ForegroundColor Cyan
  & $Cmd
  if ($LASTEXITCODE -ne 0) {
    Write-Host "`nFAILED: $Name (exit $LASTEXITCODE)" -ForegroundColor Red
    exit 1
  }
}

if ($Quick) {
  Write-Host "Local CI (quick mode - skipping audits)" -ForegroundColor Yellow
} else {
  Write-Host "Local CI (full - mirrors GitHub Actions checks)" -ForegroundColor Green
}

# ---- Frontend (repo root) ----
Push-Location $repoRoot
try {
  if ($CleanInstall) {
    Write-Host "`n=== npm ci ===" -ForegroundColor Cyan
    npm ci
    if ($LASTEXITCODE -ne 0) {
      Write-Host "npm ci failed (likely a locked native module); retrying in 3s..." -ForegroundColor Yellow
      Start-Sleep -Seconds 3
      npm ci
      if ($LASTEXITCODE -ne 0) {
        Write-Host "`nFAILED: npm ci - a node/vite process or antivirus may be holding node_modules. Close it and retry, or run without -CleanInstall." -ForegroundColor Red
        exit 1
      }
    }
  }
  Step "typecheck" { npm run typecheck }
  Step "lint" { npm run lint }
  Step "build" { npm run build }
  if (-not $Quick) { Step "npm audit" { npm audit --audit-level=high } }
} finally {
  Pop-Location
}

# ---- Rust (src-tauri) ----
# A running dev build locks the exe and blocks cargo build; stop it first.
try { Stop-Process -Name omniterminal -Force -ErrorAction Stop; Write-Host "stopped running omniterminal" } catch {}

Push-Location $srcTauri
try {
  Step "cargo build" { cargo build --locked --all-targets }
  Step "cargo test" { cargo test --locked --all-targets }
  if (-not $Quick) {
    if (-not (Get-Command cargo-audit -ErrorAction SilentlyContinue)) {
      Step "install cargo-audit" { cargo install cargo-audit --locked }
    }
    if (-not (Get-Command cargo-deny -ErrorAction SilentlyContinue)) {
      Step "install cargo-deny" { cargo install cargo-deny --locked }
    }
    Step "cargo audit" { cargo audit }
    Step "cargo deny check" { cargo deny check }
  }
} finally {
  Pop-Location
}

$elapsed = [int]((Get-Date) - $started).TotalSeconds
Write-Host "`nLocal CI passed in ${elapsed}s." -ForegroundColor Green
