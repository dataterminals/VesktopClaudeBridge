<#
.SYNOPSIS
    Copies the plugin into an Equicord/Vencord checkout's userplugins folder.

.DESCRIPTION
    Userplugins are compiled into the client bundle, so they have to live inside
    the Equicord source tree. You will need to re-run this (and rebuild) after
    every Equicord update, which is the main ongoing cost of this project.

.PARAMETER EquicordPath
    Root of your Equicord (or Vencord) checkout — the folder containing src/.

.PARAMETER Build
    Also run `pnpm build` afterwards.

.EXAMPLE
    .\scripts\install-plugin.ps1 -EquicordPath D:\Equicord -Build
#>
[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)]
    [string] $EquicordPath,

    [switch] $Build
)

$ErrorActionPreference = "Stop"

$repoRoot = Split-Path -Parent $PSScriptRoot
$source = Join-Path $repoRoot "plugin"

if (-not (Test-Path (Join-Path $EquicordPath "src"))) {
    throw "No src/ under '$EquicordPath' — that doesn't look like an Equicord checkout."
}

# Keep shared/protocol.ts and the plugin's copy in step before anything ships.
Write-Host "Syncing protocol..." -ForegroundColor Cyan
& node (Join-Path $repoRoot "scripts\sync-protocol.mjs")
if ($LASTEXITCODE -ne 0) { throw "protocol sync failed" }

$target = Join-Path $EquicordPath "src\userplugins\vesktopClaudeBridge"
New-Item -ItemType Directory -Force -Path $target | Out-Null

Get-ChildItem -Path $source -File | Where-Object { $_.Extension -in ".ts", ".tsx", ".css" } | ForEach-Object {
    Copy-Item $_.FullName -Destination $target -Force
    Write-Host "  $($_.Name)"
}

Write-Host "Installed to $target" -ForegroundColor Green

if ($Build) {
    Write-Host "Building Equicord..." -ForegroundColor Cyan
    Push-Location $EquicordPath
    try {
        & pnpm build
        if ($LASTEXITCODE -ne 0) { throw "pnpm build failed" }
        Write-Host "Built. Point Vesktop at $EquicordPath\dist and restart it." -ForegroundColor Green
    } finally {
        Pop-Location
    }
}
