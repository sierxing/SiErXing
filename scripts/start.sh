#!/usr/bin/env bash
# 思而行 · Linux / macOS 启动脚本
set -e
cd "$(dirname "$0")/.."

if ! command -v node >/dev/null 2>&1; then
  echo "[错误] 未找到 Node.js。请先安装 Node.js 22.5 以上版本：https://nodejs.org"
  exit 1
fi

NODE_VER=$(node -p "process.versions.node")
echo "Node.js 版本：$NODE_VER"

# Node 23.4+ 自带 node:sqlite 无需开关；22.5 ~ 23.3 需要 --experimental-sqlite
FLAG=""
if ! node -e "const [a,b]=process.versions.node.split('.').map(Number); process.exit((a>23||(a===23&&b>=4))?0:1)"; then
  FLAG="--experimental-sqlite"
  echo "提示：当前 Node 版本较旧，将使用 --experimental-sqlite 启动（建议升级到 Node 24 LTS）"
fi

PORT="${PORT:-3213}"
echo "思而行已启动，请在浏览器打开：http://localhost:${PORT}"
echo "使用期间请保持此终端窗口开启（按 Ctrl+C 可停止）"
echo
exec node --no-warnings $FLAG server/server.js
