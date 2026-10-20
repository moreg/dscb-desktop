@echo off
chcp 936 >nul
cd /d "%~dp0"
set WEB_ACCESS_TOKEN=dev-token
set WEB_HOST=127.0.0.1
set WEB_PORT=8787
echo.
echo 正在启动 Web 版...
echo 浏览器打开 http://127.0.0.1:8787
echo 口令：dev-token
echo 数据目录：%cd%\data
echo.
npm run web:start
