'use strict';
/**
 * 思而行 · 今日任务（quests）
 * ------------------------------------------------------------------
 * 像游戏里的任务栏：每天告诉你「今天推进哪几个节点、每个节点拆成哪几小步、各要多久」。
 *
 * 和「每日刷题」不是一回事：那边排的是算法题，这边排的是**路线图上的任务节点**。
 *
 * AI 排今天的依据（这就是"根据实际推进情况"）：
 *   · 正在进行的节点优先（接着昨天没做完的）
 *   · 每个节点自己写的预计投入（nodes.hours）—— 拆子任务时按它分
 *   · 每个节点/它的上级的说明、产出物、验收标准（子任务要贴着这些写，不能空泛）
 *   · 最近几天的实际完成情况（排了 120 分钟却只做了 40 → 今天少排点）
 *   · 今天你愿意投入多少分钟（可随时改）
 * 排完之后可以逐条勾；全部勾完 → 一键把该节点标成完成。
 */
const fs = require('node:fs');

let db, nowISO, safeParse, sendJSON, readBody, getSetting, setSetting, backup, log;
let getGoal, aiText, currentModel, tasks;

const SCHEMA = `
CREATE TABLE IF NOT EXISTS quest_days (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  goal_id INTEGER NOT NULL DEFAULT 0,
  date TEXT NOT NULL DEFAULT '',
  note TEXT NOT NULL DEFAULT '',            /* AI 一句话：今天为什么这么排 */
  items TEXT NOT NULL DEFAULT '[]',         /* [{id,node_id,title,why,minutes,subs:[{t,min,done}],done,done_at}] */
  minutes INTEGER NOT NULL DEFAULT 0,       /* 今天打算投入多少分钟（用户设的） */
  plan_total INTEGER NOT NULL DEFAULT 0,    /* AI 排出来的总分钟 */
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE(goal_id, date)
);
`;

function bind(ctx) {
  ({ db, nowISO, safeParse, sendJSON, readBody, getSetting, setSetting, backup, log } = ctx);
  ({ getGoal, aiText, currentModel, tasks } = ctx);
}
function aiJob({ title, note, goalId, nodeId, message, run }) {
  const job = tasks.begin({ type: 'quests', title, note, goalId, nodeId, message });
  const t0 = Date.now();
  job.progress(4, message);
  const iv = setInterval(() => {
    const sec = Math.round((Date.now() - t0) / 1000);
    job.progress(Math.min(93, Math.round(100 * (1 - Math.exp(-sec / 18)))), message + '（已等 ' + sec + ' 秒）');
  }, 1500);
  return Promise.resolve().then(() => run(job.signal))
    .then(v => { clearInterval(iv); job.progress(100, '完成'); job.done(v); return v; })
    .catch(e => { clearInterval(iv); job.fail(e); throw e; });
}
function firstJSON(text) {
  const s = String(text || '');
  for (let i = 0; i < s.length; i++) {
    if (s[i] !== '{') continue;
    let depth = 0, inStr = false, esc = false;
    for (let j = i; j < s.length; j++) {
      const c = s[j];
      if (inStr) { if (esc) esc = false; else if (c === '\\') esc = true; else if (c === '"') inStr = false; continue; }
      if (c === '"') { inStr = true; continue; }
      if (c === '{') depth++;
      else if (c === '}') { depth--; if (depth === 0) { try { return JSON.parse(s.slice(i, j + 1)); } catch (e) { break; } } }
    }
  }
  return null;
}
const clip = (s, n) => String(s == null ? '' : s).trim().slice(0, n || 300);
const todayStr = () => { const d = new Date(); const p = n => String(n).padStart(2, '0'); return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate()); };

/* ---------- 「预计投入」是个自由文本：3h / 2 / 1.5 / 3-4h / 半小时 / 90分钟 ---------- */
function parseMinutes(txt) {
  const s = String(txt == null ? '' : txt).trim().toLowerCase();
  if (!s) return 0;
  if (/半\s*个?\s*小时|半小时/.test(s)) return 30;
  const nums = (s.match(/\d+(?:\.\d+)?/g) || []).map(Number).filter(x => x > 0);
  if (!nums.length) return 0;
  let v = nums.length > 1 && /[-~到至]/.test(s) ? (nums[0] + nums[1]) / 2 : nums[0];
  if (/分|min/.test(s) && !/时|h/.test(s)) return Math.round(v);       // 分钟
  if (v <= 24) return Math.round(v * 60);                              // 小时
  return Math.round(v);                                                // 直接当分钟
}
function fmtMin(m) {
  const n = Math.max(0, Math.round(Number(m) || 0));
  if (!n) return '';
  if (n % 60 === 0) return (n / 60) + 'h';
  if (n < 60) return n + 'm';
  return Math.floor(n / 60) + 'h' + (n % 60) + 'm';
}

/* ---------- 今日可用时间：默认按目标的每周投入折算（一周算 6 天） ---------- */
function defaultMinutes(goal) {
  const wk = Number(String((goal && goal.weekly_hours) || '').replace(/[^0-9.]/g, ''));
  if (Number.isFinite(wk) && wk > 0) return Math.max(30, Math.min(300, Math.round(wk * 60 / 6)));
  return 120;
}

function dayOf(goalId, date) {
  return db.prepare('SELECT * FROM quest_days WHERE goal_id = ? AND date = ?').get(Number(goalId), String(date)) || null;
}
function dayOut(r) {
  if (!r) return null;
  const o = Object.assign({}, r);
  o.items = safeParse(r.items) || [];
  return o;
}
function saveDay(goalId, date, items, note, minutes, planTotal) {
  const t = nowISO();
  const has = dayOf(goalId, date);
  const js = JSON.stringify(items || []);
  if (has) db.prepare('UPDATE quest_days SET items = ?, note = ?, minutes = ?, plan_total = ?, updated_at = ? WHERE id = ?')
    .run(js, note || '', Number(minutes) || 0, Number(planTotal) || 0, t, has.id);
  else db.prepare('INSERT INTO quest_days (goal_id,date,items,note,minutes,plan_total,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?)')
    .run(Number(goalId), String(date), js, note || '', Number(minutes) || 0, Number(planTotal) || 0, t, t);
  return dayOf(goalId, date);
}
/* 最近几天的完成情况：给 AI 校准"排多少合适" */
function historyOf(goalId, days) {
  const rows = db.prepare('SELECT date, items, plan_total FROM quest_days WHERE goal_id = ? ORDER BY date DESC LIMIT ?')
    .all(Number(goalId), Number(days) || 4);
  return rows.map(r => {
    const items = safeParse(r.items) || [];
    const subs = items.reduce((a, it) => a + (it.subs || []).length, 0);
    const sdone = items.reduce((a, it) => a + (it.subs || []).filter(s => s.done).length, 0);
    return { date: r.date, planned: Number(r.plan_total) || 0, nodes: items.length, subs, sdone, done: items.filter(x => x.done).length };
  });
}

/* ---------- 候选节点：还没做完的 + 正在进行的优先 ---------- */
function nodesOf(goalId) {
  return db.prepare('SELECT * FROM nodes WHERE goal_id = ? ORDER BY level, sort_order, id').all(Number(goalId));
}
function candidatesOf(goalId, limit) {
  const all = nodesOf(goalId);
  const byId = new Map(all.map(n => [Number(n.id), n]));
  const titleOf = id => { const n = byId.get(Number(id)); return n ? n.title : ''; };
  const pick = all.filter(n => Number(n.level) === 2 && n.status !== 'done');
  const list = pick.length ? pick : all.filter(n => Number(n.level) === 1 && n.status !== 'done');
  const rank = n => (n.status === 'doing' ? 0 : 1) * 1000 + (Number(n.sort_order) || 0);
  return list.slice().sort((a, b) => rank(a) - rank(b) || (a.id - b.id)).slice(0, limit || 14).map(n => {
    const parent = byId.get(Number(n.parent_id)) || null;
    const stage = parent ? (byId.get(Number(parent.parent_id)) || null) : null;
    return {
      id: Number(n.id), title: n.title, status: n.status,
      minutes: parseMinutes(n.hours) || 0,
      hours_text: String(n.hours || ''),
      parent: parent ? parent.title : '', stage: stage ? stage.title : '',
      detail: clip(n.detail, 400), artifact: clip(n.artifact, 200), acceptance: clip(n.acceptance, 200),
      parent_note: parent ? clip(parent.detail, 200) : '',
      title_of: titleOf
    };
  });
}

function buildQuestPrompt(goal, date, cands, avail, hist, doneToday) {
  const L = [];
  L.push('你在帮一位学习者排**今天**的任务。像游戏里的任务栏：今天推进哪几个节点、每个拆成哪几小步、各要多久。');
  L.push('');
  L.push('【目标】' + clip((goal && goal.title) || '', 120)
    + ((goal && goal.deadline) ? '（期限：' + clip(goal.deadline, 30) + '）' : ''));
  L.push('【今天】' + date + '｜今天愿意投入 ' + avail + ' 分钟');
  const h = (hist || []).filter(x => x.date !== date);
  if (h.length) {
    L.push('【最近几天实际完成情况（用来校准今天排多少）】');
    for (const x of h.slice(0, 3)) {
      const subs = x.subs || 0, sdone = x.sdone || 0;
      L.push('- ' + x.date + '：排了 ' + x.planned + ' 分钟 / ' + x.nodes + ' 个节点，子任务完成 ' + sdone + '/' + subs
        + (x.planned && x.subs ? '（约完成 ' + Math.round(100 * sdone / Math.max(1, x.subs)) + '%）' : ''));
    }
    L.push('如果前几天完成率明显偏低，今天就**少排一点**（宁可做完）；完成率很高可以稍微加量。');
  }
  const undone = (doneToday || []);
  if (undone.length) {
    L.push('【今天已经勾掉的子任务（不用再排）】');
    for (const x of undone) L.push('- ' + clip(x, 120));
  }
  L.push('');
  L.push('【可选的节点（只能从这里挑，node_id 必须原样用）】');
  for (const c of cands) {
    L.push('#' + c.id + ' ' + c.title + '（预计投入 ' + (c.hours_text || (c.minutes ? fmtMin(c.minutes) : '未估')) + '）'
      + (c.status === 'doing' ? '【进行中】' : ''));
    if (c.stage || c.parent) L.push('   位置：' + [c.stage, c.parent].filter(Boolean).join(' › '));
    if (c.detail) L.push('   要做的事：' + c.detail);
    if (c.acceptance) L.push('   验收：' + c.acceptance);
    if (c.artifact) L.push('   产出物：' + c.artifact);
  }
  L.push('');
  L.push('【怎么排】');
  L.push('1. **先接着没做完的**：标了【进行中】的优先，而且它的子任务要从"还差什么"接着写，不要从头再来一遍。');
  L.push('2. 一个节点 = 今天要推进的一块。挑 1~4 个；总分钟数不超过今天愿意投入的 ' + avail + ' 分钟（可以略超 10%）。');
  L.push('3. 每个节点拆 **2~5 个今天能做完的小步**（subs），每步 15~60 分钟，必须有明确的动作和产出：');
  L.push('   写"打开 5 条 JD 抄录硬门槛"这种，不要写"继续学习/深入理解/认真推进"这种空话。');
  L.push('   各步分钟数加起来，要跟这个节点的预计投入接近（差太多说明拆错了）。');
  L.push('4. 首次做的节点，第一步要具体到"打开什么、写什么"；已经做了一部分的，第一步是"补完剩下的 X"。');
  L.push('5. 如果今天时间明显不够推完任何一个完整节点，就只挑 1 个节点 + 2~3 步，别硬塞。');
  L.push('');
  L.push('只输出一个 JSON 对象，不要代码围栏、不要多余文字：');
  L.push('{"note":"一句话：今天为什么这么排（30 字内，像教练，别客套）",');
  L.push(' "items":[{"node_id":节点id,"why":"今天推进它的理由（25 字内，具体）",');
  L.push('   "subs":[{"t":"今天这一小步做什么","min":30}]}]}');
  return L.join('\n');
}

/* 把 AI 的排期收敛成能用的结构（id 必须在候选里、分钟数夹紧、子任务去空） */
function normPlan(j, cands, avail) {
  const byId = new Map((cands || []).map(c => [Number(c.id), c]));
  const items = [];
  const raw = (j && Array.isArray(j.items)) ? j.items : [];
  for (const it of raw) {
    const c = byId.get(Number(it && it.node_id));
    if (!c) continue;
    if (items.some(x => x.node_id === c.id)) continue;
    const subs = (Array.isArray(it.subs) ? it.subs : []).map(s => ({
      t: clip(s && (s.t || s.title), 90),
      min: Math.max(5, Math.min(180, Math.round(Number(s && (s.min || s.minutes)) || 25))),
      done: false
    })).filter(s => s.t).slice(0, 6);
    if (!subs.length) continue;
    items.push({
      id: items.length + 1, node_id: c.id, title: c.title, hours_text: c.hours_text,
      why: clip(it.why, 60), minutes: subs.reduce((a, s) => a + s.min, 0), subs, done: false, done_at: ''
    });
    if (items.length >= 5) break;
  }
  /* 总时长按今天的预算收一收：超太多就把最小的那条砍掉 */
  let total = items.reduce((a, x) => a + x.minutes, 0);
  const cap = Math.round(avail * 1.1);
  while (items.length > 1 && total > cap) {
    const last = items.pop();
    total -= last.minutes;
  }
  return { items, note: clip(j && j.note, 80), total };
}

module.exports = {
  id: 'quests',
  name: '今日任务',
  icon: '🎯',
  desc: '像游戏任务栏：AI 按你的推进情况和每个任务的预计耗时，排今天推进哪几个节点、拆成哪几小步、各要多久',
  category: '学习与练习',
  order: 44,
  goalToggle: true,
  defaultEnabled: true,
  client: '/plugins/quests.js',

  init(ctx) {
    bind(ctx);
    db.exec(SCHEMA);
  },

  onGoalDelete(goalId, ctx) {
    ctx.db.prepare('DELETE FROM quest_days WHERE goal_id = ?').run(goalId);
  },
  exportData(ctx) { return { days: ctx.db.prepare('SELECT * FROM quest_days').all() }; },
  importData(data, ctx) {
    for (const d of ((data && data.days) || [])) {
      ctx.db.prepare('INSERT OR REPLACE INTO quest_days (id,goal_id,date,note,items,minutes,plan_total,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?)')
        .run(d.id, d.goal_id, d.date, d.note, d.items, d.minutes, d.plan_total, d.created_at, d.updated_at);
    }
  },

  api: [
    /* 今天（或指定某天）的任务栏 */
    {
      method: 'GET', path: '/api/quests',
      handler: async (req, res, u) => {
        const gid = Number(u.searchParams.get('goal_id')) || 0;
        const g = db.prepare('SELECT * FROM goals WHERE id = ?').get(gid);
        if (!g) return sendJSON(res, 404, { error: '目标不存在' });
        const date = String(u.searchParams.get('date') || todayStr());
        const row = dayOf(gid, date);
        const items = (row ? safeParse(row.items) : []) || [];
        return sendJSON(res, 200, {
          date, day: row ? Object.assign({}, row, { items }) : null,
          items,
          minutes: (row && Number(row.minutes)) || defaultMinutes(g),
          default_minutes: defaultMinutes(g),
          history: historyOf(gid, 5),
          candidates: candidatesOf(gid, 20).map(c => ({ id: c.id, title: c.title, minutes: c.minutes, hours_text: c.hours_text, status: c.status, parent: c.parent, stage: c.stage })),
          node_titles: (() => { const m = {}; for (const n of nodesOf(gid)) m[String(n.id)] = n.title; return m; })()
        });
      }
    },
    /* AI 排今天（会保留今天已经勾掉的进度：已完成的节点不重排） */
    {
      method: 'POST', path: '/api/quests/plan',
      handler: async (req, res, u) => {
        const body = await readBody(req).catch(() => ({}));
        const gid = Number(body.goal_id) || 0;
        const g = db.prepare('SELECT * FROM goals WHERE id = ?').get(gid);
        if (!g) return sendJSON(res, 404, { error: '目标不存在' });
        const date = String(body.date || todayStr());
        const row = dayOf(gid, date);
        const oldItems = (row ? safeParse(row.items) : []) || [];
        /* 已经全部做完的节点今天不再排；用户主动改过的可用时间优先 */
        const doneNodes = oldItems.filter(x => x.done).map(x => Number(x.node_id));
        const avail = Math.max(15, Math.min(600, Number(body.minutes) || (row && Number(row.minutes)) || defaultMinutes(g)));
        const cands = candidatesOf(gid, 20).filter(c => !doneNodes.includes(c.id));
        if (!cands.length) return sendJSON(res, 200, { ok: true, empty: true, note: '路线图上的任务都做完了 —— 可以去目标页看看要不要加新任务。', items: [], date });
        const doneSubs = [];
        for (const x of oldItems) for (const s of (x.subs || [])) if (s.done) doneSubs.push(x.title + '：' + s.t);
        const basePrompt = buildQuestPrompt(g, date, cands, avail, historyOf(gid, 5), doneSubs);
        const ask = async (extra, label) => aiJob({
          title: '排今天的任务', note: clip(String(g.title || ''), 40), goalId: gid,
          message: label || 'AI 正在看你的推进情况，排今天的任务栏',
          run: signal => aiText(basePrompt + (extra || ''), currentModel(), 300000, null, signal)
        });
        let txt = await ask('');
        let plan = normPlan(firstJSON(txt), cands, avail);
        /* 模型偶尔把 node_id 写错、或者忘了给 subs —— 直接失败太可惜，
           把它的毛病点出来再要一次（和「用自己的话」里的做法一致）。 */
        if (!plan.items.length) {
          const j0 = firstJSON(txt) || {};
          const got = (Array.isArray(j0.items) ? j0.items : []).map(x => Number(x && x.node_id)).filter(Boolean);
          log('[quests] 第一次没排出来：返回的 node_id=' + JSON.stringify(got.slice(0, 6))
            + ' 候选=' + JSON.stringify(cands.slice(0, 6).map(c => c.id)));
          txt = await ask('\n\n【注意】你上一次的输出用不了，请重来一次并严格满足：'
            + '\n1. node_id 必须**原样**用候选里 # 后面那个数字（不要自己编、不要用标题当 id）；'
            + '\n2. items 里的每条都必须带 2~5 个 subs，每个 sub 必须有 t（具体动作）和 min（分钟数）；'
            + '\n3. 只输出那一个 JSON 对象。', 'AI 正在重新排（上次的节点 id 对不上）');
          plan = normPlan(firstJSON(txt), cands, avail);
        }
        if (!plan.items.length) throw new Error('今天没排出来（AI 没选出有效节点），点重试再来一次');
        /* 今天已经勾过的子任务，能对上就保持勾着（别因为重排把进度抹掉） */
        for (const it of plan.items) {
          const old = oldItems.find(x => Number(x.node_id) === Number(it.node_id));
          if (!old) continue;
          for (const s of it.subs) {
            const o = (old.subs || []).find(z => z.t === s.t);
            if (o && o.done) s.done = true;
          }
          it.done = !!(old.done && false);
        }
        const saved = saveDay(gid, date, plan.items, plan.note, avail, plan.total);
        return sendJSON(res, 200, { ok: true, date, day: dayOut(saved), items: plan.items, minutes: avail, total: plan.total, note: plan.note });
      }
    },
    /* 改「今天愿意投入多少分钟」（只记下来，下次排用；不动现有清单） */
    {
      method: 'POST', path: '/api/quests/minutes',
      handler: async (req, res, u) => {
        const body = await readBody(req).catch(() => ({}));
        const gid = Number(body.goal_id) || 0;
        const date = String(body.date || todayStr());
        const m = Math.max(15, Math.min(600, Number(body.minutes) || 120));
        const row = dayOf(gid, date);
        if (row) db.prepare('UPDATE quest_days SET minutes = ?, updated_at = ? WHERE id = ?').run(m, nowISO(), row.id);
        else saveDay(gid, date, [], '', m, 0);
        return sendJSON(res, 200, { ok: true, minutes: m });
      }
    },
    /* 勾 / 取消：整条节点 */
    {
      method: 'POST', path: '/api/quests/item',
      handler: async (req, res, u) => {
        const body = await readBody(req).catch(() => ({}));
        const gid = Number(body.goal_id) || 0;
        const date = String(body.date || todayStr());
        const row = dayOf(gid, date);
        if (!row) return sendJSON(res, 404, { error: '今天还没排任务' });
        const items = safeParse(row.items) || [];
        const it = items.find(x => Number(x.id) === Number(body.item_id));
        if (!it) return sendJSON(res, 404, { error: '这条不在今天的清单里' });
        const done = body.done === undefined ? true : !!body.done;
        it.done = done;
        it.done_at = done ? nowISO() : '';
        for (const s of (it.subs || [])) s.done = done;      // 整条勾了 = 子任务全勾
        const saved = saveDay(gid, date, items, row.note, row.minutes, row.plan_total);
        /* 顺带把节点状态推进一步：勾完就是 doing，取消就退回 todo（不动已完成的节点） */
        const node = db.prepare('SELECT id,status FROM nodes WHERE id = ?').get(Number(it.node_id));
        if (node && node.status !== 'done') {
          const want = done ? 'doing' : 'todo';
          if (node.status !== want) db.prepare('UPDATE nodes SET status = ?, updated_at = ? WHERE id = ?').run(want, nowISO(), node.id);
        }
        return sendJSON(res, 200, { ok: true, day: dayOut(saved), items, goal: getGoal(gid) });
      }
    },
    /* 勾 / 取消：某一步 */
    {
      method: 'POST', path: '/api/quests/sub',
      handler: async (req, res, u) => {
        const body = await readBody(req).catch(() => ({}));
        const gid = Number(body.goal_id) || 0;
        const date = String(body.date || todayStr());
        const row = dayOf(gid, date);
        if (!row) return sendJSON(res, 404, { error: '今天还没排任务' });
        const items = safeParse(row.items) || [];
        const it = items.find(x => Number(x.id) === Number(body.item_id));
        if (!it) return sendJSON(res, 404, { error: '这条不在今天的清单里' });
        const s = (it.subs || [])[Number(body.idx)];
        if (!s) return sendJSON(res, 404, { error: '找不到这一小步' });
        s.done = body.done === undefined ? true : !!body.done;
        it.done = (it.subs || []).every(z => z.done);
        it.done_at = it.done ? nowISO() : '';
        const saved = saveDay(gid, date, items, row.note, row.minutes, row.plan_total);
        const node = db.prepare('SELECT id,status FROM nodes WHERE id = ?').get(Number(it.node_id));
        if (node && node.status !== 'done') {
          const any = (it.subs || []).some(z => z.done);
          const want = any ? 'doing' : 'todo';
          if (node.status !== want) db.prepare('UPDATE nodes SET status = ?, updated_at = ? WHERE id = ?').run(want, nowISO(), node.id);
        }
        return sendJSON(res, 200, { ok: true, day: dayOut(saved), items, goal: getGoal(gid) });
      }
    },
    /* 手动把一个节点加进今天 */
    {
      method: 'POST', path: '/api/quests/add',
      handler: async (req, res, u) => {
        const body = await readBody(req).catch(() => ({}));
        const gid = Number(body.goal_id) || 0;
        const date = String(body.date || todayStr());
        const nid = Number(body.node_id);
        const n = db.prepare('SELECT * FROM nodes WHERE id = ? AND goal_id = ?').get(nid, gid);
        if (!n) return sendJSON(res, 404, { error: '节点不存在' });
        const row = dayOf(gid, date);
        const items = row ? (safeParse(row.items) || []) : [];
        if (items.some(x => Number(x.node_id) === nid)) return sendJSON(res, 200, { ok: true, already: true, items, day: dayOut(row) });
        const mins = parseMinutes(n.hours) || 60;
        items.push({
          id: Math.max(0, ...items.map(x => Number(x.id) || 0)) + 1,
          node_id: nid, title: n.title, hours_text: String(n.hours || ''),
          why: '你自己加进来的', minutes: mins,
          subs: (Array.isArray(body.subs) && body.subs.length)
            ? body.subs.map(s => ({ t: clip(s.t, 90), min: Math.max(5, Math.min(180, Number(s.min) || 25)), done: false }))
            : [{ t: clip(n.detail || n.title, 90) || '推进这个节点', min: mins, done: false }],
          done: false, done_at: ''
        });
        const planTotal = items.reduce((a, x) => a + (Number(x.minutes) || 0), 0);
        const saved = saveDay(gid, date, items, row ? row.note : '（手动加的）', row ? row.minutes : defaultMinutes({ weekly_hours: '' }), planTotal);
        return sendJSON(res, 200, { ok: true, added: nid, items, day: dayOut(saved) });
      }
    },
    /* 清掉今天的清单（节点状态不动） */
    {
      method: 'DELETE', path: '/api/quests/today',
      handler: async (req, res, u) => {
        const gid = Number(u.searchParams.get('goal_id')) || 0;
        const date = String(u.searchParams.get('date') || todayStr());
        const row = dayOf(gid, date);
        if (row) db.prepare('DELETE FROM quest_days WHERE id = ?').run(row.id);
        return sendJSON(res, 200, { ok: true, date });
      }
    }
  ]
};
