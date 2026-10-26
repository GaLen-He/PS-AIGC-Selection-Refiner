@echo off
setlocal
title AIGC Plugin Installer 0.5.30
echo AIGC Plugin 0.5.30 installer
echo Please save your work and CLOSE Photoshop first.
echo.
pause
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0install.ps1" -Mode Install
if errorlevel 1 (
  echo.
  echo [FAILED] Install did not complete. Please send a screenshot of this window.
  pause
  exit /b 1
)
echo.
echo [OK] Installed. Open Photoshop: Window ^> Extensions (Legacy) ^> AIGC
pause
