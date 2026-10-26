@echo off
setlocal
echo Uninstall AIGC plugin. Please CLOSE Photoshop first.
pause
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0install.ps1" -Mode Disable
if errorlevel 1 (
  echo [FAILED] Please send a screenshot of this window.
  pause
  exit /b 1
)
echo [OK] Uninstalled.
pause
