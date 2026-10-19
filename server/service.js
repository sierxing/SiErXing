'use strict';
/**
 * 思而行 · 服务与启动管理（跨平台）
 * ------------------------------------------------------------------
 * 能力：
 *   · 一键创建「启动命令」（终端可用）与「桌面图标」（双击即用）
 *   · 开机自启：Linux 用 systemd --user（无则退回 XDG autostart）；
 *               Windows 用启动文件夹快捷方式；macOS 用 LaunchAgent
 *   · 状态查询：是否已装、用的哪种机制、给出提示
 *
 * 说明：所有操作只写入当前用户目录，不修改系统级配置，不需要管理员权限。
 */

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
/* 开机自启是 systemd 用户服务：这个进程不在桌面会话里，喊浏览器/文件管理器前要补显示环境 */
const { guiEnv } = require('./gui-env');

const APP_LABEL = '思而行';
const UNIT_NAME = 'sierxing.service';
const LAUNCH_AGENT_ID = 'com.sierxing.app';

function sh(cmd, args, timeout = 15000) {
  return new Promise(resolve => {
    let out = '', err = '';
    let child;
    try {
      child = spawn(cmd, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    } catch (e) { return resolve({ ok: false, out: '', err: String(e.message) }); }
    const timer = setTimeout(() => { try { child.kill('SIGKILL'); } catch (e) {} resolve({ ok: false, out, err: 'timeout' }); }, timeout);
    child.stdout.on('data', d => { out += d; });
    child.stderr.on('data', d => { err += d; });
    child.on('error', e => { clearTimeout(timer); resolve({ ok: false, out, err: String(e.message) }); });
    child.on('close', code => { clearTimeout(timer); resolve({ ok: code === 0, out: out.trim(), err: err.trim(), code }); });
  });
}

module.exports = function createService({ appDir, port, log = () => {} }) {
  const home = os.homedir();
  const platform = process.platform;

  function needsSqliteFlag() {
    const [maj, min] = String(process.versions.node).split('.').map(Number);
    return !(maj > 23 || (maj === 23 && min >= 4));
  }
  const nodeFlags = ['--no-warnings'].concat(needsSqliteFlag() ? ['--experimental-sqlite'] : []);
  const serverScript = path.join(appDir, 'server', 'server.js');
  const url = 'http://localhost:' + port;

  /* ---------------- 路径 ---------------- */
  const paths = (() => {
    if (platform === 'win32') {
      const appData = process.env.APPDATA || path.join(home, 'AppData', 'Roaming');
      const localAppData = process.env.LOCALAPPDATA || path.join(home, 'AppData', 'Local');
      return {
        binDir: path.join(localAppData, 'SiErXing'),
        launcher: path.join(localAppData, 'SiErXing', 'sierxing.cmd'),
        desktop: path.join(home, 'Desktop', APP_LABEL + '.lnk'),
        startMenu: path.join(appData, 'Microsoft', 'Windows', 'Start Menu', 'Programs', APP_LABEL + '.lnk'),
        autostart: path.join(appData, 'Microsoft', 'Windows', 'Start Menu', 'Programs', 'Startup', APP_LABEL + '.lnk')
      };
    }
    const desktopDir = fs.existsSync(path.join(home, 'Desktop')) ? path.join(home, 'Desktop') : path.join(home, '桌面');
    if (platform === 'darwin') {
      return {
        binDir: path.join(home, '.local', 'bin'),
        launcher: path.join(home, '.local', 'bin', 'sierxing'),
        desktop: path.join(desktopDir, APP_LABEL + '.command'),
        applications: path.join(home, 'Applications', APP_LABEL + '.app'),
        autostart: path.join(home, 'Library', 'LaunchAgents', LAUNCH_AGENT_ID + '.plist')
      };
    }
    return {
      binDir: path.join(home, '.local', 'bin'),
      launcher: path.join(home, '.local', 'bin', 'sierxing'),
      desktop: path.join(desktopDir, APP_LABEL + '.desktop'),
      applications: path.join(home, '.local', 'share', 'applications', 'sierxing.desktop'),
      autostart: path.join(home, '.config', 'autostart', 'sierxing.desktop'),
      unit: path.join(home, '.config', 'systemd', 'user', UNIT_NAME)
    };
  })();

  /* ---------------- Windows 真实目录（兼容 OneDrive 桌面重定向） ---------------- */
  let winDirs = null;
  async function resolveWinDirs() {
    if (winDirs) return winDirs;
    const ps = "[Environment]::GetFolderPath('Desktop'); [Environment]::GetFolderPath('StartMenu'); [Environment]::GetFolderPath('Startup'); $env:APPDATA; $env:LOCALAPPDATA";
    const r = await sh('powershell', ['-NoProfile', '-NonInteractive', '-Command', ps], 20000);
    const lines = String(r.out || '').split(/\r?\n/).map(x => x.trim()).filter(Boolean);
    const appData = lines[3] || process.env.APPDATA || path.join(home, 'AppData', 'Roaming');
    winDirs = {
      desktop: lines[0] || path.join(home, 'Desktop'),
      startMenu: lines[1] || path.join(appData, 'Microsoft', 'Windows', 'Start Menu', 'Programs'),
      startup: lines[2] || path.join(appData, 'Microsoft', 'Windows', 'Start Menu', 'Programs', 'Startup'),
      appData,
      localAppData: lines[4] || process.env.LOCALAPPDATA || path.join(home, 'AppData', 'Local')
    };
    return winDirs;
  }
  /** Windows 下取真实路径；其它平台直接用静态 paths */
  async function pth(key) {
    if (platform !== 'win32') return paths[key];
    const d = await resolveWinDirs();
    if (key === 'desktop') return path.join(d.desktop, APP_LABEL + '.lnk');
    if (key === 'startMenu') return path.join(d.startMenu, APP_LABEL + '.lnk');
    if (key === 'autostart') return path.join(d.startup, APP_LABEL + '.lnk');
    if (key === 'binDir') return path.join(d.localAppData, 'SiErXing');
    if (key === 'launcher') return path.join(d.localAppData, 'SiErXing', 'sierxing.cmd');
    return paths[key];
  }

  /* ---------------- 应用图标（与浏览器标签页图标同款） ---------------- */
  const iconSrc = {
    svg: path.join(appDir, 'public', 'icon.svg'),
    png: path.join(appDir, 'public', 'icon.png'),
    ico: path.join(appDir, 'public', 'icon.ico')
  };
  async function installLinuxIcon() {
    try {
      const dir = path.join(home, '.local', 'share', 'icons', 'hicolor', '256x256', 'apps');
      fs.mkdirSync(dir, { recursive: true });
      fs.copyFileSync(iconSrc.png, path.join(dir, 'sierxing.png'));
      // 刷新图标缓存，避免其它机器上显示旧图标/不显示
      const themeDir = path.join(home, '.local', 'share', 'icons', 'hicolor');
      await sh('gtk-update-icon-cache', ['-f', '-t', themeDir], 8000).catch(() => {});
      return 'sierxing';
    } catch (e) { return ''; }
  }

  /* ---------------- 生成启动脚本内容 ---------------- */
  function launcherContent() {
    const node = process.execPath;
    if (platform === 'win32') {
      return [
        '@echo off',
        'chcp 65001 >nul',
        `set PORT=${port}`,
        `start "" /min "${node}" ${nodeFlags.join(' ')} "${serverScript}"`,
        'timeout /t 2 >nul',
        `start "" "${url}"`
      ].join('\r\n') + '\r\n';
    }
    return [
      '#!/usr/bin/env bash',
      '# 思而行 · 启动脚本（终端命令：sierxing）',
      `PORT=${port}`,
      'export PORT',
      `URL="http://localhost:$PORT"`,
      `if command -v curl >/dev/null 2>&1 && curl -s --max-time 1 "$URL/api/health" >/dev/null 2>&1; then`,
      '  echo "思而行已在运行：$URL"',
      'else',
      `  nohup "${process.execPath}" ${nodeFlags.join(' ')} "${serverScript}" > "${path.join(home, '.sierxing.log')}" 2>&1 &`,
      '  sleep 2',
      '  echo "思而行已启动：$URL"',
      'fi',
      `if command -v xdg-open >/dev/null 2>&1; then xdg-open "$URL" >/dev/null 2>&1 &`,
      `elif command -v open >/dev/null 2>&1; then open "$URL" >/dev/null 2>&1 &`,
      'fi',
      'exit 0'
    ].join('\n') + '\n';
  }

  function desktopEntryContent(execLine, iconName) {
    return [
      '[Desktop Entry]',
      'Type=Application',
      `Name=${APP_LABEL}`,
      'Name[en]=SiErXing',
      'Comment=目标规划助手：先问卷确认，再拆成可执行路径',
      `Exec=${execLine}`,
      'Terminal=false',
      'Categories=Utility;Office;',
      'StartupNotify=false',
      `Icon=${iconName || iconSrc.png}`
    ].join('\n') + '\n';
  }

  function unitContent() {
    return [
      '[Unit]',
      `Description=${APP_LABEL} SiErXing · 目标规划助手`,
      'After=network.target',
      'StartLimitIntervalSec=0',
      '',
      '[Service]',
      'Type=simple',
      `WorkingDirectory=${appDir}`,
      `Environment=PORT=${port}`,
      `ExecStart=${process.execPath} ${nodeFlags.join(' ')} ${serverScript}`,
      'Restart=always',
      'RestartSec=3',
      '',
      '[Install]',
      'WantedBy=default.target',
      ''
    ].join('\n');
  }

  /* ---------------- 桌面图标 / 启动命令 ---------------- */
  async function installShortcuts() {
    const result = { launcher: false, desktop: false, applications: false, autostartKind: platform, notes: [] };
    try {
      if (platform === 'win32') {
        const binDir = await pth('binDir');
        const launcher = await pth('launcher');
        const desktopLnk = await pth('desktop');
        const startMenuLnk = await pth('startMenu');
        fs.mkdirSync(binDir, { recursive: true });
        fs.writeFileSync(launcher, launcherContent(), 'utf8');
        result.launcher = true;
        const q = x => String(x).replace(/"/g, '""');
        const ps = [
          '$ws = New-Object -ComObject WScript.Shell',
          `$sc = $ws.CreateShortcut("${q(desktopLnk)}")`,
          `$sc.TargetPath = "${q(launcher)}"`,
          `$sc.WorkingDirectory = "${q(binDir)}"`,
          `$sc.Description = "${APP_LABEL} · 目标规划助手"`,
          `$sc.IconLocation = "${q(iconSrc.ico)}"`,
          '$sc.WindowStyle = 7',
          '$sc.Save()',
          `$sc2 = $ws.CreateShortcut("${q(startMenuLnk)}")`,
          `$sc2.TargetPath = "${q(launcher)}"`,
          `$sc2.WorkingDirectory = "${q(binDir)}"`,
          `$sc2.IconLocation = "${q(iconSrc.ico)}"`,
          '$sc2.WindowStyle = 7',
          '$sc2.Save()'
        ].join('; ');
        const r = await sh('powershell', ['-NoProfile', '-NonInteractive', '-Command', ps], 30000);
        result.desktop = fs.existsSync(desktopLnk);
        result.applications = fs.existsSync(startMenuLnk);
        result.desktopPath = desktopLnk;
        if (!result.desktop) result.notes.push('桌面快捷方式创建失败（桌面目录：' + desktopLnk + '）：' + (r.err || '未知错误'));
        else result.notes.push('桌面快捷方式：' + desktopLnk);
      } else {
        // 启动命令
        fs.mkdirSync(paths.binDir, { recursive: true });
        fs.writeFileSync(paths.launcher, launcherContent(), { mode: 0o755 });
        fs.chmodSync(paths.launcher, 0o755);
        result.launcher = true;
        // 应用菜单 + 桌面
        const execLine = `${paths.launcher}`;
        if (platform === 'darwin') {
          fs.writeFileSync(paths.desktop, '#!/usr/bin/env bash\n' + launcherContent().replace(/^#!.*\n/, ''), { mode: 0o755 });
          fs.chmodSync(paths.desktop, 0o755);
          result.desktop = true;
          result.icon = iconSrc.png;   // macOS 可在「显示简介」里把该 PNG 拖到图标上自定义
        } else {
          const iconName = (await installLinuxIcon()) || iconSrc.png;   // 优先装到 hicolor 主题，失败则用绝对路径
          fs.mkdirSync(path.dirname(paths.applications), { recursive: true });
          fs.writeFileSync(paths.applications, desktopEntryContent(execLine, iconName), 'utf8');
          result.applications = true;
          result.icon = iconName;
          try {
            fs.writeFileSync(paths.desktop, desktopEntryContent(execLine, iconName), 'utf8');
            fs.chmodSync(paths.desktop, 0o755);
            result.desktop = true;
            await sh('gio', ['set', paths.desktop, 'metadata::trusted', 'true'], 6000);
          } catch (e) {
            result.notes.push('桌面图标写入失败（可手动从应用菜单启动）：' + e.message);
          }
        }
        const inPath = (process.env.PATH || '').split(':').includes(paths.binDir);
        if (!inPath) result.notes.push('目录 ' + paths.binDir + ' 不在 PATH 中：可执行 export PATH="$HOME/.local/bin:$PATH"，或直接双击桌面图标');
      }
    } catch (e) {
      result.notes.push(e.message);
    }
    log('[service] installShortcuts:', JSON.stringify(result));
    return result;
  }

  function appDataOr(d) { return d; }

  /* ---------------- 开机自启 ---------------- */
  const isWindows = platform === 'win32';
  const isMac = platform === 'darwin';

  async function autostartInfo() {
    if (isWindows) {
      const autoLnk = await pth('autostart');
      const enabled = fs.existsSync(autoLnk);
      return { supported: true, enabled, mechanism: 'Windows 启动文件夹快捷方式', detail: autoLnk };
    }
    if (isMac) {
      const enabled = fs.existsSync(paths.autostart);
      return { supported: true, enabled, mechanism: 'macOS LaunchAgent', detail: paths.autostart };
    }
    // Linux：优先 systemd --user（若可用），否则 XDG autostart
    const hasSystemd = (await sh('systemctl', ['--user', 'show-environment'], 6000)).ok;
    const hasUnit = fs.existsSync(paths.unit);
    const hasXdg = fs.existsSync(paths.autostart);
    if (hasSystemd) {
      const sys = await sh('systemctl', ['--user', 'is-enabled', UNIT_NAME], 6000);
      const active = await sh('systemctl', ['--user', 'is-active', UNIT_NAME], 6000);
      const linger = await sh('loginctl', ['show-user', os.userInfo().username, '-p', 'Linger', '--value'], 6000);
      return {
        supported: true,
        enabled: (sys.out || '').trim() === 'enabled',
        running: (active.out || '').trim() === 'active',
        mechanism: 'systemd 用户服务（推荐）',
        detail: paths.unit,
        hint: /yes/i.test(linger.out || '') ? '已开启 linger：未登录也会启动' : '如需「未登录也启动」：loginctl enable-linger ' + os.userInfo().username
      };
    }
    return { supported: true, enabled: hasXdg, mechanism: 'XDG 自启动（桌面登录后启动）', detail: paths.autostart };
  }

  async function setAutostart(enabled) {
    if (isWindows) {
      const autoLnk = await pth('autostart');
      if (enabled) {
        const r = await installShortcuts();
        if (!r.launcher) return { ok: false, error: '启动脚本创建失败' };
        const launcher = await pth('launcher');
        const binDir = await pth('binDir');
        const q = x => String(x).replace(/"/g, '""');
        const ps = [
          '$ws = New-Object -ComObject WScript.Shell',
          `$sc = $ws.CreateShortcut("${q(autoLnk)}")`,
          `$sc.TargetPath = "${q(launcher)}"`,
          `$sc.WorkingDirectory = "${q(binDir)}"`,
          `$sc.Description = "${APP_LABEL} 开机自启"`,
          '$sc.WindowStyle = 7',
          '$sc.Save()'
        ].join('; ');
        const res = await sh('powershell', ['-NoProfile', '-NonInteractive', '-Command', ps], 30000);
        if (!fs.existsSync(autoLnk)) return { ok: false, error: '创建开机自启项失败：' + (res.err || '未知错误') };
        return { ok: true, enabled: true };
      }
      try { fs.unlinkSync(autoLnk); } catch (e) {}
      return { ok: true, enabled: false };
    }

    if (isMac) {
      if (enabled) {
        fs.mkdirSync(path.dirname(paths.autostart), { recursive: true });
        const plist = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>Label</key><string>${LAUNCH_AGENT_ID}</string>
  <key>ProgramArguments</key><array>
    <string>${process.execPath}</string>${nodeFlags.map(f => `<string>${f}</string>`).join('')}
    <string>${serverScript}</string>
  </array>
  <key>EnvironmentVariables</key><dict><key>PORT</key><string>${port}</string></dict>
  <key>WorkingDirectory</key><string>${appDir}</string>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><false/>
</dict></plist>`;
        fs.writeFileSync(paths.autostart, plist, 'utf8');
        await sh('launchctl', ['load', paths.autostart], 10000);
        return { ok: true, enabled: true };
      }
      await sh('launchctl', ['unload', paths.autostart], 10000);
      try { fs.unlinkSync(paths.autostart); } catch (e) {}
      return { ok: true, enabled: false };
    }

    // Linux
    const hasSystemd = (await sh('systemctl', ['--user', 'show-environment'], 6000)).ok;
    if (hasSystemd) {
      if (enabled) {
        await installLinuxIcon();   // 老安装升级后也能拿到最新图标
        fs.mkdirSync(path.dirname(paths.unit), { recursive: true });
        fs.writeFileSync(paths.unit, unitContent(), 'utf8');
        await sh('systemctl', ['--user', 'daemon-reload'], 10000);
        await sh('systemctl', ['--user', 'daemon-reload'], 10000);
        const en = await sh('systemctl', ['--user', 'enable', UNIT_NAME], 15000);
        if (!en.ok) return { ok: false, error: 'systemctl 启用失败：' + (en.err || en.out || '未知错误') };
        // 清掉可能残留的 failed 状态并立即尝试启动（端口被占用时会持续重试，退出后自动接管）
        await sh('systemctl', ['--user', 'reset-failed', UNIT_NAME], 8000);
        const r = await sh('systemctl', ['--user', 'restart', UNIT_NAME], 15000);
        if (!r.ok && !/Failed to restart|not found/i.test(r.err || '')) {
          // restart 失败通常是因为端口被占用，服务仍会重试，不算致命错误
        }
        await new Promise(res => setTimeout(res, 1200));
        const active = await sh('systemctl', ['--user', 'is-active', UNIT_NAME], 6000);
        const linger = await sh('loginctl', ['show-user', os.userInfo().username, '-p', 'Linger', '--value'], 6000);
        const hints = [];
        if ((active.out || '').trim() !== 'active') hints.push('当前端口已被另一个实例占用：服务已启用，会在该实例退出后（或下次开机）自动接管');
        if (!/yes/i.test(linger.out || '')) hints.push('如需「未登录也启动」：loginctl enable-linger ' + os.userInfo().username);
        return { ok: true, enabled: true, hint: hints.join('；') };
      }
      await sh('systemctl', ['--user', 'disable', '--now', UNIT_NAME], 15000);
      try { fs.unlinkSync(paths.unit); } catch (e) {}
      await sh('systemctl', ['--user', 'daemon-reload'], 10000);
      return { ok: true, enabled: false };
    }
    // 退回 XDG autostart
    if (enabled) {
      fs.mkdirSync(path.dirname(paths.autostart), { recursive: true });
      fs.writeFileSync(paths.autostart, desktopEntryContent(paths.launcher, (await installLinuxIcon()) || iconSrc.png), 'utf8');
      return { ok: true, enabled: true, hint: '当前环境无 systemd --user，已使用 XDG 自启动（登录桌面后启动）' };
    }
    try { fs.unlinkSync(paths.autostart); } catch (e) {}
    return { ok: true, enabled: false };
  }

  /* ---------------- 状态 ---------------- */
  async function status() {
    const auto = await autostartInfo();
    const desktopFile = await pth('desktop');
    const launcherFile = await pth('launcher');
    let desktopExists = false;
    try { desktopExists = fs.existsSync(desktopFile); } catch (e) {}
    let launcherExists = false;
    try { launcherExists = fs.existsSync(launcherFile); } catch (e) {}
    return {
      platform,
      platformName: isWindows ? 'Windows' : (isMac ? 'macOS' : 'Linux'),
      port,
      url,
      appDir,
      node: process.execPath,
      nodeVersion: process.versions.node,
      startCommand: 'node ' + nodeFlags.join(' ') + ' ' + serverScript,
      launcher: { path: launcherFile, exists: launcherExists, command: 'sierxing', binDir: await pth('binDir') },
      desktop: { path: desktopFile, exists: desktopExists },
      autostart: auto
    };
  }

  function openBrowser(route) {
    let target = url;
    const r = String(route || '').trim();
    if (r) {
      if (r.length > 300 || !/^[#/]/.test(r) || /\s/.test(r)) {
        return { ok: false, error: '页面地址格式不对：应以 / 或 # 开头，且不含空白（例：#/g/12）' };
      }
      target = url.replace(/\/+$/, '') + (r.charAt(0) === '#' ? '/' + r : r);
    }
    if (process.env.NO_OPEN) return { ok: false, reason: 'NO_OPEN', url: target };
    const cmd = platform === 'win32' ? 'cmd' : (platform === 'darwin' ? 'open' : 'xdg-open');
    const args = platform === 'win32' ? ['/c', 'start', '', target] : [target];
    try {
      const child = spawn(cmd, args, { detached: true, stdio: 'ignore', env: guiEnv() });
      child.unref();
      return { ok: true, url: target };
    } catch (e) { return { ok: false, error: e.message }; }
  }

  return { status, setAutostart, installShortcuts, openBrowser, paths, nodeFlags, serverScript };
};
