@echo off
chcp 65001 >nul
rem Polygon Paradise Outreach - how is the app doing? Changes nothing.
setlocal
cd /d "%~dp0"
title Polygon Paradise Outreach - status
powershell -NoProfile -ExecutionPolicy Bypass -File scripts\status.ps1
echo.
echo Press any key to close this window.
pause >nul
