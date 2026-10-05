@echo off
title Auto-Reply Bot
cd /d "%~dp0auto-reply-bot"
setlocal
where node >nul 2>&1
if errorlevel 1 (
    if exist "%ProgramFiles%\nodejs\node.exe" set "PATH=%ProgramFiles%\nodejs;%PATH%"
    if exist "%LocalAppData%\Programs\nodejs\node.exe" set "PATH=%LocalAppData%\Programs\nodejs;%PATH%"
)
echo [Auto-Reply Bot] Starting on http://localhost:3001
node index.js
pause