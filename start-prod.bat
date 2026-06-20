@echo off
chcp 65001 >nul
cd /d "%~dp0"

setlocal

echo ========================================
echo   AI 写作桌面应用 - 启动
echo ========================================
echo.

set "EXE=%~dp0release\win-unpacked\ai-writer.exe"

REM ---- 1. 检查 release exe 是否存在 ----
if not exist "%EXE%" (
  echo [1/3] 找不到 %EXE%，正在打包...
  call "%~dp0node_modules\.bin\electron-builder.cmd" --dir
  if errorlevel 1 (
    echo [错误] 打包失败
    pause
    exit /b 1
  )
) else (
  echo [1/3] Release exe 已存在
)
echo.

REM ---- 2. 检查源码是否需要重新打包 ----
REM    比较源码最新修改时间和 app.asar 时间
set "SRC_LATEST=0"
for /f "delims=" %%i in ('dir /s /b /a-d "src\main" "src\preload" "src\renderer\src" 2^>nul') do (
  set "FILE_TIME=%%~ti"
  if "!FILE_TIME!" gtr "!SRC_LATEST!" set "SRC_LATEST=!FILE_TIME!"
)

set "ASAR=%~dp0release\win-unpacked\resources\app.asar"
set "ASAR_LATEST=00000000000000"
if exist "%ASAR%" set "ASAR_LATEST=%~ti"

echo [2/3] 源码最新：%SRC_LATEST%
echo       app.asar：  %ASAR_LATEST%

if "%SRC_LATEST%" gtr "%ASAR_LATEST%" (
  echo       源码比 app.asar 新，正在重新打包...
  call "%~dp0node_modules\.bin\electron-vite.cmd" build
  if errorlevel 1 (
    echo [错误] 构建失败
    pause
    exit /b 1
  )
  call "%~dp0node_modules\.bin\electron-builder.cmd" --dir
  if errorlevel 1 (
    echo [错误] 打包失败
    pause
    exit /b 1
  )
  echo       重新打包完成
) else (
  echo       无需重新打包
)
echo.

REM ---- 3. 启动应用 ----
echo [3/3] 正在启动应用...
start "" "%EXE%"

endlocal
exit /b 0