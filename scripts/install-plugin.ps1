<#
.SYNOPSIS
    Copies the plugin into an Equicord/Vencord checkout's userplugins folder.

.DESCRIPTION
    Userplugins are compiled into the client bundle, so they have to live inside
    the Equicord source tree. You will need to re-run this (and rebuild) after
    every Equicord update, which is the main ongoing cost of this project.

    With -Build it also writes the aliases Vesktop needs to accept the build as a
    custom "Vencord Location". See the comment on Set-VesktopAliases below.

.PARAMETER EquicordPath
    Root of your Equicord (or Vencord) checkout - the folder containing src/.

.PARAMETER Build
    Also run `pnpm build` afterwards, then write the Vesktop aliases.

.EXAMPLE
    .\scripts\install-plugin.ps1 -EquicordPath D:\Equicord -Build

.NOTES
    Keep this file ASCII-only. Windows PowerShell 5.1 reads a BOM-less script as
    CP1252, where a UTF-8 em-dash (E2 80 94) ends with 0x94 - a curly closing
    quote - which terminates the enclosing string and turns the rest of the file
    into a parse error. An em-dash inside a throw message was enough to make this
    script fail to parse at all.
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
    throw "No src/ under '$EquicordPath' - that doesn't look like an Equicord checkout."
}

function Invoke-Pnpm {
    param([Parameter(Mandatory = $true)][string[]] $PnpmArgs)

    & pnpm @PnpmArgs
    if ($LASTEXITCODE -eq 0) { return }

    # pnpm tries to self-switch to the version pinned in package.json#packageManager,
    # which fails on some setups. Fall back to whatever pnpm is on PATH.
    Write-Host "pnpm failed; retrying without packageManager self-switching..." -ForegroundColor Yellow
    & pnpm --config.manage-package-manager-versions=false @PnpmArgs
    if ($LASTEXITCODE -ne 0) { throw "pnpm $($PnpmArgs -join ' ') failed" }
}

function Set-VesktopAliases {
    param([Parameter(Mandatory = $true)][string] $DistDir)

    # Vesktop validates a custom Vencord Location by looking for Vencord's release
    # asset names (isValidVencordInstall in src/main/utils/vencordLoader.ts) and
    # require()s vencordDesktopMain.js from its own main process. Equicord doesn't
    # build those names, so a stock Equicord dist is rejected as "invalid".
    #
    # Use dist/equibop, NOT dist/desktop. Equibop is Equicord's Vesktop fork, so
    # equibop/main.js is the "host app loads Vencord" entry point Vesktop wants.
    # dist/desktop/patcher.js is the other thing entirely - it rewrites Discord's
    # own app.asar and pulls in discord_desktop_core. Hand that to Vesktop and it
    # hangs on the splash screen with no error.
    #
    # The copies go in beside the originals rather than in a folder of their own:
    # main.js resolves preload.js and renderer.css from its own __dirname, so both
    # sets of names have to sit in the same directory.
    #
    # These are copies of build output, so they go stale the moment Equicord is
    # rebuilt - which is why this runs as part of -Build rather than once by hand.
    $aliases = [ordered]@{
        "main.js"      = "vencordDesktopMain.js"
        "preload.js"   = "vencordDesktopPreload.js"
        "renderer.js"  = "vencordDesktopRenderer.js"
        "renderer.css" = "vencordDesktopRenderer.css"
    }

    foreach ($real in $aliases.Keys) {
        $from = Join-Path $DistDir $real
        if (-not (Test-Path $from)) {
            throw "Expected '$from' after the build but it isn't there. Did the Equicord build layout change?"
        }
        Copy-Item $from -Destination (Join-Path $DistDir $aliases[$real]) -Force
        Write-Host "  $real -> $($aliases[$real])"
    }

    # Vesktop also requires a package.json in the folder; Equicord already writes one.
    if (-not (Test-Path (Join-Path $DistDir "package.json"))) {
        throw "No package.json in '$DistDir' - Vesktop will reject this folder."
    }

    # Guard the mixup above: if this is the Discord-injection build, bail loudly.
    if (Select-String -Path (Join-Path $DistDir "vencordDesktopMain.js") -Pattern "discord_desktop_core" -Quiet) {
        throw "'$DistDir' looks like the Discord app.asar patcher, not a Vesktop host build. Point at dist\equibop."
    }
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
    Push-Location $EquicordPath
    try {
        # A fresh clone has no node_modules, and `pnpm build` fails confusingly without them.
        if (-not (Test-Path (Join-Path $EquicordPath "node_modules"))) {
            Write-Host "No node_modules yet; installing Equicord deps..." -ForegroundColor Cyan
            Invoke-Pnpm install
        }

        Write-Host "Building Equicord..." -ForegroundColor Cyan
        Invoke-Pnpm build
    } finally {
        Pop-Location
    }

    $distDir = Join-Path $EquicordPath "dist\equibop"
    Write-Host "Writing Vesktop aliases..." -ForegroundColor Cyan
    Set-VesktopAliases -DistDir $distDir

    Write-Host ""
    Write-Host "Built. Point Vesktop's Vencord Location at:" -ForegroundColor Green
    Write-Host "  $distDir" -ForegroundColor Green
    Write-Host "then restart Vesktop." -ForegroundColor Green
}
