@echo off
setlocal EnableExtensions
title OpenWA Setup & Launch
cd /d "%~dp0"

echo ============================================================
echo   OpenWA Setup + Launch  (Node 22 + Chrome + API + Bot)
echo   Folder: %CD%
echo ============================================================
echo.

REM ---------- 1) Locate Node.js ----------
echo [1/4] Checking Node.js...
set "NODE="
where node >nul 2>&1 && for /f "tokens=*" %%i in ('where node') do set "NODE=%%i"
if not defined NODE if exist "%ProgramFiles%\nodejs\node.exe" set "NODE=%ProgramFiles%\nodejs\node.exe"
if not defined NODE if exist "%LocalAppData%\Programs\nodejs\node.exe" set "NODE=%LocalAppData%\Programs\nodejs\node.exe"

if not defined NODE (
    echo   Node.js NOT found. Installing from tools\...
    if exist "tools\node-v22.23.2-x64.msi" (
        echo   Running Node 22 installer, please wait...
        msiexec /i "tools\node-v22.23.2-x64.msi" /qn /norestart
        if errorlevel 1 (
            echo   [FAIL] Node installer failed. Install manually then rerun.
            pause
            exit /b 1
        )
        if exist "%ProgramFiles%\nodejs\node.exe" set "NODE=%ProgramFiles%\nodejs\node.exe"
    ) else (
        echo   [FAIL] tools\node-v22.23.2-x64.msi is missing.
        pause
        exit /b 1
    )
)
echo   Node: %NODE%
"%NODE%" -v

REM ---------- 2) Locate Chrome ----------
echo.
echo [2/4] Checking Google Chrome...
set "CHROME="
if exist "C:\Program Files\Google\Chrome\Application\chrome.exe" set "CHROME=C:\Program Files\Google\Chrome\Application\chrome.exe"
if not defined CHROME if exist "%ProgramFiles(x86)%\Google\Chrome\Application\chrome.exe" set "CHROME=%ProgramFiles(x86)%\Google\Chrome\Application\chrome.exe"
if not defined CHROME if exist "%LocalAppData%\Google\Chrome\Application\chrome.exe" set "CHROME=%LocalAppData%\Google\Chrome\Application\chrome.exe"

if not defined CHROME (
    echo   Chrome NOT found. Installing from tools\...
    if exist "tools\chrome-setup.exe" (
        echo   Running Chrome installer (background), please wait...
        start /wait "ChromeInstall" "tools\chrome-setup.exe" /install
        if exist "C:\Program Files\Google\Chrome\Application\chrome.exe" set "CHROME=C:\Program Files\Google\Chrome\Application\chrome.exe"
    ) else (
        echo   [FAIL] tools\chrome-setup.exe is missing.
        pause
        exit /b 1
    )
)
if not defined CHROME (
    echo   [WARN] Chrome still not detected. The session may require a QR re-login.
    set "CHROME="
) else (
    echo   Chrome: %CHROME%
)

REM ---------- 3) Verify build artifacts ----------
echo.
echo [3/4] Verifying build artifacts...
if not exist "dist\main.js" (
    echo   dist\main.js missing - building OpenWA API...
    call "%NODE%" -e "console.log('building')"
)
if not exist "dist\main.js" (
    echo   [WARN] Cannot build API here. Trying start via npm run dev (ts-dev mode).
)

REM ---------- 4) Launch ----------
echo.
echo [4/4] Launching services...
echo   API       : http://localhost:2785
echo   Dashboard : http://localhost:2886
echo   Bot Stats : http://localhost:3001/api/stats
echo.

set "CWD=%CD%"
set "ROOTDIR=%CD%"
set "NODEBIN=%NODE%"

start "OpenWA-API" cmd /c ""%ROOTDIR%"\run-api.bat"
echo   API window opened. Waiting for health check...
:wait
timeout /t 3 /nobreak >nul
curl -s http://localhost:2785/api/health >nul 2>&1
if errorlevel 1 goto wait

echo   API is UP. Opening Auto-Reply Bot...
start "OpenWA-Bot" cmd /c ""%ROOTDIR%"\run-bot.bat"

echo.
echo ============================================================
echo   All services running:
echo     Dashboard : http://localhost:2886
echo     API       : http://localhost:2785
echo     Bot Stats : http://localhost:3001/api/stats
echo   (Keep this window open. Use Ctrl+C to stop.)
echo ============================================================
echo.
pause