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
 * 冲突策略：两边都有新改动时**停下来让用户二选一**（用本地 / 用云端），
 *          绝不直接覆盖；只有一边动了才自动同步。
 *          判断依据是 git 提交（远端 HEAD 变没变）+ 本地改动时间，
 *          不比较两台设备的时钟 —— 设备间时钟差几分钟很常见，按时间比会误判。
 *          导入前自动 backup，选错了也能从 data/backups 找回来。
 */

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');

// 参与同步的表（顺序无关，导入时先清空再写入）
const SYNC_TABLES = [
  'goals', 'nodes', 'sources', 'tutorials', 'tutorial_versions', 'tutorial_bookmarks', 'tutorial_progress', 'node_notes', 'node_workspaces', 'goal_versions', 'study_records', 'study_days', 'study_segments', 'ai_prompts',
  'chat_sessions', 'chats', 'problems', 'practice_records', 'daily_plans', 'jd_images',
  /* 执行可视化 HTML 跟着作答记录走（一记录一份，删记录级联删）。 */
  'record_visuals',
  /* 掌握闭环：思路卡 / 引导会话 / 盲写考核 / 易错卡片 / 复习进度。
     review_plans 不进这里 —— 它是「今天练哪几道」，各人作息不同，
     跟着插件的备份 importData 走就够了，跨设备互相覆盖没意义。 */
  'review_cards', 'problem_mind', 'mind_sessions', 'recall_tests', 'pitfall_cards',
  'quiz_outlines', 'quiz_sessions', 'quiz_records',
  'restate_points', 'restate_arc', 'restate_rounds', 'restate_turns'
];
// 不参与同步的列：题面正文与代码模板体积大，且每台设备用本机 LeetCode 登录态自己抓即可；
// 多设备之间互相覆盖反而会看到别人的缓存（导入时保留本机已有值）
const SYNC_OMIT_COLUMNS = { problems: ['statement', 'statement_at', 'snapshots'] };
// 参与同步的设置项白名单（绝不包含密钥）
// 注意：AI 接入配置（ai_provider / ai_base_url / model / vision 相关 / 超时 / agent）故意不同步。
// 原因：① 密钥从不同步，只同步过去一半配置会让对方设备不可用；② 不同设备的地址/模型本就不同
// （本机 Ollama、代理、各自的 key）；③ 曾出现两台设备互相覆盖对方 AI 设置的故障。
// AI 配置请在每台设备上单独设置（30 秒），应用偏好（组件/分类/刷题）照常同步。
const SYNC_SETTINGS = [
  'components', 'component_categories', 'component_category_map', 'practice_lang', 'practice_daily'
];

module.exports = function createSync(ctx) {
  const { db, APP_DIR, DATA_DIR, getSetting, setSetting, backup, log = () => {} } = ctx;
  const WORK_DIR = path.join(DATA_DIR, 'sync');
  const SNAP_NAME = 'sierxing-sync.json';
  const UPLOAD_DIR = path.join(DATA_DIR, 'uploads');

  const enabled = () => getSetting('sync_enabled', '') === '1';
  /* 规范化仓库地址：补 .git、去尾斜杠。git 重定向会丢掉地址里内嵌的用户名密码，
     进而转去调用凭据助手（Windows 上就报 cache daemon 错误），所以先规整成最终地址。 */
  function normalizeRepo(url) {
    let t = String(url || '').trim();
    if (!t) return t;
    t = t.replace(/\/+$/, '');
    if (/^https?:\/\//i.test(t) && !/\.git$/i.test(t)) t += '.git';
    return t;
  }
  const repoUrl = () => normalizeRepo(getSetting('sync_repo', '') || '');
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
        // -c credential.helper= ：禁用系统凭据助手（Windows 上 Git Credential Manager 的
        //   "unable to connect to cache daemon" 就来自这里；凭据已内嵌在仓库地址中，不需要助手）
        const hardened = ['-c', 'credential.helper=', '-c', 'credential.interactive=never', '-c', 'core.askPass='].concat(args);
        child = spawn('git', hardened, {
          cwd: WORK_DIR,
          env: Object.assign({}, process.env, {
            GIT_TERMINAL_PROMPT: '0',
            GCM_INTERACTIVE: 'never',
            GIT_ASKPASS: process.platform === 'win32' ? 'echo' : '/bin/echo'
          }),
          stdio: ['ignore', 'pipe', 'pipe'],
          windowsHide: true
        });
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

  /* ---------------- 冲突检测 ----------------
     上次成功同步时记两个水位：
       sync_base_commit  远端同步到的 git 提交（HEAD）
       sync_base_local   当时本地最后改动时间（localChangeAt，本机时钟自比，不怕设备间时钟差）
     本次：远端 HEAD 变了 = 云端动过；本地改动时间前进了 = 本地动过。
     两边都动 = 冲突，停下来让用户选；否则自动走动的那一边。 */
  const getBase = () => ({ commit: getSetting('sync_base_commit', '') || '', localAt: getSetting('sync_base_local', '') || '' });
  function setBase(commit, localAt) {
    setSetting('sync_base_commit', commit || '');
    setSetting('sync_base_local', localAt || '');
  }
  function readConflict() {
    try { return JSON.parse(getSetting('sync_conflict', '') || 'null'); } catch (e) { return null; }
  }
  function writeConflict(c) {
    if (!c) { setSetting('sync_conflict', ''); return; }
    setSetting('sync_conflict', JSON.stringify(c));
  }
  /** 本地是否有「上次同步之后」的新改动。从没同步过时：库里有任何数据就算动过。 */
  function localChangedSince(baseLocalAt) {
    const cur = localChangeAt();
    if (!cur) return false;
    if (!baseLocalAt) return true;
    return cur > baseLocalAt;
  }
  function localCounts() {
    const c = {};
    for (const t of ['goals', 'nodes', 'sources', 'tutorials']) {
      try { c[t] = db.prepare(`SELECT COUNT(*) AS n FROM ${t}`).get().n || 0; } catch (e) { c[t] = 0; }
    }
    return c;
  }
  async function fetchRemote() {
    const r = await git(['fetch', 'origin', branch()], 90000);
    return r.ok;
  }
  async function remoteHead() {
    const r = await git(['rev-parse', 'origin/' + branch()], 30000);
    return r.ok ? (r.out || '').trim() : '';
  }
  async function localHead() {
    const r = await git(['rev-parse', 'HEAD'], 30000);
    return r.ok ? (r.out || '').trim() : '';
  }
  /** 不合并、只看：把远端分支上的快照读出来比对 */
  async function readRemoteSnapshot() {
    const r = await git(['show', 'origin/' + branch() + ':' + SNAP_NAME], 30000);
    if (!r.ok || !r.out) return null;
    try {
      const j = JSON.parse(r.out);
      return (j && j.format === 'sierxing-sync' && j.data) ? j : null;
    } catch (e) { return null; }
  }
  /** 两边状态一次看全。调用前需 ensureRepo + fetchRemote。 */
  async function analyze() {
    const base = getBase();
    const rHead = await remoteHead();
    const snap = rHead ? await readRemoteSnapshot() : null;
    const remoteChanged = !!(rHead && rHead !== base.commit);
    const localChanged = localChangedSince(base.localAt);
    return {
      base, rHead, snap,
      remoteChanged: remoteChanged && !!snap,
      remoteMoved: !!rHead && rHead !== base.commit,
      localChanged,
      conflict: !!(rHead && rHead !== base.commit && snap && localChanged)
    };
  }
  function conflictRecord(rHead, snap) {
    return {
      detectedAt: new Date().toISOString(),
      remoteCommit: rHead,
      remote: { savedAt: snap.savedAt || '', device: snap.device || '', counts: snap.counts || {} },
      local: { changeAt: localChangeAt(), counts: localCounts() }
    };
  }
  function markConflicted(rHead, snap) {
    const c = conflictRecord(rHead, snap);
    writeConflict(c);
    setSetting('sync_last_at', new Date().toISOString());
    setSetting('sync_last_status', '检测到冲突：本地与云端都有新改动，请在「设置 → 多端同步」二选一');
    log('[sync] conflict: local', c.local.changeAt, 'vs remote', c.remote.savedAt, c.remote.device);
    return c;
  }
  /** 把远端快照落到本地库（调用前必须已确认不冲突或用户选了云端） */
  function importRemote(snap) {
    applySnapshot(snap);
    if (syncImages()) {
      const src = path.join(WORK_DIR, 'uploads');
      if (fs.existsSync(src)) {
        fs.mkdirSync(UPLOAD_DIR, { recursive: true });
        for (const f of fs.readdirSync(src)) {
          try { fs.copyFileSync(path.join(src, f), path.join(UPLOAD_DIR, f)); } catch (e) {}
        }
      }
    }
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
      // 设置上游（远端分支还不存在时会失败，忽略即可：pull/push 都显式带分支）
      await git(['branch', '--set-upstream-to=origin/' + branch(), branch()], 20000);
    return true;
  }

  /* ---------------- 快照导出 / 导入 ---------------- */
  function exportSnapshot(reason) {
    const data = {};
    for (const t of SYNC_TABLES) {
      let rows = [];
      try { rows = db.prepare(`SELECT * FROM ${t}`).all(); } catch (e) { rows = []; }
      const omit = SYNC_OMIT_COLUMNS[t];
      if (omit && rows.length) rows = rows.map(r => { const c = Object.assign({}, r); for (const k of omit) delete c[k]; return c; });
      data[t] = rows;
    }
    const settings = {};
    for (const k of SYNC_SETTINGS) {
      const v = getSetting(k, '');
      if (v === '' || v == null) continue;
      settings[k] = v;
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
    // 安全阀：远端快照的目标数明显少于本地时拒绝导入（避免空快照/误删把本地数据清空）
      try {
        const localGoals = db.prepare('SELECT COUNT(*) AS c FROM goals').get().c || 0;
        const remoteGoals = Array.isArray(snap.data.goals) ? snap.data.goals.length : 0;
        if (localGoals >= 1 && remoteGoals < localGoals) {
          throw new Error('已拒绝导入：远端快照只有 ' + remoteGoals + ' 个目标，本地有 ' + localGoals + ' 个（如需强制导入，请先在本机删掉多余目标）');
        }
      } catch (e) { if (/已拒绝导入/.test(e.message)) throw e; }
      backup();   // 导入前先备份，出问题可回滚
    db.exec('BEGIN');
    try {
      for (const t of SYNC_TABLES) {
        const rows = Array.isArray(snap.data[t]) ? snap.data[t] : [];
        const valid = new Set(tableColumns(t));
        const keep = (SYNC_OMIT_COLUMNS[t] || []).filter(c => valid.has(c));
        // 必须在清表之前读出本机这些列的值（题面等不同步字段要保留本机缓存）
        const localKeep = new Map();
        if (keep.length) {
          try { for (const r of db.prepare(`SELECT id, ${keep.join(',')} FROM ${t}`).all()) localKeep.set(r.id, r); } catch (e) {}
        }
        db.prepare(`DELETE FROM ${t}`).run();
        if (!rows.length) continue;
        const cols = Object.keys(rows[0]).filter(c => valid.has(c));
        if (!cols.length) continue;
        for (const k of keep) if (!cols.includes(k)) cols.push(k);
        const stmt = db.prepare(`INSERT INTO ${t} (${cols.join(',')}) VALUES (${cols.map(() => '?').join(',')})`);
        for (const r of rows) {
          const row = Object.assign({}, r);
          const lk = localKeep.get(r.id);
          for (const k of keep) row[k] = lk ? lk[k] : (KEEP_DEFAULTS[k] !== undefined ? KEEP_DEFAULTS[k] : null);
          stmt.run(...cols.map(c => (row[c] === undefined ? null : row[c])));
        }
      }
      // 设置项：只导入白名单，绝不覆盖密钥
      if (snap.settings && typeof snap.settings === 'object') {
        for (const k of SYNC_SETTINGS) {
          if (snap.settings[k] === undefined) continue;
          setSetting(k, String(snap.settings[k]));
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

  /* 本地最后改动时间：不能只看 goals——节点/资料/汇总的改动同样重要，
     否则"新生成的节点"会被判定为比远端旧而被覆盖（曾导致节点消失） */
  function localChangeAt() {
    let latest = '';
    for (const t of ['goals', 'nodes', 'sources', 'source_digests', 'tutorials', 'tutorial_bookmarks', 'tutorial_progress', 'node_notes', 'node_workspaces', 'goal_versions', 'study_records', 'study_days', 'study_segments', 'ai_prompts', 'jd_images', 'practice_records', 'daily_plans']) {
      for (const col of ['updated_at', 'created_at']) {
        try {
          const row = db.prepare(`SELECT MAX(${col}) AS t FROM ${t}`).get();
          const v = row && row.t ? String(row.t) : '';
          if (v && v > latest) latest = v;
        } catch (e) {}
      }
    }
    return latest;
  }

  /* ---------------- 上传 / 拉取 ---------------- */
  let pushing = false;
  let pushTimer = null;

  async function push(reason, opts) {
    if (!enabled()) throw new Error('未启用多端同步');
    if (pushing) return { ok: true, skipped: 'busy' };
    pushing = true;
    try {
      await ensureRepo();
      await fetchRemote();
      const st = await analyze();
      if (st.remoteMoved && !st.snap) {
        // 远端分支动了但读不出快照（别人传了一半？）：不敢贸然覆盖，先停下
        throw new Error('远端有新提交但读不到快照文件，暂停上传（先点「立即拉取」看看）');
      }
      if (st.conflict && !(opts && opts.force)) {
        /* 两边都动了：直接 push 会用本地快照把云端文件盖掉，云端数据就没了。
           以前这里静默覆盖，这正是用户要求改掉的行为 —— 停下来让人选。 */
        const c = markConflicted(st.rHead, st.snap);
        return { ok: true, conflict: c };
      }
      if (st.remoteChanged && !(opts && opts.force)) {
        /* 只有云端动了：先把云端合进来再传，避免传上去的快照丢了别人的改动。
           以前只合文件不合库，合完又直接用本地快照盖掉，等于白合。 */
        await git(['pull', '--rebase', '--autostash', 'origin', branch()], 120000);
        const merged = readLocalSnapshot();
        if (merged) importRemote(merged);
        writeConflict(null);
      }
      if (st.remoteMoved && (opts && opts.force)) {
        /* 用户亲选了「保留本地」：只合 git 血缘（不然 push 会被远端拒绝），
           绝不把云端数据合进库 —— 否则刚选"保留"的本地改动当场就没了。 */
        await git(['pull', '--rebase', '--autostash', 'origin', branch()], 120000);
        writeConflict(null);
      }
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
      if (!p.ok) throw new Error('推送失败：' + friendlyGitError(p.err || p.out));
      setBase(await localHead(), localChangeAt());
      writeConflict(null);
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
    await fetchRemote();
    const st = await analyze();
    if (!st.rHead || !st.snap) {
      return { ok: true, imported: false, message: '仓库里还没有同步数据（先从一台设备点「立即上传」）' };
    }
    if (st.conflict) {
      /* 两边都动了：以前直接用云端覆盖本地，用户在另一台设备的改动就没了。
         现在停下来，把两边摘要给前端，让用户二选一。 */
      const c = markConflicted(st.rHead, st.snap);
      return { ok: true, imported: false, conflict: c };
    }
    if (!st.remoteChanged) {
      writeConflict(null);
      setSetting('sync_last_at', new Date().toISOString());
      setSetting('sync_last_status', st.localChanged ? '云端没有新数据（本地有未上传的改动）' : '已是最新');
      return { ok: true, imported: false, message: st.localChanged ? '云端没有新数据，本地有未上传的改动（可点「立即上传」）' : '已是最新' };
    }
    // 只有云端动了：合进来
    const p = await git(['pull', '--rebase', '--autostash', 'origin', branch()], 180000);
    if (!p.ok && !/Already up to date|Already up-to-date/i.test(p.out + p.err)) {
      setSetting('sync_last_status', '拉取失败：' + friendlyGitError(p.err || p.out));
      throw new Error('拉取失败：' + friendlyGitError(p.err || p.out));
    }
    const remote = readLocalSnapshot() || st.snap;
    importRemote(remote);
    setBase(await localHead(), localChangeAt());
    writeConflict(null);
    setSetting('sync_last_at', new Date().toISOString());
    setSetting('sync_last_status', '拉取成功 · 来自 ' + (remote.device || '其它设备') + ' · ' + (remote.counts && remote.counts.goals || 0) + ' 个目标');
    log('[sync] pulled from', remote.device, remote.counts);
    return { ok: true, imported: true, savedAt: remote.savedAt, device: remote.device, counts: remote.counts };
  }

  /** 用户在冲突对话框里二选一。
   *  remote = 用云端覆盖本地（导入前自动 backup，选错可回滚）
   *  local  = 保留本地并上传（强制 push，云端以本地为准） */
  async function resolve(choice) {
    if (!enabled()) throw new Error('未启用多端同步');
    if (choice !== 'remote' && choice !== 'local') throw new Error('未知选择');
    await ensureRepo();
    await fetchRemote();
    const st = await analyze();
    if (choice === 'remote') {
      const snap = st.snap || readLocalSnapshot();
      if (!snap) throw new Error('云端没有可用的快照');
      await git(['pull', '--rebase', '--autostash', 'origin', branch()], 180000);
      const merged = readLocalSnapshot() || snap;
      importRemote(merged);
      setBase(await localHead(), localChangeAt());
      writeConflict(null);
      setSetting('sync_last_at', new Date().toISOString());
      setSetting('sync_last_status', '已用云端覆盖本地 · 来自 ' + (merged.device || '其它设备'));
      log('[sync] resolved: use remote from', merged.device);
      return { ok: true, imported: true, savedAt: merged.savedAt, device: merged.device, counts: merged.counts };
    }
    writeConflict(null);
    return push('冲突解决：保留本地', { force: true });
  }

  /* 把 git 的凭据类报错翻译成可操作提示 */
  function friendlyGitError(msg) {
    const t = String(msg || '');
    if (/password-based authentication.*removed|Access denied|Authorization failed|could not read Username|terminal prompts disabled|Permission denied|403|401/i.test(t)) {
      return t + '\n\n分步解决（AtomGit 已关闭密码登录，登录密码推不动仓库）：'
        + '\n1. 浏览器打开 AtomGit → 右上角头像 → 设置 → 访问令牌 → 生成新令牌（权限勾选仓库读写 / repository）'
        + '\n2. 回到思而行「设置 → 多端同步」：用户名填你的 AtomGit 账号名，密码框粘贴刚生成的令牌（不是登录密码）'
        + '\n3. 点「保存并测试连接」，显示"仓库可访问"再点「立即上传」';
    }
    return t;
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
      try {
        const hardened = ['-c', 'credential.helper=', '-c', 'credential.interactive=never', '-c', 'core.askPass=', 'ls-remote', '--heads', authUrl(repoUrl())];
        child = spawn('git', hardened, {
          env: Object.assign({}, process.env, { GIT_TERMINAL_PROMPT: '0', GCM_INTERACTIVE: 'never', GIT_ASKPASS: process.platform === 'win32' ? 'echo' : '/bin/echo' }),
          stdio: ['ignore', 'pipe', 'pipe'],
          windowsHide: true
        });
      }
      catch (e) { return resolve({ ok: false, err: String(e.message) }); }
      let out = '', err = '';
      const timer = setTimeout(() => { try { child.kill('SIGKILL'); } catch (e) {} resolve({ ok: false, err: 'timeout' }); }, 60000);
      child.stdout.on('data', d => { out += d; });
      child.stderr.on('data', d => { err += d; });
      child.on('error', e => { clearTimeout(timer); resolve({ ok: false, err: String(e.message) }); });
      child.on('close', code => { clearTimeout(timer); resolve({ ok: code === 0, out, err }); });
    });
    if (!r.ok) return { ok: false, message: friendlyGitError('无法访问仓库：' + (r.err || '').replace(/oauth2:[^@]*@/, 'oauth2:***@').slice(0, 200)) };
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
      /* 用户名要回给前端做回显：之前 status 里没有 user，前端用了个从没赋值的
         state.settingsSyncUser，刷新后用户名输入框永远是空的 —— 用户以为「没保存」。 */
      user: (getSetting('sync_user', '') || '').trim(),
      autoPush: autoPush(), autoPull: autoPull(), images: syncImages(), hasToken: !!token(),
      /* 未解决的冲突（有则前端弹二选一，不再静默覆盖） */
      conflict: readConflict(),
      workDir: WORK_DIR, cloned, commit: remoteHead, workState: ahead,
      lastAt: getSetting('sync_last_at', ''), lastStatus: getSetting('sync_last_status', ''),
      snapshot: snap ? { savedAt: snap.savedAt, device: snap.device, counts: snap.counts } : null,
      localChangeAt: localChangeAt()
    };
  }

  return { status, push, pull, test, resolve, schedulePush, exportSnapshot, applySnapshot, gitAvailable, workDir: WORK_DIR };
};
