@echo off
chcp 936 >nul
cd /d "%~dp0"

echo.
echo 正在启动桌面版...
echo 数据目录：%APPDATA%\ai-writer-desktop
echo.

npm run dev

:end
pause
