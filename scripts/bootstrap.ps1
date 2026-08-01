<#
.SYNOPSIS
    One command from a fresh clone to a built sidecar and an installed plugin.

.DESCRIPTION
    Does everything that doesn't need a mouse:

      1. checks the tools this needs are actually on PATH
      2. installs and builds the sidecar
      3. clones Equicord if it isn't there yet
      4. hands off to install-plugin.ps1 -Build

    Then prints the three things you have to carry into the GUI by hand: the
    token, the folder Vesktop's "Vencord Location" wants, and the `claude mcp
    add` line with this checkout's real path already filled in.

    Safe to re-run. An existing Equicord checkout is reused as-is, never pulled
    or reset, because it is a runtime dependency of your Vesktop install rather
    than a build artifact - see "Living with it" in the README.

.PARAMETER EquicordPath
    Where your Equicord checkout lives, or should live. Defaults to a sibling of
    this repo, so a default run leaves the two checkouts next to each other.

.PARAMETER SkipEquicord
    Build the sidecar only. For when Claude Code is all you need right now and
    the plugin half is already installed.

.EXAMPLE
    .\scripts\bootstrap.ps1

.EXAMPLE
    .\scripts\bootstrap.ps1 -EquicordPath D:\Equicord

.NOTES
    Keep this file ASCII-only, for the same reason as install-plugin.ps1: Windows
    PowerShell 5.1 reads a BOM-less script as CP1252, and a UTF-8 em-dash ends in
    a byte that closes the enclosing string and breaks the parse.
#>
[CmdletBinding()]
param(
    [string] $EquicordPath,

    [switch] $SkipEquicord
)

$ErrorActionPreference = "Stop"

$repoRoot = Split-Path -Parent $PSScriptRoot

if (-not $EquicordPath) {
    $EquicordPath = Join-Path (Split-Path -Parent $repoRoot) "Equicord"
}

function Assert-Tool {
    param(
        [Parameter(Mandatory = $true)][string] $Name,
        [Parameter(Mandatory = $true)][string] $Hint
    )

    if (-not (Get-Command $Name -ErrorAction SilentlyContinue)) {
        throw "'$Name' is not on your PATH. $Hint"
    }
}

function Invoke-Checked {
    param(
        [Parameter(Mandatory = $true)][string] $Exe,
        [Parameter(Mandatory = $true)][string[]] $CmdArgs,
        [Parameter(Mandatory = $true)][string] $What
    )

    & $Exe @CmdArgs
    if ($LASTEXITCODE -ne 0) { throw "$What failed (exit $LASTEXITCODE)" }
}

# --- 1. Preflight -----------------------------------------------------------
#
# pnpm is the one people are missing, and without this check it surfaces several
# minutes in, from inside install-plugin.ps1, as a pnpm error about Equicord.

Write-Host "[1/4] Checking tools..." -ForegroundColor Cyan

Assert-Tool -Name "node" -Hint "Install Node 20 or newer from https://nodejs.org."
Assert-Tool -Name "npm"  -Hint "It ships with Node; a partial install is the usual cause."

if (-not $SkipEquicord) {
    Assert-Tool -Name "git"  -Hint "Install Git from https://git-scm.com."
    Assert-Tool -Name "pnpm" -Hint "Equicord builds with it: npm i -g pnpm"
}

$nodeVersion = (& node --version).Trim()
if ($nodeVersion -match "^v(\d+)" -and [int] $Matches[1] -lt 20) {
    Write-Host "  node $nodeVersion is older than 20; this may work, but it is untested." -ForegroundColor Yellow
} else {
    Write-Host "  node $nodeVersion"
}

# --- 2. Sidecar -------------------------------------------------------------

Write-Host "[2/4] Building the sidecar..." -ForegroundColor Cyan

Push-Location $repoRoot
try {
    Invoke-Checked -Exe "npm" -CmdArgs @("run", "install:sidecar") -What "sidecar install"
    Invoke-Checked -Exe "npm" -CmdArgs @("run", "build") -What "sidecar build"
} finally {
    Pop-Location
}

# --print-token mints the token on first run, so this doubles as "make sure a
# token exists" rather than being only a read.
$token = (& npm --prefix (Join-Path $repoRoot "sidecar") run --silent token | Select-Object -Last 1)
if ($LASTEXITCODE -ne 0) { throw "Could not read the sidecar token" }
$token = "$token".Trim()
if (-not $token) { throw "The sidecar printed an empty token" }

# --- 3. Equicord ------------------------------------------------------------

if ($SkipEquicord) {
    Write-Host "[3/4] Skipping Equicord (-SkipEquicord)." -ForegroundColor Yellow
    Write-Host "[4/4] Sidecar ready." -ForegroundColor Cyan
} else {
    Write-Host "[3/4] Fetching Equicord..." -ForegroundColor Cyan

    if (Test-Path (Join-Path $EquicordPath "src")) {
        Write-Host "  Reusing the checkout at $EquicordPath"
    } elseif ((Test-Path $EquicordPath) -and (Get-ChildItem -Force -Path $EquicordPath | Select-Object -First 1)) {
        throw "'$EquicordPath' exists, isn't empty, and has no src/ - refusing to clone over it. Pass -EquicordPath somewhere else."
    } else {
        Invoke-Checked -Exe "git" `
            -CmdArgs @("clone", "https://github.com/Equicord/Equicord.git", $EquicordPath) `
            -What "git clone of Equicord"
    }

    # First run installs Equicord's own dependencies too, which is the slow part.
    Write-Host "[4/4] Installing the plugin and building Equicord..." -ForegroundColor Cyan
    & (Join-Path $PSScriptRoot "install-plugin.ps1") -EquicordPath $EquicordPath -Build
}

# --- What's left, which is all GUI ------------------------------------------

$distDir = Join-Path $EquicordPath "dist\equibop"
$mcpPath = (Join-Path $repoRoot "sidecar\dist\index.js") -replace "\\", "/"

Write-Host ""
Write-Host "Done. What is left is all clicking:" -ForegroundColor Green
Write-Host ""

$step = 1

if (-not $SkipEquicord) {
    Write-Host "  $step. Vesktop settings -> Vencord Location:"
    Write-Host "       $distDir" -ForegroundColor Green
    Write-Host "     (not dist, not dist\desktop - those hang on the splash screen)"
    Write-Host "     then restart Vesktop."
    Write-Host ""
    $step++
}

Write-Host "  $step. Equicord settings -> enable VesktopClaudeBridge, paste this token,"
Write-Host "     then reload Discord with Ctrl+R:"
Write-Host "       $token" -ForegroundColor Green
Write-Host "     (the box clears itself on reload - that is on purpose)"
Write-Host ""
$step++

Write-Host "  $step. Register the MCP server:"
Write-Host "       claude mcp add discord -- node `"$mcpPath`"" -ForegroundColor Green
Write-Host ""
$step++

Write-Host "  $step. Ask Claude for discord_status. Anything but no_client means you are done."
Write-Host ""
