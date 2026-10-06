@echo off
chcp 65001 >nul
rem Polygon Paradise Outreach - put your data back from a backup.
rem   restore.bat                 shows the backups and asks which one
rem   restore.bat backups\x.db    restores that file
setlocal
cd /d "%~dp0"
title Polygon Paradise Outreach - restore a backup
where node >nul 2>&1
if errorlevel 1 goto nonode

rem With background services installed, restoring needs administrator rights.
sc query OutreachWeb >nul 2>&1
if errorlevel 1 goto run
net session >nul 2>&1
if not errorlevel 1 goto run
fltmc >nul 2>&1
if not errorlevel 1 goto run
echo Windows will ask for permission, because the app runs as a background service.
rem The new window gets EVERY argument, not only the first, so an option such as --db or
rem --backups-dir is never dropped (that would restore into the real database instead).
rem Each argument travels in its own environment variable (PP_RESTORE_ARG1, PP_RESTORE_ARG2, ...),
rem so spaces, apostrophes, ampersands or other characters in a path can't break this file or the
rem PowerShell command. PowerShell puts quotes around each one again (doubling a trailing backslash,
rem so "D:\Backups\" stays one argument).
set "PP_SELF=%~f0"
set "PP_RESTORE_ARGC=0"
:nextarg
if [%1]==[] goto collected
set /a PP_RESTORE_ARGC+=1
set "PP_RESTORE_ARG%PP_RESTORE_ARGC%=%~1"
shift
goto nextarg
:collected
if "%PP_RESTORE_ARGC%"=="0" goto elevatenoargs
powershell -NoProfile -Command "$n = [int]$env:PP_RESTORE_ARGC; $list = foreach ($i in 1..$n) { [char]34 + ([Environment]::GetEnvironmentVariable('PP_RESTORE_ARG' + $i) -replace '(\\+)$', '$1$1') + [char]34 }; try { Start-Process -FilePath $env:PP_SELF -ArgumentList ($list -join ' ') -Verb RunAs -ErrorAction Stop } catch { exit 1 }"
goto elevated
:elevatenoargs
powershell -NoProfile -Command "try { Start-Process -FilePath $env:PP_SELF -Verb RunAs -ErrorAction Stop } catch { exit 1 }"
:elevated
if errorlevel 1 goto noperm
exit /b 0

:run
node scripts\restore.mjs %*
goto end

:noperm
echo Windows didn't give permission, so nothing was changed.
goto end

:nonode
echo  Node.js isn't installed on this PC, or Windows can't find it. Install Node.js 24 (not 26) from https://nodejs.org/dist/latest-v24.x/ (the file ending in -x64.msi).
goto end

:end
echo.
echo Press any key to close this window.
pause >nul
