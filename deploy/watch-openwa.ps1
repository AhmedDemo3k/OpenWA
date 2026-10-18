#requires -Version 5.1
<#
Supervises the long-running OpenWA instance.

Why this exists: the task scheduler alone only restarts a process that EXITS. It cannot
notice a process that is still alive but no longer serving (a wedged Chromium, a stuck
SQLite write, a leaked handle). Those are the failures that actually happened -- the
process stayed up and /api/health/ready stopped answering.

So: run node as a child, poll readiness, and restart on repeated failure. Backoff caps
the restart rate so a genuine config error cannot turn into a hot loop.

All state lives under the repository's data/ directory, which is gitignored. The previous
copy of this script ran out of %TEMP%\opencode\openwa-smoke, which meant the SQLite
databases, the media store, the logs, and this script itself could all be destroyed by a
disk cleanup or a reboot. Nothing here may point at %TEMP%.

Three things this watches, because each has taken the instance down without the process
exiting:

  * readiness      - the API stops answering while node is still alive
  * resource usage - Chromium leaks and node never gives the memory back
  * orphans        - Chromium outlives the node that launched it

The orphan and resource checks are both on by default and both self-disable through
parameters, because a supervisor that kills a healthy instance is worse than no
supervisor at all.
#>

[CmdletBinding()]
param(
  # Restart the API once node's working set stays above this for $ResourceStrikes ticks.
  # 3 GB is roughly three times a healthy idle figure for one WhatsApp session, so it is
  # high enough to leave headroom and low enough to catch a real leak.
  [int] $MaxNodeRamMB = 3072,

  # Same, for sustained CPU. Measured against all logical cores, so a fully pegged single
  # core reads as 100/n rather than 100.
  [double] $MaxNodeCpuPercent = 85,

  # Consecutive over-threshold ticks before acting. One spike is noise; this many in a row
  # is a process that is not coming back on its own.
  [int] $ResourceStrikes = 5,

  # An orphaned Chromium is left alone this long before it is reaped. On a restart the
  # previous browser is still tearing down, and killing it immediately would race the
  # profile directory it is closing.
  [int] $ReapAfterSeconds = 120,

  # How often to look for orphans. A full Win32_Process query per tick is more expensive
  # than the readiness probe it shares a loop with.
  [int] $ReapEveryTicks = 6,

  # How often to check that every session is actually up and restart the ones that are not.
  # Same cadence rationale as the orphan reaper: an HTTP call every few ticks is cheap, but a
  # session that has gone down stays down until an operator acts, so a periodic re-start is
  # what keeps the API useful overnight.
  [int] $SessionGuardEveryTicks = 6,

  # Base seconds before the guard retries the same session. Doubles on each consecutive
  # failure (capped at 30 min) so a session that cannot come back is retried slowly instead
  # of launching a fresh Chromium every tick.
  [int] $SessionGuardCooldownSeconds = 120,

  # A session that has sat in `initializing` this long is treated as wedged and restarted.
  # Generous on purpose: a cold Chromium plus a LocalAuth restore is around a minute and a
  # busy handshake can take longer, so the point is to catch one that will never advance,
  # not to race a slow one.
  [int] $SessionGuardStuckSeconds = 600,

  [switch] $DisableResourceGuard,
  [switch] $DisableOrphanReaper,
  [switch] $DisableSessionGuard
)

$ErrorActionPreference = 'Stop'

# The decisions live in a module so they can be tested: the supervisor below is an infinite
# loop that launches processes, so dot-sourcing it to reach a function would start an instance.
Import-Module (Join-Path $PSScriptRoot 'watchdog-lib.psm1') -Force -DisableNameChecking

$Root     = 'C:\Users\homek\Downloads\OpenWA'
$DataDir  = Join-Path $Root 'data'
$RunDir   = Join-Path $DataDir 'runtime'
$LogDir   = Join-Path $DataDir 'logs'
$Sessions = Join-Path $DataDir 'sessions'

$LogFile     = Join-Path $LogDir 'watchdog.log'
$NodeLog     = Join-Path $LogDir 'api.log'
$NodeErrLog  = Join-Path $LogDir 'api.err.log'
$Strikes   = 3      # consecutive failed probes before we call it dead
$ProbeWait = 10     # seconds between probes
$Backoff   = 10     # seconds before the first restart; doubles each failure up to 10 min
# A cold Chromium start on this machine takes roughly 45-60s: puppeteer launches the browser,
# LocalAuth restores the profile, and WhatsApp Web completes its handshake before Nest reports
# listening. With only $Strikes x $ProbeWait = 30s of tolerance the watchdog killed a perfectly
# healthy first boot and paid a full backoff cycle for it. So the first $GraceSeconds of a new
# process are treated as startup, not as failure.
$GraceSeconds = 150

function Write-WatchLog([string]$Message) {
  $line = '{0} [watchdog] {1}' -f (Get-Date -Format 'yyyy-MM-dd HH:mm:ss'), $Message
  Add-Content -LiteralPath $LogFile -Value $line -Encoding UTF8
  Write-Output $line
}

# The env the launcher sets, repeated here because we no longer go through the .cmd.
# Production: enables a random owa_k1_ API key (persisted to data/.api-key), HSTS, and hides
# error details. This instance is exposed through Tailscale Funnel, so the static
# dev-admin-key must not be used here.
$env:NODE_ENV                = 'production'
$env:PORT                    = '2785'
$env:LOG_LEVEL               = 'info'
# v0.24.0 names. MAIN_DATABASE_NAME was DATABASE_MAIN_NAME; synchronize stays off in
# production because the schema is owned by the migration CLI, not by boot-time sync.
$env:MAIN_DATABASE_NAME      = Join-Path $DataDir 'main.sqlite'
$env:MAIN_DATABASE_SYNCHRONIZE = 'false'
$env:DATABASE_NAME           = Join-Path $DataDir 'openwa.sqlite'
$env:DATABASE_SYNCHRONIZE    = 'false'
$env:STORAGE_LOCAL_PATH      = Join-Path $DataDir 'media'
# The profiles are the one piece of state that is large and genuinely worth keeping in the
# project, and they are already there. Pointing this at %TEMP% is what split the instance in
# half: the databases moved with the environment while the authenticated Chromium profiles
# stayed behind, so a restart logged a session in from scratch.
$env:SESSION_DATA_PATH       = $Sessions
# Where the first-boot admin key is written and read back from on later boots. The v0.1.6
# AUTH_KEY_FILE was renamed BOOTSTRAP_KEY_FILE in v0.24.0; an old name here is silently
# ignored. Keeps the key inside data/, beside the databases it authenticates against.
$env:BOOTSTRAP_KEY_FILE      = Join-Path $DataDir '.api-key'
$env:QUEUE_ENABLED           = 'false'
$env:CACHE_ENABLED           = 'false'
$env:PUPPETEER_HEADLESS      = 'true'
# Sessions reconnect on their own at boot (documented production behaviour); the watchdog's
# session guard stays as the fallback for one that later drops while node is still up.
$env:AUTO_START_SESSIONS     = 'true'
# Give an in-flight webhook POST time to finish at shutdown; must be >= WEBHOOK_TIMEOUT
# (10s here) or boot warns and the delivery is truncated. Moves the graceful-exit deadline.
$env:WEBHOOK_SHUTDOWN_DRAIN_MS = '15000'
# NODE_ENV is forced to production above, so silence the CSP upgrade that would render the
# dashboard blank on the plain-HTTP localhost path (the Funnel HTTPS path is unaffected).
$env:CSP_UPGRADE_INSECURE_REQUESTS = 'false'
# Rate limits are deliberately left at the application defaults (10/s, 100/min, 1000/hour).
# The raised limits this instance used to carry were only needed while polling the QR code by
# hand; leaving 60000/hour on a publicly reachable endpoint would be a DoS gift.

# Never let a cleanup step take out the user's own browser. The old version of this script
# did `Get-Process chrome | Stop-Process`, which killed every Chrome window on the machine
# on each restart -- including a personal browsing session, with no warning and no unsaved
# form data preserved. Chromium instances started by whatsapp-web.js always carry the
# session profile directory we control, so that is what we match on instead, via the same
# tested predicate the reaper uses. One matcher, so the two paths cannot drift apart.
function Stop-OpenWaChromium {
  $procs = Get-CimInstance Win32_Process -Filter "Name='chrome.exe'" -ErrorAction SilentlyContinue
  foreach ($p in $procs) {
    if (Test-IsOpenWaChromiumCommandLine -CommandLine $p.CommandLine -SessionsRoot $Sessions) {
      Write-WatchLog "stopping OpenWA chromium PID $($p.ProcessId)"
      Stop-Process -Id $p.ProcessId -Force -ErrorAction SilentlyContinue
    }
  }
}

function Stop-StrayServer {
  $listeners = Get-NetTCPConnection -LocalPort $env:PORT -State Listen -ErrorAction SilentlyContinue
  foreach ($l in $listeners) {
    Write-WatchLog "port $($env:PORT) held by PID $($l.OwningProcess); stopping it"
    Stop-Process -Id $l.OwningProcess -Force -ErrorAction SilentlyContinue
  }
  Stop-OpenWaChromium
}

# ── Orphan reaper ─────────────────────────────────────────────────────────────
#
# Chromium outlives node more often than it should. whatsapp-web.js launches the browser as
# a child, and the browser spawns renderers, zygotes and a GPU process beneath it. Kill node
# and those grandchildren are re-parented, not terminated: the API port frees up, the
# watchdog declares victory, and the leftover browser keeps its own profile lock and its own
# slice of RAM indefinitely. Nothing reports it, because from Windows' point of view nothing
# is wrong.
#
# So the reaper asks a narrower question than "is there a stale browser": is any Chromium
# that owns one of our profile directories *no longer* a descendant of the node we are
# currently supervising? That distinction is what keeps this from killing a healthy browser,
# and it is why this cannot be replaced by matching on age alone.
#
# PIDs are reused, so ancestry is only followed while each link's creation time is later than
# its child's. Without that check a recycled PID can make an orphan look like a descendant.

function Invoke-OrphanReaper([int] $NodePid) {
  if ($DisableOrphanReaper) { return }

  # Two passes. Killing a browser process re-parents its renderers a moment or two later, so
  # the first pass can complete before that settles and miss them; the second re-queries so
  # the parent links are fresh.
  #
  # Both passes are scoped to processes that are NOT descendants of the node being
  # supervised. An earlier draft called the blanket Stop-OpenWaChromium sweep here, which
  # would have killed the live session's own browser every time a stale one was collected --
  # precisely the outcome the ancestry check exists to prevent.
  $total = 0

  for ($pass = 1; $pass -le 2; $pass++) {
    # One unfiltered query, then every ancestry answer is an in-memory lookup. Following the
    # chain with a filtered query per hop cost ~4 WMI round trips per Chromium process, which
    # on this box is enough latency to show up in the watchdog's own timing.
    $procs = @(Get-CimInstance Win32_Process -ErrorAction SilentlyContinue)
    $scan = Get-OrphanedChromium -NodePid $NodePid -SessionsRoot $Sessions `
      -ReapAfterSeconds $ReapAfterSeconds -Processes $procs

    if ($scan.Owned -gt 0) {
      Write-WatchLog "reaper pass ${pass}: $($scan.Owned) OpenWA chromium process(es), $($scan.Orphans.Count) orphaned"
    }

    if ($scan.Orphans.Count -eq 0) { break }

    foreach ($o in $scan.Orphans) {
      Write-WatchLog "reaping orphaned chromium PID $($o.ProcessId) ($($o.AgeSeconds)s old, not under node PID $NodePid)"
      Stop-Process -Id $o.ProcessId -Force -ErrorAction SilentlyContinue
      $total++
    }

    if ($pass -lt 2) { Start-Sleep -Milliseconds 750 }
  }

  if ($total -gt 0) { Write-WatchLog "reaped $total orphaned chromium process(es)" }
}

# ── Session guard ─────────────────────────────────────────────────────────────
#
# Keeping node alive is not the same as keeping the API useful. whatsapp-web.js marks a
# session `failed` on auth_failure and, once it is terminal, the service will not bring it
# back on its own -- so node can answer /health/ready forever while both live sessions sit
# in `failed`/`disconnected`. That is the state this machine actually gets into overnight,
# and without a guard nothing short of a manual /start clears it.
#
# The guard lists sessions, and for any that are in a terminal state asks the API to start
# them again. Sessions that are genuinely making progress -- qr_ready, authenticating, or a
# recent initializing -- are left alone, because re-issuing /start on them only yields
# "already started" noise (and would discard a QR the operator is waiting to scan). The one
# exception is a session wedged in `initializing` well past any plausible startup time, which
# is restarted via stop+start.
#
# Retries back off per session: two minutes after the first failed attempt, four after the
# second, and so on up to 30 minutes. A session that genuinely cannot come back therefore
# costs one Chromium launch every half hour instead of one every tick, and a session that
# recovers has its state reset the moment it is seen `ready` again.

$script:sessionGuardState = @{}

function Get-ApiKey {
  $keyFile = Join-Path $DataDir '.api-key'
  if (-not (Test-Path -LiteralPath $keyFile)) { return $null }
  try { return (Get-Content -LiteralPath $keyFile -Raw).Trim() } catch { return $null }
}

function Invoke-SessionGuard($ApiKey) {
  if ($DisableSessionGuard) { return }
  if (-not $ApiKey) { return }

  $headers = @{ 'X-API-Key' = $ApiKey }
  $base    = "http://localhost:$($env:PORT)/api/sessions"

  try {
    $sessions = Invoke-RestMethod -Uri $base -Headers $headers -TimeoutSec 8
  } catch {
    Write-WatchLog "session guard: could not list sessions: $($_.Exception.Message)"
    return
  }

  $now = Get-Date

  foreach ($s in @($sessions)) {
    if ($s.status -eq 'ready') {
      # Recovered (or never fell over): drop the backoff so a later failure starts fresh.
      if ($script:sessionGuardState.ContainsKey($s.id)) { $script:sessionGuardState.Remove($s.id) }
      continue
    }

    $state = $script:sessionGuardState[$s.id]
    if (-not $state) {
      $state = @{ Last = [datetime]::MinValue; Attempts = 0; SinceProgress = $null }
      $script:sessionGuardState[$s.id] = $state
    }

    if ($s.status -eq 'initializing') {
      # A session that is coming up is normally left alone. But one that has not left
      # `initializing` for a long time is the fingerprint of a wedged Chromium: the status
      # never advances and no resource ceiling is crossed, so nothing else here would notice.
      # The age is tracked by observation rather than read from the row, which keeps it immune
      # to clock/timezone skew. First sighting records the moment; only a later tick can fire.
      if (-not $state.SinceProgress) { $state.SinceProgress = $now; continue }
      if (($now - $state.SinceProgress).TotalSeconds -lt $SessionGuardStuckSeconds) { continue }
      $restart = $true
    } elseif ($s.status -in @('created', 'disconnected', 'failed')) {
      $state.SinceProgress = $null
      $restart = $false
    } else {
      # qr_ready / authenticating / anything else: actively in progress or waiting on a scan.
      # Restarting a qr_ready session would throw away the code the operator is about to scan.
      $state.SinceProgress = $null
      continue
    }

    $cooldown = [Math]::Min($SessionGuardCooldownSeconds * [Math]::Pow(2, $state.Attempts), 1800)
    if (($now - $state.Last).TotalSeconds -lt $cooldown) { continue }

    $state.Last = $now
    $state.Attempts++

    if ($restart) {
      # A stuck session usually still has its engine registered, and start() on a registered
      # engine is rejected with "already started" -- so clear it first. stop() is best-effort:
      # a wedged engine may not answer, which is exactly why the start below is the real fix.
      Write-WatchLog "session guard: restarting stuck '$($s.name)' (in initializing for over ${SessionGuardStuckSeconds}s)"
      try {
        Invoke-RestMethod -Uri "$base/$($s.id)/stop" -Headers $headers -Method Post -TimeoutSec 20 | Out-Null
      } catch {
        Write-WatchLog "session guard: stop (pre-restart) for '$($s.name)' failed: $($_.Exception.Message)"
      }
      Start-Sleep -Seconds 2
      $state.SinceProgress = $null
    }

    Write-WatchLog "session guard: starting '$($s.name)' (status=$($s.status), attempt $($state.Attempts))"
    try {
      Invoke-RestMethod -Uri "$base/$($s.id)/start" -Headers $headers -Method Post -TimeoutSec 15 | Out-Null
      Write-WatchLog "session guard: start requested for '$($s.name)'"
    } catch {
      Write-WatchLog "session guard: start failed for '$($s.name)': $($_.Exception.Message)"
    }
  }
}

# ── Resource guard ───────────────────────────────────────────────────────────
#
# A wedged Chromium that never releases its profile leaves node holding memory it will not
# give back, and the readiness probe keeps answering 200 the whole time. The process looks
# healthy and is not. CPU is measured the same way for the same reason: a session that has
# wedged will often spin rather than leak, and still pass every readiness check.

function Read-NodeUsage($Proc) {
  try { $Proc.Refresh() } catch { return $null }
  if ($Proc.HasExited) { return $null }
  return [pscustomobject]@{
    RamMB     = [Math]::Round($Proc.WorkingSet64 / 1MB, 1)
    CpuTotal  = $Proc.TotalProcessorTime.TotalSeconds
    CpuSample = Get-Date
  }
}

function Get-CpuPercent([double] $CpuDeltaSeconds, [double] $WallSeconds) {
  return Get-NormalizedCpuPercent -CpuDeltaSeconds $CpuDeltaSeconds -WallSeconds $WallSeconds
}

foreach ($d in @($RunDir, $LogDir, $Sessions, $env:STORAGE_LOCAL_PATH)) {
  if (-not (Test-Path -LiteralPath $d)) {
    New-Item -ItemType Directory -Path $d -Force | Out-Null
    Write-WatchLog "created $d"
  }
}
$HealthUrl = "http://localhost:$($env:PORT)/api/health/ready"

# Single-instance guard. Two supervisors racing on the same port is how a session ends up
# wedged in `initializing`: the loser runs the startup reset/resume, then dies on EADDRINUSE
# before it can finish, and the survivor is left with no engine for the session the loser
# touched -- a status the session guard deliberately does not override. Task Scheduler's
# IgnoreNew only prevents two *task* instances, not a hand-started watchdog running alongside
# one, so the exclusion has to live here. An abandoned mutex (previous holder died) counts as
# acquired so a crash never locks the supervisor out permanently.
$instanceMutex = New-Object System.Threading.Mutex($false, 'Local\OpenWA-Watchdog')
$isOnlyInstance = $false
try { $isOnlyInstance = $instanceMutex.WaitOne(0) }
catch [System.Threading.AbandonedMutexException] { $isOnlyInstance = $true }
if (-not $isOnlyInstance) {
  Write-WatchLog 'another watchdog instance is already running; exiting'
  exit 0
}

$failures = 0
$attempt  = 0

while ($true) {
  $attempt++
  Write-WatchLog "starting node (attempt $attempt)"

  # Reclaim the port BEFORE launching. A previous instance that is still shutting down will
  # make this attempt die instantly on EADDRINUSE, which then costs a whole backoff cycle.
  # Observed when the task was restarted with /end followed quickly by /run.
  Stop-StrayServer
  Start-Sleep -Seconds 2

  # Two separate log files on purpose: Start-Process refuses to point stdout and stderr at
  # the same path. The env vars set above are inherited by the child automatically, so there
  # is no -Environment here -- that parameter only exists in PowerShell 7+, and this runs
  # under Windows PowerShell 5.1.
  $proc = Start-Process -FilePath 'node.exe' -ArgumentList 'dist\main.js' `
    -WorkingDirectory $Root -PassThru -WindowStyle Hidden `
    -RedirectStandardOutput $NodeLog -RedirectStandardError $NodeErrLog

  Write-WatchLog "node PID $($proc.Id)"
  $failures = 0
  $healthy  = $false
  $elapsed  = 0

  # Resource tracking state. Sampled from the *previous* tick rather than by sleeping here,
  # so the guard costs nothing when it is not firing.
  $strikeCount = 0
  $usage      = Read-NodeUsage $proc
  $tick       = 0

  # Supervise this child until it dies or stops answering.
  while ($true) {
    Start-Sleep -Seconds $ProbeWait
    $elapsed += $ProbeWait
    $tick++

    if ($proc.HasExited) {
      Write-WatchLog "node exited with code $($proc.ExitCode)"
      break
    }

    $unhealthyReason = $null

    try {
      $r = Invoke-WebRequest -Uri $HealthUrl -UseBasicParsing -TimeoutSec 8
      if ($r.StatusCode -eq 200) {
        $failures = 0
        if (-not $healthy) {
          $healthy = $true
          # Reset the backoff once the server has actually proven itself. Without this the
          # delay only ever ratchets upward, so a crash a week into a good week would wait
          # the full 10 minutes before restarting.
          $Backoff = 10
          Write-WatchLog "healthy; backoff reset to ${Backoff}s"
        }
      } else {
        $unhealthyReason = "probe returned HTTP $($r.StatusCode)"
      }
    } catch {
      $unhealthyReason = "probe failed: $($_.Exception.Message)"
    }

    # ── Orphan reaper ───────────────────────────────────────────────────────────
    # Runs even while healthy, which is the point: an orphaned browser is invisible to
    # every other check here.
    if (($tick % $ReapEveryTicks) -eq 0) {
      try {
        Invoke-OrphanReaper $proc.Id
      } catch {
        Write-WatchLog "orphan reaper error: $($_.Exception.Message)"
      }
    }

    # ── Session guard ───────────────────────────────────────────────────────────
    # Only while the server is answering: a start request against a half-dead node just
    # fails, and the fix for an unresponsive node is the restart path below, not this.
    if (-not $unhealthyReason -and -not $DisableSessionGuard -and (($tick % $SessionGuardEveryTicks) -eq 0)) {
      try {
        Invoke-SessionGuard (Get-ApiKey)
      } catch {
        Write-WatchLog "session guard error: $($_.Exception.Message)"
      }
    }

    # ── Resource guard ──────────────────────────────────────────────────────────
    if (-not $DisableResourceGuard) {
      $now = Read-NodeUsage $proc
      if ($now -and $usage) {
        $wall = ($now.CpuSample - $usage.CpuSample).TotalSeconds
        $cpu  = Get-CpuPercent ($now.CpuTotal - $usage.CpuTotal) $wall

        $previous = $strikeCount
        $strikeCount = Update-ResourceStrike -CurrentStrikes $strikeCount `
          -RamMB $now.RamMB -MaxRamMB $MaxNodeRamMB `
          -CpuPercent $cpu -MaxCpuPercent $MaxNodeCpuPercent

        if ($strikeCount -gt $previous) {
          Write-WatchLog "resource pressure ($strikeCount/$ResourceStrikes): ram=$($now.RamMB)MB (max ${MaxNodeRamMB}MB) cpu=$cpu% (max ${MaxNodeCpuPercent}%)"
        } elseif ($strikeCount -eq 0 -and $previous -gt 0) {
          Write-WatchLog "resource pressure cleared: ram=$($now.RamMB)MB cpu=$cpu%"
        }

        if ($strikeCount -ge $ResourceStrikes) {
          Write-WatchLog "resource guard tripped; restarting PID $($proc.Id)"
          Stop-Process -Id $proc.Id -Force -ErrorAction SilentlyContinue
          break
        }
      }
      $usage = $now
    }

    if (-not $unhealthyReason) { continue }

    Write-WatchLog $unhealthyReason

    if ($elapsed -lt $GraceSeconds) {
      # Still inside the startup window. Log it so a slow boot is visible rather than silent,
      # but do not count it as a strike.
      Write-WatchLog "still starting (${elapsed}s/${GraceSeconds}s) -- PID $($proc.Id)"
      continue
    }

    $failures++
    Write-WatchLog "unhealthy ($failures/$Strikes) -- PID $($proc.Id)"
    if ($failures -ge $Strikes) {
      Write-WatchLog "giving up on PID $($proc.Id); killing and restarting"
      Stop-Process -Id $proc.Id -Force -ErrorAction SilentlyContinue
      break
    }
  }

  # If we got here because the child was unhealthy or exited, make sure nothing is still
  # holding the port so the next attempt can bind.
  Stop-StrayServer
  Start-Sleep -Seconds $Backoff
  $Backoff = [Math]::Min($Backoff * 2, 600)
}
