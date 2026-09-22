@echo off
chcp 65001 >nul
setlocal enabledelayedexpansion
rem ============================================================
rem   思而行 SiErXing · 一键安装（Windows）
rem   用法：双击本文件；或在终端执行 install.bat
rem   可选：set SIERXING_PORT=3213  指定端口
rem         set SIERXING_NO_AUTOSTART=1  跳过开机自启询问
rem ============================================================
set LABEL=思而行
set REPO=https://atomgit.com/sierxing/SiErXing.git

echo.
echo === %LABEL% SiErXing · 安装程序 ===
echo.

rem ---------- 1. 检查 Node.js ----------
where node >nul 2>nul
if errorlevel 1 (
  echo [错误] 未找到 Node.js。请先安装 Node.js 22.5 以上版本（推荐 24 LTS）：https://nodejs.org
  pause
  exit /b 1
)
for /f "delims=" %%v in ('node -p "process.versions.node"') do set NODE_VER=%%v
for /f "delims=" %%v in ('node -p "process.versions.node.split('.')[0]"') do set NODE_MAJOR=%%v
for /f "delims=" %%v in ('node -p "process.versions.node.split('.')[1]"') do set NODE_MINOR=%%v
if %NODE_MAJOR% LSS 22 (
  echo [错误] Node.js 版本过低（当前 %NODE_VER%），需要 22.5 以上
  pause
  exit /b 1
)
echo  [OK] Node.js %NODE_VER%

rem ---------- 2. 定位项目 ----------
set APP_DIR=%~dp0
if not exist "%APP_DIR%server\server.js" (
  echo [错误] 未找到 server\server.js，请把本脚本放在项目根目录下运行
  pause
  exit /b 1
)
echo  [OK] 项目目录：%APP_DIR%

if "%SIERXING_PORT%"=="" set SIERXING_PORT=3213
set URL=http://localhost:%SIERXING_PORT%

rem ---------- 3. 启动服务 ----------
echo  正在启动服务...
start "SiErXing" /min cmd /c "cd /d "%APP_DIR%" && set PORT=%SIERXING_PORT% && node --no-warnings --experimental-sqlite server\server.js > "%USERPROFILE%\.sierxing.log" 2>&1"
set READY=0
for /l %%i in (1,1,20) do (
  timeout /t 1 >nul
  curl -s --max-time 1 "%URL%/api/health" >nul 2>nul && (set READY=1 & goto :started)
)
:started
if "%READY%"=="1" (echo  [OK] 服务已启动：%URL%) else (echo  [!] 服务未响应，请查看日志：%USERPROFILE%\.sierxing.log)

rem ---------- 4. 桌面图标 + 终端命令 ----------
echo  正在创建桌面图标与终端命令...
curl -s -X POST "%URL%/api/service/shortcuts" -H "Content-Type: application/json" -d "{}" > "%TEMP%\sierxing-shortcuts.json" 2>nul
findstr /C:"\"desktop\":true" "%TEMP%\sierxing-shortcuts.json" >nul 2>nul && echo  [OK] 桌面图标已创建（双击「%LABEL%」） || echo  [!] 桌面图标创建失败，可在「设置 → 服务与启动」里重试
findstr /C:"\"launcher\":true" "%TEMP%\sierxing-shortcuts.json" >nul 2>nul && echo  [OK] 终端命令已创建

rem ---------- 5. 开机自启 ----------
if "%SIERXING_NO_AUTOSTART%"=="1" goto :skipauto
set /p ASK=是否开启开机自启？让 %LABEL% 开机自动运行 [Y/n]：
if /i "%ASK%"=="n" goto :skipauto
if /i "%ASK%"=="no" goto :skipauto
curl -s -X POST "%URL%/api/service/autostart" -H "Content-Type: application/json" -d "{\"enabled\":true}" >nul 2>nul
echo  [OK] 已开启开机自启（可在「设置 → 服务与启动」里关闭）
goto :done
:skipauto
echo  未开启开机自启（可在「设置 → 服务与启动」里随时打开）

:done
echo.
echo === 安装完成！ ===
echo   · 访问地址：%URL%
echo   · 桌面图标：双击「%LABEL%」
echo   · 下一步：在页面「设置」里填入 AI 接口（DeepSeek / 通义千问 / 本地 Ollama…），点「测试连接」即可开始
echo.
start "" "%URL%"
pause
