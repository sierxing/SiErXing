/**
 * 思而行 · 扩展组件：番茄钟
 * ------------------------------------------------------------------
 * 学一段时间、休息一下：可分别设置专注时长与休息时长，手动开始 / 暂停 /
 * 结束（不自动循环）；时间到时应用内弹窗 + 系统通知 + 提示音 + 标题闪烁，
 * 切到别的页面、甚至别的标签页（刷视频）也能收到提醒。
 *
 * 计时逻辑全在前端（localStorage 持久化）。本文件除了声明元数据，还提供
 * 一个 OS 级查询：当前前台窗口的标题 / 应用名。
 * 用途见文件末尾「为什么需要这个接口」。
 */
'use strict';

const PLATFORM = process.platform;

/* ---------- 当前前台窗口 ---------- */
let winCache = { at: 0, val: null };

function runCapture(cmd, args, timeoutMs) {
  return new Promise(resolve => {
    let done = false, out = '', err = '';
    const finish = v => { if (!done) { done = true; resolve(v); } };
    let child;
    try {
      const { spawn } = require('node:child_process');
      child = spawn(cmd, args, { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
    } catch (e) { return finish({ ok: false, out: '', err: String(e && e.message || e) }); }
    const t = setTimeout(() => { try { child.kill(); } catch (e) {} finish({ ok: false, out: '', err: 'timeout' }); }, timeoutMs);
    child.stdout.on('data', d => { if (out.length < 800) out += d; });
    child.stderr.on('data', d => { if (err.length < 400) err += d; });
    child.on('error', e => { clearTimeout(t); finish({ ok: false, out: '', err: String(e && e.message || e) }); });
    child.on('close', () => { clearTimeout(t); finish({ ok: true, out: String(out).trim(), err: String(err).trim() }); });
  });
}

/* 逐个平台拿「前台窗口标题」。拿不到就 ok:false，前端会退回到旧行为。 */
async function captureActiveWindow() {
  if (PLATFORM === 'darwin') {
    // 前台应用的**窗口标题**（Chrome/Edge 窗口标题里含当前页面标题，用得上）
    const r = await runCapture('osascript', ['-e',
      'tell application "System Events" to tell (first application process whose frontmost is true) to get name of front window'
    ], 3000);
    if (r.ok && r.out) {
      const app = await runCapture('osascript', ['-e',
        'tell application "System Events" to get name of first application process whose frontmost is true'
      ], 3000);
      return { ok: true, title: r.out.slice(0, 300), app: app.ok ? app.out.slice(0, 120) : '', source: 'osascript' };
    }
    return { ok: false, title: '', app: '', source: 'osascript', err: r.err || 'empty' };
  }
  if (PLATFORM === 'win32') {
    const ps = [
      "$ErrorActionPreference='Stop';",
      "Add-Type -Namespace SXW -Name U -MemberDefinition @(",
      "'[DllImport(\"user32.dll\")] public static extern IntPtr GetForegroundWindow();',",
      "'[DllImport(\"user32.dll\")] public static extern int GetWindowText(IntPtr h, System.Text.UTF8StringBuilder b, int n);',",
      "'[DllImport(\"user32.dll\")] public static extern int GetWindowThreadProcessId(IntPtr h, out int p);')",
      ");",
      "$h=[SXW.U]::GetForegroundWindow();",
      "$b=New-Object System.Text.UTF8StringBuilder 512;",
      "[void][SXW.U]::GetWindowText($h,$b,512);",
      "$pid2=0; [void][SXW.U]::GetWindowThreadProcessId($h,[ref]$pid2);",
      "$pn=(Get-Process -Id $pid2 -ErrorAction SilentlyContinue).ProcessName;",
      "Write-Output ($b.ToString()); Write-Output ('--PN--'+$pn)",
    ].join(' ');
    const r = await runCapture('powershell', ['-NoProfile', '-NonInteractive', '-Command', ps], 6000);
    if (r.ok && r.out) {
      const [title, appRaw] = r.out.split('\n--PN--');
      return {
        ok: true,
        title: String(title || '').trim().slice(0, 300),
        app: String(appRaw || '').trim().slice(0, 120),
        source: 'powershell',
      };
    }
    return { ok: false, title: '', app: '', source: 'powershell', err: r.err || 'empty' };
  }
  // Linux / BSD：X11 走 xdotool；Wayland 下通常拿不到，前端会退回旧行为
  let title = await runCapture('xdotool', ['getactivewindow', 'getwindowname'], 3000);
  if (!title.ok || !title.out) {
    // 退化方案：wmctrl -l 的第一行（N/A 行除外）
    const alt = await runCapture('wmctrl', ['-l'], 3000);
    if (alt.ok && alt.out) {
      const line = alt.out.split('\n').map(x => x.trim()).filter(Boolean).pop() || '';
      const parts = line.split(/\s+/);
      const t = parts.slice(3).join(' ').trim();
      if (t && t !== 'N/A') return { ok: true, title: t.slice(0, 300), app: '', source: 'wmctrl' };
    }
    return { ok: false, title: '', app: '', source: 'xdotool', err: (title.err || '') + (alt.err || '') };
  }
  let app = '';
  try {
    const pidr = await runCapture('xdotool', ['getactivewindow', 'getwindowpid'], 2500);
    if (pidr.ok && /^\d+$/.test(pidr.out)) {
      const fs = require('node:fs');
      app = String(fs.readFileSync('/proc/' + pidr.out + '/comm', 'utf8') || '').trim().slice(0, 120);
    }
  } catch (e) {}
  return { ok: true, title: title.out.slice(0, 300), app, source: 'xdotool' };
}

function activeWindow(maxAgeMs) {
  const now = Date.now();
  if (winCache.val && (now - winCache.at) < (maxAgeMs || 1200)) return winCache.val;
  return captureActiveWindow().then(v => {
    winCache = { at: Date.now(), val: v };
    return v;
  }).catch(e => {
    const v = { ok: false, title: '', app: '', source: PLATFORM, err: String(e && e.message || e) };
    winCache = { at: Date.now(), val: v };
    return v;
  });
}

module.exports = {
  id: 'pomodoro',
  name: '番茄钟',
  icon: '🍅',
  category: '其它',
  desc: '专注 / 休息计时：时长可设，手动开始与结束（不自动循环）；时间到应用内弹窗 + 系统通知 + 提示音，切页面、切标签页也能收到',
  order: 43,
  version: '1.1.0',
  author: '思而行内置',
  goalToggle: false,          // 非按目标启用：应用级开关
  defaultEnabled: true,
  client: '/plugins/pomodoro.js',
  /* 平台能力探测：前端设置面板据此提示"能不能检测" */
  api: [
    {
      method: 'GET',
      path: '/api/pomodoro/activewin',
      handler: async (req, res, u, ctx) => {
        if (req.method !== 'GET') return false;
        const maxAge = Math.max(0, Math.min(5000, Number(u.searchParams.get('maxAge')) || 1200));
        const v = await activeWindow(maxAge);
        ctx.sendJSON(res, 200, Object.assign({ platform: PLATFORM }, v));
        return true;
      },
    },
    {
      method: 'GET',
      path: '/api/pomodoro/winprobe',
      handler: async (req, res, u, ctx) => {
        if (req.method !== 'GET') return false;
        const v = await activeWindow(0);
        ctx.sendJSON(res, 200, { platform: PLATFORM, ok: !!v.ok, source: v.source || '', title: v.title || '', app: v.app || '' });
        return true;
      },
    },
  ],
};

/* ============================================================================
 * 为什么需要这个接口（别删）
 * ---------------------------------------------------------------------------
 * 「切走页面时只在特定网站才算休息」这个需求，**网页自己是查不到别的窗口的网址的**：
 *   - 浏览器标签之间的 DOM 互相隔离，读不到另一个标签页的 URL；
 *   - 更不用说另一个应用；
 *   - 而且浏览器就是**故意**不给 web 页面这个能力的。
 * 所以唯一可行的办法是让本机的 Node 进程去问操作系统"现在前台窗口叫什么"。
 * 前端拿到的是**窗口标题**而不是网址 —— 对浏览器来说两者差别很大：
 *   Edge/Chrome 的窗口标题形如
 *     「视频标题 和另外 1 个页面 - 个人 - Microsoft Edge」
 *   里面**没有网址**，但 bilibili 的页面 <title> 通常是
 *     「……_哔哩哔哩_bilibili」
 *   所以拿关键词（默认 bilibili）去匹配窗口标题是可用的。
 *   如果某个网站标题里既没有品牌名也没有域名，那它就匹配不上 —— 这是能力边界，
 *   前端会明确告诉用户，而不是假装检测到了。
 * 各平台实现：macOS 用 osascript 问 System Events；Windows 用 PowerShell 调
 * user32 的 GetForegroundWindow；Linux 用 xdotool（拿不到时退化 wmctrl）。
 * Wayland 下这些通常拿不到（Wayland 有意不暴露前台窗口），此时接口返回 ok:false，
 * 前端退回"切走就算休息"的旧行为，不会把功能弄坏。
 * ========================================================================== */