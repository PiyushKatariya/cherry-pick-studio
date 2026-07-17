@echo off
title Cherry-Pick Studio - Combined Launcher
color 0E

:: =============================================================================
:: Cherry-Pick Studio - Combined Launcher (Web + Desktop)
::
:: Smart launcher: checks each project independently and starts ONLY what is
:: not already running.
::   - Web running  + Desktop running  -> starts nothing (reopens browser).
::   - Web running  + Desktop killed   -> starts ONLY the desktop.
::   - Web killed   + Desktop running  -> starts ONLY the web.
::   - Both killed                     -> starts BOTH.
:: The web UI always uses an automatically chosen FREE port.
:: =============================================================================

powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0studio.ps1" -Mode all

echo.
pause
exit /b 0
