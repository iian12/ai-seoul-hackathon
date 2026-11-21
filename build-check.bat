@echo off
cd /d "%~dp0"
echo Running npm run build ... (log: build-log.txt)
call npm run build > build-log.txt 2>&1
echo EXIT CODE: %ERRORLEVEL% >> build-log.txt
type build-log.txt
echo.
echo Done. You can close this window.
pause
