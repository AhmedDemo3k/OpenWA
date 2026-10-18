#requires -Version 5.1
<#
Creates the OpenWA desktop and Start-menu shortcuts (Start, Dashboard, Stop).

Idempotent: re-running overwrites the existing .lnk files, so changing where the control
script lives does not require removing the old shortcuts first.

Each shortcut is a thin wrapper around deploy\openwa-control.ps1. Running PowerShell with
-File rather than -Command keeps the quoting stable when the repository path contains
spaces, which it does here.
#>

[CmdletBinding()]
param(
    # Repository root; resolved in the body because $PSScriptRoot is not bound during
    # parameter default evaluation under Windows PowerShell 5.1.
    [string] $RepoRoot,

    # Skip the Start-menu copies and only write the desktop ones.
    [switch] $DesktopOnly
)

$ErrorActionPreference = 'Stop'

$scriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
if (-not $RepoRoot) { $RepoRoot = (Resolve-Path (Join-Path $scriptDir '..')).Path }

$control = Join-Path $scriptDir 'openwa-control.ps1'
$icon    = Join-Path $scriptDir 'openwa.ico'
$powershell = Join-Path $PSHOME 'powershell.exe'

# The icon is a build product of make-icon.ps1; regenerate it if it is missing.
if (-not (Test-Path -LiteralPath $icon)) {
    & (Join-Path $scriptDir 'make-icon.ps1')
}

$desktop     = [Environment]::GetFolderPath('Desktop')
$startMenu   = Join-Path $env:APPDATA 'Microsoft\Windows\Start Menu\Programs\OpenWA'

# name -> -Action value
$shortcuts = [ordered]@{
    'OpenWA - Start'     = 'Start'
    'OpenWA - Dashboard' = 'Dashboard'
    'OpenWA - Stop'      = 'Stop'
}

$shell = New-Object -ComObject WScript.Shell

function New-Shortcut([string] $Path, [string] $Target, [string] $Arguments, [string] $WorkingDirectory, [string] $IconPath, [string] $Description) {
    $dir = Split-Path -Parent $Path
    if (-not (Test-Path -LiteralPath $dir)) { New-Item -ItemType Directory -Path $dir -Force | Out-Null }
    $lnk = $shell.CreateShortcut($Path)
    $lnk.TargetPath       = $Target
    $lnk.Arguments        = $Arguments
    $lnk.WorkingDirectory = $WorkingDirectory
    $lnk.IconLocation     = $IconPath
    $lnk.Description      = $Description
    $lnk.Save()
}

foreach ($entry in $shortcuts.GetEnumerator()) {
    $name   = $entry.Key
    $action = $entry.Value
    $args   = '-NoProfile -NonInteractive -ExecutionPolicy Bypass -WindowStyle Hidden -File "{0}" -Action {1}' -f $control, $action
    $desc   = 'OpenWA: {0}' -f $action

    New-Shortcut -Path (Join-Path $desktop "$name.lnk") -Target $powershell -Arguments $args `
        -WorkingDirectory $RepoRoot -IconPath "$icon,0" -Description $desc
    Write-Host "  wrote $desktop\$name.lnk"

    if (-not $DesktopOnly) {
        New-Shortcut -Path (Join-Path $startMenu "$name.lnk") -Target $powershell -Arguments $args `
            -WorkingDirectory $RepoRoot -IconPath "$icon,0" -Description $desc
        Write-Host "  wrote $startMenu\$name.lnk"
    }
}

Write-Host ''
Write-Host 'Shortcuts created:'
Write-Host "  Start     - starts the scheduled task and waits for the API to answer"
Write-Host "  Dashboard - opens http://localhost:2785"
Write-Host "  Stop      - stops the task, then clears the port and OpenWA browsers"
Write-Host ''
Write-Host "Or from a terminal: $powershell -ExecutionPolicy Bypass -File `"$control`" -Action Status"
