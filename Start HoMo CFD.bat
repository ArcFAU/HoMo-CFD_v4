@echo off
rem Double-click to start HoMo CFD and open it in the browser.
rem Works offline. Requires Python 3 (python.org); nothing else to install.
title HoMo CFD
cd /d "%~dp0"
echo Starting HoMo CFD...
echo Keep this window open while you use HoMo CFD. Close it to stop HoMo CFD.
echo.
where py >nul 2>nul
if %errorlevel%==0 (
  py -3 serve.py --open
) else (
  python serve.py --open
)
if errorlevel 1 (
  echo.
  echo HoMo CFD could not start. Is Python 3 installed? Get it from https://www.python.org/downloads/
  pause
)
