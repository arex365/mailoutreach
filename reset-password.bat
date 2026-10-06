@echo off
chcp 65001 >nul
rem Polygon Paradise Outreach - make a password reset link. Works only on this PC.
setlocal
cd /d "%~dp0"
title Polygon Paradise Outreach - reset a password
where node >nul 2>&1
if errorlevel 1 goto nonode
if not exist "node_modules\tsx\" goto nosetup
node --import tsx scripts\reset-password.ts
goto end

:nosetup
echo  The app isn't set up yet. Double-click setup.bat first.
goto end

:nonode
echo  Node.js isn't installed on this PC, or Windows can't find it. Install Node.js 24 (not 26) from https://nodejs.org/dist/latest-v24.x/ (the file ending in -x64.msi).
goto end

:end
echo.
echo Press any key to close this window.
pause >nul
