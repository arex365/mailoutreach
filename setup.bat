@echo off
chcp 65001 >nul
rem Polygon Paradise Outreach - first-time setup. Safe to run again at any time:
rem it never replaces the encryption key or your data. See docs\setup\1-install.md.
setlocal
cd /d "%~dp0"
title Polygon Paradise Outreach - setup
set "PP_PAUSE=1"
for %%A in (%*) do if /i "%%~A"=="--no-pause" set "PP_PAUSE="
set "PP_CODE=1"
where node >nul 2>&1
if errorlevel 1 goto nonode
rem setup.mjs doesn't wait for a key itself (--no-pause): this window waits below, so it also
rem stays open when Node.js can't even load the script (for example a much too old Node.js).
node scripts\setup.mjs -- %* --no-pause
set "PP_CODE=%errorlevel%"
if "%PP_CODE%"=="0" goto end
echo.
echo  Setup didn't finish. The message above says why.
echo  If it mentions Node.js, install Node.js 24 (not 26) from https://nodejs.org/dist/latest-v24.x/ (the file ending in -x64.msi) and double-click setup.bat again.
goto end

:nonode
echo.
echo  Node.js isn't installed on this PC, or Windows can't find it.
echo  1. Download Node.js 24 (not 26) from https://nodejs.org/dist/latest-v24.x/ (the file ending in -x64.msi).
echo  2. Install it with the default options.
echo  3. Double-click setup.bat again.
goto end

:end
if not defined PP_PAUSE exit /b %PP_CODE%
echo.
echo Press any key to close this window.
pause >nul
exit /b %PP_CODE%
