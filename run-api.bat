@echo off
title OpenWA API
cd /d "%~dp0"
setlocal
where node >nul 2>&1
if errorlevel 1 (
    if exist "%ProgramFiles%\nodejs\node.exe" set "PATH=%ProgramFiles%\nodejs;%PATH%"
    if exist "%LocalAppData%\Programs\nodejs\node.exe" set "PATH=%LocalAppData%\Programs\nodejs;%PATH%"
)
echo [OpenWA API] Starting on http://localhost:2785
node -v
call npm run dev
pause