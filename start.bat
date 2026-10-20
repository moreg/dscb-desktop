@echo off
chcp 936 >nul
cd /d "%~dp0"

echo.
echo  1. 只启动桌面版
echo  2. 只启动 Web 版    http://127.0.0.1:8787    口令 dev-token
echo  3. 同时启动
echo.
set /p choice=请选择启动方式 [3]: 
if "%choice%"=="" set choice=3
if "%choice%"=="1" goto desktop
if "%choice%"=="2" goto webonly
if "%choice%"=="3" goto both
echo 没有这个选项。
goto end

:desktop
echo.
echo 正在启动桌面版...
echo.
npm run dev
goto end

:webonly
call :prepareweb
if errorlevel 1 goto end
call "%~dp0start-web.cmd"
goto end

:both
call :prepareweb
if errorlevel 1 goto end
echo.
echo 正在另开窗口启动 Web 版...
echo 浏览器打开 http://127.0.0.1:8787
echo 口令：dev-token
echo Web 版数据目录：%cd%\data
echo 桌面版数据目录：%APPDATA%\ai-writer-desktop
echo 两套数据互不相通，模型密钥也不会互相覆盖。
echo.
start "大神持笔 Web" /D "%~dp0." cmd /k start-web.cmd
echo 正在启动桌面版...
echo.
npm run dev
goto end

:prepareweb
if exist "out\web-server\server.cjs" if exist "out\web\renderer\index.html" exit /b 0
echo.
echo 第一次启动 Web 版，正在构建页面和服务...
echo.
call npm run web:build
exit /b %errorlevel%

:end
pause
