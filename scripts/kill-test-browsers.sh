#!/usr/bin/env bash
# 一键清掉「AI 测试泄漏的无头浏览器」。
#
# 为什么需要它（真实事故）：AI 测试脚本普遍这么写 ——
#     spawn('microsoft-edge', ['--headless=new', ...], { stdio: 'ignore' });
#     ... 跑完 process.exit(0);
# 浏览器是**别起的、还断了父子关系**，脚本一退出它就没了爹、被 systemd 收养，
# 然后一直活着。而且 `--headless=new --disable-gpu` 会留一个 gpu-process **空转 ~86% CPU**。
# 实测：一天下来攒了 21 个实例 / 80 个进程 / 903% CPU / 13GB 内存，机器负载飙到 24。
#
# 用法：
#   bash scripts/kill-test-browsers.sh            # 只清「孤儿」（父进程已死）—— 安全，不会打断正在跑的测试
#   bash scripts/kill-test-browsers.sh --all      # 连正在跑的测试的浏览器一起清
#   bash scripts/kill-test-browsers.sh --dry      # 只列出来，不动手
#   bash scripts/kill-test-browsers.sh --servers  # 顺带停掉沙箱里的残留测试服务（端口不是 3211/3212/3213 的）
#
# ⚠️ 只认「带 --headless 的浏览器进程」。你自己平时用的 Edge/Chrome **不会**被碰。

set -u

MODE_ALL=0; DRY=0; SERVERS=0
for a in "$@"; do
  case "$a" in
    --all) MODE_ALL=1 ;;
    --dry|-n) DRY=1 ;;
    --servers) SERVERS=1 ;;
    -h|--help) sed -n '2,20p' "$0"; exit 0 ;;
    *) echo "未知参数：$a（用 --help 看用法）"; exit 2 ;;
  esac
done

# 进程被 systemd 收养 = 起它的脚本已经没了 = 纯泄漏
is_orphan() {
  local pp="$1"
  [ -z "$pp" ] && return 1
  [ "$pp" = "1" ] && return 0
  [ "$(ps -o comm= -p "$pp" 2>/dev/null | tr -d ' \n')" = "systemd" ] && return 0
  return 1
}

# 只取「主进程」（不带 --type= 的那些才是浏览器本体；杀掉它，子进程会跟着走）
list_mains() {
  ps -eo pid=,ppid=,etime=,pcpu=,args= 2>/dev/null \
    | grep -E '(msedge|chromium|chrome)' \
    | grep -- '--headless' \
    | grep -v -- '--type=' \
    | grep -v 'grep' || true
}

show() { # pid ppid etime pcpu args
  local pid="$1" pp="$2" et="$3" cpu="$4"; shift 4
  local prof; prof=$(printf '%s' "$*" | grep -oE 'user-data-dir=[^ ]+' | head -1)
  local tag="  "; is_orphan "$pp" && tag="孤儿"
  printf '  [%s] pid=%-8s 跑了%-10s cpu=%-6s %s\n' "$tag" "$pid" "$et" "$cpu" "${prof:-（默认 profile）}"
}

echo '════ 扫描无头浏览器（只认 --headless，不碰你平时的浏览器）════'
COUNT=0; ORPH=0; LIVE=0
PIDS=""
while read -r pid ppid etime pcpu rest; do
  [ -z "${pid:-}" ] && continue
  # rest 是 args 的其余部分（含空格）——重新从 ps 取一次完整命令行，避免被 read 拆散
  args=$(ps -o args= -p "$pid" 2>/dev/null)
  show "$pid" "$ppid" "$etime" "$pcpu" "$args"
  COUNT=$((COUNT+1))
  if is_orphan "$ppid"; then ORPH=$((ORPH+1)); PIDS="$PIDS $pid"; else LIVE=$((LIVE+1)); [ "$MODE_ALL" = "1" ] && PIDS="$PIDS $pid"; fi
done < <(list_mains)

if [ "$COUNT" = "0" ]; then echo '  （没有无头浏览器在跑，很干净）'; else
  echo "  合计 $COUNT 个实例：孤儿 $ORPH · 还在跑 $LIVE"
  [ "$MODE_ALL" != "1" ] && [ "$LIVE" != "0" ] && echo "  （$LIVE 个还在跑的这次不动；要一起清加 --all）"
fi

if [ "$DRY" = "1" ]; then echo; echo '（--dry：只看不杀）'; exit 0; fi

if [ -n "${PIDS// /}" ]; then
  echo
  echo '════ 清理 ════'
  K=0
  for p in $PIDS; do kill -9 "$p" 2>/dev/null && K=$((K+1)); done
  echo "  已终止 $K 个浏览器实例"
  sleep 2
  # 第二遍：主进程死后，偶尔还有子进程活着且已变成孤儿 —— 一并收掉
  LEFTOVER=""
  while read -r pid ppid rest; do
    [ -z "${pid:-}" ] && continue
    is_orphan "$ppid" && LEFTOVER="$LEFTOVER $pid"
  done < <(ps -eo pid=,ppid=,args= 2>/dev/null | grep -- '--headless' | grep -v 'grep' | awk '{print $1, $2}')
  if [ -n "${LEFTOVER// /}" ]; then
    L=0; for p in $LEFTOVER; do kill -9 "$p" 2>/dev/null && L=$((L+1)); done
    [ "$L" != "0" ] && echo "  另收掉 $L 个残留子进程"
  fi
else
  echo; echo '  没有需要清理的目标。'
fi

if [ "$SERVERS" = "1" ]; then
  echo
  echo '════ 残留的测试服务（跳过思而行本体 3211/3212/3213）════'
  S=0
  while read -r pid rest; do
    [ -z "${pid:-}" ] && continue
    cmd=$(ps -o args= -p "$pid" 2>/dev/null)
    cwd=$(readlink "/proc/$pid/cwd" 2>/dev/null || echo '')
    port=$(ss -ltnp 2>/dev/null | grep "pid=$pid," | grep -oE ':[0-9]+' | head -1 | tr -d ':')
    # 只动「从临时沙箱目录启动的」测试实例
    case "$cwd" in /tmp/*|/var/tmp/*) ;; *) continue ;; esac
    echo "  停 pid=$pid 端口=${port:-?}（$cwd）"
    kill -9 "$pid" 2>/dev/null && S=$((S+1))
  done < <(pgrep -f 'server/server\.js' 2>/dev/null | awk '{print $1}')
  [ "$S" = "0" ] && echo '  （没有临时沙箱里跑着的测试服务）'
fi

echo
echo '════ 现在的负载 ════'
uptime
echo
echo '提示：load average 是 1/5/15 分钟的滑动平均，清完要等几分钟才会落到底。'
