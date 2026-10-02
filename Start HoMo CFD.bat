@echo off
rem Double-click to start HoMo CFD and open it in the browser. Works offline.
rem HoMo CFD runs in the background without a window: stop it with the Quit
rem button (bottom of the sidebar); it also stops by itself 30 minutes after its
rem last window was closed. Its output goes to %APPDATA%\HoMo-CFD\homo-cfd.log.
rem Uses the bundled Python of the portable version (python\ folder) if present,
rem otherwise an installed Python 3 (python.org).
title HoMo CFD
cd /d "%~dp0"
if exist "python\pythonw.exe" (
  start "" "python\pythonw.exe" serve.py --open --background
  exit /b 0
)
where pyw >nul 2>nul
if not errorlevel 1 (
  start "" pyw -3 serve.py --open --background
  exit /b 0
)
where pythonw >nul 2>nul
if not errorlevel 1 (
  start "" pythonw serve.py --open --background
  exit /b 0
)
echo HoMo CFD could not start: no Python found.
echo Use the portable version, or install Python 3 from https://www.python.org/downloads/
pause
