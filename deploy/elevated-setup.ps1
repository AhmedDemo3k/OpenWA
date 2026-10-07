#requires -Version 5.1
<#
.Reruns the one-time, admin-only pieces of the OpenWA host setup that the interactive
watchdog script (watch-openwa.ps1) cannot do for itself: it self-elevates, registers the
`scheduled task that launches the watchdog at logon, opens the inbound firewall port the
API listens on, and (optionally) hardens the data directory ACL.

Why elevated: the scheduled task and firewall policy are per-machine. The shared "how do I
run this thing" story is then reduced to a single command that can be pasted into an
Administrator PowerShell:

    powershell -ExecutionPolicy Bypass -File deploy\elevated-setup.ps1

Safety rules that apply here:

  * Nothing here points at %TEMP%. Every path is derived from the repository root so the
    helper (and the databases/state it is meant to keep supervised) survives disk cleanups.
  * The API key, sessions, and media under data/ are never read, printed, or modified. The
    ACL step only changes who is *allowed* access; it does not open anything.
  * Registering the task is idempotent: re-running with -ForceTask re-registers with the
    exact same definition, so refreshing the watchdog script does not require uninstalling.
  * ACL hardening is opt-in (-HardenDataAcl) and only grants the current user, Administrators,
    and SYSTEM. Restricting the data directory is a breaking change for the previous layout,
    so nothing applies it silently.
#>

[CmdletBinding()]
param(
    # Repository root; defaults to the parent of this script's folder.
    [string] $RepoRoot = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path,

    # Scheduled task that runs deploy\watch-openwa.ps1 at logon.
    [string] $TaskName = 'OpenWA',

    # Inbound TCP port to allow through the firewall.
    [int] $Port = 2785,

    # Skip the firewall rule entirely (e.g. when the API is only reachable via Tailscale).
    [switch] $NoFirewall,

    # Lock data\ down to the current user, Administrators, and SYSTEM.
    [switch] $HardenDataAcl,

    # Re-register the task even if it already exists (config refresh).
    [switch] $Force
)

$ErrorActionPreference = 'Stop'

function Write-Step([string]$Message) {
    Write-Host "  * $Message"
}

# ---- Elevate ----------------------------------------------------------------------
# The TCP port and the machine-wide task both need Administrator rights. If we are not
# elevated, relaunch the exact same invocation through UAC and hand control back. Adding
# -NoProfile keeps the child identical to what a clean Administrator console would run.
$isAdmin = ([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent())
if (-not $isAdmin.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
    $escaped = '"' + $PSCommandPath + '"'
    foreach ($p in $PSBoundParameters.GetEnumerator()) {
        if ($p.Key -in @('RepoRoot', 'TaskName')) { continue }
        if ($p.Value -is [switch]) { $escaped += " -$($p.Key)" }
        else { $escaped += " -$($p.Key) '$($p.Value)'" }
    }
    Write-Host "Not elevated; relaunching with administrator rights..."
    Start-Process -FilePath 'powershell.exe' -Verb RunAs -Wait -ArgumentList @(
        '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass',
        '-File', $escaped
    )
    exit $LASTEXITCODE
}

Write-Host "OpenWA host setup (running as $([Security.Principal.WindowsIdentity]::GetCurrent().Name))"

# ---- Task settings ----------------------------------------------------------------
# Mirror the definition that was originally created by hand: logon trigger for the
# interactive user, RunLevel Limited (the watchdog must not run with admin rights), Start
# When Available so a missed logon still starts on boot, PT0S so task scheduler never ends
# the watchdog, RestartCount 999 so the Task Scheduler itself restarts a dead supervisor,
# and IgnoreNew so a double logon can never run two watchdogs.
$user = [Security.Principal.WindowsIdentity]::GetCurrent().Name
$watchdog = Join-Path $PSScriptRoot 'watch-openwa.ps1'

$action = New-ScheduledTaskAction -Execute 'powershell.exe' -Argument (
    "-NoProfile -NonInteractive -ExecutionPolicy Bypass -WindowStyle Hidden -File `"$watchdog`""
) -WorkingDirectory $RepoRoot

$trigger = New-ScheduledTaskTrigger -AtLogOn -User $user

$settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries `
    -StartWhenAvailable -ExecutionTimeLimit ([TimeSpan]::Zero) `
    -RestartCount 999 -RestartInterval (New-TimeSpan -Minutes 1) `
    -MultipleInstances IgnoreNew

$principal = New-ScheduledTaskPrincipal -UserId $user -LogonType Interactive -RunLevel Limited

Write-Step "registering scheduled task '$TaskName' (watchdog: $watchdog)"
if (-not $Force -and (Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue)) {
    Write-Step "task '$TaskName' already exists; use -Force to re-register with the current script path"
} else {
    Register-ScheduledTask -TaskName $TaskName -Action $action -Trigger $trigger `
        -Settings $settings -Principal $principal -Description (
            'OpenWA + watchdog. Auto-starts at logon, survives battery changes, restarts on failure, no execution time limit.'
        ) -Force | Out-Null
    Write-Step 'task registered'
}

# ---- Firewall ---------------------------------------------------------------------
if (-not $NoFirewall) {
    Write-Step "firewall: allowing inbound TCP $Port"
    try {
        Get-NetFirewallRule -DisplayName 'OpenWA API (TCP)' -ErrorAction SilentlyContinue |
            Remove-NetFirewallRule -ErrorAction SilentlyContinue
        New-NetFirewallRule -DisplayName 'OpenWA API (TCP)' -Direction Inbound `
            -Protocol TCP -LocalPort $Port -Action Allow -Profile Any | Out-Null
    } catch {
        Write-Warning "firewall rule could not be applied: $($_.Exception.Message)"
    }
} else {
    Write-Step 'firewall: skipped (-NoFirewall)'
}

# ---- Data directory + ACL ---------------------------------------------------------
$dataDir = Join-Path $RepoRoot 'data'
foreach ($d in @($dataDir, (Join-Path $dataDir 'runtime'), (Join-Path $dataDir 'logs'), (Join-Path $dataDir 'sessions'), (Join-Path $dataDir 'media'))) {
    if (-not (Test-Path -LiteralPath $d)) {
        New-Item -ItemType Directory -Path $d -Force | Out-Null
        Write-Step "created $d"
    }
}

if ($HardenDataAcl) {
    Write-Step "hardening ACL on $dataDir (current user, Administrators, SYSTEM)"
    $identity = [Security.Principal.WindowsIdentity]::GetCurrent()
    $acl = Get-Acl -LiteralPath $dataDir
    $acl.SetAccessRuleProtection($true, $false)
    $admin = New-Object System.Security.AccessControl.FileSystemAccessRule(
        'BUILTIN\Administrators', 'FullControl', 'ContainerInherit,ObjectInherit', 'None', 'Allow')
    $system = New-Object System.Security.AccessControl.FileSystemAccessRule(
        'SYSTEM', 'FullControl', 'ContainerInherit,ObjectInherit', 'None', 'Allow')
    $owner = New-Object System.Security.AccessControl.FileSystemAccessRule(
        $identity.Name, 'FullControl', 'ContainerInherit,ObjectInherit', 'None', 'Allow')
    $acl.AddAccessRule($admin)
    $acl.AddAccessRule($system)
    $acl.AddAccessRule($owner)
    Set-Acl -LiteralPath $dataDir -AclObject $acl
    Write-Step "ACL updated for $dataDir"
} else {
    Write-Step "ACL left untouched; use -HardenDataAcl to restrict $dataDir"
}

Write-Host ''
Write-Host 'Done. The watchdog is supervised by Task Scheduler (logon trigger).'
Write-Host "  Start now : Start-ScheduledTask -TaskName '$TaskName'"
Write-Host "  Stop now  : Get-ScheduledTask -TaskName '$TaskName' | Stop-ScheduledTask"
Write-Host "  Remove all: Unregister-ScheduledTask -TaskName '$TaskName' -Confirm:`$false ; Get-NetFirewallRule -DisplayName 'OpenWA API (TCP)' | Remove-NetFirewallRule"