@echo off
title Cherry-Pick Studio - Web Launcher
color 0A

:: =============================================================================
:: Cherry-Pick Studio - Web (browser) Launcher
:: Double-click this file to start the browser UI on an automatically chosen
:: free port (so a busy fixed port never blocks the tool).
:: =============================================================================

powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0studio.ps1" -Mode web

echo.
pause
exit /b 0
