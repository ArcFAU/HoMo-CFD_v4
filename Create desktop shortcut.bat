@echo off
rem Puts a "HoMo CFD" shortcut with the HoMo CFD icon on your desktop.
rem Run it again if you move this folder.
title HoMo CFD
set "HOMO_DIR=%~dp0"
powershell -NoProfile -ExecutionPolicy Bypass -Command "$dir = $env:HOMO_DIR; $desktop = [Environment]::GetFolderPath('Desktop'); $link = (New-Object -ComObject WScript.Shell).CreateShortcut((Join-Path $desktop 'HoMo CFD.lnk')); $link.TargetPath = (Join-Path $dir 'Start HoMo CFD.bat'); $link.WorkingDirectory = $dir; $link.IconLocation = (Join-Path $dir 'web\homo-cfd.ico') + ',0'; $link.Description = 'Start HoMo CFD'; $link.Save()"
if errorlevel 1 (
  echo Could not create the shortcut.
) else (
  echo A "HoMo CFD" shortcut is now on your desktop.
)
rem Keep the message readable for a few seconds (works without a keyboard, unlike timeout).
ping -n 6 127.0.0.1 >nul
