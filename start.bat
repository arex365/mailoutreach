@echo off
chcp 65001 >nul
rem Polygon Paradise Outreach - start the app.
rem With the background services installed it starts them (asking Windows for permission) and
rem opens the app. Without them it runs the app in this window: keep the window open.
setlocal
cd /d "%~dp0"
title Polygon Paradise Outreach
where node >nul 2>&1
if errorlevel 1 goto nonode

sc query OutreachWeb >nul 2>&1
if errorlevel 1 goto byhand

rem Background services: if both already run, just open the app (no permission needed).
node scripts\service-control.mjs status --quiet
if not errorlevel 1 goto openonly
net session >nul 2>&1
if not errorlevel 1 goto startservices
fltmc >nul 2>&1
if not errorlevel 1 goto startservices
echo Windows will ask for permission to start the background services.
set "PP_SELF=%~f0"
powershell -NoProfile -Command "try { Start-Process -FilePath $env:PP_SELF -Verb RunAs -ErrorAction Stop } catch { exit 1 }"
if errorlevel 1 goto noperm
exit /b 0

:startservices
node scripts\service-control.mjs start --open
goto end

:openonly
node scripts\service-control.mjs open
goto end

:byhand
node scripts\run-prod.mjs --open %*
goto end

:noperm
echo Windows didn't give permission, so the services weren't started.
goto end

:nonode
echo.
echo  Node.js isn't installed on this PC, or Windows can't find it.
echo  1. Download Node.js 24 (not 26) from https://nodejs.org/dist/latest-v24.x/ (the file ending in -x64.msi).
echo  2. Install it with the default options.
echo  3. Double-click setup.bat.
goto end

:end
echo.
echo Press any key to close this window.
pause >nul
