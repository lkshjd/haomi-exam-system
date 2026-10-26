@echo off
setlocal
chcp 65001 >nul
cd /d "%~dp0"

where node >nul 2>&1
if errorlevel 1 (
  echo [ERROR] Node.js not found. Please install Node.js 22 LTS: https://nodejs.org/
  pause
  exit /b 1
)

where pwsh >nul 2>&1
if errorlevel 1 goto use_windows_powershell

pwsh -NoProfile -ExecutionPolicy Bypass -File "%~dp0start.ps1" %*
set "EXITCODE=%ERRORLEVEL%"
goto finish

:use_windows_powershell
where powershell >nul 2>&1
if errorlevel 1 (
  echo [ERROR] PowerShell not found.
  pause
  exit /b 1
)
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0start.ps1" %*
set "EXITCODE=%ERRORLEVEL%"

:finish
if not "%EXITCODE%"=="0" (
  echo.
  echo [ERROR] Startup failed with exit code %EXITCODE%.
  pause
)
exit /b %EXITCODE%
