@echo off
chcp 65001 >nul
rem Polygon Paradise Outreach - make the app and the background sender start with Windows.
rem Close the start.bat window first. Asks Windows for permission.
setlocal
cd /d "%~dp0"
title Polygon Paradise Outreach - install services
net session >nul 2>&1
if not errorlevel 1 goto run
fltmc >nul 2>&1
if not errorlevel 1 goto run
echo Windows will ask for permission to install the background services.
set "PP_SELF=%~f0"
powershell -NoProfile -Command "try { Start-Process -FilePath $env:PP_SELF -Verb RunAs -ErrorAction Stop } catch { exit 1 }"
if errorlevel 1 goto noperm
exit /b 0

:run
powershell -NoProfile -ExecutionPolicy Bypass -File scripts\install-services.ps1
goto end

:noperm
echo Windows didn't give permission, so nothing was installed.
goto end

:end
echo.
echo Press any key to close this window.
pause >nul
