@echo off
setlocal
title OpenWA API (Logged)
cd /d "%~dp0"
set "PATH=%ProgramFiles%\nodejs;%LocalAppData%\Programs\nodejs;%PATH%"
echo ============================================ > server_live.log
echo OpenWA API live log - %date% %time% >> server_live.log
echo ============================================ >> server_live.log
npm run dev >> server_live.log 2>&1