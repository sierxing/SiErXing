/**
 * 思而行 · 插件：每日刷题（LeetCode 热题 100）
 * ------------------------------------------------------------------
 * 能力：拉取热题 100（按知识点分组）、每日任务、完整题面、VSCode 作答文件、
 *       作答记录（代码/笔记/用时/次数）、连续打卡统计。
 * 依赖：本机 VSCode LeetCode 插件的登录态（默认 ~/.lc/leetcode.cn/user.json）。
 * 说明：这是一个「服务端插件」示例——插件通过 init(ctx) 拿到宿主能力，
 *       用 api 数组声明路由，用 migrate 建表，用 onGoalDelete 处理级联。
 */
'use strict';
let db, nowISO, safeParse, sendJSON, readBody, getSetting, setSetting, backup, log;
let fs, path, os, spawn, APP_DIR, DATA_DIR, UPLOAD_DIR, PUBLIC_DIR;
let getGoal, sourcesOf, aiText, aiTextFiles, currentModel, currentVisionModel;
function bind(ctx) {
  ({ db, nowISO, safeParse, sendJSON, readBody, getSetting, setSetting, backup, log } = ctx);
  ({ fs, path, os, spawn, APP_DIR, DATA_DIR, UPLOAD_DIR, PUBLIC_DIR } = ctx);
  ({ getGoal, sourcesOf, aiText, aiTextFiles, currentModel, currentVisionModel } = ctx);
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS problems (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  fid INTEGER NOT NULL DEFAULT 0,
  slug TEXT NOT NULL UNIQUE,
  title TEXT NOT NULL DEFAULT '',
  difficulty TEXT NOT NULL DEFAULT '',
  link TEXT NOT NULL DEFAULT '',
  groups TEXT NOT NULL DEFAULT '[]',
  tags TEXT NOT NULL DEFAULT '[]',
  sort_index INTEGER NOT NULL DEFAULT 0,
  statement TEXT NOT NULL DEFAULT '',
  statement_at TEXT NOT NULL DEFAULT '',
  snapshots TEXT NOT NULL DEFAULT '[]',
  /* 手动完成状态：-1 = 跟随作答记录自动判定；0 = 手动标为未完成；1 = 手动标为已完成。
     为什么要有它：「按知识点练习」覆盖全部 100 道题，而每日任务只是当天的 3 道，
     原来的 data-toggle 写的是 daily_plans（非当日任务就没有这一项），所以列表里无处可改。
     手动值只改这道题的完成状态，不影响其它题，也不伪造一条「通过」记录。 */
  done_manual INTEGER NOT NULL DEFAULT -1,
  synced_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS practice_records (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  problem_id INTEGER NOT NULL,
  goal_id INTEGER NOT NULL DEFAULT 0,
  date TEXT NOT NULL DEFAULT '',
  passed INTEGER NOT NULL DEFAULT 0,
  language TEXT NOT NULL DEFAULT '',
  code TEXT NOT NULL DEFAULT '',
  notes TEXT NOT NULL DEFAULT '',
  minutes INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS daily_plans (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  goal_id INTEGER NOT NULL,
  date TEXT NOT NULL DEFAULT '',
  items TEXT NOT NULL DEFAULT '[]',
  created_at TEXT NOT NULL,
  UNIQUE(goal_id, date)
);`;

module.exports = {
  id: 'hot100',
  name: '每日刷题',
  category: '其它',
  icon: '🧩',
  desc: 'LeetCode 热题 100：按知识点分组、每日任务、完整题面、VSCode 作答与作答记录',
  order: 20,
  goalToggle: true,        // 新建目标时可勾选启用
  defaultEnabled: false,
  client: '/plugins/hot100.js',

  /** 建表（宿主启动时调用一次） */
  init(ctx) {
    bind(ctx);
    db.exec(SCHEMA);
    /* 老库补列：建表语句只对新建的库生效，已存在的 problems 表不会有 done_manual。
     写法与 server.js 的迁移一致（先查列名再 ALTER，不要靠 catch 吞 duplicate）。 */
    const cols = db.prepare('PRAGMA table_info(problems)').all().map(c => c.name);
    if (!cols.includes('done_manual')) db.exec('ALTER TABLE problems ADD COLUMN done_manual INTEGER NOT NULL DEFAULT -1;');
    // 依赖宿主环境的路径在这里初始化（保证插件可在任意环境加载）
    LC_USER_FILE_DEFAULT = path.join(os.homedir(), '.lc', 'leetcode.cn', 'user.json');
    VSCODE_SETTINGS = path.join(os.homedir(), '.config', 'Code', 'User', 'settings.json');
    VSCODE_SETTINGS_ALT = path.join(os.homedir(), '.config', 'Code - OSS', 'User', 'settings.json');
  },
  /** 目标被删除时的清理 */
  onGoalDelete(goalId, ctx) {
    ctx.db.prepare('DELETE FROM daily_plans WHERE goal_id = ?').run(goalId);
  },
  /** 该目标的插件设置（如作答目录、题量） */
  goalConfig(ctx) {
    return [
      { key: 'hot100_daily', label: '每日题量', type: 'number', dflt: '3', hint: '1-10 题' },
      { key: 'practice_dir', label: 'VSCode 作答目录', type: 'text', dflt: '', hint: '默认 ~/Leetcode' }
    ];
  },

  /** 导出：题库 + 作答记录 + 每日计划（随主数据一起备份） */
  exportData(ctx) {
    // 题面正文（statement/snapshots）不参与同步：体积大、且每台设备用本机 LeetCode 登录态自己抓即可，
    // 多设备之间互相覆盖反而容易看到别人的缓存。题目列表、作答记录、每日计划照常同步。
    return {
      problems: ctx.db.prepare('SELECT id,fid,slug,title,difficulty,link,groups,tags,sort_index,done_manual,synced_at FROM problems').all(),
      records: ctx.db.prepare('SELECT * FROM practice_records').all(),
      plans: ctx.db.prepare('SELECT * FROM daily_plans').all()
    };
  },
  importData(data, ctx) {
    if (!data) return;
    const { db } = ctx;
    for (const x of (data.problems || [])) {
      const cur = db.prepare('SELECT statement, statement_at, snapshots FROM problems WHERE id = ?').get(x.id) || {};
      const statement = x.statement === undefined ? (cur.statement || '') : x.statement;
      const statement_at = x.statement === undefined ? (cur.statement_at || '') : (x.statement_at || '');
      const snapshots = x.snapshots === undefined ? (cur.snapshots || '[]') : x.snapshots;
      /* done_manual 缺省为 -1（自动），别让旧备份把别人手动标的完成状态清掉 */
      const doneManual = x.done_manual === undefined || x.done_manual === null ? -1 : Number(x.done_manual);
      db.prepare('INSERT OR REPLACE INTO problems (id,fid,slug,title,difficulty,link,groups,tags,sort_index,statement,statement_at,snapshots,done_manual,synced_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)')
        .run(x.id, x.fid, x.slug, x.title, x.difficulty, x.link, x.groups, x.tags, x.sort_index, statement, statement_at, snapshots, doneManual, x.synced_at);
    }
    for (const x of (data.records || [])) db.prepare('INSERT OR REPLACE INTO practice_records (id,problem_id,goal_id,date,passed,language,code,notes,minutes,created_at) VALUES (?,?,?,?,?,?,?,?,?,?)')
      .run(x.id, x.problem_id, x.goal_id, x.date, x.passed, x.language, x.code, x.notes, x.minutes, x.created_at);
    for (const x of (data.plans || [])) db.prepare('INSERT OR REPLACE INTO daily_plans (id,goal_id,date,items,created_at) VALUES (?,?,?,?,?)')
      .run(x.id, x.goal_id, x.date, x.items, x.created_at);
  },
  clearAll(ctx) {
    ctx.db.exec('DELETE FROM practice_records; DELETE FROM daily_plans;');
  },

  api: [
  {
    method: 'POST', pattern: /^\/api\/problems\/sync$/,
    handler: async (req, res, u, ctx) => {
      const p = u.pathname, method = req.method;
        const syncMatch = p.match(/^\/api\/problems\/sync$/);
        if (syncMatch && method === 'POST') {
          try {
            const r = await syncHot100();
            return sendJSON(res, 200, r);
          } catch (e) {
            return sendJSON(res, 500, { error: e.message });
          }
        }
    }
  },
  {
    method: 'GET', path: '/api/problems',
    handler: async (req, res, u, ctx) => {
      const p = u.pathname, method = req.method;
        if (p === '/api/problems' && method === 'GET') {
          const list = problemWithStatus();
          return sendJSON(res, 200, { problems: list, groups: groupByProblems(list), stats: practiceStats() });
        }
    }
  },
  {
    method: 'GET', pattern: /^\/api\/problems\/(\d+)$/,
    handler: async (req, res, u, ctx) => {
      const p = u.pathname, method = req.method;
        const probDetailMatch = p.match(/^\/api\/problems\/(\d+)$/);
        if (probDetailMatch && method === 'GET') {
          const prob = db.prepare('SELECT * FROM problems WHERE id = ?').get(Number(probDetailMatch[1]));
          if (!prob) return sendJSON(res, 404, { error: '题目不存在' });
          const refresh = u.searchParams.get('refresh') === '1';
          let notice = '';
          if (!prob.statement || refresh) {
            try {
              await fetchProblemStatement(prob);
            } catch (e) {
              notice = e.message;
            }
            prob.statement = db.prepare('SELECT statement FROM problems WHERE id = ?').get(prob.id).statement;
          }
          const records = db.prepare('SELECT * FROM practice_records WHERE problem_id = ? ORDER BY date DESC, id DESC').all(prob.id);
          const st = practiceSettings();
          const dm = prob.done_manual === undefined || prob.done_manual === null ? -1 : Number(prob.done_manual);
          return sendJSON(res, 200, {
            problem: { ...prob, done_manual: dm, groups: safeParse(prob.groups) || [], tags: safeParse(prob.tags) || [], snapshots: [] },
            records, notice, settings: st,
            /* 题目页顶部的「完成状态」按钮要跟着列表一致，所以这里也算一次 */
            done: dm >= 0 ? !!dm : records.some(r => r.passed),
            langs: Object.keys(LANG_EXT).map(k => ({ id: k, name: LANG_NAME[k] }))
          });
        }
    }
  },
  {
    method: 'POST', pattern: /^\/api\/problems\/(\d+)\/records$/,
    handler: async (req, res, u, ctx) => {
      const p = u.pathname, method = req.method;
        const probRecordsMatch = p.match(/^\/api\/problems\/(\d+)\/records$/);
        if (probRecordsMatch && method === 'POST') {
          const pid = Number(probRecordsMatch[1]);
          const prob = db.prepare('SELECT id FROM problems WHERE id = ?').get(pid);
          if (!prob) return sendJSON(res, 404, { error: '题目不存在' });
          const body = await readBody(req);
          const t = nowISO();
          const date = String(body.date || '').trim().slice(0, 10) || todayStr();
          const passed = body.passed ? 1 : 0;
          const language = String(body.language || '').slice(0, 30);
          const code = String(body.code || '').slice(0, 60000);
          const notes = String(body.notes || '').slice(0, 4000);
          const minutes = Math.max(0, Math.min(600, Number(body.minutes) || 0));
          const goalId = Number(body.goal_id) || 0;
          const r = db.prepare('INSERT INTO practice_records (problem_id, goal_id, date, passed, language, code, notes, minutes, created_at) VALUES (?,?,?,?,?,?,?,?,?)')
            .run(pid, goalId, date, passed, language, code, notes, minutes, t);
          const rid = Number(r.lastInsertRowid);
          /* 记一次「通过」就把当日任务里这道题勾掉。
           * 若记的是「未通过」而当天任务已勾选，也要取消 —— 否则题目标成未通过、
           * 今日任务却还打勾，两处状态永远对不上（用户报的「不同步」有一半是这个）。 */
          syncDailyItem(goalId, date, pid, rid, passed ? true : null);
          return sendJSON(res, 201, { id: rid });
        }
    }
  },
  {
    method: 'PUT', pattern: /^\/api\/records\/(\d+)$/,
    handler: async (req, res, u, ctx) => {
      const p = u.pathname, method = req.method;
        const recEditMatch = p.match(/^\/api\/records\/(\d+)$/);
        if (recEditMatch && method === 'PUT') {
          const rid = Number(recEditMatch[1]);
          const old = db.prepare('SELECT * FROM practice_records WHERE id = ?').get(rid);
          if (!old) return sendJSON(res, 404, { error: '记录不存在' });
          const body = await readBody(req);
          /* 只覆盖传了的字段，没传的沿用原值 —— 前端表单只提交可见项，
             若一律取默认值会把「用时/语言/笔记」抹掉。 */
          const date = String(body.date === undefined ? old.date : (body.date || '')).trim().slice(0, 10) || todayStr();
          const passed = body.passed === undefined ? old.passed : (body.passed ? 1 : 0);
          const language = String(body.language === undefined ? old.language : (body.language || '')).slice(0, 30);
          const code = String(body.code === undefined ? old.code : (body.code || '')).slice(0, 60000);
          const notes = String(body.notes === undefined ? old.notes : (body.notes || '')).slice(0, 4000);
          const minutes = Math.max(0, Math.min(600, Number(body.minutes === undefined ? old.minutes : body.minutes) || 0));
          const goalId = Number(body.goal_id) || old.goal_id || 0;
          db.prepare('UPDATE practice_records SET date=?, passed=?, language=?, code=?, notes=?, minutes=?, goal_id=? WHERE id=?')
            .run(date, passed, language, code, notes, minutes, goalId, rid);
          /* 通过状态变了才动当日任务，避免只是改个笔记就把勾去掉了 */
          if (passed !== old.passed) syncDailyItem(goalId, date, old.problem_id, rid, passed ? true : false);
          return sendJSON(res, 200, { ok: true, id: rid });
        }
    }
  },
  {
    method: 'DELETE', pattern: /^\/api\/records\/(\d+)$/,
    handler: async (req, res, u, ctx) => {
      const p = u.pathname, method = req.method;
        const recordDelMatch = p.match(/^\/api\/records\/(\d+)$/);
        if (recordDelMatch && method === 'DELETE') {
          db.prepare('DELETE FROM practice_records WHERE id = ?').run(Number(recordDelMatch[1]));
          return sendJSON(res, 200, { ok: true });
        }
    }
  },
  /* 手动改「完成状态」。与 daily/toggle 分开：那个只管当日任务的几道题，
     这里管题库里任何一道题（用户要求能在「按知识点练习」和题目页里直接改）。
     done 传 true/false；传 'auto' 交回自动判定（按作答记录）。 */
  {
    method: 'POST', pattern: /^\/api\/problems\/(\d+)\/done$/,
    handler: async (req, res, u, ctx) => {
      const p = u.pathname, method = req.method;
        const probDoneMatch = p.match(/^\/api\/problems\/(\d+)\/done$/);
        if (probDoneMatch && method === 'POST') {
          const pid = Number(probDoneMatch[1]);
          const prob = db.prepare('SELECT id FROM problems WHERE id = ?').get(pid);
          if (!prob) return sendJSON(res, 404, { error: '题目不存在' });
          let body = {};
          try { body = await readBody(req); } catch (e) {}
          const raw = body.done;
          const v = (raw === 'auto' || raw === null || raw === undefined || raw === -1) ? -1 : (raw ? 1 : 0);
          db.prepare('UPDATE problems SET done_manual = ? WHERE id = ?').run(v, pid);
          /* 手动标完成时，若这道题正好在今天的任务里，一并勾上，反之亦然 */
          if (v >= 0) {
            const gid = Number(body.goal_id) || 0;
            if (gid) syncDailyItem(gid, todayStr(), pid, 0, !!v);
          }
          const full = problemWithStatus().find(x => x.id === pid) || null;
          return sendJSON(res, 200, { ok: true, done_manual: v, problem: full, stats: practiceStats() });
        }
    }
  },
  {
    method: 'GET', pattern: /^\/api\/problems\/(\d+)\/solution$/,
    handler: async (req, res, u, ctx) => {
      const p = u.pathname, method = req.method;
        const probSolMatch = p.match(/^\/api\/problems\/(\d+)\/solution$/);
        if (probSolMatch && method === 'GET') {
          const prob = db.prepare('SELECT * FROM problems WHERE id = ?').get(Number(probSolMatch[1]));
          if (!prob) return sendJSON(res, 404, { error: '题目不存在' });
          const st = practiceSettings();
          const lang = LANG_EXT[u.searchParams.get('lang') || ''] ? u.searchParams.get('lang') : st.language;
          const ext = LANG_EXT[lang] || 'py';
          const safe = String(prob.title || prob.slug).replace(/[\\/:*?"<>|\n\r]/g, '').slice(0, 60).trim();
          const file = path.join(st.dir, prob.fid + '.' + (safe || prob.slug) + '.' + ext);
          let code = '';
          let exists = false;
          try { code = fs.readFileSync(file, 'utf8'); exists = true; } catch (e) {}
          return sendJSON(res, 200, { file, exists, code, lang });
        }
    }
  },
  {
    method: 'POST', pattern: /^\/api\/problems\/(\d+)\/ide$/,
    handler: async (req, res, u, ctx) => {
      const p = u.pathname, method = req.method;
        const probIdeMatch = p.match(/^\/api\/problems\/(\d+)\/ide$/);
        if (probIdeMatch && method === 'POST') {
          const prob = db.prepare('SELECT * FROM problems WHERE id = ?').get(Number(probIdeMatch[1]));
          if (!prob) return sendJSON(res, 404, { error: '题目不存在' });
          let language = '';
          try { const b = await readBody(req); language = String(b.language || ''); } catch (e) {}
          try {
            const r = openInIDE(prob, language);
            return sendJSON(res, 200, r);
          } catch (e) {
            return sendJSON(res, 500, { error: e.message });
          }
        }
    }
  },
  {
    method: 'GET', path: '/api/practice/vscode',
    handler: async (req, res, u, ctx) => {
      const p = u.pathname, method = req.method;
        if (p === '/api/practice/vscode' && method === 'GET') {
          const cur = leetcodeWorkspaceFolder();
          const want = practiceSettings().dir;
          return sendJSON(res, 200, { current: cur, want, ok: cur === want, settingsPath: vscodeSettingsPath() });
        }
    }
  },
  {
    method: 'POST', path: '/api/practice/vscode/fix',
    handler: async (req, res, u, ctx) => {
      const p = u.pathname, method = req.method;
        if (p === '/api/practice/vscode/fix' && method === 'POST') {
          const want = practiceSettings().dir;
          const ok = fixVscodeWorkspaceFolder(want);
          return sendJSON(res, ok ? 200 : 500, ok ? { ok: true, current: want } : { error: '无法写入 VSCode 设置文件' });
        }
    }
  },
  {
    method: 'GET', path: '/api/practice/settings',
    handler: async (req, res, u, ctx) => {
      const p = u.pathname, method = req.method;
        if (p === '/api/practice/settings' && method === 'GET') {
          const s = practiceSettings();
          const dirExists = (() => { try { return fs.existsSync(s.dir); } catch (e) { return false; } })();
          return sendJSON(res, 200, { ...s, dirExists, user: (lcSession() || {}).name || '', langs: Object.keys(LANG_EXT).map(k => ({ id: k, name: LANG_NAME[k] })) });
        }
    }
  },
  {
    method: 'POST', path: '/api/practice/settings',
    handler: async (req, res, u, ctx) => {
      const p = u.pathname, method = req.method;
        if (p === '/api/practice/settings' && method === 'POST') {
          const body = await readBody(req);
          if (body.dir != null) setSetting('practice_dir', String(body.dir).trim().slice(0, 300));
          if (body.language != null && LANG_EXT[String(body.language)]) setSetting('practice_lang', String(body.language));
          if (body.daily_size != null) setSetting('practice_daily', String(Math.max(1, Math.min(10, Number(body.daily_size) || 3))));
          return sendJSON(res, 200, practiceSettings());
        }
    }
  },
  {
    method: 'GET', pattern: /^\/api\/goals\/(\d+)\/daily$/,
    handler: async (req, res, u, ctx) => {
      const p = u.pathname, method = req.method;
        const dailyMatch = p.match(/^\/api\/goals\/(\d+)\/daily$/);
        if (dailyMatch) {
          const gid = Number(dailyMatch[1]);
          if (method === 'GET') {
            const plan = getDailyPlan(gid);
            const items = safeParse(plan.items) || [];
            const problems = problemWithStatus();
            const byId = {};
            for (const pr of problems) byId[pr.id] = pr;
            return sendJSON(res, 200, {
              date: plan.date,
              items: items.map(it => ({ ...it, problem: byId[it.pid] || null })),
              stats: practiceStats(),
              settings: practiceSettings(),
              hasProblems: problems.length > 0
            });
          }
          if (method === 'POST') {
            let size = 0;
            try { const b = await readBody(req); size = Number(b.size) || 0; } catch (e) {}
            const today = todayStr();
            const problems = problemWithStatus();
            const unsolved = problems.filter(x => !x.done);
            const want = Math.max(1, Math.min(10, size || practiceSettings().daily_size));
            const picks = unsolved.slice(0, want);
            const items = picks.map(x => ({ pid: x.id, done: false, done_at: '', record_id: 0 }));
            db.prepare('DELETE FROM daily_plans WHERE goal_id = ? AND date = ?').run(gid, today);
            db.prepare('INSERT INTO daily_plans (goal_id, date, items, created_at) VALUES (?,?,?,?)').run(gid, today, JSON.stringify(items), nowISO());
            const plan = db.prepare('SELECT * FROM daily_plans WHERE goal_id = ? AND date = ?').get(gid, today);
            const byId = {};
            for (const pr of problems) byId[pr.id] = pr;
            return sendJSON(res, 200, { date: plan.date, items: items.map(it => ({ ...it, problem: byId[it.pid] || null })), stats: practiceStats() });
          }
        }
    }
  },
  {
    method: 'POST', pattern: /^\/api\/goals\/(\d+)\/daily\/toggle$/,
    handler: async (req, res, u, ctx) => {
      const p = u.pathname, method = req.method;
        const dailyToggleMatch = p.match(/^\/api\/goals\/(\d+)\/daily\/toggle$/);
        if (dailyToggleMatch && method === 'POST') {
          const gid = Number(dailyToggleMatch[1]);
          const body = await readBody(req);
          const pid = Number(body.pid);
          const plan = db.prepare('SELECT * FROM daily_plans WHERE goal_id = ? AND date = ?').get(gid, todayStr());
          if (!plan) return sendJSON(res, 404, { error: '今天还没有任务' });
          const items = safeParse(plan.items) || [];
          let found = false;
          for (const it of items) {
            if (Number(it.pid) === pid) { it.done = !!body.done; it.done_at = it.done ? nowISO() : ''; found = true; }
          }
          if (!found) return sendJSON(res, 404, { error: '任务里没有这道题' });
          db.prepare('UPDATE daily_plans SET items = ? WHERE id = ?').run(JSON.stringify(items), plan.id);
          return sendJSON(res, 200, { ok: true, items });
        }
    }
  }
  ]
};

/* ===================== 以下为插件实现 ===================== */
/* ===== 每日刷题（LeetCode 热题 100） ===== */
let LC_USER_FILE_DEFAULT = '';
const LANG_EXT = { python3: 'py', python: 'py', cpp: 'cpp', c: 'c', java: 'java', javascript: 'js', typescript: 'ts', go: 'go', rust: 'rs', csharp: 'cs', kotlin: 'kt', swift: 'swift', php: 'php', ruby: 'rb', scala: 'scala', sql: 'sql', mysql: 'sql' };
const LANG_NAME = { python3: 'Python3', python: 'Python', cpp: 'C++', c: 'C', java: 'Java', javascript: 'JavaScript', typescript: 'TypeScript', go: 'Go', rust: 'Rust', csharp: 'C#', kotlin: 'Kotlin', swift: 'Swift', php: 'PHP', ruby: 'Ruby', scala: 'Scala', sql: 'MySQL' };
function lcUserFile() {
  const custom = (getSetting('lc_user_file', '') || process.env.SIERXING_LC_USER_FILE || '').trim();
  return custom || LC_USER_FILE_DEFAULT;
}
function lcSession() {
  try {
    const u = JSON.parse(fs.readFileSync(lcUserFile(), 'utf8'));
    if (!u || !u.sessionId) return null;
    return { session: u.sessionId, csrf: u.sessionCSRF || '', name: u.name || '' };
  } catch (e) { return null; }
}
function lcHeaders(referer) {
  const s = lcSession();
  const h = {
    'Content-Type': 'application/json',
    'User-Agent': 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
    'Accept-Language': 'zh-CN,zh;q=0.9',
    'Origin': 'https://leetcode.cn',
    'Referer': referer || 'https://leetcode.cn/problemset/'
  };
  if (s) { h.Cookie = 'LEETCODE_SESSION=' + s.session + '; csrftoken=' + s.csrf; h['x-csrftoken'] = s.csrf; }
  return h;
}
function findKey(o, key) {
  if (!o || typeof o !== 'object') return null;
  if (!Array.isArray(o) && o[key] != null) return o[key];
  for (const k of Object.keys(o)) {
    const r = findKey(o[k], key);
    if (r != null) return r;
  }
  return null;
}
async function syncHot100() {
  const url = 'https://leetcode.cn/studyplan/top-100-liked/';
  const res = await fetch(url, { headers: lcHeaders(url) });
  if (!res.ok) throw new Error('题单获取失败（HTTP ' + res.status + '）');
  const html = await res.text();
  const m = html.match(/<script id="__NEXT_DATA__" type="application\/json">([\s\S]*?)<\/script>/);
  if (!m) throw new Error('题单解析失败（页面结构变化或需要登录）');
  const data = JSON.parse(m[1]);
  const groups = findKey(data, 'planSubGroups');
  if (!Array.isArray(groups) || !groups.length) throw new Error('题单为空（可能未登录 leetcode.cn）');
  const map = new Map();
  const groupList = [];
  let idx = 0;
  for (const g of groups) {
    const gname = String(g.name || '').trim();
    const qs = Array.isArray(g.questions) ? g.questions : [];
    if (gname) groupList.push({ name: gname, count: qs.length });
    for (const q of qs) {
      if (!q || !q.titleSlug) continue;
      idx++;
      if (!map.has(q.titleSlug)) {
        map.set(q.titleSlug, {
          fid: Number(q.questionFrontendId || q.id || 0),
          slug: q.titleSlug,
          title: q.translatedTitle || q.title || q.titleSlug,
          difficulty: q.difficulty || '',
          groups: [], tags: [], sort_index: idx
        });
      }
      const item = map.get(q.titleSlug);
      if (gname && !item.groups.includes(gname)) item.groups.push(gname);
      for (const t of (q.topicTags || [])) {
        const tn = t.nameTranslated || t.name;
        if (tn && !item.tags.includes(tn)) item.tags.push(tn);
      }
    }
  }
  const t = nowISO();
  const up = db.prepare(`INSERT INTO problems (fid, slug, title, difficulty, link, groups, tags, sort_index, synced_at)
    VALUES (?,?,?,?,?,?,?,?,?)
    ON CONFLICT(slug) DO UPDATE SET fid=excluded.fid, title=excluded.title, difficulty=excluded.difficulty,
      link=excluded.link, groups=excluded.groups, tags=excluded.tags, sort_index=excluded.sort_index, synced_at=excluded.synced_at`);
  for (const p of map.values()) {
    up.run(p.fid, p.slug, p.title, p.difficulty, 'https://leetcode.cn/problems/' + p.slug + '/', JSON.stringify(p.groups), JSON.stringify(p.tags), p.sort_index, t);
  }
  return { total: map.size, groups: groupList, user: (lcSession() || {}).name || '' };
}
function sanitizeStatement(html) {
  let s = String(html || '');
  s = s.replace(/<script[\s\S]*?<\/script>/gi, '').replace(/<style[\s\S]*?<\/style>/gi, '');
  s = s.replace(/\son[a-z]+\s*=\s*"[^"]*"/gi, '').replace(/\son[a-z]+\s*=\s*'[^']*'/gi, '');
  s = s.replace(/(<img[^>]+src\s*=\s*["'])\/(?!\/)/gi, '$1https://leetcode.cn/');
  return s;
}
async function fetchProblemStatement(p) {
  const query = 'query getQuestionDetail($titleSlug: String!) { question(titleSlug: $titleSlug) { content translatedContent stats codeDefinition sampleTestCase enableRunCode } }';
  const res = await fetch('https://leetcode.cn/graphql/', {
    method: 'POST', headers: lcHeaders(p.link),
    body: JSON.stringify({ query, variables: { titleSlug: p.slug }, operationName: 'getQuestionDetail' })
  });
  const j = await res.json().catch(() => null);
  const q = j && j.data && j.data.question;
  if (!q) throw new Error('题面获取失败（' + ((j && j.errors && j.errors[0] && j.errors[0].message) || '请检查 leetcode.cn 登录状态') + '）');
  const html = sanitizeStatement(q.translatedContent || q.content || '');
  let stats = '';
  try { const st = JSON.parse(q.stats || '{}'); stats = (st.totalAccepted || '') + ' 通过 / ' + (st.totalSubmission || '') + ' 提交'; } catch (e) {}
  let snippets = [];
  try {
    snippets = (JSON.parse(q.codeDefinition || '[]') || []).map(s => ({ langSlug: s.langSlug || s.value || '', lang: s.value || s.langSlug || '', code: s.defaultCode || '' }));
  } catch (e) {}
  db.prepare('UPDATE problems SET statement = ?, statement_at = ?, snapshots = ? WHERE id = ?')
    .run(html, nowISO(), JSON.stringify(snippets), p.id);
  return { html, stats, snippets };
}
function practiceSettings() {
  return {
    dir: getSetting('practice_dir', path.join(os.homedir(), 'Leetcode')),
    language: getSetting('practice_lang', 'python3'),
    daily_size: Math.max(1, Math.min(10, Number(getSetting('practice_daily', '3')) || 3))
  };
}
function todayStr() {
  const d = new Date();
  const p2 = n => String(n).padStart(2, '0');
  return d.getFullYear() + '-' + p2(d.getMonth() + 1) + '-' + p2(d.getDate());
}
/** 题目 + 作答状态。
 *  attempts / passed  来自作答记录（「真的提交通过了几次」），不被人为改动
 *  done              界面上的「完成状态」= 手动值优先，没有手动值才按记录判定
 *  done_manual       -1 自动 / 0 手动未完成 / 1 手动完成 */
/** 把当日任务里某道题的完成状态同步成 done。
 *  rid>0 表示这次改动来自一条作答记录，null 表示「通过」记录导致的自动勾选，
 *  0 表示纯手动（不绑定记录）。找不到该题在任务里就直接不动。 */
function syncDailyItem(goalId, date, pid, rid, done) {
  if (!goalId) return;
  const plan = db.prepare('SELECT * FROM daily_plans WHERE goal_id = ? AND date = ?').get(goalId, date);
  if (!plan) return;
  const items = safeParse(plan.items) || [];
  let changed = false;
  for (const it of items) {
    if (Number(it.pid) !== pid) continue;
    if (it.done === !!done && (!done || it.record_id === rid)) continue;
    it.done = !!done;
    it.done_at = done ? nowISO() : '';
    if (done) it.record_id = rid;
    else if (!rid) it.record_id = 0;
    changed = true;
  }
  if (changed) db.prepare('UPDATE daily_plans SET items = ? WHERE id = ?').run(JSON.stringify(items), plan.id);
}
function problemWithStatus() {
  const stat = {};
  for (const r of db.prepare('SELECT problem_id, COUNT(*) AS attempts, SUM(passed) AS passed, MAX(date) AS last_date FROM practice_records GROUP BY problem_id').all()) {
    stat[r.problem_id] = { attempts: r.attempts, passed: r.passed || 0, last_date: r.last_date || '' };
  }
  const probs = db.prepare("SELECT id, fid, slug, title, difficulty, link, groups, tags, sort_index, done_manual, (statement <> '') AS has_statement FROM problems ORDER BY sort_index, fid").all();
  return probs.map(p => {
    const st = stat[p.id] || { attempts: 0, passed: 0, last_date: '' };
    const dm = p.done_manual === undefined || p.done_manual === null ? -1 : Number(p.done_manual);
    return {
      ...p, done_manual: dm,
      groups: safeParse(p.groups) || [], tags: safeParse(p.tags) || [],
      attempts: st.attempts, passed: st.passed, last_date: st.last_date,
      done: dm >= 0 ? !!dm : st.passed > 0
    };
  });
}
/** 知识点分组的进度：已解决数按「完成状态」算，与列表上的圆点保持一致 */
function groupByProblems(list) {
  const groups = [];
  for (const pr of list) {
    for (const g of pr.groups) {
      let it = groups.find(x => x.name === g);
      if (!it) { it = { name: g, problems: [], solved: 0, total: 0 }; groups.push(it); }
      it.problems.push(pr);
      it.total++;
      if (pr.done) it.solved++;
    }
  }
  return groups;
}
function practiceStats() {
  const total = db.prepare('SELECT COUNT(*) AS n FROM problems').get().n;
  const solved = db.prepare('SELECT COUNT(DISTINCT problem_id) AS n FROM practice_records WHERE passed = 1').get().n;
  const attempts = db.prepare('SELECT COUNT(*) AS n FROM practice_records').get().n;
  const dates = new Set(db.prepare('SELECT DISTINCT date FROM practice_records WHERE passed = 1').all().map(r => r.date));
  let streak = 0;
  const base = new Date();
  for (let i = 0; i < 400; i++) {
    const d = new Date(base.getTime() - i * 86400000);
    const key = d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
    if (dates.has(key)) streak++;
    else if (i === 0) continue;
    else break;
  }
  return { total, solved, attempts, streak, active_days: dates.size };
}
function getDailyPlan(goalId, size) {
  const today = todayStr();
  let plan = db.prepare('SELECT * FROM daily_plans WHERE goal_id = ? AND date = ?').get(goalId, today);
  const st = practiceSettings();
  const want = size || st.daily_size;
  if (!plan) {
    const problems = problemWithStatus();
    const unsolved = problems.filter(p => !p.done);   // 按「完成状态」挑，不是只看有没有通过记录
    const picks = unsolved.slice(0, want);
    const items = picks.map(p => ({ pid: p.id, done: false, done_at: '', record_id: 0 }));
    db.prepare('INSERT INTO daily_plans (goal_id, date, items, created_at) VALUES (?,?,?,?)').run(goalId, today, JSON.stringify(items), nowISO());
    plan = db.prepare('SELECT * FROM daily_plans WHERE goal_id = ? AND date = ?').get(goalId, today);
  }
  return plan;
}
/* LeetCode 的 langSlug 与本组件的语言 id 不完全同名，模板匹配前先归一 */
const LANG_SLUG_ALIAS = { python: 'python3', python3: 'python3', sql: 'mysql', mysql: 'mysql', c: 'c', cpp: 'cpp', java: 'java', golang: 'go', go: 'go', rust: 'rust', csharp: 'csharp', 'c#': 'csharp', kotlin: 'kotlin', swift: 'swift', php: 'php', ruby: 'ruby', scala: 'scala', javascript: 'javascript', typescript: 'typescript' };
/** 这道题在该语言下的官方起始代码（抓题面时 codeDefinition 一起存进了 snapshots）。
 *  找不到才退回通用骨架 —— 早先一律退回通用骨架，而那份骨架里写死了 twoSum，
 *  于是「在 VSCode 里作答」打开任何题都是两数之和。 */
function codeDefFor(problem, lang) {
  const want = LANG_SLUG_ALIAS[lang] || lang;
  const list = safeParse(problem && problem.snapshots) || [];
  for (const s of list) {
    const slug = String((s && s.langSlug) || '').trim();
    if (!slug) continue;
    if (slug === want || LANG_SLUG_ALIAS[slug] === want) {
      const code = String((s && s.code) || '');
      if (code.trim()) return code.replace(/\s+$/, '');
    }
  }
  return '';
}
function templateFor(lang, problem) {
  const def = problem ? codeDefFor(problem, lang) : '';
  if (def) return def + '\n';
  const L = LANG_NAME[lang] || 'Python3';
  if (lang === 'python3' || lang === 'python') return 'class Solution:\n    pass\n';
  if (lang === 'cpp') return '#include <bits/stdc++.h>\nusing namespace std;\n\nclass Solution {\npublic:\n};\n';
  if (lang === 'java') return 'class Solution {\n}\n';
  if (lang === 'javascript' || lang === 'typescript') return '// ' + L + '\nvar solve = function() {\n};\n';
  if (lang === 'go') return 'package main\n\nfunc main() {\n}\n';
  if (lang === 'rust') return 'impl Solution {\n}\n';
  return '// ' + L + '\n';
}
let VSCODE_SETTINGS = '';
let VSCODE_SETTINGS_ALT = '';
function vscodeSettingsPath() {
  if (fs.existsSync(VSCODE_SETTINGS)) return VSCODE_SETTINGS;
  if (fs.existsSync(VSCODE_SETTINGS_ALT)) return VSCODE_SETTINGS_ALT;
  return VSCODE_SETTINGS;
}
function readVscodeSettings() {
  const f = vscodeSettingsPath();
  try { return { path: f, raw: fs.readFileSync(f, 'utf8') }; } catch (e) { return { path: f, raw: '' }; }
}
function leetcodeWorkspaceFolder() {
  const { raw } = readVscodeSettings();
  const m = raw.match(/["']leetcode\.workspaceFolder["']\s*:\s*["']([^"']*)["']/);
  return m ? m[1] : '';
}
function fixVscodeWorkspaceFolder(dir) {
  const { path: f, raw } = readVscodeSettings();
  if (!raw) return false;
  const esc = dir.replace(/\\/g, '\\\\');
  let out;
  if (/["']leetcode\.workspaceFolder["']\s*:/.test(raw)) {
    out = raw.replace(/(["']leetcode\.workspaceFolder["']\s*:\s*)["'][^"']*["']/, '$1"' + esc + '"');
  } else {
    const idx = raw.lastIndexOf('}');
    if (idx < 0) return false;
    const head = raw.slice(0, idx).replace(/\s*$/, '');
    const needsComma = !/[{,]\s*$/.test(head);
    out = head + (needsComma ? ',' : '') + '\n    "leetcode.workspaceFolder": "' + esc + '",\n    "leetcode.endpoint": "leetcode-cn"\n' + raw.slice(idx);
  }
  try { fs.writeFileSync(f, out); return true; } catch (e) { return false; }
}
function openInIDE(problem, language) {
  const st = practiceSettings();
  const lang = LANG_EXT[language] ? language : st.language;
  const ext = LANG_EXT[lang] || 'py';
  const dir = st.dir;
  fs.mkdirSync(dir, { recursive: true });
  const safe = String(problem.title || problem.slug).replace(/[\\/:*?"<>|\n\r]/g, '').slice(0, 60).trim();
  const file = path.join(dir, problem.fid + '.' + (safe || problem.slug) + '.' + ext);
  let created = false;
  if (!fs.existsSync(file)) {
    const lines = [];
    if (lang === 'python3' || lang === 'python' || lang === 'ruby') {
      lines.push('# @lc app=leetcode.cn id=' + problem.fid + ' lang=' + lang);
      lines.push('#');
      lines.push('# [' + problem.fid + '] ' + problem.title);
      lines.push('# ' + problem.link);
    } else {
      lines.push('/*');
      lines.push(' * @lc app=leetcode.cn id=' + problem.fid + ' lang=' + lang);
      lines.push(' *');
      lines.push(' * [' + problem.fid + '] ' + problem.title);
      lines.push(' * ' + problem.link);
      lines.push(' */');
    }
    lines.push('');
    lines.push(templateFor(lang, problem));
    fs.writeFileSync(file, lines.join('\n'));
    created = true;
  }
  try {
    const c1 = spawn('code', [dir], { detached: true, stdio: 'ignore' });
    c1.unref();
    setTimeout(() => {
      try { const c2 = spawn('code', [file], { detached: true, stdio: 'ignore' }); c2.unref(); } catch (e) {}
    }, 1200);
  } catch (e) {}
  return { file, dir, lang, langName: LANG_NAME[lang] || lang, created };
}
