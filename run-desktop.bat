@echo off
title Cherry-Pick Studio - Desktop Launcher
color 0B

:: =============================================================================
:: Cherry-Pick Studio - Desktop (Electron) Launcher
:: Double-click this file to start the desktop app.
:: =============================================================================

powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0studio.ps1" -Mode desktop

echo.
pause
exit /b 0
