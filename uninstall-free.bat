@echo off
setlocal
set "TARGET_DIR=%APPDATA%\Adobe\CEP\extensions\AIGCSelectionRefiner"

echo.
echo Uninstalling AIGC Selection Refiner CEP plugin...

if exist "%TARGET_DIR%" rmdir /s /q "%TARGET_DIR%"

echo Done. Please restart Photoshop.
echo.
pause
