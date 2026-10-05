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
#>

$ErrorActionPreference = 'Stop'

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
$env:DATABASE_MAIN_NAME      = Join-Path $RunDir 'main.sqlite'
$env:DATABASE_NAME           = Join-Path $RunDir 'data.sqlite'
$env:STORAGE_LOCAL_PATH      = Join-Path $RunDir 'media'
# The profiles are the one piece of state that is large and genuinely worth keeping in the
# project, and they are already there. Pointing this at %TEMP% is what split the instance in
# half: the databases moved with the environment while the authenticated Chromium profiles
# stayed behind, so a restart logged a session in from scratch.
$env:SESSION_DATA_PATH       = $Sessions
# Without this the auth service cannot rotate a leaked development key out of a production
# database, because it has no way to prove the replacement is observable. Pointing it at the
# real key file opts in to that safety check.
$env:AUTH_KEY_FILE           = Join-Path $DataDir '.api-key'
$env:QUEUE_ENABLED           = 'false'
$env:CACHE_ENABLED           = 'false'
$env:PUPPETEER_HEADLESS      = 'true'
# Rate limits are deliberately left at the application defaults (10/s, 100/min, 1000/hour).
# The raised limits this instance used to carry were only needed while polling the QR code by
# hand; leaving 60000/hour on a publicly reachable endpoint would be a DoS gift.

# Never let a cleanup step take out the user's own browser. The old version of this script
# did `Get-Process chrome | Stop-Process`, which killed every Chrome window on the machine
# on each restart -- including a personal browsing session, with no warning and no unsaved
# form data preserved. Chromium instances started by whatsapp-web.js always carry the
# session profile directory we control, so that is what we match on instead.
function Stop-OpenWaChromium {
  $procs = Get-CimInstance Win32_Process -Filter "Name='chrome.exe'" -ErrorAction SilentlyContinue
  foreach ($p in $procs) {
    $cmd = $p.CommandLine
    if (-not $cmd) { continue }
    if ($cmd -match [regex]::Escape('user-data-dir') -and
        $cmd.IndexOf($Sessions, [StringComparison]::OrdinalIgnoreCase) -ge 0) {
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

foreach ($d in @($RunDir, $LogDir, $Sessions, $env:STORAGE_LOCAL_PATH)) {
  if (-not (Test-Path -LiteralPath $d)) {
    New-Item -ItemType Directory -Path $d -Force | Out-Null
    Write-WatchLog "created $d"
  }
}
$HealthUrl = "http://localhost:$($env:PORT)/api/health/ready"

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

  # Supervise this child until it dies or stops answering.
  while ($true) {
    Start-Sleep -Seconds $ProbeWait
    $elapsed += $ProbeWait

    if ($proc.HasExited) {
      Write-WatchLog "node exited with code $($proc.ExitCode)"
      break
    }

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
        continue
      }
      Write-WatchLog "probe returned HTTP $($r.StatusCode)"
    } catch {
      Write-WatchLog "probe failed: $($_.Exception.Message)"
    }

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