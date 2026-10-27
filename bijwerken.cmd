@echo off
title TV iPhone-app bijwerken
cd /d "%~dp0"
node scripts\build.js
echo.
echo Upload nu de map "www" opnieuw op GitHub (Add file - Upload files).
pause
