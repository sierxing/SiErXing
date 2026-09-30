@echo off
chcp 65001 >nul
rem 思而行 · Windows 启动脚本
cd /d "%~dp0.."

where node >nul 2>nul
if errorlevel 1 (
  echo [错误] 未找到 Node.js，请先安装 Node.js 22.5 以上版本：https://nodejs.org
  pause
  exit /b 1
)

for /f "delims=" %%v in ('node -p "process.versions.node"') do set NODE_VER=%%v
echo Node.js 版本：%NODE_VER%

set FLAG=
node -e "const [a,b]=process.versions.node.split('.').map(Number); process.exit((a>23||(a===23&&b>=4))?0:1)" >nul 2>nul
if errorlevel 1 (
  set FLAG=--experimental-sqlite
  echo 提示：当前 Node 版本较旧，将使用 --experimental-sqlite 启动（建议升级到 Node 24 LTS）
)

if "%PORT%"=="" set PORT=3213
echo.
echo 思而行已启动，请在浏览器打开：http://localhost:%PORT%
echo 使用期间请保持此窗口开启（按 Ctrl+C 可停止）
echo.
node --no-warnings %FLAG% server\server.js
pause
