#requires -Version 5.1
<#
Start / Stop / Dashboard / Status helper behind the desktop and Start-menu shortcuts.

The shortcuts are thin: they all run this script with a different -Action. Keeping the logic
here rather than in a shortcut target means the three shortcuts cannot drift apart, and the
same script is usable from a terminal when a shortcut is not handy:

    powershell -ExecutionPolicy Bypass -File deploy\openwa-control.ps1 -Action Start
    powershell -ExecutionPolicy Bypass -File deploy\openwa-control.ps1 -Action Stop
    powershell -ExecutionPolicy Bypass -File deploy\openwa-control.ps1 -Action Status

Start and Stop touch the scheduled task and the port, both of which belong to the current
user's interactive session, so no elevation is required. Stop is deliberately more thorough
than Stop-ScheduledTask: ending the task terminates the *watchdog*, while the node it
launched is a child that can survive the kill, and the leftover Chromium profiles survive
both. Stop therefore also clears the port and the OpenWA browsers.
#>

[CmdletBinding()]
param(
    [Parameter(Mandatory = $true, Position = 0)]
    [ValidateSet('Start', 'Stop', 'Restart', 'Status', 'Dashboard')]
    [string] $Action,

    # Scheduled task that runs deploy\watch-openwa.ps1 at logon.
    [string] $TaskName = 'OpenWA',

    # Port the API listens on.
    [int] $Port = 2785,

    # Repository root; resolved in the body because $PSScriptRoot is not bound during
    # parameter default evaluation under Windows PowerShell 5.1.
    [string] $RepoRoot,

    # Open the browser after Start reports ready.
    [switch] $NoBrowser
)

$ErrorActionPreference = 'Stop'

$scriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
if (-not $RepoRoot) { $RepoRoot = (Resolve-Path (Join-Path $scriptDir '..')).Path }

$DataDir  = Join-Path $RepoRoot 'data'
$Sessions = Join-Path $DataDir 'sessions'
$KeyFile  = Join-Path $DataDir '.api-key'

Import-Module (Join-Path $scriptDir 'watchdog-lib.psm1') -Force -DisableNameChecking

function Write-Step([string] $Message) { Write-Host "  $Message" }

# PIDs currently listening on the API port. Get-NetTCPConnection is the preferred path;
# netstat is the fallback for the rare host without the NetTCPIP module.
function Get-ListenerPid {
    try {
        $conns = Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction Stop
        return @($conns | Select-Object -ExpandProperty OwningProcess -Unique)
    } catch {
        $pids = @()
        foreach ($line in (netstat -ano -p tcp)) {
            if ($line -match "^\s*TCP\s+\S+:$Port\s+\S+\s+LISTENING\s+(\d+)\s*$") { $pids += [int] $Matches[1] }
        }
        return @($pids | Select-Object -Unique)
    }
}

# Only browsers whose profile lives under our sessions folder, via the same tested predicate
# the watchdog reaper uses -- never a blanket chrome.exe sweep.
function Stop-OpenWaChromium {
    $procs = Get-CimInstance Win32_Process -Filter "Name='chrome.exe'" -ErrorAction SilentlyContinue
    foreach ($p in $procs) {
        if (Test-IsOpenWaChromiumCommandLine -CommandLine $p.CommandLine -SessionsRoot $Sessions) {
            Write-Step "stopping OpenWA chromium PID $($p.ProcessId)"
            Stop-Process -Id $p.ProcessId -Force -ErrorAction SilentlyContinue
        }
    }
}

# Stop-ScheduledTask ends the watchdog only when the task launched it. A watchdog started by
# hand is not the task's process, so it has to be matched separately; otherwise it keeps
# relaunching node the moment Stop clears the port.
#
# The match is on the *full* path to watch-openwa.ps1 as the -File argument, not on the bare
# filename. A bare-name match also hit any shell whose command line merely mentioned the
# script (including this very tool invocation), which is how an earlier version terminated an
# unrelated terminal. Anything carrying openwa-control.ps1 is excluded for the same reason.
function Stop-WatchdogProcesses {
    $watchdogPath = Join-Path $scriptDir 'watch-openwa.ps1'
    $procs = Get-CimInstance Win32_Process -Filter "Name='powershell.exe'" -ErrorAction SilentlyContinue
    foreach ($p in $procs) {
        if ($p.ProcessId -eq $PID) { continue }
        $cl = $p.CommandLine
        if (-not $cl) { continue }
        if ($cl -notlike "*$watchdogPath*") { continue }
        if ($cl -like '*openwa-control.ps1*') { continue }
        Write-Step "stopping watchdog PID $($p.ProcessId)"
        Stop-Process -Id $p.ProcessId -Force -ErrorAction SilentlyContinue
    }
}

function Test-ApiReady {
    try {
        $r = Invoke-WebRequest -Uri "http://localhost:$Port/api/health/ready" -UseBasicParsing -TimeoutSec 5
        return ($r.StatusCode -eq 200)
    } catch {
        return $false
    }
}

function Open-Dashboard {
    if ($NoBrowser) { return }
    Start-Process "http://localhost:$Port"
}

function Invoke-Start {
    $task = Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
    if ($task) {
        Write-Step "starting scheduled task '$TaskName'"
        Start-ScheduledTask -TaskName $TaskName
    } else {
        Write-Step "'$TaskName' is not registered; launching the watchdog directly"
        Start-Process -FilePath 'powershell.exe' -WindowStyle Hidden -ArgumentList @(
            '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass',
            '-File', (Join-Path $scriptDir 'watch-openwa.ps1')
        )
    }

    Write-Step 'waiting for /api/health/ready (up to 120s)'
    $deadline = (Get-Date).AddSeconds(120)
    while ((Get-Date) -lt $deadline) {
        if (Test-ApiReady) {
            Write-Step 'API is ready'
            Open-Dashboard
            return
        }
        Start-Sleep -Seconds 2
    }

    Write-Warning "the API did not become ready within 120s; see data\logs\watchdog.log"
}

function Invoke-Stop {
    $task = Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
    if ($task) {
        Write-Step "stopping scheduled task '$TaskName'"
        Stop-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
        # Give the watchdog a moment to exit so it cannot relaunch node behind us.
        Start-Sleep -Seconds 3
    }

    # Covers a watchdog that was launched by hand rather than by the task.
    Stop-WatchdogProcesses
    Start-Sleep -Seconds 1

    # Ending the watchdog stops it from supervising, not the node it launched. Clear the port,
    # retrying a few times in case node was mid-restart when the watchdog was told to stop.
    for ($i = 0; $i -lt 6; $i++) {
        $pids = Get-ListenerPid
        if (-not $pids) { break }
        foreach ($procId in $pids) {
            Write-Step "stopping node PID $procId on port $Port"
            Stop-Process -Id $procId -Force -ErrorAction SilentlyContinue
        }
        Start-Sleep -Seconds 1
    }

    Stop-OpenWaChromium
    Write-Step 'stopped'
}

function Invoke-Status {
    $task = Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
    if ($task) {
        $info = Get-ScheduledTaskInfo -TaskName $TaskName
        Write-Host "Task '$TaskName': state=$($task.State) lastResult=$($info.LastTaskResult) lastRun=$($info.LastRunTime)"
    } else {
        Write-Host "Task '$TaskName': not registered"
    }

    if (-not (Test-ApiReady)) {
        Write-Host "API: not ready on port $Port"
        return
    }

    Write-Host "API: ready on port $Port"
    if (-not (Test-Path -LiteralPath $KeyFile)) { return }
    $key = (Get-Content -LiteralPath $KeyFile -Raw).Trim()
    try {
        $sessions = Invoke-RestMethod -Uri "http://localhost:$Port/api/sessions" -Headers @{ 'X-API-Key' = $key } -TimeoutSec 8
        foreach ($s in @($sessions)) { Write-Host ("  session {0}: {1}" -f $s.name, $s.status) }
    } catch {
        Write-Host "  could not list sessions: $($_.Exception.Message)"
    }
}

switch ($Action) {
    'Start'     { Invoke-Start }
    'Stop'      { Invoke-Stop }
    'Restart'   { Invoke-Stop; Invoke-Start }
    'Status'    { Invoke-Status }
    'Dashboard' { Open-Dashboard }
}
