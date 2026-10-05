@echo off
title OpenWA Fix Funnel
cd /d "%~dp0"
echo.
echo Running fix_funnel_dashboard.ps1 ...
echo Output will be saved to fix_funnel_log.txt
echo.
powershell -ExecutionPolicy Bypass -File "%~dp0fix_funnel_dashboard.ps1" > fix_funnel_log.txt 2>&1
echo.
echo ================================================================
echo  Done. Log saved to fix_funnel_log.txt
echo  Press any key to close this window.
echo ================================================================
pause >nul