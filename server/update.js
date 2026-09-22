'use strict';
/**
 * 更新检查与一键更新（基于 git）
 *
 *   · 启动后自动检测远端仓库是否有新提交（异步、不阻塞启动、失败不打扰）
 *   · 前端拿到状态后弹出提示，用户可选择「立即更新 / 稍后 / 跳过此版本」
 *   · 更新用 git pull --ff-only；本地有改动会先自动 stash，失败会明确告知原因
 *   · 更新完成后由前端调用 restart() 自动拉起新进程（旧进程退出）
 *
 * 只有 git clone 安装的副本才支持自动更新；zip 解压安装会返回 supported:false。
 */
const { execFile, spawn } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const CHECK_TTL = 10 * 60 * 1000; // 10 分钟内不重复联网检测

module.exports = function createUpdate({ appDir, port = 3213, log = () => {} }) {
  const state = {
    supported: null,     // null=未检测 / true=git 安装 / false=不支持自动更新
    reason: '',          // not-git | fetch-failed | ''
    error: '',           // 失败详情（给用户看的一句话）
    branch: '',
    current: '', currentShort: '', currentSubject: '', currentDate: '',
    latest: '', latestShort: '', latestSubject: '', latestDate: '',
    behind: 0,           // 落后远端几个提交
    ahead: 0,            // 本地领先几个提交（有本地提交时不能快进合并）
    dirty: 0,            // 本地改动的文件数
    commits: [],         // 落后的提交列表（最多 10 条）
    checkedAt: 0,
    checking: false
  };

  function git(args, timeout = 60000) {
    return new Promise(resolve => {
      execFile('git', args, {
        cwd: appDir,
        timeout,
        windowsHide: true,
        maxBuffer: 4 * 1024 * 1024,
        env: Object.assign({}, process.env, {
          GIT_TERMINAL_PROMPT: '0',   // 不弹交互式账号密码，失败就失败
          GIT_ASKPASS: process.platform === 'win32' ? 'echo' : '/bin/echo'
        })
      }, (err, stdout, stderr) => {
        resolve({
          ok: !err,
          stdout: String(stdout || ''),
          stderr: String(stderr || ''),
          error: err ? (err.killed ? '超时' : (err.message || '')) : ''
        });
      });
    });
  }

  /** 仓库里是否存在未解决的合并冲突 */
  async function conflictFiles() {
    const r = await git(['diff', '--name-only', '--diff-filter=U'], 15000);
    return (r.stdout || '').trim().split('\n').filter(Boolean);
  }

  function firstLine(s) {
    return String(s || '').trim().split('\n').filter(Boolean).pop() || '';
  }

  function parseLogLine(line) {
    const [hash, subject, date] = String(line).split('|');
    return { hash: (hash || '').trim(), subject: (subject || '').trim(), date: (date || '').trim() };
  }

  async function check(force = false) {
    if (state.checking) return state;
    if (!force && state.checkedAt && Date.now() - state.checkedAt < CHECK_TTL) return state;
    state.checking = true;
    try {
      state.error = '';
      state.reason = '';
      if (!fs.existsSync(path.join(appDir, '.git'))) {
        state.supported = false;
        state.reason = 'not-git';
        state.checkedAt = Date.now();
        return state;
      }
      state.supported = true;

      const br = await git(['rev-parse', '--abbrev-ref', 'HEAD'], 15000);
      state.branch = (br.stdout || '').trim() || 'main';
      if (state.branch === 'HEAD') state.branch = 'main'; // detached HEAD 兜底

      const cur = await git(['log', '-1', '--format=%H%n%h%n%s%n%ci'], 15000);
      const curLines = (cur.stdout || '').trim().split('\n');
      state.current = curLines[0] || '';
      state.currentShort = curLines[1] || '';
      state.currentSubject = curLines[2] || '';
      state.currentDate = curLines[3] || '';

      const fetched = await git(['fetch', '--prune', 'origin', state.branch], 90000);
      if (!fetched.ok) {
        state.reason = 'fetch-failed';
        state.error = firstLine(fetched.stderr) || firstLine(fetched.stdout) || fetched.error || '无法连接远端仓库';
        state.checkedAt = Date.now();
        return state;
      }

      const rem = await git(['log', '-1', '--format=%H%n%h%n%s%n%ci', 'origin/' + state.branch], 15000);
      const remLines = (rem.stdout || '').trim().split('\n');
      state.latest = remLines[0] || '';
      state.latestShort = remLines[1] || '';
      state.latestSubject = remLines[2] || '';
      state.latestDate = remLines[3] || '';

      const cnt = await git(['rev-list', '--count', 'HEAD..origin/' + state.branch], 15000);
      state.behind = parseInt((cnt.stdout || '0').trim(), 10) || 0;
      const cnt2 = await git(['rev-list', '--count', 'origin/' + state.branch + '..HEAD'], 15000);
      state.ahead = parseInt((cnt2.stdout || '0').trim(), 10) || 0;

      if (state.behind) {
        const list = await git(['log', '--format=%h|%s|%ci', '--max-count=10', 'HEAD..origin/' + state.branch], 15000);
        state.commits = (list.stdout || '').trim().split('\n').filter(Boolean).map(parseLogLine);
      } else {
        state.commits = [];
      }

      const st = await git(['status', '--porcelain'], 15000);
      const changed = (st.stdout || '').trim();
      state.dirty = changed ? changed.split('\n').filter(Boolean).length : 0;

      state.checkedAt = Date.now();
      log(`[update] 检查完成：落后 ${state.behind} 个提交${state.ahead ? `，本地领先 ${state.ahead} 个` : ''}${state.dirty ? `，本地有 ${state.dirty} 个改动文件` : ''}`);
      return state;
    } catch (e) {
      state.error = e.message;
      state.checkedAt = Date.now();
      return state;
    } finally {
      state.checking = false;
    }
  }

  async function apply() {
    await check(true);
    if (!state.supported) {
      throw new Error(state.reason === 'not-git'
        ? '当前不是 git 安装（可能是解压安装包），无法自动更新。可以重新用 git clone 安装后继续使用，数据不会丢。'
        : '暂时无法检查更新：' + (state.error || '网络或权限问题'));
    }
    if (state.ahead) {
      throw new Error('本地有 ' + state.ahead + ' 个未推送的提交，自动更新可能冲突。请先在项目目录执行 git pull --rebase 处理。');
    }
    if (!state.behind) return { ok: true, updated: false, message: '已经是最新版本', state };

    const conflicts = await conflictFiles();
    if (conflicts.length) {
      throw new Error('项目里有 ' + conflicts.length + ' 个文件存在未解决的冲突（如 ' + conflicts[0] + '），请先在项目目录执行 git status 处理后再更新。');
    }

    const before = state.currentShort;
    let stashed = false;
    if (state.dirty) {
      const st = await git(['stash', 'push', '-m', 'sierxing-auto-update-' + Date.now()], 30000);
      stashed = st.ok && !/No local changes/i.test(st.stdout);
      if (!stashed && st.ok === false) {
        throw new Error('本地改动无法自动暂存：' + (firstLine(st.stderr) || firstLine(st.stdout) || '请先在项目目录执行 git stash 处理'));
      }
      if (stashed) log('[update] 本地改动已暂存：' + firstLine(st.stdout));
    }

    const pull = await git(['pull', '--ff-only', 'origin', state.branch], 180000);
    if (!pull.ok) {
      if (stashed) await git(['stash', 'pop'], 30000);
      throw new Error('更新失败：' + (firstLine(pull.stderr) || firstLine(pull.stdout) || pull.error || 'git pull 未成功'));
    }

    let warning = '';
    if (stashed) {
      const pop = await git(['stash', 'pop'], 60000);
      if (!pop.ok) warning = '你的本地改动与新版有冲突，已安全保留在 git stash（在项目目录执行 git stash list 可查看、git stash pop 可恢复）';
    }

    const pulled = state.behind;
    await check(true);
    log(`[update] 已更新：${before} → ${state.currentShort}（${pulled} 个提交）${warning ? '（' + warning + '）' : ''}`);
    return { ok: true, updated: true, before, after: state.currentShort, commits: pulled, warning, restartRequired: true, state };
  }

  /** 重新拉起应用：先起一个延时启动的新进程，再让当前进程退出 */
  function restart() {
    const logFile = path.join(appDir, 'data', 'server.log');
    try { fs.mkdirSync(path.dirname(logFile), { recursive: true }); } catch (e) {}
    const entry = path.join(appDir, 'server', 'server.js');
    const args = process.execArgv.filter(a => !/^--eval$|^-e$/.test(a)).concat([entry]);
    const code = `
      const { spawn } = require('node:child_process');
      const fs = require('node:fs');
      setTimeout(() => {
        let out = 'ignore';
        try { out = fs.openSync(${JSON.stringify(logFile)}, 'a'); } catch (e) {}
        const p = spawn(process.execPath, ${JSON.stringify(args)}, {
          cwd: ${JSON.stringify(appDir)}, detached: true, stdio: ['ignore', out, out], windowsHide: true
        });
        p.unref();
      }, 1600);
    `;
    try {
      spawn(process.execPath, ['-e', code], { cwd: appDir, detached: true, stdio: 'ignore', windowsHide: true }).unref();
    } catch (e) {
      return { ok: false, error: '自动重启失败：' + e.message + '（请手动关闭后重新启动）' };
    }
    log('[update] 正在重启应用…');
    setTimeout(() => process.exit(0), 500);
    return { ok: true, restarting: true, port };
  }

  /** 启动后自动检测一次（延迟几秒，别和启动抢时间） */
  function startAutoCheck(delay = 5000) {
    setTimeout(() => { check().catch(() => {}); }, delay);
  }

  return { check, apply, restart, startAutoCheck, state };
};
