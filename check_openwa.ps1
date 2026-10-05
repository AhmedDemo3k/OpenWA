# =============================================================
#  OpenWA Pre-flight Check  |  يعمل على Windows PowerShell 5.1+
#  يشغّل من الجهاز نفسه:  powershell -ExecutionPolicy Bypass -File .\check_openwa.ps1
# =============================================================
$ErrorActionPreference = 'SilentlyContinue'
$out = @()

function Line($t) { $out += $t; Write-Host $t }
function Sep()  { Line "------------------------------------------------------------" }
function OK($t) { Line "[ OK  ] $t" }
function WARN($t){ Line "[WARN ] $t" }
function FAIL($t){ Line "[FAIL ] $t" }

$stamp = Get-Date -Format 'yyyy-MM-dd HH:mm:ss'
Line "OpenWA Pre-flight Check  |  $stamp"
Line "Machine: $env:COMPUTERNAME  |  User: $env:USERNAME"
Line "OS: $((Get-CimInstance Win32_OperatingSystem).Caption)  $((Get-CimInstance Win32_OperatingSystem).Version)"
Sep

# ------------------------------------------------------------- RAM / Disk
$cs = Get-CimInstance Win32_ComputerSystem
$os = Get-CimInstance Win32_OperatingSystem
$ramGB = [math]::Round($cs.TotalPhysicalMemory/1GB,1)
$freeGB = [math]::Round($os.FreePhysicalMemory/1MB,1)
Line "RAM: $ramGB GB total / $freeGB GB free"
Get-CimInstance Win32_LogicalDisk -Filter "DriveType=3" | ForEach-Object {
    Line "Disk $($_.DeviceID): $([math]::Round($_.FreeSpace/1GB,1)) GB free of $([math]::Round($_.Size/1GB,1)) GB"
}
Sep

# ------------------------------------------------------------- Node.js
Line "--- [1] Node.js / npm ---"
$node = Get-Command node -ErrorAction SilentlyContinue
if ($node) { Line ("node: " + (& node -v) + "  @" + $node.Source) } else { FAIL "node NOT found in PATH" }
$npm = Get-Command npm -ErrorAction SilentlyContinue
if ($npm) { Line ("npm : " + (& npm -v) + "  @" + $npm.Source) } else { FAIL "npm NOT found in PATH" }
# Common install locations
foreach ($p in @("$env:ProgramFiles\nodejs\node.exe", "${env:ProgramFiles(x86)}\nodejs\node.exe", "$env:LOCALAPPDATA\Programs\nodejs\node.exe", "$env:APPDATA\npm\node.exe")) {
    if (Test-Path $p) { Line "found node: $p" }
}
Sep

# ------------------------------------------------------------- Chrome
Line "--- [2] Chrome / Browser ---"
$chromePaths = @(
    "C:\Program Files\Google\Chrome\Application\chrome.exe",
    "${env:ProgramFiles(x86)}\Google\Chrome\Application\chrome.exe",
    "$env:LOCALAPPDATA\Google\Chrome\Application\chrome.exe"
)
$foundChrome = $false
foreach ($p in $chromePaths) {
    if (Test-Path $p) { OK "Chrome exists: $p"; $foundChrome = $true }
}
if (-not $foundChrome) { FAIL "Chrome NOT found at any common path" }
if (Test-Path "C:\Program Files\Google\Chrome\Application\chrome.exe") {
    $v = (Get-Item "C:\Program Files\Google\Chrome\Application\chrome.exe").VersionInfo.FileVersion
    Line "Chrome version (that path): $v"
}
Sep

# ------------------------------------------------------------- OpenWA folder
Line "--- [3] OpenWA folder ---"
$openwaRoot = "C:\Users\homek\Downloads\OpenWA"
if (-not (Test-Path $openwaRoot)) { $openwaRoot = "D:\WAP\OpenWA" }
if (Test-Path $openwaRoot) {
    Line "OpenWA root: $openwaRoot"
    foreach ($c in @("dist\main.js","node_modules","package.json","data`,sessions`,`session-edu-system","start.bat","data\openwa.sqlite","data\main.sqlite","data\.env.generated",".env")) {
        if (Test-Path (Join-Path $openwaRoot $c)) { OK "exists: $c" } else { WARN "missing: $c" }
    }
} else {
    FAIL "OpenWA root NOT found"
    $openwaRoot = $null
}
Sep

# ------------------------------------------------------------- running processes / ports
Line "--- [4] Services & Ports (listen) ---"
$listening = Get-NetTCPConnection -State Listen -ErrorAction SilentlyContinue | Select-Object -ExpandProperty LocalPort -Unique
foreach ($port in @(2785,2886,3001,80,443,3389)) {
    if ($listening -contains $port) { OK "port $port is LISTENING" } else { Line "(info) port $port is CLOSED" }
}
$nodeProcs = Get-Process node -ErrorAction SilentlyContinue
if ($nodeProcs) {
    Line "node processes running: $($nodeProcs.Count)"
    $nodeProcs | ForEach-Object { Line ("  PID $($_.Id)  CPU-base " + ([math]::Round($_.CPU,0)) + "s  RAM " + ([math]::Round($_.WorkingSet64/1MB,0)) + "MB") }
} else {
    Line "No node process running (OpenWA is OFF)"
}
if (Test-Path (Join-Path $openwaRoot "server.pid")) {
    $oldPid = (Get-Content (Join-Path $openwaRoot "server.pid") -ErrorAction SilentlyContinue | Select-Object -First 1).Trim()
    Line "server.pid says: $oldPid  (still alive: $([bool](Get-Process -Id $oldPid -ErrorAction SilentlyContinue)))"
}
Sep

# ------------------------------------------------------------- .env effective settings
Line "--- [5] .env effective settings ---"
$envPath = Join-Path $openwaRoot ".env"
if (Test-Path $envPath) {
    Get-Content $envPath | Where-Object { $_ -match '^\s*[A-Za-z_]+\s*=' -and $_ -notmatch 'KEY|SECRET|TOKEN|PASSWORD' } | ForEach-Object { Line "  $_" }
} else { FAIL ".env not found" }
Sep

# ------------------------------------------------------------- session age
Line "--- [6] WhatsApp session ---"
$sess = Join-Path $openwaRoot "data\sessions\session-edu-system"
if (Test-Path $sess) {
    $last = (Get-ChildItem $sess -Recurse -File -ErrorAction SilentlyContinue | Sort-Object LastWriteTime -Descending | Select-Object -First 1)
    Line "session folder last activity: $($last.LastWriteTime)"
    Line "days since last session use: $([math]::Round(((Get-Date) - $last.LastWriteTime).TotalDays,1))"
} else { WARN "session-edu-system not found (will need QR re-login)" }
Sep

# ------------------------------------------------------------- aux runners
Line "--- [7] Optional runners (Docker / WSL) ---"
$docker = Get-Command docker -ErrorAction SilentlyContinue
if ($docker) { Line ("docker: " + (& docker --version)) } else { Line "(info) docker NOT found (optional; can run via npm)" }
$wsl = Get-Command wsl -ErrorAction SilentlyContinue
if ($wsl) { Line "wsl present" } else { Line "(info) wsl NOT found" }
Sep

# ------------------------------------------------------------- XAMPP / port 80
Line "--- [8] Web on port 80 ---"
try {
    $r = Invoke-WebRequest -Uri "http://127.0.0.1/" -UseBasicParsing -TimeoutSec 5 -ErrorAction Stop
    Line ("port 80 responds: HTTP " + $r.StatusCode + "  (title: " + ([regex]::Match($r.Content, '<title>(.*?)</title>').Groups[1].Value) + ")")
} catch {
    Line "port 80 did not respond to a request: $($_.Exception.Message)"
}
Sep

$logFile = Join-Path $PSScriptRoot ("openwa_check_" + (Get-Date -Format 'yyyyMMdd_HHmmss') + ".txt")
$out | Out-File -FilePath $logFile -Encoding UTF8
Line "Log saved: $logFile"
Line "DONE."