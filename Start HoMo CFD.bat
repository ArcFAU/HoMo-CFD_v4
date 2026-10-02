@echo off
rem Double-click to start HoMo CFD and open it in the browser.
rem Works offline. Uses the bundled Python of the portable version (python\ folder)
rem if present, otherwise an installed Python 3 (python.org).
title HoMo CFD
cd /d "%~dp0"
echo Starting HoMo CFD...
echo Keep this window open while you use HoMo CFD. Close it to stop HoMo CFD.
echo.
if exist "python\python.exe" (
  "python\python.exe" serve.py --open
) else (
  where py >nul 2>nul
  if not errorlevel 1 (
    py -3 serve.py --open
  ) else (
    python serve.py --open
  )
)
if errorlevel 1 (
  echo.
  echo HoMo CFD could not start. Use the portable version, or install Python 3 from https://www.python.org/downloads/
  pause
)
