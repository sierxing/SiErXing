'use strict';
/**
 * 思而行 · 多端同步（基于你自己的 Git 仓库）
 * ------------------------------------------------------------------
 * 原理：把数据导出一份 JSON 快照，提交到你的（私有）git 仓库；
 *       改动后自动 push，启动时自动 pull，从而实现多台设备同步。
 *
 * 安全：
 *   · 快照**不包含任何密钥**（AI API Key、同步令牌、LeetCode 登录态等一律不同步）
 *   · 令牌只保存在本机数据库，不会写进快照
 *   · 本地工作副本在 data/sync/（已在 .gitignore 中）
 *
 * 冲突策略：以「最后保存者为准」（savedAt 较新的一方覆盖另一方），
 *          适合个人多设备场景；同时保留本地备份（push 前自动 backup）。
 */

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');

// 参与同步的表（顺序无关，导入时先清空再写入）
const SYNC_TABLES = [
  'goals', 'nodes', 'sources', 'tutorials', 'goal_versions',
  'chat_sessions', 'chats', 'problems', 'practice_records', 'daily_plans', 'jd_images'
];
// 参与同步的设置项白名单（绝不包含密钥）
const SYNC_SETTINGS = [
  'model', 'vision_model', 'ai_provider', 'ai_base_url', 'ai_vision_model', 'ai_opencode_agent',
  'components', 'component_categories', 'component_category_map', 'practice_lang', 'practice_daily'
];

module.exports = function createSync(ctx) {
  const { db, APP_DIR, DATA_DIR, getSetting, setSetting, backup, log = () => {} } = ctx;
  const WORK_DIR = path.join(DATA_DIR, 'sync');
  const SNAP_NAME = 'sierxing-sync.json';
  const UPLOAD_DIR = path.join(DATA_DIR, 'uploads');

  const enabled = () => getSetting('sync_enabled', '') === '1';
  const repoUrl = () => (getSetting('sync_repo', '') || '').trim();
  const branch = () => (getSetting('sync_branch', '') || 'main').trim();
  const autoPush = () => getSetting('sync_auto_push', '1') !== '0';
  const autoPull = () => getSetting('sync_auto_pull', '1') !== '0';
  const syncImages = () => getSetting('sync_images', '1') === '1';
  const token = () => (getSetting('sync_token', '') || '').trim();

  /* ---------------- git 辅助 ---------------- */
  function git(args, timeoutMs = 60000) {
    return new Promise(resolve => {
      let child;
      try {
        child = spawn('git', args, { cwd: WORK_DIR, env: { ...process.env, GIT_TERMINAL_PROMPT: '0' }, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
      } catch (e) { return resolve({ ok: false, out: '', err: String(e.message) }); }
      let out = '', err = '';
      const timer = setTimeout(() => { try { child.kill('SIGKILL'); } catch (e) {} resolve({ ok: false, out, err: 'timeout' }); }, timeoutMs);
      child.stdout.on('data', d => { out += d; });
      child.stderr.on('data', d => { err += d; });
      child.on('error', e => { clearTimeout(timer); resolve({ ok: false, out, err: String(e.message) }); });
      child.on('close', code => { clearTimeout(timer); resolve({ ok: code === 0, out: out.trim(), err: err.trim(), code }); });
    });
  }
  async function gitAvailable() {
    const r = await new Promise(resolve => {
      let child;
      try { child = spawn('git', ['--version'], { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true }); } catch (e) { return resolve(false); }
      let out = '';
      child.stdout.on('data', d => { out += d; });
      child.on('error', () => resolve(false));
      child.on('close', code => resolve(code === 0 && /git version/i.test(out)));
    });
    return r;
  }
  /** 带令牌的地址（私有仓库）；令牌只用于本机 git 操作，不写入快照 */
  function authUrl(url) {
    const t = token();
    if (!t) return url;
    try {
      const u = new URL(url);
      if (!u.password) {
        u.username = (getSetting('sync_user', '') || 'oauth2').trim() || 'oauth2';
        u.password = t;
      }
      return u.toString();
    } catch (e) { return url; }
  }
  function safeUrl(url) {
    try { const u = new URL(url); if (u.password) u.password = '***'; if (u.username) u.username = u.username + (u.password ? '' : ''); return u.toString(); } catch (e) { return url; }
  }

  async function ensureRepo() {
    if (!repoUrl()) throw new Error('还没有填写同步仓库地址');
    if (!fs.existsSync(path.join(WORK_DIR, '.git'))) {
      fs.mkdirSync(path.dirname(WORK_DIR), { recursive: true });
      try { fs.rmSync(WORK_DIR, { recursive: true, force: true }); } catch (e) {}
      const clone = await git(['clone', '--depth', '1', '--branch', branch(), authUrl(repoUrl()), WORK_DIR], 180000);
      if (!clone.ok) {
        // 空仓库（没有 main 分支）时，改为初始化并关联远程
        fs.mkdirSync(WORK_DIR, { recursive: true });
        const init = await git(['init', '-q'], 30000);
        if (!init.ok) throw new Error('git 初始化失败：' + (init.err || ''));
        await git(['remote', 'add', 'origin', authUrl(repoUrl())], 30000);
        await git(['checkout', '-q', '-b', branch()], 30000);
      }
    }
    await git(['remote', 'set-url', 'origin', authUrl(repoUrl())], 30000);
    await git(['config', 'user.name', 'sierxing-sync'], 20000);
    await git(['config', 'user.email', 'sync@localhost'], 20000);
    return true;
  }

  /* ---------------- 快照导出 / 导入 ---------------- */
  function exportSnapshot(reason) {
    const data = {};
    for (const t of SYNC_TABLES) {
      try { data[t] = db.prepare(`SELECT * FROM ${t}`).all(); } catch (e) { data[t] = []; }
    }
    const settings = {};
    for (const k of SYNC_SETTINGS) {
      const v = getSetting(k, '');
      if (v !== '' && v != null) settings[k] = v;
    }
    return {
      format: 'sierxing-sync',
      version: 1,
      savedAt: new Date().toISOString(),
      device: os.hostname(),
      reason: reason || '',
      counts: Object.fromEntries(Object.entries(data).map(([k, v]) => [k, v.length])),
      settings,
      data
    };
  }

  function tableColumns(table) {
    try { return db.prepare(`PRAGMA table_info(${table})`).all().map(c => c.name); } catch (e) { return []; }
  }

  function applySnapshot(snap) {
    if (!snap || snap.format !== 'sierxing-sync' || !snap.data) throw new Error('不是有效的同步快照');
    backup();   // 导入前先备份，出问题可回滚
    db.exec('BEGIN');
    try {
      for (const t of SYNC_TABLES) {
        const rows = Array.isArray(snap.data[t]) ? snap.data[t] : [];
        db.prepare(`DELETE FROM ${t}`).run();
        if (!rows.length) continue;
        const valid = new Set(tableColumns(t));
        const cols = Object.keys(rows[0]).filter(c => valid.has(c));
        if (!cols.length) continue;
        const stmt = db.prepare(`INSERT INTO ${t} (${cols.join(',')}) VALUES (${cols.map(() => '?').join(',')})`);
        for (const r of rows) stmt.run(...cols.map(c => (r[c] === undefined ? null : r[c])));
      }
      // 设置项：只导入白名单，绝不覆盖密钥
      if (snap.settings && typeof snap.settings === 'object') {
        for (const k of SYNC_SETTINGS) {
          if (snap.settings[k] !== undefined) setSetting(k, String(snap.settings[k]));
        }
      }
      db.exec('COMMIT');
    } catch (e) {
      try { db.exec('ROLLBACK'); } catch (e2) {}
      throw e;
    }
    return true;
  }

  function readLocalSnapshot() {
    const p = path.join(WORK_DIR, SNAP_NAME);
    if (!fs.existsSync(p)) return null;
    try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch (e) { return null; }
  }

  function localChangeAt() {
    try {
      const row = db.prepare('SELECT MAX(updated_at) AS t FROM goals').get();
      return row && row.t ? String(row.t) : '';
    } catch (e) { return ''; }
  }

  /* ---------------- 上传 / 拉取 ---------------- */
  let pushing = false;
  let pushTimer = null;

  async function push(reason) {
    if (!enabled()) throw new Error('未启用多端同步');
    if (pushing) return { ok: true, skipped: 'busy' };
    pushing = true;
    try {
      await ensureRepo();
      await git(['pull', '--rebase', '--autostash'], 120000);   // 先同步远程，减少冲突
      const snap = exportSnapshot(reason);
      fs.writeFileSync(path.join(WORK_DIR, SNAP_NAME), JSON.stringify(snap, null, 1), 'utf8');
      if (syncImages() && fs.existsSync(UPLOAD_DIR)) {
        const dest = path.join(WORK_DIR, 'uploads');
        fs.mkdirSync(dest, { recursive: true });
        for (const f of fs.readdirSync(UPLOAD_DIR)) {
          try { fs.copyFileSync(path.join(UPLOAD_DIR, f), path.join(dest, f)); } catch (e) {}
        }
      }
      await git(['add', '-A'], 60000);
      const commit = await git(['commit', '-m', `sync: ${reason || 'update'} @ ${new Date().toLocaleString('zh-CN')}`], 60000);
      if (!commit.ok && !/nothing to commit|no changes added/i.test(commit.out + commit.err)) {
        throw new Error('提交失败：' + (commit.err || commit.out));
      }
      const p = await git(['push', '-u', 'origin', branch()], 180000);
      if (!p.ok) throw new Error('推送失败：' + (p.err || p.out));
      setSetting('sync_last_at', new Date().toISOString());
      setSetting('sync_last_status', '上传成功 · ' + (snap.counts.goals || 0) + ' 个目标');
      log('[sync] push ok:', snap.counts.goals, 'goals');
      return { ok: true, at: new Date().toISOString(), counts: snap.counts };
    } catch (e) {
      setSetting('sync_last_status', '上传失败：' + e.message);
      throw e;
    } finally {
      pushing = false;
    }
  }

  async function pull() {
    if (!enabled()) throw new Error('未启用多端同步');
    await ensureRepo();
    const before = await git(['rev-parse', 'HEAD'], 30000);
    const p = await git(['pull', '--rebase', '--autostash'], 180000);
    if (!p.ok && !/Already up to date|Already up-to-date/i.test(p.out + p.err)) {
      setSetting('sync_last_status', '拉取失败：' + (p.err || p.out));
      throw new Error('拉取失败：' + (p.err || p.out));
    }
    const remote = readLocalSnapshot();
    if (!remote) return { ok: true, imported: false, message: '仓库里还没有同步数据（先从一台设备点「立即上传」）' };
    const localAt = localChangeAt();
    if (localAt && remote.savedAt && new Date(remote.savedAt) <= new Date(localAt)) {
      setSetting('sync_last_at', new Date().toISOString());
      setSetting('sync_last_status', '已是最新（本地更新）');
      return { ok: true, imported: false, message: '本地数据更新，无需导入' };
    }
    applySnapshot(remote);
    if (syncImages()) {
      const src = path.join(WORK_DIR, 'uploads');
      if (fs.existsSync(src)) {
        fs.mkdirSync(UPLOAD_DIR, { recursive: true });
        for (const f of fs.readdirSync(src)) {
          try { fs.copyFileSync(path.join(src, f), path.join(UPLOAD_DIR, f)); } catch (e) {}
        }
      }
    }
    setSetting('sync_last_at', new Date().toISOString());
    setSetting('sync_last_status', '拉取成功 · 来自 ' + (remote.device || '其它设备') + ' · ' + (remote.counts && remote.counts.goals || 0) + ' 个目标');
    log('[sync] pulled from', remote.device, remote.counts);
    return { ok: true, imported: true, savedAt: remote.savedAt, device: remote.device, counts: remote.counts };
  }

  /** 数据变化后自动上传（去抖，避免频繁提交） */
  function schedulePush(reason) {
    if (!enabled() || !autoPush()) return;
    if (pushTimer) clearTimeout(pushTimer);
    pushTimer = setTimeout(() => { push(reason || 'auto').catch(e => log('[sync] auto push failed:', e.message)); }, 20000);
    pushTimer.unref && pushTimer.unref();
  }

  async function test() {
    if (!repoUrl()) return { ok: false, message: '请先填写仓库地址' };
    const hasGit = await gitAvailable();
    if (!hasGit) return { ok: false, message: '本机未找到 git 命令，请先安装 git' };
    const r = await new Promise(resolve => {
      let child;
      try { child = spawn('git', ['ls-remote', '--heads', authUrl(repoUrl())], { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true }); }
      catch (e) { return resolve({ ok: false, err: String(e.message) }); }
      let out = '', err = '';
      const timer = setTimeout(() => { try { child.kill('SIGKILL'); } catch (e) {} resolve({ ok: false, err: 'timeout' }); }, 60000);
      child.stdout.on('data', d => { out += d; });
      child.stderr.on('data', d => { err += d; });
      child.on('error', e => { clearTimeout(timer); resolve({ ok: false, err: String(e.message) }); });
      child.on('close', code => { clearTimeout(timer); resolve({ ok: code === 0, out, err }); });
    });
    if (!r.ok) return { ok: false, message: '无法访问仓库：' + (r.err || '').replace(/oauth2:[^@]*@/, 'oauth2:***@').slice(0, 200) };
    const heads = (r.out || '').split('\n').filter(Boolean).map(l => l.split('refs/heads/')[1]).filter(Boolean);
    return { ok: true, message: '仓库可访问', branches: heads, hasSnapshotBranch: heads.includes(branch()) };
  }

  async function status() {
    const hasGit = await gitAvailable();
    let cloned = false, remoteHead = '', ahead = '';
    try { cloned = fs.existsSync(path.join(WORK_DIR, '.git')); } catch (e) {}
    if (cloned) {
      const h = await git(['rev-parse', '--short', 'HEAD'], 20000);
      remoteHead = h.out || '';
      const st = await git(['status', '--porcelain'], 20000);
      ahead = (st.out || '').trim() ? '有未提交改动' : '干净';
    }
    const snap = cloned ? readLocalSnapshot() : null;
    return {
      enabled: enabled(), hasGit, repo: safeUrl(repoUrl()), branch: branch(),
      autoPush: autoPush(), autoPull: autoPull(), images: syncImages(), hasToken: !!token(),
      workDir: WORK_DIR, cloned, commit: remoteHead, workState: ahead,
      lastAt: getSetting('sync_last_at', ''), lastStatus: getSetting('sync_last_status', ''),
      snapshot: snap ? { savedAt: snap.savedAt, device: snap.device, counts: snap.counts } : null,
      localChangeAt: localChangeAt()
    };
  }

  return { status, push, pull, test, schedulePush, exportSnapshot, applySnapshot, gitAvailable, workDir: WORK_DIR };
};
