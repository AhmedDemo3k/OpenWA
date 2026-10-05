@echo off
title OpenWA + Auto-Reply Bot
cd /d "%~dp0"

echo ============================================
echo   OpenWA + Auto-Reply Bot
echo   اضغط Ctrl+C للإيقاف
echo ============================================
echo.

:: Start OpenWA
echo [1/2] Starting OpenWA API + Dashboard...
start "OpenWA-API" cmd /c "npm run dev 2>&1"

:: Wait for API to be ready
echo Waiting for API...
:wait
timeout /t 3 /nobreak >nul
curl -s http://localhost:2785/api/health >nul 2>&1
if errorlevel 1 goto wait

echo [2/2] Starting Auto-Reply Bot...
start "OpenWA-Bot" cmd /c "cd auto-reply-bot && node index.js 2>&1"

echo.
echo ============================================
echo   All services are running!
echo   Dashboard: http://localhost:2886
echo   API:       http://localhost:2785
echo   Bot Stats: http://localhost:3001/api/stats
echo ============================================
echo.
pause
