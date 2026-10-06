@echo off
chcp 65001 >nul
rem Polygon Paradise Outreach - install an update: stop, back up, install, upgrade the
rem database, build, start. If anything fails it says how to go back.
setlocal
cd /d "%~dp0"
title Polygon Paradise Outreach - update
where node >nul 2>&1
if errorlevel 1 goto nonode

rem With background services installed, updating needs administrator rights.
sc query OutreachWeb >nul 2>&1
if errorlevel 1 goto run
net session >nul 2>&1
if not errorlevel 1 goto run
fltmc >nul 2>&1
if not errorlevel 1 goto run
echo Windows will ask for permission, because the app runs as a background service.
set "PP_SELF=%~f0"
powershell -NoProfile -Command "try { Start-Process -FilePath $env:PP_SELF -Verb RunAs -ErrorAction Stop } catch { exit 1 }"
if errorlevel 1 goto noperm
exit /b 0

:run
node scripts\update.mjs %*
goto end

:noperm
echo Windows didn't give permission, so nothing was changed.
goto end

:nonode
echo.
echo  Node.js isn't installed on this PC, or Windows can't find it.
echo  Install Node.js 24 (not 26) from https://nodejs.org/dist/latest-v24.x/ (the file ending in -x64.msi), then double-click update.bat again.
goto end

:end
echo.
echo Press any key to close this window.
pause >nul
