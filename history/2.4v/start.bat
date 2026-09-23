@echo off
chcp 65001 >nul
cd /d "%~dp0"
set URL=http://127.0.0.1:8765
where pythonw >nul 2>nul
if not errorlevel 1 (
  start "" pythonw server.py
  rem 稍候再开浏览器，确保服务已监听
  timeout /t 1 /nobreak >nul
  start "" %URL%
  exit /b 0
)
where pyw >nul 2>nul
if not errorlevel 1 (
  start "" pyw -3 server.py
  timeout /t 1 /nobreak >nul
  start "" %URL%
  exit /b 0
)
where python >nul 2>nul
if not errorlevel 1 (
  start "成贤课程资料库" /min python server.py
  timeout /t 1 /nobreak >nul
  start "" %URL%
  exit /b 0
)
echo 未找到 Python，请安装 Python 3 后重试
pause
