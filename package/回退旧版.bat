@echo off
setlocal
echo Restore the previous AIGC plugin version. Please CLOSE Photoshop first.
pause
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0install.ps1" -Mode Restore
if errorlevel 1 (
  echo [FAILED] Please send a screenshot of this window.
  pause
  exit /b 1
)
echo [OK] Restored. Reopen Photoshop.
pause
