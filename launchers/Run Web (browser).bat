@echo off
:: ===========================================================================
:: Cherry-Pick Studio - Web (browser)
:: Starts the local server on a free port and opens your default browser.
:: A small status window appears - CLOSE IT to stop the server.
:: Nothing to install; Node.js is NOT needed.
::
:: Keep this file in the same folder as "Cherry-Pick Studio.exe" - it uses
:: %~dp0 (the folder this .bat lives in) to find it.
:: ===========================================================================

if not exist "%~dp0Cherry-Pick Studio.exe" goto :missing
start "" "%~dp0Cherry-Pick Studio.exe" --web
exit /b 0

:missing
echo.
echo  Could not find "Cherry-Pick Studio.exe" next to this file.
echo  Keep this .bat in the same folder as the .exe.
echo.
pause
exit /b 1
