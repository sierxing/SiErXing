'use strict';
/**
 * 更新检查与一键更新 —— 两种后端共用一套接口
 *
 *   mode='git'     ：git clone 安装的副本。用 git pull --ff-only，
 *                    本地有改动会先自动 stash，失败会明确告知原因。
 *   mode='payload' ：打包成单个 exe 的用户。exe 里没有 .git、node 也不带 git，
 *                    所以改用「清单 + 载荷」：只下 450KB 的程序文件换掉旧的，
 *                    node 运行时不动（重下整个 exe 要 89MB）。
 *   mode='none'    ：zip 解压安装，既没有 .git 也没有载荷标记 → 不支持。
 *
 * 两种后端都：启动后异步检测（不阻塞启动、失败不打扰）、前端提示后由用户点确认、
 * 更新完调 restart() 重新拉起（旧进程退出）。
 * SX_UPDATE=off 可完全关掉；SX_UPDATE_URL 可把清单指到自己的地址。
 */
const { execFile, spawn } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const CHECK_TTL = 10 * 60 * 1000; // 10 分钟内不重复联网检测

/* payload 模式的默认清单地址（AtomGit contents 接口，免鉴权） */
const DEFAULT_MANIFEST = 'https://atomgit.com/api/v5/repos/sierxing/SiErXing/contents/release/latest.json?ref=main';

module.exports = function createUpdate({ appDir, port = 3213, log = () => {} }) {
  const state = {
    supported: null,     // null=未检测 / true=可以自动更新 / false=不支持
    reason: '',          // not-git | fetch-failed | off | ''
    error: '',           // 失败详情（给用户看的一句话）
    mode: '',            // 'git' | 'payload' | 'none'  ← 见下面「两种更新后端」
    localVersion: '',    // 打包版的当前版本（payload 模式）
    manifest: null,      // 远端清单：{version, notes, publishedAt, size, sha256…}
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
      const m = detectMode();
      state.mode = m;
      if (m !== 'git') {
        /* 打包版没有 .git、node.exe 也不带 git —— 走 payload 后端（见文件末尾） */
        if (m === 'payload') return checkPayload();
        state.supported = false;
        state.reason = process.env.SX_UPDATE === 'off' ? 'off' : 'not-git';
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

  /* ======================================================================
   * payload 后端：给打包成单个 .exe 的用户用
   * ----------------------------------------------------------------------
   * 为什么需要它：打包版解包出来的目录里**没有 .git**，而 exe 里那个 node 运行时
   * 也**不带 git**，所以上面整套 git 逻辑对它一律 supported:false —— 永远更新不了。
   *
   * 但真的不需要 git：exe 里 99.5% 是 node 运行时，永远不变。会变的只有那 450KB 的
   * 程序文件。所以更新 = 只换这一个载荷：
   *    latest.json（几十字节，跟代码一起提交到仓库）
   *      → payload-1.2.0.sxar（约 450KB，校验 sha256 后解包，**保留 data/**）
   * 重新下整个 exe 要 89MB，换载荷只要 450KB。
   *
   * 清单与载荷都放在 AtomGit 仓库里，用它的 contents 接口取：免鉴权、返回 base64。
   * 离线/内网用户把 SX_UPDATE_URL 指向自己的地址即可（也能 SX_UPDATE=off 关掉）。
   * ====================================================================== */
  const MANIFEST_URL = process.env.SX_UPDATE_URL || DEFAULT_MANIFEST;

  /* 版本比较：a 比 b 新返回正数。认 v1.2.3 / 1.2.3 / 1.2 这种写法。 */
  function cmpVer(a, b) {
    const pa = String(a || '0').replace(/^v/i, '').split(/[.-]/).map(x => (parseInt(x, 10) || 0));
    const pb = String(b || '0').replace(/^v/i, '').split(/[.-]/).map(x => (parseInt(x, 10) || 0));
    for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
      const d = (pa[i] || 0) - (pb[i] || 0);
      if (d) return d;
    }
    return 0;
  }

  /* 三种安装形态：git clone / 打包 exe / zip 解压 */
  function detectMode() {
    if (process.env.SX_UPDATE === 'off') return 'none';
    if (fs.existsSync(path.join(appDir, '.git'))) return 'git';
    if (fs.existsSync(path.join(appDir, '.sx-current'))) return 'payload';
    return 'none';
  }
  function readCurrent() {
    try { return JSON.parse(fs.readFileSync(path.join(appDir, '.sx-current'), 'utf8')) || {}; }
    catch (e) { return {}; }
  }
  /* AtomGit contents 接口返回 { content: base64, encoding: 'base64' } */
  async function fetchViaContents(url) {
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), 20000);
    try {
      const r = await fetch(url, { signal: ac.signal, headers: { 'User-Agent': 'SiErXing-update' } });
      if (!r.ok) throw new Error('HTTP ' + r.status);
      const j = await r.json();
      if (j && j.content) return Buffer.from(j.content, 'base64');
      throw new Error('响应里没有 content 字段');
    } finally { clearTimeout(timer); }
  }
  async function fetchManifest() {
    const buf = await fetchViaContents(MANIFEST_URL);
    return JSON.parse(buf.toString('utf8'));
  }

  async function checkPayload() {
    state.mode = 'payload';
    state.supported = true;
    const cur = readCurrent();
    state.localVersion = cur.rel || '';
    state.current = state.localVersion;
    state.currentShort = state.localVersion;
    try {
      const man = await fetchManifest();
      state.manifest = man;
      state.latest = String(man.version || '');
      state.latestShort = state.latest;
      state.latestSubject = String(man.notes || '').slice(0, 200);
      state.latestDate = String(man.publishedAt || '');
      state.exeRequired = man.exeRequired === true;
      state.releasesUrl = String(man.releasesUrl || '');
      /* 语义化比较：只有远端真的更新才提示。
         反过来「本地比清单还新」（自己编译过、或清单回滚了）也绝不能提示降级。 */
      state.behind = cmpVer(state.latest, state.localVersion) > 0 ? 1 : 0;
      state.ahead = cmpVer(state.localVersion, state.latest) > 0 ? 1 : 0;
      state.commits = [];
      state.error = '';
    } catch (e) {
      state.behind = 0; state.ahead = 0;
      state.reason = 'fetch-failed';
      state.error = '连不上更新服务器：' + ((e && e.message) || e) + '（不影响使用，可稍后再试）';
    }
    state.checkedAt = Date.now();
    state.checking = false;
    return state;
  }

  function unpackPayload(buf) {
    const zlib = require('node:zlib');
    const raw = zlib.gunzipSync(buf);
    if (raw.slice(0, 4).toString('ascii') !== 'SXA1') throw new Error('更新包已损坏');
    const hl = raw.readUInt32LE(4);
    const head = JSON.parse(raw.slice(8, 8 + hl).toString('utf8'));
    let off = 8 + hl;
    let n = 0;
    for (const f of head.files) {
      const out = path.join(appDir, f.p);
      if (f.p.startsWith('data/')) { off += f.size; continue; }   // 用户数据绝不被覆盖
      fs.mkdirSync(path.dirname(out), { recursive: true });
      fs.writeFileSync(out, raw.slice(off, off + f.size));
      off += f.size; n++;
    }
    return { head, written: n };
  }

  async function applyPayload() {
    state.mode = 'payload';
    const before = readCurrent();
    const man = await fetchManifest();
    if (!man || !man.payload || !man.sha256) throw new Error('更新清单不完整');
    log('[update] 下载载荷 ' + man.payload + ' …');
    const buf = await fetchViaContents(man.url);
    const crypto = require('node:crypto');
    const got = crypto.createHash('sha256').update(buf).digest('hex');
    if (got !== man.sha256) throw new Error('更新包校验失败（sha256 不匹配），已放弃本次更新');
    const { head, written } = unpackPayload(buf);
    /* 载荷自称的版本要和清单一致，否则说明发布时搞混了，不能写标记 */
    if (head.rel && man.version && head.rel !== man.version) {
      throw new Error('更新包版本（' + head.rel + '）与清单（' + man.version + '）不一致，已放弃');
    }
    /* 只在真正落盘成功后才写标记 → 中途失败下次启动会重新解内嵌载荷，不会半残 */
    fs.writeFileSync(path.join(appDir, '.sx-current'),
      JSON.stringify({ rel: head.rel || man.version, ver: head.ver || '' }));
    state.localVersion = head.rel || man.version;
    state.checkedAt = 0;
    log(`[update] 已更新 ${before.rel || '?'} → ${state.localVersion}（${written} 个文件）`);
    return {
      ok: true, updated: true, before: before.rel || '', after: state.localVersion,
      files: written, restartRequired: true, mode: 'payload', state,
    };
  }

  /** 打包版的「重启」。
   *  关键顺序（都是血泪）：
   *   1. 先关本进程的监听端口 —— 老启动器只认"空闲端口"（ping 不通就 boot）；
   *      若端口还占着，新实例会以为撞了别的实例而直接退出（旧 bug）。
   *   2. 再拉新实例（SX_WAIT=1 兜底），本进程 800ms 后退出。
   *  不用 cmd 延迟链：在 wine 下父进程退出会连带收走子进程；
   *  也不用 exe -e：SEA 下 -e 不执行。 */
  async function restartPayload(releasePort) {
    try {
      if (releasePort) { try { await releasePort(); } catch (e) {} }
      const p = spawn(process.execPath, [], {
        cwd: appDir, detached: true, stdio: 'ignore', windowsHide: true,
        env: Object.assign({}, process.env, { SX_WAIT: '1' }),
      });
      p.unref();
    } catch (e) {
      return { ok: false, error: '自动重启失败：' + ((e && e.message) || e) + '（请手动关闭后重新双击）' };
    }
    log('[update] 正在重启…');
    return { ok: true, restarting: true, port, mode: 'payload' };
  }

  return {
    check, apply, restart, startAutoCheck, state,
    mode: detectMode,
    checkPayload, applyPayload, restartPayload,
  };
};
