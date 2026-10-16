'use strict';
/**
 * 思而行 · GUI 环境补齐（Linux）
 * ------------------------------------------------------------------
 * 应用常以「开机自启」的身份运行：Linux 上就是 service.js 写的那个 systemd
 * 用户服务。**这类进程不在桌面会话里**，环境变量里根本没有 DISPLAY /
 * XAUTHORITY / WAYLAND_DISPLAY，于是从它里面 spawn VSCode 这类 GUI 程序时，
 * Electron 只来得及打印
 *     Missing X server or $DISPLAY
 *     The platform failed to initialize.  Exiting.
 * 就自我了断（exit code 133）；更坑的是 VSCode 的 `code` 命令是「fork 出主
 * 进程、自己立刻 exit 0」的写法，所以上层拿到 0、误判成「已经打开」。
 * 真实表现就是：点「💻 写代码」→ 提示「已在 VSCode 打开」→ 窗口永远不出现。
 * （2026-10-16 定位到，见 AGENTS.md 的坑清单。）
 *
 * 这里只在显示变量缺失时补一份（已有的值一概不动）：
 *   · X11 —— 扫 /tmp/.X11-unix 的 socket，优先本用户会话、其次最新的那个；
 *   · Wayland —— 扫 $XDG_RUNTIME_DIR/wayland-*；
 *   · XAUTHORITY —— 几个常见位置里挑 mtime 最新的（登录时刚写过的那份）。
 * 一个都找不到就原样返回，由调用方决定怎么如实提示，别假装成功。
 */
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

/* /tmp/.X11-unix/X1 → ':1'。优先本用户的 socket（别的用户/残留的 X 会话连不上），
   多个都是自己的时候取最新的那个（刚登录的会话 mtime 最新） */
function xDisplay(uid) {
  let names = [];
  try {
    names = fs.readdirSync('/tmp/.X11-unix').filter(n => /^X\d+$/.test(n));
  } catch (e) { return ''; }
  let best = null;
  for (const n of names) {
    let st = null;
    try { st = fs.statSync(path.join('/tmp/.X11-unix', n)); } catch (e) { continue; }
    const mine = uid == null || st.uid === uid;
    const score = (mine ? 1e15 : 0) + (st.mtimeMs || 0);
    if (!best || score > best.score) best = { score, display: ':' + n.slice(1) };
  }
  return best ? best.display : '';
}

/* 桌面会话的 xauth 文件位置各家不同：gdm 写 /run/user/<uid>/gdm/Xauthority，
   别的发行版写 /run/user/<uid>/Xauthority 或家目录。用 mtime 挑最新的那份 ——
   登录时会刚写过它，而家目录里可能躺着上个月（甚至换机前）的旧文件 */
function xauthFile(env, uid) {
  const runtime = env.XDG_RUNTIME_DIR || (uid != null ? '/run/user/' + uid : '');
  const cands = [];
  if (env.XAUTHORITY) cands.push(env.XAUTHORITY);
  if (runtime) cands.push(path.join(runtime, 'gdm', 'Xauthority'), path.join(runtime, 'Xauthority'));
  try { cands.push(path.join(os.homedir(), '.Xauthority')); } catch (e) {}
  let best = null;
  for (const c of cands) {
    let st = null;
    try { st = fs.statSync(c); } catch (e) { continue; }
    if (!st.isFile()) continue;
    if (!best || (st.mtimeMs || 0) > best.mtimeMs) best = { mtimeMs: st.mtimeMs || 0, file: c };
  }
  return best ? best.file : '';
}

function waylandDisplay(env, uid) {
  const runtime = env.XDG_RUNTIME_DIR || (uid != null ? '/run/user/' + uid : '');
  if (!runtime) return '';
  try {
    const socks = fs.readdirSync(runtime).filter(n => /^wayland-\d+$/.test(n)).sort();
    return socks.length ? socks[socks.length - 1] : '';
  } catch (e) { return ''; }
}

/* 给 spawn 用的环境变量副本：Windows / macOS 原样返回（那两家不需要这个），
   Linux 上本来就是从桌面会话起的也原样返回 */
function guiEnv(base) {
  const env = { ...(base || process.env) };
  if (process.platform !== 'linux') return env;
  if (env.DISPLAY || env.WAYLAND_DISPLAY) return env;
  const uid = typeof process.getuid === 'function' ? process.getuid() : null;
  try {
    const wd = waylandDisplay(env, uid);
    if (wd) env.WAYLAND_DISPLAY = wd;
    const xd = xDisplay(uid);
    if (xd) {
      env.DISPLAY = xd;
      const auth = xauthFile(env, uid);
      if (auth) env.XAUTHORITY = auth;   // 挑不到就别写空值：空 XAUTHORITY 会让 Xlib 直接认证失败
    }
  } catch (e) { /* 探测失败就当没探测，绝不因此打断启动 */ }
  return env;
}

/* 这份环境到底有没有「能出窗口」的显示目标（给提示用，别用它做唯一判据：
   已经有实例在跑时，VSCode 的 CLI 靠 IPC 也能把窗口叫出来） */
function hasDisplay(env) {
  const e = env || process.env;
  return !!(e.DISPLAY || e.WAYLAND_DISPLAY);
}

module.exports = { guiEnv, hasDisplay, xDisplay, xauthFile, waylandDisplay };
