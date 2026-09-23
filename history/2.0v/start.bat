@echo off
chcp 65001 >nul
cd /d "%~dp0"
echo Starting ChengXian Course Tool...
python server.py
if errorlevel 1 (
  echo.
  echo [ERROR] failed to start. Trying py launcher...
  py server.py
)
pause
