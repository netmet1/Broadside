#requires -Version 5
<#
.SYNOPSIS
  Cut a GitHub Release for the current version, using the local gitignored notes.

.DESCRIPTION
  Broadside's release notes live in "internal_only/release notes/" which is
  GITIGNORED, so the cloud runner never sees them. This script bridges that gap:
  it reads the version from src-tauri/tauri.conf.json, finds the matching local
  notes file, and triggers the Release workflow (.github/workflows/release.yml),
  passing the notes contents as the `notes` input. The workflow then builds a
  clean-room MSI and assembles a DRAFT release (title vX.X.X, your notes as the
  body, the MSI as the asset) for you to review and publish.

  The notes are sent as a workflow input only; they are never committed or pushed.

  Version -> notes filename mapping: 1.1.0 -> "v1-1-0.md".

  Prerequisites: GitHub CLI (gh) installed and authenticated (gh auth status).
  Run this AFTER the version bump is merged to main and has passed CI, since the
  release is tagged at the target branch's HEAD.

  ASCII-only on purpose (Windows PowerShell 5.1 reads unmarked .ps1 as ANSI).

.PARAMETER Ref
  Branch to cut the release from. Default: main.

.PARAMETER Force
  Skip the confirmation prompt.

.EXAMPLE
  powershell -ExecutionPolicy Bypass -File scripts\release.ps1
#>
param(
  [string]$Ref = "main",
  [switch]$Force
)

$ErrorActionPreference = "Stop"
$repoRoot = Split-Path -Parent $PSScriptRoot

# --- Version from the single source of truth ---
$conf = Get-Content (Join-Path $repoRoot "src-tauri/tauri.conf.json") -Raw | ConvertFrom-Json
$version = $conf.version
$tag = "v$version"

# --- Matching gitignored notes file (1.1.0 -> v1-1-0.md) ---
$notesName = "v" + ($version -replace '\.', '-') + ".md"
$notesPath = Join-Path $repoRoot "internal_only/release notes/$notesName"
if (-not (Test-Path $notesPath)) {
  Write-Host "FAILED: release notes not found at:" -ForegroundColor Red
  Write-Host "  $notesPath" -ForegroundColor Red
  Write-Host "Create the notes for $tag first (see the release-notes format)." -ForegroundColor Yellow
  exit 1
}
# -Encoding UTF8 so the header emoji decode correctly under Windows PowerShell 5.1.
$notes = Get-Content $notesPath -Raw -Encoding UTF8

# --- gh present and authenticated ---
if (-not (Get-Command gh -ErrorAction SilentlyContinue)) {
  Write-Host "FAILED: GitHub CLI (gh) is not installed." -ForegroundColor Red
  exit 1
}
gh auth status 1>$null 2>$null
if ($LASTEXITCODE -ne 0) {
  Write-Host "FAILED: gh is not authenticated. Run: gh auth login" -ForegroundColor Red
  exit 1
}

# --- Confirm ---
Write-Host ""
Write-Host "Release   : $tag" -ForegroundColor Cyan
Write-Host "From ref  : $Ref" -ForegroundColor Cyan
Write-Host "Notes file: $notesPath" -ForegroundColor Cyan
Write-Host "------ notes preview ------" -ForegroundColor DarkGray
Write-Host $notes
Write-Host "---------------------------" -ForegroundColor DarkGray
Write-Host "This triggers the Release workflow: it builds the MSI and creates a DRAFT release." -ForegroundColor Yellow

if (-not $Force) {
  $answer = Read-Host "Proceed? (y/N)"
  if ($answer -ne "y" -and $answer -ne "Y") {
    Write-Host "Aborted." -ForegroundColor Yellow
    exit 0
  }
}

# --- Trigger the workflow (notes passed as an input, not committed) ---
# Pass the notes with `-F notes=@<file>`: gh reads the value straight from the
# notes file (the "@ syntax", see `gh help api`). Reading from the file, not the
# command line, keeps the header emoji intact under Windows PowerShell 5.1 (which
# otherwise mangles non-ASCII args to native exes) without needing any JSON step.
# (STDIN-JSON was tried and abandoned: it needs `--json`, and even then gh wants a
# different shape than {"notes":"..."} -> "cannot unmarshal object into string".)
gh workflow run release.yml --ref $Ref -F "notes=@$notesPath"
if ($LASTEXITCODE -ne 0) {
  Write-Host "FAILED: could not trigger the Release workflow." -ForegroundColor Red
  exit 1
}

Write-Host ""
Write-Host "Release workflow triggered for $tag." -ForegroundColor Green
Write-Host "Watch it:   gh run watch (or: gh run list --workflow release.yml)" -ForegroundColor Green
Write-Host "When green, review the DRAFT release on the Releases page and click Publish." -ForegroundColor Green
