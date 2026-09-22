@echo off
chcp 65001 >nul
rem ============================================================
rem   思而行 SiErXing · Windows 一键安装（包装脚本，实际逻辑在 install.ps1）
rem
rem   用法：
rem     install.bat                  默认安装（当前目录或 %USERPROFILE%\SiErXing）
rem     install.bat D:\SiErXing      指定安装目录（任意盘符/目录）
rem     install.bat D:\Apps\SiErXing -Port 3222 -NoAutostart
rem
rem   说明：只写用户目录，不需要管理员权限。
rem ============================================================
setlocal
set "PS1=%~dp0install.ps1"
if not exist "%PS1%" (
  echo [错误] 未找到 install.ps1，请确认它与 install.bat 在同一目录
  pause
  exit /b 1
)
powershell -NoProfile -ExecutionPolicy Bypass -File "%PS1%" %*
if errorlevel 1 (
  echo.
  echo 安装过程出现问题，请把上面的信息截图反馈。
  pause
)
endlocal
