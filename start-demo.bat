@echo off
chcp 65001 >nul
rem Polygon Paradise Outreach - the practice copy: made-up companies on http://localhost:3001.
rem It never sends anything and never touches your real data (data\app.db).
setlocal
cd /d "%~dp0"
title Polygon Paradise Outreach - practice copy
where node >nul 2>&1
if errorlevel 1 goto nonode
node scripts\start-demo.mjs %*
goto end

:nonode
echo  Node.js isn't installed on this PC, or Windows can't find it. Install Node.js 24 (not 26) from https://nodejs.org/dist/latest-v24.x/ (the file ending in -x64.msi).
goto end

:end
echo.
echo Press any key to close this window.
pause >nul
