@echo off
chcp 65001 >nul
setlocal EnableExtensions EnableDelayedExpansion
rem ============================================================
rem   SiErXing - Windows installer wrapper (lives in scripts\)
rem   Usage (run from project root or scripts dir):
rem     scripts\install.bat                  install in place (or %USERPROFILE%\SiErXing)
rem     scripts\install.bat D:\SiErXing      choose install directory
rem     scripts\install.bat D:\Apps\SiErXing -Port 3222 -NoAutostart
rem   Notes: only writes user folders, no admin rights needed.
rem ============================================================

set "HERE=%~dp0"
set "PORT=3213"
set "NOAUTO="
set "TARGET="

rem ---- parse args: [dir] [-Port N] [-NoAutostart] ----
:parse
if "%~1"=="" goto parsed
if /i "%~1"=="-Port" ( set "PORT=%~2" & shift & shift & goto parse )
if /i "%~1"=="-NoAutostart" ( set "NOAUTO=1" & shift & goto parse )
if "!TARGET!"=="" ( set "TARGET=%~1" & shift & goto parse )
shift
goto parse
:parsed

if "%TARGET%"=="" set "TARGET=%HERE:~0,-1%"
if not exist "%TARGET%\server\server.js" (
  if exist "%HERE%server\server.js" ( set "TARGET=%HERE:~0,-1%" ) else (
    for %%p in ("%HERE%..") do if exist "%%~fp\server\server.js" set "TARGET=%%~fp"
  )
)

echo.
echo === SiErXing installer (Windows) ===
echo   target dir : %TARGET%
echo   port       : %PORT%
echo.

rem ---- 1) try PowerShell installer (UTF-8 BOM, PS 5.1 compatible) ----
if exist "%HERE%install.ps1" (
  powershell -NoProfile -ExecutionPolicy Bypass -File "%HERE%install.ps1" "%TARGET%" -Port %PORT% %NOAUTO%
  if not errorlevel 1 (
    endlocal
    exit /b 0
  )
  echo.
  echo   [!] PowerShell installer failed, falling back to plain cmd mode...
  echo.
)

rem ---- 2) fallback: pure cmd (no PowerShell needed) ----
where node >nul 2>nul
if errorlevel 1 (
  echo   [X] Node.js not found. Please install Node.js 22.5+ ^(24 LTS recommended^): https://nodejs.org
  pause
  exit /b 1
)
for /f "delims=" %%v in ('node -p "process.versions.node"') do set "NODEVER=%%v"
for /f "delims=" %%v in ('node -p "process.versions.node.split('.')[0]"') do set "NMAJ=%%v"
for /f "delims=" %%v in ('node -p "process.versions.node.split('.')[1]"') do set "NMIN=%%v"
echo   [OK] Node.js %NODEVER%

set "SQLITEFLAG="
if %NMAJ% LSS 23 set "SQLITEFLAG=--experimental-sqlite"
if %NMAJ%==23 if %NMIN% LSS 4 set "SQLITEFLAG=--experimental-sqlite"

set "URL=http://localhost:%PORT%"
set "LOG=%USERPROFILE%\.sierxing.log"

rem already running?
curl -s --max-time 2 "%URL%/api/health" >nul 2>nul
if not errorlevel 1 (
  echo   [OK] service already running: %URL%
  goto shortcuts
)

echo   starting service...
start "SiErXing" /min cmd /c "set PORT=%PORT% && node --no-warnings %SQLITEFLAG% "%TARGET%\server\server.js" > "%LOG%" 2>&1"
set "READY=0"
for /l %%i in (1,1,25) do (
  timeout /t 1 >nul
  curl -s --max-time 2 "%URL%/api/health" >nul 2>nul
  if not errorlevel 1 ( set "READY=1" & goto started )
)
:started
if "%READY%"=="1" ( echo   [OK] service started: %URL% ) else ( echo   [!] service not responding, log: %LOG% )

:shortcuts
echo   creating desktop icon and terminal command...
curl -s -X POST "%URL%/api/service/shortcuts" -H "Content-Type: application/json" -d "{}" > "%TEMP%\sierxing-sc.json" 2>nul
findstr /C:"\"desktop\":true" "%TEMP%\sierxing-sc.json" >nul 2>nul
if errorlevel 1 ( echo   [!] desktop icon creation failed - retry later in Settings ^> Service ^& Startup ) else ( echo   [OK] desktop icon created )
findstr /C:"\"launcher\":true" "%TEMP%\sierxing-sc.json" >nul 2>nul
if not errorlevel 1 echo   [OK] terminal command created: sierxing

if not "%NOAUTO%"=="" goto done
set /p ASK=Enable auto-start on boot? [Y/n]:
if /i "%ASK%"=="n" goto done
if /i "%ASK%"=="no" goto done
curl -s -X POST "%URL%/api/service/autostart" -H "Content-Type: application/json" -d "{\"enabled\":true}" >nul 2>nul
echo   [OK] auto-start enabled ^(toggle anytime in Settings^)

:done
echo.
echo === Done ===
echo   url        : %URL%
echo   desktop    : SiErXing icon ^(double click^)
echo   command    : sierxing
echo   next step  : open the page, go to Settings, configure AI ^(OpenAI compatible / Ollama / opencode^), click Test
echo.
start "" "%URL%"
pause
endlocal
