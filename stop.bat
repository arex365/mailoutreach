@echo off
chcp 65001 >nul
rem Polygon Paradise Outreach - stop the app (and the background sender).
setlocal
cd /d "%~dp0"
title Polygon Paradise Outreach - stop
where node >nul 2>&1
if errorlevel 1 goto nonode

sc query OutreachWeb >nul 2>&1
if errorlevel 1 goto byhand

net session >nul 2>&1
if not errorlevel 1 goto stopservices
fltmc >nul 2>&1
if not errorlevel 1 goto stopservices
echo Windows will ask for permission to stop the background services.
set "PP_SELF=%~f0"
powershell -NoProfile -Command "try { Start-Process -FilePath $env:PP_SELF -Verb RunAs -ErrorAction Stop } catch { exit 1 }"
if errorlevel 1 goto noperm
exit /b 0

:stopservices
node scripts\service-control.mjs stop
goto end

:byhand
node scripts\stop.mjs %*
goto end

:noperm
echo Windows didn't give permission, so nothing was stopped.
goto end

:nonode
echo  Node.js isn't installed on this PC, or Windows can't find it. Install Node.js 24 (not 26) from https://nodejs.org/dist/latest-v24.x/ (the file ending in -x64.msi).
goto end

:end
echo.
echo Press any key to close this window.
pause >nul
