@echo off
:: ===========================================================================
:: Cherry-Pick Studio - Desktop
:: Opens the app in its own window. Nothing to install; Node.js is NOT needed.
::
:: Keep this file in the same folder as "Cherry-Pick Studio.exe" - it uses
:: %~dp0 (the folder this .bat lives in) to find it.
:: ===========================================================================

if not exist "%~dp0Cherry-Pick Studio.exe" goto :missing
start "" "%~dp0Cherry-Pick Studio.exe"
exit /b 0

:missing
echo.
echo  Could not find "Cherry-Pick Studio.exe" next to this file.
echo  Keep this .bat in the same folder as the .exe.
echo.
pause
exit /b 1
