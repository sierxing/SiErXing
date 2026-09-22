# ============================================================
#  思而行 SiErXing · Windows 一键安装
#  用法：
#    install.bat                      # 默认：当前目录（若已是项目目录）或 %USERPROFILE%\SiErXing
#    install.bat D:\SiErXing          # 指定安装目录（任意盘符）
#    install.bat D:\Apps\SiErXing -Port 3222 -NoAutostart
#  说明：只写用户目录，不需要管理员权限；已安装过会自动更新。
# ============================================================
param(
  [Parameter(Position = 0)][string]$Dir = "",
  [int]$Port = 3213,
  [switch]$NoAutostart,
  [switch]$NoOpen
)

$ErrorActionPreference = 'Continue'
$Repo  = 'https://atomgit.com/sierxing/SiErXing.git'
$Label = '思而行'

function Say($m)  { Write-Host $m }
function Ok($m)   { Write-Host "  [OK] $m"   -ForegroundColor Green }
function Warn($m) { Write-Host "  [!] $m"    -ForegroundColor Yellow }
function Die($m)  { Write-Host "  [X] $m"    -ForegroundColor Red; Read-Host "按回车退出"; exit 1 }

Say ""
Say "=== $Label SiErXing · Windows 安装程序 ==="
Say ""

# ---------- 1. 检查 Node.js ----------
$nodeCmd = Get-Command node -ErrorAction SilentlyContinue
if (-not $nodeCmd) {
  Die "未找到 Node.js。请先安装 Node.js 22.5 以上版本（推荐 24 LTS）：https://nodejs.org"
}
$nodeVer = (& node -p "process.versions.node")
$maj = [int](& node -p "process.versions.node.split('.')[0]")
$min = [int](& node -p "process.versions.node.split('.')[1]")
if ($maj -lt 22 -or ($maj -eq 22 -and $min -lt 5)) {
  Die "Node.js 版本过低（当前 $nodeVer），需要 22.5 以上（推荐 24 LTS）"
}
Ok "Node.js $nodeVer"

# ---------- 2. 确定安装目录 ----------
$here = Split-Path -Parent $MyInvocation.MyCommand.Path
$inProject = Test-Path (Join-Path $here 'server\server.js')

if (-not $Dir -or $Dir.Trim() -eq '') {
  if ($inProject) {
    $Dir = $here
    Say "当前目录即项目目录：$Dir"
    Say "如需装到其它盘/目录：install.bat D:\SiErXing（或 install.bat E:\Apps\SiErXing）"
  } else {
    $Dir = Join-Path $env:USERPROFILE 'SiErXing'
    Say "未检测到项目文件，将下载到默认目录：$Dir"
    Say "如需装到其它盘/目录：install.bat D:\SiErXing"
  }
}
$Dir = $Dir.TrimEnd('\')

# 若指定了其它目录，而当前目录已有项目 → 复制过去
if ($inProject -and ($here.TrimEnd('\') -ne $Dir)) {
  Say "正在复制项目到 $Dir …"
  New-Item -ItemType Directory -Force -Path $Dir | Out-Null
  robocopy $here $Dir /E /XD .git /NFL /NDL /NJH /NJS /NP | Out-Null   # 连 data（目标与进度）一起搬，只排除 .git
  if (-not (Test-Path (Join-Path $Dir 'server\server.js'))) { Die "复制失败，请检查目标目录权限：$Dir" }
}

# 需要时从仓库下载
if (-not (Test-Path (Join-Path $Dir 'server\server.js'))) {
  New-Item -ItemType Directory -Force -Path $Dir | Out-Null
  if (Get-Command git -ErrorAction SilentlyContinue) {
    Say "正在下载项目到 $Dir …"
    & git clone --depth 1 $Repo $Dir 2>&1 | Out-Null
    if (-not (Test-Path (Join-Path $Dir 'server\server.js'))) { Die "下载失败，请检查网络后重试（或手动下载 ZIP 解压到该目录）" }
  } else {
    Die "未找到 git。请打开 https://atomgit.com/sierxing/SiErXing 下载 ZIP，解压到 $Dir 后再运行本脚本"
  }
}
Ok "安装目录：$Dir"

# ---------- 3. 启动服务 ----------
$url = "http://localhost:$Port"
$flag = if ($maj -gt 23 -or ($maj -eq 23 -and $min -ge 4)) { '' } else { '--experimental-sqlite' }
$log = Join-Path $env:USERPROFILE '.sierxing.log'

$alive = $false
try { $h = Invoke-RestMethod "$url/api/health" -TimeoutSec 2; if ($h.ok) { $alive = $true } } catch {}
if ($alive) {
  Ok "服务已在运行：$url"
} else {
  Say "正在启动服务…"
  $inner = "set PORT=$Port && node --no-warnings $flag `"$Dir\server\server.js`" > `"$log`" 2>&1"
  Start-Process -FilePath 'cmd.exe' -ArgumentList "/c $inner" -WindowStyle Minimized
  for ($i = 1; $i -le 25; $i++) {
    Start-Sleep -Seconds 1
    try { $h = Invoke-RestMethod "$url/api/health" -TimeoutSec 2; if ($h.ok) { break } } catch {}
  }
  try { $h = Invoke-RestMethod "$url/api/health" -TimeoutSec 3; if ($h.ok) { Ok "服务已启动：$url" } else { Warn "服务未响应，日志：$log" } }
  catch { Warn "服务未响应，日志：$log" }
}

# ---------- 4. 桌面图标 + 终端命令 ----------
Say "正在创建桌面图标与终端命令…"
try {
  $sc = Invoke-RestMethod -Method Post -Uri "$url/api/service/shortcuts" -ContentType 'application/json' -Body '{}' -TimeoutSec 40
  if ($sc.desktop) { Ok "桌面图标已创建：$($sc.desktopPath)" } else { Warn "桌面图标创建失败" }
  if ($sc.launcher) { Ok "终端命令已创建：sierxing（在 %LOCALAPPDATA%\SiErXing）" }
  if ($sc.notes) { $sc.notes | ForEach-Object { Warn $_ } }
} catch {
  Warn "创建快捷方式失败：$($_.Exception.Message)"
}

# ---------- 5. 开机自启 ----------
if ($NoAutostart) {
  Say "未开启开机自启（可在「设置 → 服务与启动」里打开）"
} else {
  $ans = Read-Host "是否开启开机自启？让 $Label 开机自动运行 [Y/n]"
  if ($ans -notmatch '^\s*[nN]') {
    try {
      $auto = Invoke-RestMethod -Method Post -Uri "$url/api/service/autostart" -ContentType 'application/json' -Body '{"enabled":true}' -TimeoutSec 40
      if ($auto.ok) { Ok "已开启开机自启（可随时在「设置 → 服务与启动」里关闭）" } else { Warn "开启失败：$($auto.error)" }
    } catch { Warn "开启失败：$($_.Exception.Message)" }
  } else {
    Say "未开启开机自启（可在「设置 → 服务与启动」里打开）"
  }
}

# ---------- 6. 完成 ----------
Say ""
Say "=== 安装完成！ ==="
Say "  · 安装目录：$Dir"
Say "  · 访问地址：$url"
Say "  · 桌面图标：$Label（双击即用）"
Say "  · 终端命令：sierxing"
Say "  · 下一步：在页面左侧「设置」里配置 AI（OpenAI 兼容接口 / 本地 Ollama / opencode CLI），点「测试连接」"
Say ""
if (-not $NoOpen) { Start-Process $url }
Say "（本窗口可以关闭）"
