#!/usr/bin/env bash
# ============================================================
#  思而行 SiErXing · 一键安装脚本（Linux / macOS）
#  用法：
#    1) 已下载本项目：  ./install.sh
#    2) 全新安装（一条命令）：
#       git clone --depth 1 https://atomgit.com/sierxing/SiErXing.git ~/SiErXing && bash ~/SiErXing/install.sh
#  可选环境变量：
#    SIERXING_DIR=<安装目录>      默认 ~/SiErXing
#    SIERXING_PORT=<端口>         默认 3213
#    SIERXING_AUTOSTART=1         免询问直接开启开机自启
#    SIERXING_NO_AUTOSTART=1      不开启（也不询问）
# ============================================================
set -u
REPO="https://atomgit.com/sierxing/SiErXing.git"
LABEL="思而行"
GREEN='\033[0;32m'; YELLOW='\033[0;33m'; RED='\033[0;31m'; BOLD='\033[1m'; NC='\033[0m'
say()  { printf "%b\n" "$1"; }
ok()   { printf "${GREEN}✓${NC} %s\n" "$1"; }
warn() { printf "${YELLOW}!${NC} %s\n" "$1"; }
die()  { printf "${RED}✗ %s${NC}\n" "$1"; exit 1; }

say "${BOLD}${LABEL} SiErXing · 安装程序${NC}"
say ""

# ---------- 1. 检查 Node.js ----------
if ! command -v node >/dev/null 2>&1; then
  die "未找到 Node.js。请先安装 Node.js 22.5 以上版本（推荐 24 LTS）：https://nodejs.org"
fi
NODE_VER="$(node -p 'process.versions.node')"
MAJOR="$(node -p 'process.versions.node.split(".")[0]')"
MINOR="$(node -p 'process.versions.node.split(".")[1]')"
if [ "$MAJOR" -lt 22 ] || { [ "$MAJOR" -eq 22 ] && [ "$MINOR" -lt 5 ]; }; then
  die "Node.js 版本过低（当前 ${NODE_VER}），需要 22.5 以上（推荐 24 LTS）"
fi
ok "Node.js ${NODE_VER}"

# ---------- 2. 定位 / 获取项目 ----------
SRC_DIR="$(cd "$(dirname "$0")" && pwd)"
if [ -f "${SRC_DIR}/server/server.js" ]; then
  APP_DIR="$SRC_DIR"
  ok "使用当前目录：${APP_DIR}"
else
  APP_DIR="${SIERXING_DIR:-}"
  if [ -z "$APP_DIR" ]; then
    if [ -t 0 ]; then
      printf "安装目录（回车使用 %s）：" "$HOME/SiErXing"
      read -r ans || ans=""
      APP_DIR="${ans:-$HOME/SiErXing}"
    else
      APP_DIR="$HOME/SiErXing"
    fi
  fi
  APP_DIR="${APP_DIR/#\~/$HOME}"
  if [ -f "${APP_DIR}/server/server.js" ]; then
    ok "使用已有安装：${APP_DIR}"
  else
    say "正在下载项目到 ${APP_DIR} …"
    mkdir -p "$(dirname "$APP_DIR")"
    if command -v git >/dev/null 2>&1; then
      git clone --depth 1 "$REPO" "$APP_DIR" >/dev/null 2>&1 || die "git clone 失败，请检查网络后重试"
    else
      TMP="$(mktemp -d)"
      (cd "$TMP" && curl -fsSL "$REPO/archive/refs/heads/main.tar.gz" -o src.tgz && tar xzf src.tgz) \
        || die "下载失败，请检查网络或改用 git clone"
      mv "$TMP"/*/ "$APP_DIR" 2>/dev/null || die "解压失败"
      rm -rf "$TMP"
    fi
    ok "项目已就绪：${APP_DIR}"
  fi
fi

PORT="${SIERXING_PORT:-3213}"
URL="http://localhost:${PORT}"

# ---------- 3. 启动服务 ----------
if curl -s --max-time 1 "${URL}/api/health" >/dev/null 2>&1; then
  ok "服务已在运行：${URL}"
else
  say "正在启动服务…"
  ( cd "$APP_DIR" && PORT="$PORT" nohup ./start.sh > "$HOME/.sierxing.log" 2>&1 & ) || true
  for i in $(seq 1 20); do
    sleep 1
    curl -s --max-time 1 "${URL}/api/health" >/dev/null 2>&1 && break
  done
  if curl -s --max-time 2 "${URL}/api/health" >/dev/null 2>&1; then ok "服务已启动：${URL}"; else
    warn "服务未能响应，请查看日志：$HOME/.sierxing.log"
  fi
fi

# ---------- 4. 创建桌面图标 + 终端命令 ----------
say "正在创建桌面图标与终端命令…"
SHORTCUT_RES="$(curl -s -X POST "${URL}/api/service/shortcuts" -H 'Content-Type: application/json' -d '{}' 2>/dev/null || true)"
case "$SHORTCUT_RES" in
  *'"desktop":true'*) ok "桌面图标已创建（双击即可使用）" ;;
  *) warn "桌面图标创建失败，可稍后在「设置 → 服务与启动」里重试" ;;
esac
case "$SHORTCUT_RES" in
  *'"launcher":true'*) ok "终端命令已创建：输入 sierxing 即可启动" ;;
esac

# ---------- 5. 开机自启（可询问） ----------
STATUS_JSON="$(curl -s --max-time 3 "${URL}/api/service/status" 2>/dev/null || true)"
ALREADY_AUTO="0"
case "$STATUS_JSON" in *'"autostart":{"supported":true,"enabled":true'*|*'"enabled":true'*'"mechanism"'*) ALREADY_AUTO="1" ;; esac
WANT_AUTO="${SIERXING_AUTOSTART:-}"
if [ "${SIERXING_NO_AUTOSTART:-}" = "1" ]; then WANT_AUTO="0"; fi
if [ "$ALREADY_AUTO" = "1" ] && [ -z "$WANT_AUTO" ]; then
  ok "开机自启：已开启（可在「设置 → 服务与启动」里关闭）"
  WANT_AUTO="keep"
fi
if [ -z "$WANT_AUTO" ]; then
  if [ -t 0 ]; then
    printf "是否开启${BOLD}开机自启${NC}？（让 %s 开机自动运行）[Y/n] " "$LABEL"
    read -r ans || ans=""
    case "$ans" in n|N|no|NO) WANT_AUTO="0" ;; *) WANT_AUTO="1" ;; esac
  else
    WANT_AUTO="0"
  fi
fi
if [ "$WANT_AUTO" = "keep" ]; then
  : # 已是开启状态，不动
elif [ "$WANT_AUTO" = "1" ]; then
  AUTO_RES="$(curl -s -X POST "${URL}/api/service/autostart" -H 'Content-Type: application/json' -d '{"enabled":true}' 2>/dev/null || true)"
  case "$AUTO_RES" in
    *'"ok":true'*) ok "已开启开机自启（可随时在「设置 → 服务与启动」里关闭）" ;;
    *) warn "开机自启开启失败，可稍后在设置页重试" ;;
  esac
else
  say "未开启开机自启（可在「设置 → 服务与启动」里随时打开）"
fi

# ---------- 6. 打开浏览器 ----------
say ""
say "${BOLD}安装完成！${NC}"
say "  · 访问地址：${URL}"
say "  · 终端命令：sierxing"
say "  · 桌面图标：双击「${LABEL}」"
say "  · 下一步：在页面右上「设置」里填入 AI 接口（DeepSeek / 通义千问 / 本地 Ollama…），点「测试连接」即可开始使用"
say ""
if command -v xdg-open >/dev/null 2>&1; then xdg-open "$URL" >/dev/null 2>&1 &
elif command -v open >/dev/null 2>&1; then open "$URL" >/dev/null 2>&1 &
fi
exit 0
