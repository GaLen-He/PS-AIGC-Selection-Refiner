@echo off
setlocal
set "EXTENSION_NAME=AIGCSelectionRefiner"
set "SOURCE_DIR=%~dp0cep\%EXTENSION_NAME%"
set "TARGET_ROOT=%APPDATA%\Adobe\CEP\extensions"
set "TARGET_DIR=%TARGET_ROOT%\%EXTENSION_NAME%"

echo.
echo Installing AIGC Selection Refiner CEP plugin...
echo Source: %SOURCE_DIR%
echo Target: %TARGET_DIR%
echo.

if not exist "%SOURCE_DIR%" (
  echo ERROR: Cannot find plugin source folder.
  pause
  exit /b 1
)

if not exist "%TARGET_ROOT%" mkdir "%TARGET_ROOT%"
if exist "%TARGET_DIR%" rmdir /s /q "%TARGET_DIR%"
xcopy "%SOURCE_DIR%" "%TARGET_DIR%" /E /I /Y >nul

echo.
echo Installed. Please restart Photoshop.
echo Open it from: Window ^> Extensions ^> AIGC 选区细化
echo If it does not show, run enable-cep-debug.bat once, then restart Photoshop.
echo.
pause
