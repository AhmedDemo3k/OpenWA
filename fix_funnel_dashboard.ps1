# =============================================================
#  OpenWA - Rebuild Tailscale Funnel rules (API + Dashboard)
#   - API:       https://home.tailcb9811.ts.net          (443 -> 2785)
#   - Dashboard: https://home.tailcb9811.ts.net:8443     (8443 -> 2886)
#
#  IMPORTANT:
#   * Run this on the SERVER (machine 101) itself.
#   * Run it as the SAME logged-in user as the Tailscale tray
#     (Home\homek) WITHOUT UAC elevation. Running as admin
#     causes: "401 Unauthorized: Tailscale already in use".
#   * ASCII-only so Windows PowerShell 5.1 can parse it.
# =============================================================
$ErrorActionPreference = 'Continue'
$global:FAIL = $false

function Step ($t) { Write-Host "`n>>> $t" -ForegroundColor Cyan }
function OK  ($t)  { Write-Host "[OK]   $t" -ForegroundColor Green }
function WARN($t)  { Write-Host "[WARN] $t" -ForegroundColor Yellow }
function FAIL($t)  { Write-Host "[FAIL] $t" -ForegroundColor Red; $script:FAIL = $true }

# ---- Context diagnostics -------------------------------------
$currentUser = [Security.Principal.WindowsIdentity]::GetCurrent()
$principal = New-Object Security.Principal.WindowsPrincipal($currentUser)
$elevated = $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)

Write-Host "Computer : $env:COMPUTERNAME"
Write-Host "Logged on: $env:USERDOMAIN\$env:USERNAME"
Write-Host "User SID : $($currentUser.User)"
Write-Host "Elevated : $elevated"
Write-Host "PS ver   : $($PSVersionTable.PSVersion.ToString())"

if ($elevated) {
    FAIL "This script is running ELEVATED (as Administrator)."
    FAIL "Tailscale will answer 401 in this context."
    FAIL "Close this window and run it WITHOUT 'Run as administrator',"
    FAIL "i.e. double-click run_fix_funnel.bat normally as user homek."
    exit 1
}

# ---- Locate tailscale CLI ------------------------------------
$ts = Get-Command tailscale -ErrorAction SilentlyContinue
if (-not $ts) {
    $cands = @(
        "$env:ProgramFiles\Tailscale\tailscale.exe",
        "${env:ProgramFiles(x86)}\Tailscale\tailscale.exe",
        "$env:LOCALAPPDATA\Programs\Tailscale\tailscale.exe"
    )
    foreach ($c in $cands) {
        if (Test-Path $c) { $ts = $c; break }
    }
    if (-not $ts) { FAIL "tailscale.exe not found."; exit 1 }
    $ts = (Get-Item $ts).FullName
} else {
    $ts = $ts.Source
}
OK "Using tailscale: $ts"

# ---- Verify CLI <-> tailscaled connection --------------------
Step "Tailscale status"
& $ts status

Step "Existing serve config"
& $ts serve status

# ---- Rule 1: API ---------------------------------------------
Step "Rule 1: API on https 443 -> 127.0.0.1:2785"
& $ts serve --bg --https=443 http://127.0.0.1:2785
Start-Sleep -Milliseconds 800
& $ts funnel --bg --https=443 2785
Start-Sleep -Milliseconds 800

# ---- Rule 2: Dashboard ---------------------------------------
Step "Rule 2: Dashboard on https 8443 -> 127.0.0.1:2886"
& $ts serve --bg --https=8443 http://127.0.0.1:2886
Start-Sleep -Milliseconds 800
& $ts funnel --bg --https=8443 2886

# ---- Show final state ----------------------------------------
Step "Current funnel status"
& $ts funnel status

# ---- Health check --------------------------------------------
Step "Brief health check (wait for startup if needed)"
Start-Sleep -Seconds 3
foreach ($p in 2785, 2886) {
    try {
        $r = Invoke-WebRequest -Uri "http://127.0.0.1:$p/" -TimeoutSec 6 -UseBasicParsing
        OK "127.0.0.1:$p -> HTTP $($r.StatusCode)"
    } catch {
        WARN "127.0.0.1:$p not responding now. If OpenWA is running (npm run dev), this may be transient."
    }
}

Write-Host "`n======================================================="
if ($script:FAIL) {
    Write-Host " There were failures above - see the red [FAIL] lines."
} else {
    Write-Host " Done. Test from outside:"
    Write-Host "   API:       https://home.tailcb9811.ts.net"
    Write-Host "   Dashboard: https://home.tailcb9811.ts.net:8443"
}
Write-Host "======================================================="