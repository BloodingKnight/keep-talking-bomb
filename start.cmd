@echo off
rem ============================================================
rem  Keep Talking Bomb - Windows launcher (double-click friendly)
rem  This is a thin wrapper; all the logic lives in start.ps1
rem
rem    start.cmd                          port 3210, opens browser
rem    start.cmd 8080                     another port
rem    start.cmd 8080 -NoBrowser          do not open a browser
rem    start.cmd 3210 -AdminToken mytok   fixed admin token
rem    start.cmd 3388 -Test               test mode (dev only)
rem    start.cmd 3210 -Detached           background mode (log: server.log)
rem
rem  Stop with Ctrl+C (foreground) or with .\stop.ps1 (background).
rem ============================================================
setlocal
set "PSEXE=powershell"
where pwsh >nul 2>nul && set "PSEXE=pwsh"

"%PSEXE%" -NoProfile -ExecutionPolicy Bypass -File "%~dp0start.ps1" %*
set "CODE=%ERRORLEVEL%"
if not "%CODE%"=="0" (
  echo.
  echo [bomb] start.ps1 exited with code %CODE%
  pause
)
endlocal
