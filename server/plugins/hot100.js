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
);
/* 复习卡：一题一行。这里刻意不存「下次该哪天复习」——
   用户不一定每天做题，把日期钉死只会攒出一堆过期项（见下面 reviewCandidates 的注释）。
   只记「复习过几次 / 上次什么时候 / 上次判定 / 最近盲写一致度」，遗忘风险由 riskOf 现算。 */
CREATE TABLE IF NOT EXISTS review_cards (
  problem_id INTEGER PRIMARY KEY,
  goal_id INTEGER NOT NULL DEFAULT 0,
  reviews INTEGER NOT NULL DEFAULT 0,
  last_review_at TEXT NOT NULL DEFAULT '',
  last_verdict TEXT NOT NULL DEFAULT '',
  last_score INTEGER NOT NULL DEFAULT -1,
  risk INTEGER NOT NULL DEFAULT 0,
  updated_at TEXT NOT NULL DEFAULT ''
);
/* 每天由 AI 排的复习清单：一个目标一天一条，用户可以随时重排。 */
CREATE TABLE IF NOT EXISTS review_plans (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  goal_id INTEGER NOT NULL DEFAULT 0,
  date TEXT NOT NULL DEFAULT '',
  items TEXT NOT NULL DEFAULT '[]',
  note TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE(goal_id, date)
);
/* 思路卡：AI 引导用户一步步说出来的思路，一题一行。
   approach 是整理后的成品，pitfalls 是老字段（保留兼容旧备份/旧前端）。
   reference_code 是用户自己写的、跑得通的版本 —— 盲写考核时 AI 拿它当基准。 */
CREATE TABLE IF NOT EXISTS problem_mind (
  problem_id INTEGER PRIMARY KEY,
  approach TEXT NOT NULL DEFAULT '',
  pitfalls TEXT NOT NULL DEFAULT '',
  reference_code TEXT NOT NULL DEFAULT '',
  updated_at TEXT NOT NULL DEFAULT ''
);
/* 引导式提炼的一次会话：AI 一次只问一个问题，用户口语回答，逐步逼近核心思路。
   steps 是 [{q,a}] 的 JSON。status='active' 时还没整理成思路卡。 */
CREATE TABLE IF NOT EXISTS mind_sessions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  problem_id INTEGER NOT NULL,
  goal_id INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'active',
  steps TEXT NOT NULL DEFAULT '[]',
  summary TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
/* 盲写考核：遮住参考代码凭记忆重写一遍，AI 对照两份代码给出判定。
   report 是 AI 的结构化结论 JSON（思路一致度 / 漏了什么 / 写错什么 / 判定）。 */
CREATE TABLE IF NOT EXISTS recall_tests (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  problem_id INTEGER NOT NULL,
  goal_id INTEGER NOT NULL DEFAULT 0,
  ref_code TEXT NOT NULL DEFAULT '',
  my_code TEXT NOT NULL DEFAULT '',
  report TEXT NOT NULL DEFAULT '',
  score INTEGER NOT NULL DEFAULT 0,
  verdict TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL
);
/* 易错卡片：AI 从每次盲写的差距里提炼出来的「你老在这儿栽」。
   AI 负责合并同类卡（每次错的点措辞不同）、按权重排序，权重 = 犯过几次 × 严重度。 */
CREATE TABLE IF NOT EXISTS pitfall_cards (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  problem_id INTEGER NOT NULL,
  goal_id INTEGER NOT NULL DEFAULT 0,
  tag TEXT NOT NULL DEFAULT '',
  title TEXT NOT NULL DEFAULT '',
  detail TEXT NOT NULL DEFAULT '',
  advice TEXT NOT NULL DEFAULT '',
  hits INTEGER NOT NULL DEFAULT 1,
  weight INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'open',
  source_test INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_pitfall_prob ON pitfall_cards(problem_id, status);
CREATE INDEX IF NOT EXISTS idx_recall_prob ON recall_tests(problem_id, id);
CREATE INDEX IF NOT EXISTS idx_mindsess_prob ON mind_sessions(problem_id, id);`;

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
    /* problem_mind 是在 1.7.0 之后加过 reference_code 的，老库补列 */
    try {
      const mc = db.prepare('PRAGMA table_info(problem_mind)').all().map(c => c.name);
      if (!mc.includes('reference_code')) db.exec("ALTER TABLE problem_mind ADD COLUMN reference_code TEXT NOT NULL DEFAULT '';");
    } catch (e) {}
    /* review_cards 在 1.8.0 从固定艾宾浩斯曲线改成「遗忘风险 + AI 排期」，
       老列 stage/next_due/last_result 是曲线下标、没有直接对应物。
       表是空的就重建；非空则补新列并把 stage 当成已记牢的轮数迁移过去，别丢用户的复习流。 */
    try {
      const rc = db.prepare('PRAGMA table_info(review_cards)').all().map(c => c.name);
      if (rc.length && !rc.includes('last_review_at')) {
        if (!db.prepare('SELECT COUNT(*) n FROM review_cards').get().n) db.exec('DROP TABLE review_cards;');
        else for (const [c, t] of [['reviews', 'INTEGER NOT NULL DEFAULT 0'], ['last_review_at', "TEXT NOT NULL DEFAULT ''"], ['last_verdict', "TEXT NOT NULL DEFAULT ''"], ['last_score', 'INTEGER NOT NULL DEFAULT -1'], ['risk', 'INTEGER NOT NULL DEFAULT 0']])
          if (!rc.includes(c)) db.exec('ALTER TABLE review_cards ADD COLUMN ' + c + ' ' + t + ';');
      }
    } catch (e) {}
    db.exec(SCHEMA);   // 上面可能 DROP 掉了 review_cards，这一句补建回新结构
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
      plans: ctx.db.prepare('SELECT * FROM daily_plans').all(),
      reviews: ctx.db.prepare('SELECT * FROM review_cards').all(),
      plansReview: ctx.db.prepare('SELECT * FROM review_plans').all(),
      minds: ctx.db.prepare('SELECT * FROM problem_mind').all(),
      mindSessions: ctx.db.prepare('SELECT * FROM mind_sessions').all(),
      recalls: ctx.db.prepare('SELECT * FROM recall_tests').all(),
      pitfalls: ctx.db.prepare('SELECT * FROM pitfall_cards').all()
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
    /* 1.8.0 起 review_cards 改成风险制（没有 stage/next_due/last_result 了）。
       1.7.0 的老备份里正好是那三列，所以按字段是否存在分别映射：
       老备份的 stage（艾宾浩斯轮数下标）换算成 reviews，让复习进度不至于归零。 */
    const newCols = db.prepare('PRAGMA table_info(review_cards)').all().map(c => c.name);
    const oldShape = newCols.includes('stage');
    for (const x of (data.reviews || [])) {
      if (oldShape) {
        db.prepare('INSERT OR REPLACE INTO review_cards (problem_id,goal_id,stage,next_due,last_result,updated_at) VALUES (?,?,?,?,?,?)')
          .run(x.problem_id, x.goal_id || 0, x.stage || 0, x.next_due || '', x.last_result || '', x.updated_at || '');
        continue;
      }
      const rv = (x.reviews !== undefined) ? Number(x.reviews) || 0
        : (x.stage !== undefined ? (Number(x.stage) || 0) + 1 : 0);   // 老备份：stage 越大=记得越牢
      const vd = x.last_verdict || ({ remembered: 'pass', fuzzy: 'fuzzy', forgotten: 'forgotten' }[x.last_result] || '');
      db.prepare('INSERT OR REPLACE INTO review_cards (problem_id,goal_id,reviews,last_review_at,last_verdict,last_score,risk,updated_at) VALUES (?,?,?,?,?,?,?,?)')
        .run(x.problem_id, x.goal_id || 0, rv, x.last_review_at || '', vd,
          x.last_score === undefined || x.last_score === null ? -1 : Number(x.last_score) || 0,
          Number(x.risk) || 0, x.updated_at || '');
    }
    for (const x of (data.minds || [])) db.prepare('INSERT OR REPLACE INTO problem_mind (problem_id,approach,pitfalls,reference_code,updated_at) VALUES (?,?,?,?,?)')
      .run(x.problem_id, x.approach || '', x.pitfalls || '', x.reference_code || '', x.updated_at || '');
    /* 下面三张表是 1.8.0 才有的，老备份里没有对应字段 —— 全部容错 */
    for (const x of (data.mindSessions || [])) db.prepare('INSERT OR REPLACE INTO mind_sessions (id,problem_id,goal_id,status,steps,summary,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?)')
      .run(x.id, x.problem_id, x.goal_id || 0, x.status || 'active', x.steps || '[]', x.summary || '', x.created_at || '', x.updated_at || '');
    for (const x of (data.recalls || [])) db.prepare('INSERT OR REPLACE INTO recall_tests (id,problem_id,goal_id,ref_code,my_code,report,score,verdict,created_at) VALUES (?,?,?,?,?,?,?,?,?)')
      .run(x.id, x.problem_id, x.goal_id || 0, x.ref_code || '', x.my_code || '', x.report || '', x.score || 0, x.verdict || '', x.created_at || '');
    for (const x of (data.pitfalls || [])) db.prepare('INSERT OR REPLACE INTO pitfall_cards (id,problem_id,goal_id,tag,title,detail,advice,hits,weight,status,source_test,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)')
      .run(x.id, x.problem_id, x.goal_id || 0, x.tag || '', x.title || '', x.detail || '', x.advice || '',
        x.hits || 1, x.weight || 0, x.status || 'open', x.source_test || 0, x.created_at || '', x.updated_at || '');
    /* 复习排期是「今天练哪几道」，跨设备没什么意义（各人作息不同），照样同步但不覆盖别人的当天清单 */
    for (const x of (data.plansReview || [])) {
      if (!x.goal_id || !x.date) continue;
      const has = db.prepare('SELECT id FROM review_plans WHERE goal_id = ? AND date = ?').get(x.goal_id, x.date);
      if (has) continue;
      db.prepare('INSERT OR REPLACE INTO review_plans (id,goal_id,date,items,note,created_at,updated_at) VALUES (?,?,?,?,?,?,?)')
        .run(x.id, x.goal_id, x.date, x.items || '[]', x.note || '', x.created_at || '', x.updated_at || '');
    }
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
          /* 通过 = 值得记住：自动加入艾宾浩斯复习（已在复习流里就不动） */
          if (passed) { try { enqueueReview(pid, goalId); } catch (e) {} }
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
          /* 改成通过也算"做出来了"，同样进复习流 */
          if (passed && !old.passed) { try { enqueueReview(old.problem_id, goalId); } catch (e) {} }
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
/* ---- 掌握闭环：AI 引导提炼思路 / 盲写重做 / 易错卡片 / 复习排期 ---- */
  {
    /* 一道题的全部「掌握闭环」状态：思路卡 + 进行中的引导会话 + 易错卡 + 复习卡 + 历次盲写 */
    method: 'GET', pattern: /^\/api\/problems\/(\d+)\/mind$/,
    handler: async (req, res, u, ctx) => {
      const p = u.pathname, method = req.method;
        const m = p.match(/^\/api\/problems\/(\d+)\/mind$/);
        if (m && method === 'GET') {
          const pid = Number(m[1]);
          const prob = db.prepare('SELECT id,fid,title,difficulty FROM problems WHERE id = ?').get(pid);
          if (!prob) return sendJSON(res, 404, { error: '题目不存在' });
          const row = db.prepare('SELECT * FROM problem_mind WHERE problem_id = ?').get(pid) || {};
          let sess = null;
          try {
            const s = db.prepare("SELECT * FROM mind_sessions WHERE problem_id = ? AND status = 'active' ORDER BY id DESC LIMIT 1").get(pid);
            if (s) { let steps = []; try { steps = safeParse(s.steps) || []; } catch (e) {} sess = { id: s.id, steps, summary: s.summary || '', updated_at: s.updated_at }; }
          } catch (e) {}
          const card = db.prepare('SELECT * FROM review_cards WHERE problem_id = ?').get(pid) || null;
          const recalls = db.prepare('SELECT id,score,verdict,report,created_at FROM recall_tests WHERE problem_id = ? ORDER BY id DESC LIMIT 8').all(pid);
          const cands = reviewCandidates(card && card.goal_id ? card.goal_id : 0);
          const self = cands.find(c => c.problem_id === pid) || null;
          return sendJSON(res, 200, {
            problem: prob,
            approach: row.approach || '',
            reference_code: row.reference_code || '',
            session: sess,
            pitfalls: problemPitfalls(pid),
            recallTests: recalls,
            review: card ? { ...card, risk: self ? self.risk : 0, why: self ? self.why : [] } : null
          });
        }
    }
  },
  {
    /* AI 引导提炼：一次只问一个问题。不传 answer 是首问，传了就是接着上一问往下走 */
    method: 'POST', pattern: /^\/api\/problems\/(\d+)\/mind\/ask$/,
    handler: async (req, res, u, ctx) => {
      const p = u.pathname, method = req.method;
        const m = p.match(/^\/api\/problems\/(\d+)\/mind\/ask$/);
        if (m && method === 'POST') {
          const pid = Number(m[1]);
          if (!db.prepare('SELECT id FROM problems WHERE id = ?').get(pid)) return sendJSON(res, 404, { error: '题目不存在' });
          if (typeof aiText !== 'function') return sendJSON(res, 500, { error: '当前环境没有可用 AI' });
          let body = {};
          try { body = await readBody(req); } catch (e) {}
          try {
            return sendJSON(res, 200, await coachAsk(pid, body.answer === undefined ? undefined : String(body.answer)));
          } catch (e) { return sendJSON(res, 500, { error: e.message || 'AI 没能问出问题' }); }
        }
    }
  },
  {
    /* 把对话整理成思路卡（只写进会话，落到存档要用户点保存） */
    method: 'POST', pattern: /^\/api\/problems\/(\d+)\/mind\/finish$/,
    handler: async (req, res, u, ctx) => {
      const p = u.pathname, method = req.method;
        const m = p.match(/^\/api\/problems\/(\d+)\/mind\/finish$/);
        if (m && method === 'POST') {
          const pid = Number(m[1]);
          if (!db.prepare('SELECT id FROM problems WHERE id = ?').get(pid)) return sendJSON(res, 404, { error: '题目不存在' });
          if (typeof aiText !== 'function') return sendJSON(res, 500, { error: '当前环境没有可用 AI' });
          try { return sendJSON(res, 200, await coachFinish(pid)); }
          catch (e) { return sendJSON(res, 500, { error: e.message || 'AI 整理失败' }); }
        }
    }
  },
  {
    /* 用户确认后把思路卡存进存档；同一请求里也能顺便存参考代码 */
    method: 'POST', pattern: /^\/api\/problems\/(\d+)\/mind$/,
    handler: async (req, res, u, ctx) => {
      const p = u.pathname, method = req.method;
        const m = p.match(/^\/api\/problems\/(\d+)\/mind$/);
        if (m && method === 'POST') {
          const pid = Number(m[1]);
          if (!db.prepare('SELECT id FROM problems WHERE id = ?').get(pid)) return sendJSON(res, 404, { error: '题目不存在' });
          const body = await readBody(req);
          const cur = db.prepare('SELECT * FROM problem_mind WHERE problem_id = ?').get(pid) || {};
          /* 只传要改的字段，不传的保持原样（前端会分两次调：先存思路卡，再存参考代码） */
          const approach = body.approach === undefined ? (cur.approach || '') : String(body.approach || '').slice(0, 20000);
          const refCode = body.reference_code === undefined ? (cur.reference_code || '') : String(body.reference_code || '').slice(0, 20000);
          db.prepare('INSERT INTO problem_mind (problem_id,approach,pitfalls,reference_code,updated_at) VALUES (?,?,?,?,?) ON CONFLICT(problem_id) DO UPDATE SET approach=excluded.approach, reference_code=excluded.reference_code, updated_at=excluded.updated_at')
            .run(pid, approach, cur.pitfalls || '', refCode, nowISO());
          /* 思路卡定了就收掉这次会话（session 里 summary 还能翻，但不再是 active） */
          if (approach && (cur.approach || '') !== approach) {
            db.prepare("UPDATE mind_sessions SET status='done', updated_at=? WHERE problem_id=? AND status='active'").run(nowISO(), pid);
          }
          return sendJSON(res, 200, { ok: true, approach, reference_code: refCode });
        }
    }
  },
  {
    /* 丢掉当前引导会话，从头再来（思路卡和易错卡不受影响） */
    method: 'POST', pattern: /^\/api\/problems\/(\d+)\/mind\/reset$/,
    handler: async (req, res, u, ctx) => {
      const p = u.pathname, method = req.method;
        const m = p.match(/^\/api\/problems\/(\d+)\/mind\/reset$/);
        if (m && method === 'POST') {
          db.prepare("DELETE FROM mind_sessions WHERE problem_id = ? AND status = 'active'").run(Number(m[1]));
          return sendJSON(res, 200, { ok: true });
        }
    }
  },
  {
    /* 盲写重做：AI 对照两份代码 → 判定 + 易错卡片（自动合并去重、按权重排序） */
    method: 'POST', pattern: /^\/api\/problems\/(\d+)\/recall\/check$/,
    handler: async (req, res, u, ctx) => {
      const p = u.pathname, method = req.method;
        const m = p.match(/^\/api\/problems\/(\d+)\/recall\/check$/);
        if (m && method === 'POST') {
          const pid = Number(m[1]);
          if (!db.prepare('SELECT id FROM problems WHERE id = ?').get(pid)) return sendJSON(res, 404, { error: '题目不存在' });
          if (typeof aiText !== 'function') return sendJSON(res, 500, { error: '当前环境没有可用 AI' });
          const body = await readBody(req);
          let ref = String(body.ref_code || '');
          if (!ref.trim()) ref = String((db.prepare('SELECT reference_code FROM problem_mind WHERE problem_id = ?').get(pid) || {}).reference_code || '');
          try {
            const out = await recallCheck(pid, body.my_code, ref, Number(body.goal_id) || 0);
            /* 重做之后顺手刷新参考代码（有更好的实现就更新基准），只在用户显式传 ref_code 时不覆盖 */
            if (!body.ref_code && out.report.verdict === 'pass' && out.report.score >= 90 && String(body.my_code || '').trim()) {
              db.prepare('INSERT INTO problem_mind (problem_id,approach,pitfalls,reference_code,updated_at) VALUES (?,?,?,?,?) ON CONFLICT(problem_id) DO UPDATE SET reference_code=excluded.reference_code, updated_at=excluded.updated_at')
                .run(pid, (db.prepare('SELECT approach FROM problem_mind WHERE problem_id = ?').get(pid) || {}).approach || '', '', String(body.my_code).slice(0, 20000), nowISO());
            }
            return sendJSON(res, 200, out);
          } catch (e) { return sendJSON(res, 500, { error: e.message || 'AI 对照失败' }); }
        }
    }
  },
  {
    /* 易错卡：攻克 / 取消攻克 / 删卡 */
    method: 'POST', pattern: /^\/api\/pitfalls\/(\d+)$/,
    handler: async (req, res, u, ctx) => {
      const p = u.pathname, method = req.method;
        const m = p.match(/^\/api\/pitfalls\/(\d+)$/);
        if (m && method === 'POST') {
          const id = Number(m[1]);
          const row = db.prepare('SELECT * FROM pitfall_cards WHERE id = ?').get(id);
          if (!row) return sendJSON(res, 404, { error: '这张易错卡不存在' });
          const body = await readBody(req);
          /* status: open / fixed / dropped（dropped = 这题我已经不需要它了） */
          const st = ['open', 'fixed', 'dropped'].includes(body.status) ? body.status : (row.status === 'fixed' ? 'open' : 'fixed');
          db.prepare('UPDATE pitfall_cards SET status=?, updated_at=? WHERE id=?').run(st, nowISO(), id);
          return sendJSON(res, 200, { ok: true, card: db.prepare('SELECT * FROM pitfall_cards WHERE id = ?').get(id) });
        }
    }
  },
  {
    method: 'DELETE', pattern: /^\/api\/pitfalls\/(\d+)$/,
    handler: async (req, res, u, ctx) => {
      const p = u.pathname, method = req.method;
        const m = p.match(/^\/api\/pitfalls\/(\d+)$/);
        if (m && method === 'DELETE') {
          db.prepare('DELETE FROM pitfall_cards WHERE id = ?').run(Number(m[1]));
          return sendJSON(res, 200, { ok: true });
        }
    }
  },
  /* ---- 复习：不按固定曲线排，AI 按「今天该练哪几道」现排 ---- */
  {
    /* 今天的复习清单（没排过 plan 为 null，前端据此提示排期） */
    method: 'GET', pattern: /^\/api\/reviews\/plan$/,
    handler: async (req, res, u, ctx) => {
      const p = u.pathname, method = req.method;
        if (p === '/api/reviews/plan' && method === 'GET') {
          const gid = Number(u.searchParams.get('goal_id')) || 0;
          const plan = todayPlan(gid);
          const cands = reviewCandidates(gid);
          return sendJSON(res, 200, {
            plan, pool: cands.length,
            topRisk: cands.slice(0, 5).map(c => ({ pid: c.problem_id, fid: c.fid, title: c.title, risk: c.risk })),
            overdue: cands.filter(c => c.risk >= 60).length
          });
        }
    }
  },
  {
    /* 重新排（AI 出主意；挑不出来按风险分兜底） */
    method: 'POST', pattern: /^\/api\/reviews\/plan$/,
    handler: async (req, res, u, ctx) => {
      const p = u.pathname, method = req.method;
        if (p === '/api/reviews/plan' && method === 'POST') {
          let body = {};
          try { body = await readBody(req); } catch (e) {}
          const gid = Number(body.goal_id) || 0;
          /* 重排前把已经练完的留下，别把用户刚做完的题又塞回来 */
          const prev = todayPlan(gid);
          if (prev) {
            const keep = prev.items.filter(x => x.done);
            if (keep.length) {
              const rest = reviewCandidates(gid).filter(c => !keep.some(k => k.pid === c.problem_id));
              const n = Math.max(1, Math.min(8, Number(body.size) || 3));
              const out = await planTodayReviews(gid, Math.max(1, n - keep.length));
              const items = keep.map(k => ({ ...k, done: true, at: k.at || nowISO() }))
                .concat((out.items || []).filter(x => !keep.some(k => k.pid === x.pid)).slice(0, Math.max(0, n - keep.length)));
              return sendJSON(res, 200, { plan: savePlan(gid, items, out.note), note: out.note, source: out.source, pool: out.pool });
            }
          }
          try {
            const out = await planTodayReviews(gid, body.size);
            return sendJSON(res, 200, { plan: todayPlan(gid), note: out.note, source: out.source, pool: out.pool });
          } catch (e) { return sendJSON(res, 500, { error: e.message || '排复习失败' }); }
        }
    }
  },
  {
    /* 清单里的一道标记练完了（盲写判定会自动记；这里是用户手动记的入口） */
    method: 'POST', pattern: /^\/api\/reviews\/plan\/item$/,
    handler: async (req, res, u, ctx) => {
      const p = u.pathname, method = req.method;
        if (p === '/api/reviews/plan/item' && method === 'POST') {
          const body = await readBody(req);
          const gid = Number(body.goal_id) || 0;
          const pid = Number(body.pid);
          const plan = todayPlan(gid);
          if (!plan) return sendJSON(res, 404, { error: '今天还没排复习' });
          const it = plan.items.find(x => Number(x.pid) === pid);
          if (!it) return sendJSON(res, 404, { error: '这道题不在今天的清单里' });
          const done = body.done === undefined ? true : !!body.done;
          it.done = done; it.at = done ? nowISO() : '';
          if (done) markReviewed(pid, body.verdict || 'pass', body.score);
          else db.prepare('UPDATE review_cards SET reviews = MAX(0, reviews - 1) WHERE problem_id = ?').run(pid);
          savePlan(gid, plan.items, plan.note);
          return sendJSON(res, 200, { plan: todayPlan(gid) });
        }
    }
  },
  {
    /* 手动加入复习流 */
    method: 'POST', pattern: /^\/api\/reviews\/(\d+)\/enqueue$/,
    handler: async (req, res, u, ctx) => {
      const p = u.pathname, method = req.method;
        const m = p.match(/^\/api\/reviews\/(\d+)\/enqueue$/);
        if (m && method === 'POST') {
          const pid = Number(m[1]);
          if (!db.prepare('SELECT id FROM problems WHERE id = ?').get(pid)) return sendJSON(res, 404, { error: '题目不存在' });
          let body = {};
          try { body = await readBody(req); } catch (e) {}
          enqueueReview(pid, Number(body.goal_id) || 0);
          return sendJSON(res, 200, { ok: true, card: db.prepare('SELECT * FROM review_cards WHERE problem_id = ?').get(pid) });
        }
    }
  },
  {
    /* 移出复习流（思路卡、易错卡、盲写记录都保留） */
    method: 'DELETE', pattern: /^\/api\/reviews\/(\d+)$/,
    handler: async (req, res, u, ctx) => {
      const p = u.pathname, method = req.method;
        const m = p.match(/^\/api\/reviews\/(\d+)$/);
        if (m && method === 'DELETE') {
          db.prepare('DELETE FROM review_cards WHERE problem_id = ?').run(Number(m[1]));
          return sendJSON(res, 200, { ok: true });
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
/* ===== 复习：遗忘风险 + AI 排期 =====
 * 为什么不用艾宾浩斯固定曲线：用户不一定每天做题。硬套 1/2/4/7/15/30/60 天，
 * 隔三天没练就会攒出一堆"到期"，隔十天再练又一次性压满 —— 只会越攒越不想打开。
 * 改成：按「距上次复习多久 / 上次判定 / 最近盲写一致度 / 易错卡权重 / 题目难度」
 * 算一个遗忘风险分（0~100），AI 在候选池里挑今天该练哪几道并说明理由。
 * 风险分只当排序依据 + AI 不可用时的兜底，排期本身是当天的、可重排的。 */
/** 距今多少天（按自然日算，跨月跨年都对） */
function daysSince(iso) {
  const s = String(iso || '').slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) return null;
  const a = new Date(s + 'T00:00:00'), b = new Date(todayStr() + 'T00:00:00');
  return Math.round((b - a) / 86400000);
}
/** 通过后自动加入复习（幂等：已在复习流里就只补 goal_id，不动进度） */
function enqueueReview(pid, goalId) {
  const has = db.prepare('SELECT * FROM review_cards WHERE problem_id = ?').get(pid);
  if (has) {
    if (goalId && !has.goal_id) db.prepare('UPDATE review_cards SET goal_id = ? WHERE problem_id = ?').run(goalId, pid);
    return has;
  }
  const t = nowISO();
  db.prepare('INSERT INTO review_cards (problem_id,goal_id,reviews,last_review_at,last_verdict,last_score,risk,updated_at) VALUES (?,?,0,\'\',\'\',-1,0,?)')
    .run(pid, goalId || 0, t);
  return db.prepare('SELECT * FROM review_cards WHERE problem_id = ?').get(pid);
}
/** 记一次复习结果（AI 判定或用户手动改）。score 为盲写一致度（-1 表示没盲写过）。 */
function markReviewed(pid, verdict, score) {
  const card = db.prepare('SELECT * FROM review_cards WHERE problem_id = ?').get(pid);
  if (!card) return null;
  const v = ['pass', 'fuzzy', 'forgotten'].includes(verdict) ? verdict : (verdict || card.last_verdict);
  const sc = (score === undefined || score === null || score === '') ? card.last_score : Math.max(0, Math.min(100, Math.round(Number(score) || 0)));
  const n = (Number(card.reviews) || 0) + 1;
  const t = nowISO();
  db.prepare('UPDATE review_cards SET reviews=?, last_review_at=?, last_verdict=?, last_score=?, updated_at=? WHERE problem_id=?')
    .run(n, t, v, sc, t, pid);
  return db.prepare('SELECT * FROM review_cards WHERE problem_id = ?').get(pid);
}
/** 一道题的遗忘风险 0~100 + 理由（AI 排期与兜底文案都用它） */
function riskOf(card, probs, pitfallAgg) {
  const p = probs[card.problem_id] || {};
  const pit = pitfallAgg[card.problem_id] || { open: 0, weight: 0 };
  const gap = card.last_review_at ? daysSince(card.last_review_at) : null;
  let r = 30, why = [];
  if (gap === null) { r = 55; why.push('刚做完还没复习过'); }
  else {
    /* 遗忘是加速的：同样 10 天，忘过的人和一次做对的人不一样。
       这里用 gap 的幂来近似「越拖越记不清」，再用上次结果调偏移。 */
    r = Math.min(92, Math.round(22 * Math.pow(gap + 1, 0.62)));
    if (gap >= 45) r = Math.max(r, 70);
    why.push(gap === 0 ? '今天刚练过' : ('距上次复习 ' + gap + ' 天'));
    if (card.last_verdict === 'forgotten') { r = Math.max(r, 72); why.push('上次没写出来'); }
    else if (card.last_verdict === 'fuzzy') { r = Math.min(96, r + 12); why.push('上次写得不完整'); }
    else if (card.last_verdict === 'pass' && gap < 3) { r = Math.max(8, r - 22); }
  }
  const sc = Number(card.last_score);
  if (sc >= 0) {
    r = Math.round(r * (0.72 + 0.42 * (sc / 100)));
    if (sc < 60) why.push('盲写一致度只有 ' + sc + '%');
    else if (sc >= 90 && gap !== null && gap > 14) r = Math.max(10, r - 10);
  } else why.push('还没盲写验证过');
  if (pit.open) { r = Math.min(100, r + Math.min(20, 4 * pit.open)); why.push('有 ' + pit.open + ' 张易错卡没攻克'); }
  if (p.difficulty === 'HARD') { r = Math.min(100, r + 8); why.push('难题本来就更容易忘'); }
  else if (p.difficulty === 'EASY') r = Math.max(6, r - 6);
  if (Number(p.attempts || 0) >= 4) r = Math.max(8, r - 6);
  return { risk: Math.max(0, Math.min(100, r)), why };
}
function pitfallAggregate() {
  const out = {};
  for (const r of db.prepare("SELECT problem_id, COUNT(*) AS open, SUM(weight) AS weight FROM pitfall_cards WHERE status = 'open' GROUP BY problem_id").all()) {
    out[r.problem_id] = { open: r.open, weight: r.weight || 0 };
  }
  return out;
}
/** 候选池：复习流里的每一道题 + 客观特征（给 AI 挑，也给兜底排序） */
function reviewCandidates(goalId) {
  const probs = {};
  for (const p of problemWithStatus()) probs[p.id] = p;
  const agg = pitfallAggregate();
  const cards = goalId
    ? db.prepare('SELECT * FROM review_cards WHERE goal_id = ? OR goal_id = 0').all(goalId)
    : db.prepare('SELECT * FROM review_cards').all();
  const out = [];
  for (const c of cards) {
    const p = probs[c.problem_id];
    if (!p) continue;   // 题被删了，卡自然失效
    const rk = riskOf(c, probs, agg);
    out.push({
      problem_id: c.problem_id, fid: p.fid, title: p.title, difficulty: p.difficulty,
      groups: p.groups || [], risk: rk.risk, why: rk.why,
      reviews: Number(c.reviews) || 0, last_review_at: c.last_review_at || '',
      last_verdict: c.last_verdict || '', last_score: Number(c.last_score),
      attempts: Number(p.attempts) || 0, passed: Number(p.passed) || 0,
      pitfall_open: (agg[c.problem_id] || {}).open || 0,
      pitfall_weight: (agg[c.problem_id] || {}).weight || 0,
      last_recall_at: (db.prepare('SELECT created_at FROM recall_tests WHERE problem_id = ? ORDER BY id DESC LIMIT 1').get(c.problem_id) || {}).created_at || ''
    });
  }
  out.sort((a, b) => b.risk - a.risk);
  return out;
}
/** 今天给这个目标排的复习计划（没排过返回 null） */
function todayPlan(goalId) {
  const row = db.prepare('SELECT * FROM review_plans WHERE goal_id = ? AND date = ?').get(goalId || 0, todayStr());
  if (!row) return null;
  let items = [];
  try { items = safeParse(row.items) || []; } catch (e) {}
  return { id: row.id, date: row.date, goal_id: row.goal_id, items, note: row.note || '' };
}
function savePlan(goalId, items, note) {
  const t = nowISO();
  const has = db.prepare('SELECT id FROM review_plans WHERE goal_id = ? AND date = ?').get(goalId || 0, todayStr());
  if (has) db.prepare('UPDATE review_plans SET items = ?, note = ?, updated_at = ? WHERE id = ?').run(JSON.stringify(items || []), note || '', t, has.id);
  else db.prepare('INSERT INTO review_plans (goal_id,date,items,note,created_at,updated_at) VALUES (?,?,?,?,?,?)')
    .run(goalId || 0, todayStr(), JSON.stringify(items || []), note || '', t, t);
  return todayPlan(goalId);
}
/** 规则兜底排期（AI 不可用、或 AI 挑不出题时用）：按风险分从高到低取 size 道 */
function rulePlan(cands, size, doneToday) {
  const done = new Set(doneToday || []);
  const picked = cands.filter(c => !done.has(c.problem_id)).slice(0, size);
  if (picked.length < size) {
    /* 今天已经练过的（还没到间隔的）也补进来 —— 一次多练两道总比空着好 */
    for (const c of cands) { if (picked.length >= size) break; if (!done.has(c.problem_id)) picked.push(c); }
  }
  return picked.map(c => ({ pid: c.problem_id, reason: c.why.join('、') || '轮到它了', risk: c.risk }));
}
/* ===================== AI 内核：引导提炼 / 盲写对照 / 易错卡 ===================== */
/** 从 AI 回复里抠出第一个完整 JSON 对象。
 *  模型爱在 JSON 前后加话、加 ```json 围栏，还会先吐半句「好的」，直接 JSON.parse 必挂。 */
function firstJSONObject(text) {
  const s = String(text || '');
  for (let i = 0; i < s.length; i++) {
    if (s[i] !== '{') continue;
    let depth = 0, inStr = false, esc = false;
    for (let j = i; j < s.length; j++) {
      const c = s[j];
      if (inStr) { if (esc) esc = false; else if (c === '\\') esc = true; else if (c === '"') inStr = false; continue; }
      if (c === '"') inStr = true;
      else if (c === '{') depth++;
      else if (c === '}') { depth--; if (!depth) { try { return JSON.parse(s.slice(i, j + 1)); } catch (e) { break; } } }
    }
  }
  return null;
}
/** 归一化标题：剥掉标点/空白/常见修饰词，只留骨架，用来判「同一个错点」 */
function pitfallKey(s) {
  return String(s || '')
    .replace(/[（）()【】\[\]{}<>《》"'`~!?！？:：;；,，.。、\/\\|_\-+*=&#$%@^*]/g, '')
    .replace(/(漏了|漏掉|忘记|忘了|又|老是|总是|没有|没有写|未处理|未考虑|不完整|写反了|搞反了|错误地|错误)/g, '')
    .replace(/\s+/g, '')
    .toLowerCase()
    .slice(0, 40);
}
/** 中文按二元组切（中文没有词边界），算 Jaccard 相似度 */
function bigrams(s) {
  const t = pitfallKey(s);
  const set = new Set();
  if (t.length <= 2) { if (t) set.add(t); return set; }
  for (let i = 0; i < t.length - 1; i++) set.add(t.slice(i, i + 2));
  return set;
}
function similarTitle(a, b) {
  const A = bigrams(a), B = bigrams(b);
  if (!A.size || !B.size) return false;
  let inter = 0;
  for (const x of A) if (B.has(x)) inter++;
  return inter / (A.size + B.size - inter) >= 0.42;
}
const PITFALL_TAGS = ['边界', '逻辑', '复杂度', '语法', '算法选择', '状态定义', '下标', '其它'];
/** 易错卡落库：AI 说重复就并进老卡；没说重复也用相似度兜一遍
 *  （用户每次写错的地方措辞略有不同，AI 不一定认得出来，但骨架往往是同一句）。 */
function upsertPitfall(pid, goalId, e, sourceTest) {
  const title = String(e && e.title || '').trim().slice(0, 120);
  if (!title) return null;
  const tag = PITFALL_TAGS.includes(String(e.tag)) ? String(e.tag) : '其它';
  const sev = Math.max(1, Math.min(3, Math.round(Number(e.severity) || 2)));
  const t = nowISO();
  const open = db.prepare("SELECT * FROM pitfall_cards WHERE problem_id = ? AND status = 'open'").all(pid);
  let target = null;
  const claimed = Number(e && e.dupOf) || 0;
  if (claimed) target = open.find(x => x.id === claimed) || null;
  if (!target) {
    const key = pitfallKey(title);
    target = open.find(x => pitfallKey(x.title) === key) || null;
  }
  if (!target) target = open.find(x => similarTitle(x.title, title)) || null;
  if (target) {
    /* 合并：老卡的描述保留（第一次犯的语境最有价值），次数 +1，权重按新严重度抬 */
    const hits = (Number(target.hits) || 1) + 1;
    const weight = hits * 5 + sev * 3;
    db.prepare('UPDATE pitfall_cards SET hits=?, weight=?, advice=?, tag=?, status=?, source_test=?, updated_at=? WHERE id=?')
      .run(hits, weight, String(e.advice || target.advice || '').slice(0, 500), tag, 'open', sourceTest || target.source_test || 0, t, target.id);
    return { ...db.prepare('SELECT * FROM pitfall_cards WHERE id = ?').get(target.id), merged: true };
  }
  const weight = 1 * 5 + sev * 3;
  const r = db.prepare('INSERT INTO pitfall_cards (problem_id,goal_id,tag,title,detail,advice,hits,weight,status,source_test,created_at,updated_at) VALUES (?,?,?,?,?,?,1,?,\'open\',?,?,?)')
    .run(pid, goalId || 0, tag, title, String(e.detail || '').slice(0, 1000), String(e.advice || '').slice(0, 500), weight, sourceTest || 0, t, t);
  return { ...db.prepare('SELECT * FROM pitfall_cards WHERE id = ?').get(Number(r.lastInsertRowid)), merged: false };
}
function problemPitfalls(pid) {
  return db.prepare("SELECT * FROM pitfall_cards WHERE problem_id = ? ORDER BY status = 'fixed', weight DESC, updated_at DESC").all(pid);
}
/* --- 提示词 --- */
const COACH_RULE = [
  '你是一位耐心的算法私教，目标只有一个：让学员把一道题的思路真正内化 —— 能讲给别人听，下次不看答案也能自己写出来。',
  '铁律：',
  '1. 一次只问一个问题。不要列 1/2/3/4，不要一口气抛一堆，不要给选项。',
  '2. 先不给答案。只有学员明确说「直接告诉我」才给思路，而且只讲思路、绝不给代码。',
  '3. 顺序：先问「这题要你做的事，一句话怎么说」→ 追问「你为什么想到这个」→ 逼出「要存什么、怎么查」→ 最后确认复杂度意识。',
  '4. 学员答得含糊就追到具体那一步（是哪个量？存在哪？为什么够用？）；答错了先指出，再用一个更小的反例让他自己撞一次。',
  '5. 学员说「不会」「不知道」时，换个更小的切口问，不要重复原问题，也不要直接给答案。',
  '6. 已经聊过的内容不要重复提问。学员讲清楚了某个层次就顺着往下问下一层。',
  '输出格式（严格）：只输出这一个问题本身，2~4 句话。开头可以先肯定他刚才说的那一小步。禁止输出 JSON、标题、编号、选项列表或任何括号补充说明。'
].join('\n');
const SUMMARY_RULE = [
  '把这段师生对话整理成一张「思路卡」。要求：',
  '- 开头用学员自己的措辞和直觉，不要换成教科书腔。',
  '- 结构固定五段，用「【】」标出：【一句话概括】【关键洞察】【解题步骤】【复杂度】【记忆钩子】。',
  '- 解题步骤分条，每条一行，动词开头，最多 5 条。',
  '- 记忆钩子：一句话钩子，让他在考场上看到这道题就立刻想起这招。',
  '- 严格只使用对话里已经出现的内容，不要补充新知识，不要出现代码。',
  '- 全中文，300 字以内。',
  '只输出这张卡的内容，不要客套、不要解释、不要代码围栏。'
].join('\n');
const RECALL_RULE = [
  '你是代码评审老师。学员把一道已经做过的题遮住答案凭记忆重写了一遍，你要找出他「没记住」的地方，并帮他把毛病沉淀成下次能避开的易错点。',
  '判定口径（重要，别判错）：',
  '- 看的是思路与关键决策点，不是代码风格。变量名不同、括号换行、等价写法、多写了防御性判空 —— 这些都不算错，不要列出来。',
  '- 「漏了」：某个边界/空指针/特殊情况整个没处理，或某个关键步骤整个忘了。',
  '- 「写错了」：逻辑写反、下标或条件搞错、复杂度退化。',
  '- 如果他用了和参考代码完全不同但同样正确的解法，照实说思路一致度高，不要硬凑差异。',
  '「思路一致度」0~100：独立想出核心数据结构给 80 以上；思路对但细节漏给 50~79；没想到核心思路给 50 以下。',
  'verdict：pass = 思路完整且关键细节没漏；fuzzy = 思路对但有遗漏；forgotten = 没想出核心思路。',
  'errors 里的 title 要写成可复用的骨架（不要带具体变量名和具体数字），因为它要跨多次尝试合并去重。',
  '严格输出一个 JSON 对象，不要代码围栏、不要任何额外文字，结构：',
  '{"score": 整数 0-100,',
  ' "verdict": "pass|fuzzy|forgotten",',
  ' "got": ["他确实想起来了的点，每条不超过 20 字"],',
  ' "missed": [{"what":"漏了什么","why":"为什么这步不可省","fix":"怎么补"}],',
  ' "errors": [{"tag":"边界|逻辑|复杂度|语法|算法选择|状态定义|下标|其它","title":"一句话点出错在哪（可复用）","detail":"对照两段代码具体说差在哪","advice":"下次怎么避免","severity":1到3,"dupOf": 该错点若已存在于已有易错卡片则填那条卡片的 id，否则填 0}],',
  ' "hint": "一句话钩子，下次动笔前先想起这件事"}'
].join('\n');
/** 题面给 AI 的摘要：题目正文是 HTML，太长且噪声大，先剥掉 */
function statementBrief(prob, max) {
  let s = String(prob.statement || '');
  s = s.replace(/<pre[\s\S]*?<\/pre>/gi, ' [代码] ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"');
  s = s.replace(/\s+/g, ' ').trim();
  return s.length > (max || 700) ? s.slice(0, max) + '…' : s;
}
/** 引导式提炼：AI 一次问一个问题，返回下一个问题 */
async function coachAsk(pid, answer) {
  const prob = db.prepare('SELECT * FROM problems WHERE id = ?').get(pid);
  if (!prob) throw new Error('题目不存在');
  let sess = db.prepare("SELECT * FROM mind_sessions WHERE problem_id = ? AND status = 'active' ORDER BY id DESC LIMIT 1").get(pid);
  const t = nowISO();
  let steps = [];
  if (sess) { try { steps = safeParse(sess.steps) || []; } catch (e) { steps = []; } }
  const ref = db.prepare('SELECT reference_code FROM problem_mind WHERE problem_id = ?').get(pid) || {};
  const refCode = String(ref.reference_code || '').trim();

  const ctxLines = [
    '题目：' + prob.fid + '. ' + prob.title + '（难度 ' + (prob.difficulty || '未知') + '）',
    (() => { try { const g = safeParse(prob.groups) || []; return g.length ? '知识点：' + g.join(' / ') : ''; } catch (e) { return ''; } })(),
    '题面：' + (statementBrief(prob, 700) || '（未缓存）')
  ].filter(Boolean);
  /* 提炼阶段故意不给参考代码：给了学员就会照抄，恰恰毁掉这个练习的目的。 */

  if (answer !== undefined && String(answer).trim()) {
    if (!sess) {
      /* 只有第一次调用且带了回答 —— 不该发生，但别把用户的字吞掉 */
      const r = db.prepare('INSERT INTO mind_sessions (problem_id,goal_id,status,steps,summary,created_at,updated_at) VALUES (?,?,\'active\',\'[]\',\'\',?,?)').run(pid, 0, t, t);
      sess = db.prepare('SELECT * FROM mind_sessions WHERE id = ?').get(Number(r.lastInsertRowid));
    }
    steps.push({ q: steps.length ? '（继续）' : '', a: String(answer).slice(0, 4000), at: t });
    db.prepare('UPDATE mind_sessions SET steps = ?, updated_at = ? WHERE id = ?').run(JSON.stringify(steps), t, sess.id);
  } else if (!sess) {
    const r = db.prepare('INSERT INTO mind_sessions (problem_id,goal_id,status,steps,summary,created_at,updated_at) VALUES (?,?,\'active\',\'[]\',\'\',?,?)').run(pid, 0, t, t);
    sess = db.prepare('SELECT * FROM mind_sessions WHERE id = ?').get(Number(r.lastInsertRowid));
  }

  const turns = steps.map((s, i) => '学员' + (i + 1) + '：' + s.a).join('\n');
  const prompt = [
    COACH_RULE, '', '=== 题目 ===', ...ctxLines, '',
    turns ? '=== 学员已经说过的（不要重复问） ===\n' + turns + '\n' : '',
    '现在问下一个问题。'
  ].filter(x => x !== '').join('\n');
  const text = await aiText(prompt, (currentModel && currentModel()) || '', 120000);
  const q = String(text || '').trim();
  if (!q) throw new Error('AI 没有给出问题，换个模型再试');
  if (steps.length && !steps[steps.length - 1].q) {
    steps[steps.length - 1].q = q;
    db.prepare('UPDATE mind_sessions SET steps = ?, updated_at = ? WHERE id = ?').run(JSON.stringify(steps), nowISO(), sess.id);
  }
  return { sessionId: sess.id, question: q, stepCount: steps.length };
}
/** 把对话整理成思路卡（不直接覆盖已有卡，写进会话 summary 由用户确认） */
async function coachFinish(pid) {
  const sess = db.prepare("SELECT * FROM mind_sessions WHERE problem_id = ? AND status = 'active' ORDER BY id DESC LIMIT 1").get(pid);
  if (!sess) throw new Error('还没有提炼过，先和 AI 聊几句');
  let steps = [];
  try { steps = safeParse(sess.steps) || []; } catch (e) {}
  const useful = steps.filter(s => String(s.a || '').trim());
  if (useful.length < 2) throw new Error('至少说两句再整理，不然整理出来也是空的');
  const prob = db.prepare('SELECT * FROM problems WHERE id = ?').get(pid);
  const turns = useful.map((s, i) => '学员' + (i + 1) + '：' + s.a).join('\n');
  const prompt = [
    SUMMARY_RULE, '',
    '题目：' + prob.fid + '. ' + prob.title,
    '题面：' + (statementBrief(prob, 500) || '（未缓存）'), '',
    '=== 对话中学员说的话（以这些为准） ===', turns
  ].join('\n');
  const text = String(await aiText(prompt, (currentModel && currentModel()) || '', 120000) || '').trim();
  if (!text) throw new Error('AI 没整理出来，换个模型再试');
  db.prepare("UPDATE mind_sessions SET summary = ?, updated_at = ? WHERE id = ?").run(text, nowISO(), sess.id);
  return { summary: text, sessionId: sess.id, turns: useful.length };
}
/** 盲写对照：把两份代码交给 AI，产出判定 + 易错卡片 */
async function recallCheck(pid, myCode, refCode, goalId) {
  const prob = db.prepare('SELECT * FROM problems WHERE id = ?').get(pid);
  if (!prob) throw new Error('题目不存在');
  const mine = String(myCode || '').trim();
  if (!mine) throw new Error('还没写呢 —— 盲写的意思是先凭记忆敲一遍，不是空着对照');
  const ref = String(refCode || '').trim();
  if (!ref) throw new Error('没有参考代码，先在作答记录里存一份你当时交的代码');
  const t = nowISO();
  const cards = problemPitfalls(pid).map(c => ({ id: c.id, tag: c.tag, title: c.title, hits: c.hits }));
  const prompt = [
    RECALL_RULE, '',
    '题目：' + prob.fid + '. ' + prob.title + '（难度 ' + (prob.difficulty || '未知') + '）',
    '题面：' + (statementBrief(prob, 700) || '（未缓存）'), '',
    '=== 参考代码（学员当初提交的、能跑通的那份） ===',
    '```\n' + ref.slice(0, 12000) + '\n```', '',
    '=== 学员这次盲写的（凭记忆重敲的，没看过上面那份） ===',
    '```\n' + mine.slice(0, 12000) + '\n```', '',
    cards.length
      ? '=== 这道题已有的易错卡片（如果这次栽的跟某条是同一件事，用 dupOf 填它的 id 合并，不要新建） ===\n' + cards.map(c => c.id + ' | ' + c.tag + ' | ' + c.title + '（已犯 ' + c.hits + ' 次）').join('\n')
      : '=== 这道题还没有易错卡片 ===', '',
    '现在给出 JSON。'
  ].join('\n');
  const raw = await aiText(prompt, (currentModel && currentModel()) || '', 180000);
  const j = firstJSONObject(raw);
  if (!j) throw new Error('AI 返回的不是 JSON（换个模型或重试）：' + String(raw || '').slice(0, 120));
  const score = Math.max(0, Math.min(100, Math.round(Number(j.score) || 0)));
  const verdict = ['pass', 'fuzzy', 'forgotten'].includes(j.verdict) ? j.verdict : (score >= 85 ? 'pass' : score >= 55 ? 'fuzzy' : 'forgotten');
  const errors = Array.isArray(j.errors) ? j.errors.slice(0, 6) : [];
  const made = errors.map(e => upsertPitfall(pid, goalId, e || {}, 0)).filter(Boolean);
  /* 再跑一遍合并：upsertPitfall 里每张都做了相似度兜底，这里只统计结果 */
  const inserted = made.filter(x => !x.merged).length;
  const merged = made.filter(x => x.merged).length;
  const report = {
    score, verdict,
    got: (Array.isArray(j.got) ? j.got : []).slice(0, 6).map(String).filter(Boolean),
    missed: (Array.isArray(j.missed) ? j.missed : []).slice(0, 5).map(m => ({ what: String(m.what || ''), why: String(m.why || ''), fix: String(m.fix || '') })).filter(m => m.what),
    hint: String(j.hint || '').slice(0, 300)
  };
  const r = db.prepare('INSERT INTO recall_tests (problem_id,goal_id,ref_code,my_code,report,score,verdict,created_at) VALUES (?,?,?,?,?,?,?,?)')
    .run(pid, goalId || 0, ref.slice(0, 12000), mine.slice(0, 12000), JSON.stringify(report), score, verdict, t);
  const testId = Number(r.lastInsertRowid);
  /* 易错卡指向这次考核（上面 upsert 时还不知道 id，补一次） */
  for (const m of made) db.prepare('UPDATE pitfall_cards SET source_test = ? WHERE id = ? AND source_test = 0').run(testId, m.id);
  /* 复习进度跟着这次盲写走：做过盲写就说明这道题已经在手上，
     不管之前有没有进复习流，都从这里开始被遗忘风险盯着。 */
  enqueueReview(pid, goalId);
  const card = db.prepare('SELECT * FROM review_cards WHERE problem_id = ?').get(pid);
  if (card) {
    const n = (Number(card.reviews) || 0) + 1;
    db.prepare('UPDATE review_cards SET reviews=?, last_review_at=?, last_verdict=?, last_score=?, updated_at=? WHERE problem_id=?')
      .run(n, t, verdict, score, t, pid);
  }
  return { testId, report, cards: problemPitfalls(pid), newCards: inserted, mergedCards: merged };
}
/** AI 排今天的复习：给它候选池和硬约束，让它挑并说明理由；挑不出就按风险分兜底 */
async function planTodayReviews(goalId, size) {
  const cands = reviewCandidates(goalId);
  if (!cands.length) return { items: [], note: '还没有题进复习流 —— 做对一道题就会自动进来。', source: 'none', pool: 0 };
  const plan = todayPlan(goalId);
  const doneToday = (plan ? plan.items : []).filter(x => x.done).map(x => x.pid);
  const n = Math.max(1, Math.min(8, Number(size) || 3));
  const pool = cands.filter(c => !doneToday.includes(c.problem_id)).slice(0, 40);
  const line = c => [
    '#' + c.fid + ' ' + c.title + '（' + (c.difficulty || '?') + '）',
    '  遗忘风险 ' + c.risk + '/100｜' + c.why.join('、'),
    '  做过 ' + c.passed + ' 次（作答 ' + c.attempts + ' 次）｜复习 ' + c.reviews + ' 次',
    (c.last_score >= 0 ? '  最近盲写 ' + c.last_score + '%' : '  没盲写验证过'),
    (c.pitfall_open ? '  未攻克易错卡 ' + c.pitfall_open + ' 张（权重 ' + c.pitfall_weight + '）' : '')
  ].filter(Boolean).join('\n');
  const prompt = [
    '你在给一个「不一定每天刷题」的算法练习者排今天的复习。硬约束：',
    '- 只能从下面的候选里挑，题目 id 要原样保留。',
    '- 一次最多 ' + n + ' 道，宁少勿多 —— 排多了用户只会一起跳过。',
    '- 优先挑「风险高」的，但对「风险中等 + 正好是同一个知识点/易错卡还没攻克」的可以插队，因为串起来复习更省脑力。',
    '- 已经掌握牢（风险 <20）的一律不要排。',
    '输出格式（严格）：只输出一个 JSON 对象，不要代码围栏、不要额外文字。',
    '{"note":"今天整体状况的一句话点评（像教练，别超过 40 字）",',
    ' "picks":[{"id":题目id,"reason":"为什么今天该练它（不超过 25 字，要具体，点出风险来源）"}]}', '',
    '=== 候选（按遗忘风险从高到低） ===',
    pool.map(line).join('\n'), '',
    '注意：风险分只是参考，你也要看这些题的知识点是否成串、是不是同一个坑反复踩。现在给出 JSON。'
  ].join('\n');
  let note = '', picks = [], source = 'ai';
  try {
    if (typeof aiText !== 'function') throw new Error('没有 AI');
    const j = firstJSONObject(await aiText(prompt, (currentModel && currentModel()) || '', 180000));
    if (!j) throw new Error('AI 没给出 JSON');
    note = String(j.note || '').slice(0, 200);
    const raw = Array.isArray(j.picks) ? j.picks : [];
    const seen = new Set();
    picks = [];
    for (const p of raw) {
      const id = Number(p && p.id);
      const c = pool.find(x => x.problem_id === id);
      if (!c || seen.has(id)) continue;      // AI 编了 id 或重复挑同一道 → 丢掉
      seen.add(id);
      picks.push({ pid: id, reason: String(p.reason || '').slice(0, 120) || c.why.join('、'), risk: c.risk, fid: c.fid, title: c.title, difficulty: c.difficulty, pitfall_open: c.pitfall_open, last_score: c.last_score });
      if (picks.length >= n) break;
    }
    if (!picks.length) throw new Error('AI 没选出有效的题');
  } catch (e) {
    source = 'rule';
    note = 'AI 没排出来，先按遗忘风险给你排了（' + (e.message || e) + '）';
  }
  if (!picks.length) {
    picks = rulePlan(pool, n, doneToday).map(x => {
      const c = pool.find(y => y.problem_id === x.pid) || {};
      return { pid: x.pid, reason: x.reason, risk: x.risk, fid: c.fid, title: c.title, difficulty: c.difficulty, pitfall_open: c.pitfall_open, last_score: c.last_score };
    });
  }
  /* AI 可能只挑了 1 道但池子里还有明显该练的：不够数就用规则补齐（别让用户面对空白） */
  if (picks.length < n) {
    for (const x of rulePlan(pool, n - picks.length, doneToday.concat(picks.map(p => p.pid)))) {
      if (picks.some(p => p.pid === x.pid)) continue;
      const c = pool.find(y => y.problem_id === x.pid) || {};
      picks.push({ pid: x.pid, reason: x.reason, risk: x.risk, fid: c.fid, title: c.title, difficulty: c.difficulty, pitfall_open: c.pitfall_open, last_score: c.last_score });
    }
  }
  const items = picks.map(p => ({ ...p, done: false, at: '' }));
  savePlan(goalId, items, note);
  return { items: todayPlan(goalId).items, note, source, pool: cands.length };
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
/** 出过事的那版通用骨架（Python 里写死了 twoSum）。
 *  只用来**识别**磁盘上遗留的坏文件，不该再拿去写新文件。
 *  为什么需要识别：openInIDE 只在文件不存在时才写模板，所以旧版本建出来的
 *  「字母异位词分组.py 里写着 twoSum」会永远留在磁盘上，光修代码救不回来。 */
function legacyTemplateFor(lang) {
  if (lang === 'python3' || lang === 'python') return 'class Solution:\n    def twoSum(self, nums, target):\n        pass\n';
  if (lang === 'cpp') return '#include <bits/stdc++.h>\nusing namespace std;\n\nclass Solution {\npublic:\n};\n';
  if (lang === 'java') return 'class Solution {\n}\n';
  if (lang === 'javascript' || lang === 'typescript') return '// ' + (LANG_NAME[lang] || 'Python3') + '\nvar solve = function() {\n};\n';
  if (lang === 'go') return 'package main\n\nfunc main() {\n}\n';
  if (lang === 'rust') return 'impl Solution {\n}\n';
  return '// ' + (LANG_NAME[lang] || 'Python3') + '\n';
}
/** 组出「题头注释 + 空行 + 模板」的完整文件内容，用于比对磁盘上那份是不是还没动过的骨架 */
function stubFile(problem, lang, tpl) {
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
  lines.push(tpl);
  return lines.join('\n');
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
  let created = false, repaired = false;
  const content = () => {
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
    return lines.join('\n');
  };
  if (!fs.existsSync(file)) {
    fs.writeFileSync(file, content());
    created = true;
  } else {
    /* 已有文件可能是旧版本留下的坏模板（当年每道题都写着 twoSum）。
       只有在内容**恰好等于**「题头 + 某份空白骨架」时才重写 ——
       也就是能确定用户一个字都没改过；只要动过就绝不碰，宁可留旧内容。 */
    let cur = '';
    try { cur = fs.readFileSync(file, 'utf8').replace(/\s+$/, ''); } catch (e) {}
    const isStub = cur && [
      stubFile(problem, lang, templateFor(lang, problem)),
      stubFile(problem, lang, legacyTemplateFor(lang))
    ].some(s => s.replace(/\s+$/, '') === cur);
    if (isStub) {
      fs.writeFileSync(file, content());
      repaired = true;
    }
  }
  try {
    const c1 = spawn('code', [dir], { detached: true, stdio: 'ignore' });
    c1.unref();
    setTimeout(() => {
      try { const c2 = spawn('code', [file], { detached: true, stdio: 'ignore' }); c2.unref(); } catch (e) {}
    }, 1200);
  } catch (e) {}
  return { file, dir, lang, langName: LANG_NAME[lang] || lang, created, repaired };
}
