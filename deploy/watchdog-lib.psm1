#requires -Version 5.1
<#
Pure helpers for watch-openwa.ps1, split out so they can be tested.

The supervisor itself is a `while ($true)` loop that launches processes, so dot-sourcing it
to reach a function would start the instance. Everything with a decision in it lives here
instead: ancestry, command-line scoping, and the resource strike state machine. The watcher
keeps only the parts that must touch real processes.
#>

$script:RootPidCeiling = 4   # pid 1..4 are the kernel and System; nothing below is a child

<#
Returns true when $ProcessId is $AncestorPid or descends from it, using $Parents as the
pid -> process lookup.

$Parents is a hashtable of pid -> Win32_Process-shaped objects, so this runs entirely
in memory. Querying WMI once per hop instead costs several round trips per Chromium
process, which is enough latency to distort the watchdog's own timing.

The creation-time comparison is the PID-reuse guard. Windows recycles PIDs, so a parent
whose start time is *later* than its child's is not that child's parent at all, it is an
earlier process that happened to be given the same number later. Without this check a
recycled PID can present an orphan as a live descendant and the reaper would sit on a
browser that needs collecting.
#>
function Test-ProcessIsDescendant {
  param(
    [Parameter(Mandatory = $true)] [int] $ProcessId,
    [Parameter(Mandatory = $true)] [int] $AncestorPid,
    [Parameter(Mandatory = $true)] [hashtable] $Parents
  )

  $seen = @{}
  $current = $ProcessId

  # Bounded: corrupt parent data could otherwise contain a cycle and spin here forever.
  for ($hop = 0; $hop -lt 64; $hop++) {
    if ($current -le $script:RootPidCeiling) { return $false }
    if ($current -eq $AncestorPid) { return $true }
    if ($seen.ContainsKey($current)) { return $false }
    $seen[$current] = $true

    $child = $Parents[$current]
    if ($null -eq $child) { return $false }

    $parentId = [int] $child.ParentProcessId
    $parent = $Parents[$parentId]
    if ($null -eq $parent) { return $false }

    # PID reuse guard. Windows hands PIDs back, so a parent whose start time is *later* than
    # its child's is not that child's parent at all -- it is an unrelated process that was
    # given the same number afterwards. Comparing the two objects' own start times is what
    # catches that. Without it a recycled PID presents an orphan as a live descendant and
    # the reaper leaves a browser running indefinitely.
    if ($parent.CreationDate -and $child.CreationDate -and
        $parent.CreationDate -gt $child.CreationDate) {
      return $false
    }

    $current = $parentId
  }

  return $false
}

<#
Builds the pid -> process map. Takes the process objects rather than doing the query, so
the caller controls the single WMI call and the tests can pass fixtures.
#>
function New-ProcessMap {
  param([Parameter(Mandatory = $true)] [AllowEmptyCollection()] [object[]] $Processes)

  $map = @{}
  foreach ($p in $Processes) { $map[[int] $p.ProcessId] = $p }
  return $map
}

<#
True when a command line belongs to a Chromium this instance owns: it carries a
user-data-dir, and that directory resolves to a path inside our sessions folder.

Both conditions are required. Matching on the name alone would take out every Chrome window
on the machine, which is what an earlier version of this script did on every restart. The
sessions path is what makes the match ours rather than the user's.

The path match is anchored on a separator rather than being a plain substring. A hand-made
copy at data\sessions-backup contains data\sessions as a prefix, and a substring test would
claim that browser as ours and eventually kill it.
#>
function Test-IsOpenWaChromiumCommandLine {
  param(
    [AllowNull()] [AllowEmptyString()] [string] $CommandLine,
    [Parameter(Mandatory = $true)] [string] $SessionsRoot
  )

  if ([string]::IsNullOrWhiteSpace($CommandLine)) { return $false }
  if ($CommandLine.IndexOf('user-data-dir', [StringComparison]::OrdinalIgnoreCase) -lt 0) { return $false }

  $root = $SessionsRoot.TrimEnd('\', '/')
  $index = $CommandLine.IndexOf($root, [StringComparison]::OrdinalIgnoreCase)
  if ($index -lt 0) { return $false }

  # Require the match to end at a path boundary, not mid-component.
  $after = $index + $root.Length
  if ($after -ge $CommandLine.Length) { return $true }

  $next = $CommandLine[$after]
  return ($next -eq '\' -or $next -eq '/' -or $next -eq '"' -or $next -eq '''' -or $next -eq ' ')
}

<#
CPU as a percentage of the whole machine over a sampling interval.

Normalised by logical core count, so the threshold reads as "this share of the box" rather
than "this share of one core". Without the division a three-thread busy process reads as
300% and never trips a 100% ceiling.
#>
function Get-NormalizedCpuPercent {
  param(
    [Parameter(Mandatory = $true)] [double] $CpuDeltaSeconds,
    [Parameter(Mandatory = $true)] [double] $WallSeconds,
    [int] $LogicalProcessors = 0
  )

  if ($WallSeconds -le 0) { return 0.0 }

  $cores = $LogicalProcessors
  if ($cores -lt 1) { $cores = [Environment]::ProcessorCount }
  if ($cores -lt 1) { $cores = 1 }

  return [Math]::Round((($CpuDeltaSeconds / $WallSeconds) / $cores) * 100, 1)
}

<#
One step of the resource state machine.

Returns the new strike count. Sustained pressure is required rather than a single sample:
a GC pause, a log rotation, or the Chromium start itself all produce a spike, and a
supervisor that restarts on those turns a busy moment into an outage. Counters reset to
zero as soon as a sample comes back under the ceiling.
#>
function Update-ResourceStrike {
  param(
    [Parameter(Mandatory = $true)] [int] $CurrentStrikes,
    [Parameter(Mandatory = $true)] [double] $RamMB,
    [Parameter(Mandatory = $true)] [double] $MaxRamMB,
    [Parameter(Mandatory = $true)] [double] $CpuPercent,
    [Parameter(Mandatory = $true)] [double] $MaxCpuPercent
  )

  $over = ($RamMB -gt $MaxRamMB) -or ($CpuPercent -gt $MaxCpuPercent)
  if ($over) { return $CurrentStrikes + 1 }
  return 0
}

<#
True when a Chromium old enough to reap is no longer under the supervised node.

The age check and the ancestry check are independent and both required. Age alone would
collect a browser that is mid-handshake; ancestry alone would collect the previous
instance's browser during the seconds before it finishes releasing its profile lock.
#>
function Test-ChromiumNeedsReaping {
  param(
    [Parameter(Mandatory = $true)] [int] $ProcessId,
    [Parameter(Mandatory = $true)] [int] $NodePid,
    [Parameter(Mandatory = $true)] [hashtable] $Parents,
    [Parameter(Mandatory = $true)] [datetime] $Now,
    [Parameter(Mandatory = $true)] [datetime] $CreationDate,
    [Parameter(Mandatory = $true)] [int] $ReapAfterSeconds
  )

  if (Test-ProcessIsDescendant -ProcessId $ProcessId -AncestorPid $NodePid -Parents $Parents) {
    return $false
  }

  return (($Now - $CreationDate).TotalSeconds -ge $ReapAfterSeconds)
}

<#
Scans a process list and reports which of our Chromium processes are collectable.

Pure: the caller supplies the process list. Windows PowerShell binds an empty array to $null,
so $null is treated as "nothing to scan" rather than "go query the machine" -- the caller
owns the WMI call, which also keeps this function runnable against fixtures.

Returns the count of processes that are ours (owned) and the ones that should be reaped, with
the age that justified each decision so the supervisor can log a reason rather than an action.
#>
function Get-OrphanedChromium {
  param(
    [Parameter(Mandatory = $true)] [int] $NodePid,
    [Parameter(Mandatory = $true)] [string] $SessionsRoot,
    [Parameter(Mandatory = $true)] [int] $ReapAfterSeconds,
    [AllowNull()] [AllowEmptyCollection()] [object[]] $Processes,
    [datetime] $Now = (Get-Date)
  )

  if ($null -eq $Processes) { $Processes = @() }

  $parents = New-ProcessMap -Processes $Processes
  $owned = 0
  $orphans = @()

  foreach ($c in $Processes) {
    if ($c.Name -ne 'chrome.exe') { continue }
    if (-not (Test-IsOpenWaChromiumCommandLine -CommandLine $c.CommandLine -SessionsRoot $SessionsRoot)) { continue }
    $owned++

    $needsReaping = Test-ChromiumNeedsReaping -ProcessId ([int] $c.ProcessId) -NodePid $NodePid `
      -Parents $parents -Now $Now -CreationDate $c.CreationDate -ReapAfterSeconds $ReapAfterSeconds

    if ($needsReaping) {
      $orphans += [pscustomobject]@{
        ProcessId  = [int] $c.ProcessId
        AgeSeconds = [Math]::Round(($Now - $c.CreationDate).TotalSeconds, 0)
      }
    }
  }

  return [pscustomobject]@{ Owned = $owned; Orphans = $orphans }
}

Export-ModuleMember -Function @(
  'Test-ProcessIsDescendant'
  'New-ProcessMap'
  'Test-IsOpenWaChromiumCommandLine'
  'Get-NormalizedCpuPercent'
  'Update-ResourceStrike'
  'Test-ChromiumNeedsReaping'
  'Get-OrphanedChromium'
)
