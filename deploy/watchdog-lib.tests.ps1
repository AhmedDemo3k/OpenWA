#requires -Version 5.1
<#
Tests for the pure helpers in watchdog-lib.psm1.

These exist because the decisions are the dangerous part of the supervisor: the reaper kills
processes, and the resource guard restarts a live instance. Both are only correct under
conditions that are awkward to reproduce for real -- an orphaned browser, a recycled PID, a
process that looks healthy while it leaks. Each of those is a fixture below.
#>

Set-ExecutionPolicy -Scope Process -ExecutionPolicy Bypass -Force
Import-Module (Join-Path $PSScriptRoot 'watchdog-lib.psm1') -Force -DisableNameChecking

$script:Base = [datetime]'2026-10-06T12:00:00'

function New-FakeProcess {
  param(
    [int] $ProcessId,
    [int] $ParentProcessId,
    [datetime] $Created,
    [string] $Name = 'chrome.exe',
    [string] $CommandLine = ''
  )

  [pscustomobject]@{
    ProcessId       = $ProcessId
    ParentProcessId = $ParentProcessId
    # Win32_Process exposes only the process's own start time. The PID-reuse guard compares
    # a child against its parent's, so two fixtures are needed to express a recycled PID:
    # the parent started later than the child claims it as parent.
    CreationDate    = $Created
    Name            = $Name
    CommandLine     = $CommandLine
  }
}

Describe 'Test-ProcessIsDescendant' {
  It 'matches the ancestor itself' {
    $map = New-ProcessMap -Processes @((New-FakeProcess -ProcessId 100 -ParentProcessId 1 -Created $script:Base))
    Test-ProcessIsDescendant -ProcessId 100 -AncestorPid 100 -Parents $map | Should Be $true
  }

  It 'follows a multi-hop chain' {
    # node 100 -> chrome browser 200 -> renderer 300 -> zygote 400.
    $map = New-ProcessMap -Processes @(
      (New-FakeProcess -ProcessId 100 -ParentProcessId 1  -Created $script:Base.AddSeconds(-100)),
      (New-FakeProcess -ProcessId 200 -ParentProcessId 100 -Created $script:Base.AddSeconds(-50)),
      (New-FakeProcess -ProcessId 300 -ParentProcessId 200 -Created $script:Base.AddSeconds(-40)),
      (New-FakeProcess -ProcessId 400 -ParentProcessId 300 -Created $script:Base.AddSeconds(-30))
    )

    Test-ProcessIsDescendant -ProcessId 400 -AncestorPid 100 -Parents $map | Should Be $true
  }

  It 'reports a re-parented process as unrelated' {
    # The failure this reaper exists for: node died, the browser was re-parented to
    # something else, and its PID is now live and holding memory.
    $map = New-ProcessMap -Processes @(
      (New-FakeProcess -ProcessId 100 -ParentProcessId 1   -Created $script:Base.AddSeconds(-100)),
      (New-FakeProcess -ProcessId 200 -ParentProcessId 555 -Created $script:Base.AddSeconds(-500))
    )

    Test-ProcessIsDescendant -ProcessId 200 -AncestorPid 100 -Parents $map | Should Be $false
  }

  It 'treats a parent started after its child as a recycled PID, not a link' {
    # Windows hands PIDs back. PID 200 claims 100 as its parent, but 100 started ten seconds
    # *after* 200, so they cannot be related. Without this guard the reaper sees a live
    # descendant and never collects a browser that has outlived its node.
    $map = New-ProcessMap -Processes @(
      (New-FakeProcess -ProcessId 100 -ParentProcessId 1 -Created $script:Base.AddSeconds(-10)),
      (New-FakeProcess -ProcessId 200 -ParentProcessId 100 -Created $script:Base.AddSeconds(-50))
    )

    Test-ProcessIsDescendant -ProcessId 200 -AncestorPid 100 -Parents $map | Should Be $false
  }

  It 'still follows a genuine chain whose parent started earlier' {
    $map = New-ProcessMap -Processes @(
      (New-FakeProcess -ProcessId 100 -ParentProcessId 1   -Created $script:Base.AddSeconds(-100)),
      (New-FakeProcess -ProcessId 200 -ParentProcessId 100 -Created $script:Base.AddSeconds(-50))
    )

    Test-ProcessIsDescendant -ProcessId 200 -AncestorPid 100 -Parents $map | Should Be $true
  }

  It 'returns false for an unknown PID' {
    $map = New-ProcessMap -Processes @()
    Test-ProcessIsDescendant -ProcessId 999 -AncestorPid 100 -Parents $map | Should Be $false
  }

  It 'returns false rather than spinning on a parent cycle' {
    $map = New-ProcessMap -Processes @(
      (New-FakeProcess -ProcessId 10 -ParentProcessId 20 -Created $script:Base.AddSeconds(-30)),
      (New-FakeProcess -ProcessId 20 -ParentProcessId 10 -Created $script:Base.AddSeconds(-20))
    )

    # Bounded at 64 hops: this returns rather than hanging the watchdog.
    Test-ProcessIsDescendant -ProcessId 10 -AncestorPid 777 -Parents $map | Should Be $false
  }

  It 'does not treat a system process as a descendant' {
    $map = New-ProcessMap -Processes @((New-FakeProcess -ProcessId 4 -ParentProcessId 0 -Created $script:Base))
    Test-ProcessIsDescendant -ProcessId 4 -AncestorPid 100 -Parents $map | Should Be $false
  }
}

Describe 'Test-IsOpenWaChromiumCommandLine' {
  $sessions = 'C:\Users\homek\Downloads\OpenWA\data\sessions'

  It 'accepts a browser holding one of our profiles' {
    $cmd = 'chrome.exe --user-data-dir="C:\Users\homek\Downloads\OpenWA\data\sessions\session-smoke-83107"'
    Test-IsOpenWaChromiumCommandLine -CommandLine $cmd -SessionsRoot $sessions | Should Be $true
  }

  It 'matches regardless of case' {
    # Chromium lower-cases its own flags on some paths; a case-sensitive match here would
    # silently stop reaping and nobody would notice.
    $cmd = 'chrome.exe --USER-DATA-DIR="c:\users\homek\downloads\openwa\data\sessions\session-x"'
    Test-IsOpenWaChromiumCommandLine -CommandLine $cmd -SessionsRoot $sessions | Should Be $true
  }

  It 'rejects a personal browser' {
    # The regression an earlier version of the watchdog carried: it killed every Chrome
    # window on the machine on each restart, including unsaved form data.
    $cmd = 'chrome.exe --user-data-dir="C:\Users\homek\AppData\Local\Google\Chrome\User Data"'
    Test-IsOpenWaChromiumCommandLine -CommandLine $cmd -SessionsRoot $sessions | Should Be $false
  }

  It 'rejects a browser with no user-data-dir at all' {
    Test-IsOpenWaChromiumCommandLine -CommandLine 'chrome.exe --no-startup-window' -SessionsRoot $sessions | Should Be $false
  }

  It 'rejects a null or empty command line' {
    Test-IsOpenWaChromiumCommandLine -CommandLine $null -SessionsRoot $sessions | Should Be $false
    Test-IsOpenWaChromiumCommandLine -CommandLine '' -SessionsRoot $sessions | Should Be $false
  }

  It 'rejects a sibling directory whose name merely starts with ours' {
    # 'data\sessions-backup' contains 'data\sessions' as a prefix. A substring test claims
    # that browser as ours, and the reaper eventually kills a directory it does not own --
    # the shape of a stale copy someone made by hand.
    $cmd = 'chrome.exe --user-data-dir="C:\Users\homek\Downloads\OpenWA\data\sessions-backup"'
    Test-IsOpenWaChromiumCommandLine -CommandLine $cmd -SessionsRoot $sessions | Should Be $false
  }

  It 'accepts the sessions root with a trailing separator in the path' {
    $cmd = 'chrome.exe --user-data-dir="C:\Users\homek\Downloads\OpenWA\data\sessions\"'
    Test-IsOpenWaChromiumCommandLine -CommandLine $cmd -SessionsRoot $sessions | Should Be $true
  }

  It 'accepts an unquoted path ending in a separator' {
    $cmd = 'chrome.exe --user-data-dir=C:\Users\homek\Downloads\OpenWA\data\sessions\'
    Test-IsOpenWaChromiumCommandLine -CommandLine $cmd -SessionsRoot $sessions | Should Be $true
  }
}

Describe 'Get-NormalizedCpuPercent' {
  It 'reports a fully busy single core as 100% of one core' {
    # One core saturated for one second, measured over one second.
    Get-NormalizedCpuPercent -CpuDeltaSeconds 1 -WallSeconds 1 -LogicalProcessors 1 | Should Be 100.0
  }

  It 'divides by core count so a multi-threaded process reads against the whole machine' {
    # Four cores pegged for a second is 400% of one core, which on a four-core box is 100%
    # of the machine. Without the division this would never trip a 100% ceiling.
    Get-NormalizedCpuPercent -CpuDeltaSeconds 4 -WallSeconds 1 -LogicalProcessors 4 | Should Be 100.0
  }

  It 'reports half the machine as 50%' {
    Get-NormalizedCpuPercent -CpuDeltaSeconds 1 -WallSeconds 1 -LogicalProcessors 2 | Should Be 50.0
  }

  It 'returns 0 for a zero-length interval rather than dividing by zero' {
    # A tick that ran instantly would otherwise produce Infinity or NaN, and NaN compares
    # false against every threshold so the guard would silently stop working.
    Get-NormalizedCpuPercent -CpuDeltaSeconds 5 -WallSeconds 0 -LogicalProcessors 4 | Should Be 0.0
  }

  It 'handles a negative delta from a recycled counter' {
    Get-NormalizedCpuPercent -CpuDeltaSeconds -3 -WallSeconds 10 -LogicalProcessors 4 | Should Be -7.5
  }

  It 'falls back to the machine core count when none is supplied' {
    $expected = [Math]::Round((1 / [Environment]::ProcessorCount) * 100, 1)
    Get-NormalizedCpuPercent -CpuDeltaSeconds 1 -WallSeconds 1 -LogicalProcessors 0 | Should Be $expected
  }
}

Describe 'Update-ResourceStrike' {
  $maxRam = 3072.0
  $maxCpu = 85.0

  It 'does not strike below both ceilings' {
    Update-ResourceStrike -CurrentStrikes 0 -RamMB 800 -MaxRamMB $maxRam -CpuPercent 5 -MaxCpuPercent $maxCpu |
      Should Be 0
  }

  It 'strikes on memory alone' {
    Update-ResourceStrike -CurrentStrikes 0 -RamMB 4000 -MaxRamMB $maxRam -CpuPercent 5 -MaxCpuPercent $maxCpu |
      Should Be 1
  }

  It 'strikes on CPU alone' {
    Update-ResourceStrike -CurrentStrikes 0 -RamMB 800 -MaxRamMB $maxRam -CpuPercent 99 -MaxCpuPercent $maxCpu |
      Should Be 1
  }

  It 'accumulates across consecutive samples' {
    $strikes = 0
    1..5 | ForEach-Object {
      $strikes = Update-ResourceStrike -CurrentStrikes $strikes -RamMB 4000 -MaxRamMB $maxRam -CpuPercent 99 -MaxCpuPercent $maxCpu
    }
    $strikes | Should Be 5
  }

  It 'resets to zero on the first recovered sample' {
    # The whole point of requiring sustained pressure: one GC pause must not count, and a
    # recovery has to clear the history rather than leaving 4 of 5 strikes on the clock.
    $strikes = 0
    1..4 | ForEach-Object {
      $strikes = Update-ResourceStrike -CurrentStrikes $strikes -RamMB 4000 -MaxRamMB $maxRam -CpuPercent 99 -MaxCpuPercent $maxCpu
    }
    $strikes = Update-ResourceStrike -CurrentStrikes $strikes -RamMB 800 -MaxRamMB $maxRam -CpuPercent 5 -MaxCpuPercent $maxCpu
    $strikes | Should Be 0
  }

  It 'treats a reading exactly on the ceiling as within it' {
    Update-ResourceStrike -CurrentStrikes 0 -RamMB $maxRam -MaxRamMB $maxRam -CpuPercent $maxCpu -MaxCpuPercent $maxCpu |
      Should Be 0
  }

  It 'strikes one unit past the ceiling' {
    Update-ResourceStrike -CurrentStrikes 0 -RamMB ($maxRam + 0.1) -MaxRamMB $maxRam -CpuPercent 5 -MaxCpuPercent $maxCpu |
      Should Be 1
  }
}

Describe 'Test-ChromiumNeedsReaping' {
  $reapAfter = 120

  It 'leaves a browser owned by the current instance alone' {
    $map = New-ProcessMap -Processes @(
      (New-FakeProcess -ProcessId 100 -ParentProcessId 1 -Created $script:Base.AddSeconds(-600)),
      (New-FakeProcess -ProcessId 200 -ParentProcessId 100 -Created $script:Base.AddSeconds(-500))
    )

    Test-ChromiumNeedsReaping -ProcessId 200 -NodePid 100 -Parents $map -Now $script:Base `
      -CreationDate $script:Base.AddSeconds(-500) -ReapAfterSeconds $reapAfter | Should Be $false
  }

  It 'reaps an old browser no longer under the node' {
    $map = New-ProcessMap -Processes @(
      (New-FakeProcess -ProcessId 100 -ParentProcessId 1   -Created $script:Base.AddSeconds(-600)),
      (New-FakeProcess -ProcessId 200 -ParentProcessId 999 -Created $script:Base.AddSeconds(-500))
    )

    Test-ChromiumNeedsReaping -ProcessId 200 -NodePid 100 -Parents $map -Now $script:Base `
      -CreationDate $script:Base.AddSeconds(-500) -ReapAfterSeconds $reapAfter | Should Be $true
  }

  It 'leaves a young orphan alone so it can finish releasing its profile' {
    # On a restart the previous browser is still tearing down. Killing it immediately
    # races the profile lock and turns a clean restart into a corrupted session.
    $map = New-ProcessMap -Processes @(
      (New-FakeProcess -ProcessId 100 -ParentProcessId 1   -Created $script:Base.AddSeconds(-600)),
      (New-FakeProcess -ProcessId 200 -ParentProcessId 999 -Created $script:Base.AddSeconds(-30))
    )

    Test-ChromiumNeedsReaping -ProcessId 200 -NodePid 100 -Parents $map -Now $script:Base `
      -CreationDate $script:Base.AddSeconds(-30) -ReapAfterSeconds $reapAfter | Should Be $false
  }

  It 'reaps at exactly the grace boundary' {
    $map = New-ProcessMap -Processes @(
      (New-FakeProcess -ProcessId 100 -ParentProcessId 1   -Created $script:Base.AddSeconds(-600)),
      (New-FakeProcess -ProcessId 200 -ParentProcessId 999 -Created $script:Base.AddSeconds(-600))
    )

    Test-ChromiumNeedsReaping -ProcessId 200 -NodePid 100 -Parents $map -Now $script:Base `
      -CreationDate $script:Base.AddSeconds(-600) -ReapAfterSeconds $reapAfter | Should Be $true
  }

  It 'reaps a renderer left behind by a browser that itself was reaped' {
    # The grandchildren case: the browser process is gone from the map entirely, so the
    # chain dead-ends and the renderer is correctly seen as unowned.
    $map = New-ProcessMap -Processes @(
      (New-FakeProcess -ProcessId 100 -ParentProcessId 1   -Created $script:Base.AddSeconds(-600)),
      (New-FakeProcess -ProcessId 300 -ParentProcessId 200 -Created $script:Base.AddSeconds(-500))
    )

    Test-ChromiumNeedsReaping -ProcessId 300 -NodePid 100 -Parents $map -Now $script:Base `
      -CreationDate $script:Base.AddSeconds(-500) -ReapAfterSeconds $reapAfter | Should Be $true
  }
}

Describe 'Get-OrphanedChromium' {
  $sessions = 'C:\Users\homek\Downloads\OpenWA\data\sessions'
  $nodePid  = 100
  $ours     = 'chrome.exe --user-data-dir="' + $sessions + '\session-a"'
  $theirs   = 'chrome.exe --user-data-dir="C:\Users\homek\AppData\Local\Google\Chrome\User Data"'

  function New-ScanSet {
    param([int] $NodePid, [datetime] $Now)

    @(
      (New-FakeProcess -ProcessId $NodePid -ParentProcessId 1   -Created $Now.AddSeconds(-900) -CommandLine 'node.exe dist\main.js'),
      (New-FakeProcess -ProcessId 200   -ParentProcessId $NodePid -Created $Now.AddSeconds(-600) -CommandLine $ours),
      (New-FakeProcess -ProcessId 300   -ParentProcessId 200 -Created $Now.AddSeconds(-600) -CommandLine $ours)
    )
  }

  It 'collects nothing while the browser is a descendant of the supervised node' {
    $now = $script:Base
    $scan = Get-OrphanedChromium -NodePid $nodePid -SessionsRoot $sessions -ReapAfterSeconds 120 `
      -Processes (New-ScanSet -NodePid $nodePid -Now $now) -Now $now

    $scan.Owned | Should Be 2
    $scan.Orphans.Count | Should Be 0
  }

  It 'collects the whole re-parented tree once the node is no longer the parent' {
    # The scenario that motivated all of this: the server died, so the browser and its
    # renderers were re-parented and kept running. Both must go, or they hold a profile
    # directory the next instance then refuses to open.
    $now = $script:Base
    $set = @(
      (New-FakeProcess -ProcessId 900   -ParentProcessId 1   -Created $now.AddSeconds(-900) -CommandLine 'node.exe dist\main.js'),
      (New-FakeProcess -ProcessId 200   -ParentProcessId 900  -Created $now.AddSeconds(-600) -CommandLine $ours),
      (New-FakeProcess -ProcessId 300   -ParentProcessId 200  -Created $now.AddSeconds(-600) -CommandLine $ours)
    )

    $scan = Get-OrphanedChromium -NodePid $nodePid -SessionsRoot $sessions -ReapAfterSeconds 120 -Processes $set -Now $now

    $scan.Owned | Should Be 2
    $scan.Orphans.Count | Should Be 2
  }

  It 'leaves a re-parented tree inside the grace period alone' {
    # On a watchdog restart the previous browser is still releasing its profile. Killing it
    # now races the lock file and turns a clean restart into a corrupted session.
    $now = $script:Base
    $set = @(
      (New-FakeProcess -ProcessId 900 -ParentProcessId 1  -Created $now.AddSeconds(-900) -CommandLine 'node.exe dist\main.js'),
      (New-FakeProcess -ProcessId 200 -ParentProcessId 900 -Created $now.AddSeconds(-10) -CommandLine $ours)
    )

    $scan = Get-OrphanedChromium -NodePid $nodePid -SessionsRoot $sessions -ReapAfterSeconds 120 -Processes $set -Now $now

    $scan.Owned | Should Be 1
    $scan.Orphans.Count | Should Be 0
  }

  It 'never counts a foreign browser as ours' {
    # Owned must describe only our processes, otherwise the log reads like the supervisor is
    # responsible for the user's own browser, and a future change that trusts the count
    # could act on it.
    $now = $script:Base
    $set = @(
      (New-FakeProcess -ProcessId $nodePid -ParentProcessId 1 -Created $now.AddSeconds(-900) -CommandLine 'node.exe dist\main.js'),
      (New-FakeProcess -ProcessId 700   -ParentProcessId 1   -Created $now.AddSeconds(-900) -CommandLine $theirs),
      (New-FakeProcess -ProcessId 701   -ParentProcessId 700  -Created $now.AddSeconds(-890) -CommandLine $theirs)
    )

    $scan = Get-OrphanedChromium -NodePid $nodePid -SessionsRoot $sessions -ReapAfterSeconds 120 -Processes $set -Now $now

    $scan.Owned | Should Be 0
    $scan.Orphans.Count | Should Be 0
  }

  It 'ignores processes that are not Chromium' {
    # The scratch copy used for testing the kill path is named chrome.exe but a stray
    # edge.exe or a WebView host must never be touched.
    $now = $script:Base
    $set = @(
      (New-FakeProcess -ProcessId 800 -ParentProcessId 1   -Created $now.AddSeconds(-900) -Name 'msedge.exe' -CommandLine $ours)
    )

    $scan = Get-OrphanedChromium -NodePid $nodePid -SessionsRoot $sessions -ReapAfterSeconds 120 -Processes $set -Now $now

    $scan.Owned | Should Be 0
    $scan.Orphans.Count | Should Be 0
  }

  It 'reports the age that justified each reap' {
    $now = $script:Base
    $set = @(
      (New-FakeProcess -ProcessId 200 -ParentProcessId 1 -Created $now.AddSeconds(-500) -CommandLine $ours)
    )

    $scan = Get-OrphanedChromium -NodePid $nodePid -SessionsRoot $sessions -ReapAfterSeconds 120 -Processes $set -Now $now

    $scan.Orphans[0].AgeSeconds | Should Be 500
    $scan.Orphans[0].ProcessId | Should Be 200
  }

  It 'handles an empty process list' {
    $scan = Get-OrphanedChromium -NodePid $nodePid -SessionsRoot $sessions -ReapAfterSeconds 120 -Processes @()

    $scan.Owned | Should Be 0
    $scan.Orphans.Count | Should Be 0
  }
}
