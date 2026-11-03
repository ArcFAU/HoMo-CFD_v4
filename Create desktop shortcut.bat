@echo off
rem Puts a "HoMo CFD" shortcut with the HoMo CFD icon on your desktop and in the Start
rem menu (right-click it there > Pin to taskbar). It opens HoMo CFD in its own window.
rem Run it again if you move this folder.
title HoMo CFD
set "HOMO_DIR=%~dp0"
powershell -NoProfile -ExecutionPolicy Bypass -Command "$dir = $env:HOMO_DIR; $bundled = Join-Path $dir 'python\pythonw.exe'; $pyw = Get-Command pyw.exe -ErrorAction SilentlyContinue; $pythonw = Get-Command pythonw.exe -ErrorAction SilentlyContinue; if (Test-Path -LiteralPath $bundled) { $target = $bundled; $arguments = 'serve.py --app --background' } elseif ($pyw) { $target = $pyw.Source; $arguments = '-3 serve.py --app --background' } elseif ($pythonw) { $target = $pythonw.Source; $arguments = 'serve.py --app --background' } else { $target = Join-Path $dir 'Start HoMo CFD.bat'; $arguments = '' }; foreach ($place in 'Desktop', 'Programs') { $link = (New-Object -ComObject WScript.Shell).CreateShortcut((Join-Path ([Environment]::GetFolderPath($place)) 'HoMo CFD.lnk')); $link.TargetPath = $target; $link.Arguments = $arguments; $link.WorkingDirectory = $dir; $link.IconLocation = (Join-Path $dir 'web\homo-cfd.ico') + ',0'; $link.Description = 'Start HoMo CFD'; $link.Save() }"
if errorlevel 1 (
  echo Could not create the shortcut.
) else (
  echo A "HoMo CFD" shortcut is now on your desktop and in the Start menu.
  echo To pin it to the taskbar: Start menu, right-click HoMo CFD, Pin to taskbar.
)
rem Keep the message readable for a few seconds (works without a keyboard, unlike timeout).
ping -n 6 127.0.0.1 >nul
