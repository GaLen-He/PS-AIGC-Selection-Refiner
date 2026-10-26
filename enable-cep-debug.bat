@echo off
echo.
echo This enables loading Unsigned CEP extensions for the current Windows user.
echo Use it only if Photoshop does not show the copied extension.
echo.
pause

for %%V in (CSXS.6 CSXS.7 CSXS.8 CSXS.9 CSXS.10 CSXS.11 CSXS.12 CSXS.13) do (
  reg add "HKCU\Software\Adobe\%%V" /v PlayerDebugMode /t REG_SZ /d 1 /f >nul
)

echo.
echo Done. Restart Photoshop.
echo.
pause
