'use strict';
/**
 * 思而行 · 扩展组件：学习统计
 * ------------------------------------------------------------------
 * 统计每天学了多久、休息多久、暂离多久，细到每个节点学了多久，
 * 并记录几点到几点在干什么（时间线）。
 *
 * 计分方式：
 * - 番茄钟专注开着 + 本页面可见 + 停在某篇教程上 → 专注秒数记到该节点；
 *   若番茄钟绑定了节点，则在哪页都记到绑定节点（与番茄钟同步）。
 * - 番茄钟专注开着 + 本页面不可见（切标签/最小化/刷视频）→ 记"暂离应用"。
 *   注意：网页拿不到别的标签页地址，只能知道"切出去了"，不能断定就是 B 站。
 * - 番茄钟休息计时走字 → 记"休息"。
 * 前端每 ~15 秒上报一次（POST /api/study/report）。
 *
 * 注意：上报接口只做节流备份（5 分钟一次）——心跳频率高，全量备份吃不消；
 * 数据照常进同步快照，随其它数据的同步时机一起上传。
 */
let db, sendJSON, readBody, backup, nowISO;
function bind(ctx) {
  ({ db, sendJSON, readBody, backup, nowISO } = ctx);
}
let lastBackupAt = 0;

const SCHEMA = `
CREATE TABLE IF NOT EXISTS study_records (
  day TEXT NOT NULL,
  goal_id INTEGER NOT NULL DEFAULT 0,
  node_id INTEGER NOT NULL,
  node_title TEXT NOT NULL DEFAULT '',
  goal_title TEXT NOT NULL DEFAULT '',
  focus_sec INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT '',
  updated_at TEXT NOT NULL DEFAULT '',
  PRIMARY KEY (day, node_id)
);
CREATE TABLE IF NOT EXISTS study_days (
  day TEXT PRIMARY KEY,
  focus_sec INTEGER NOT NULL DEFAULT 0,
  rest_sec INTEGER NOT NULL DEFAULT 0,
  away_sec INTEGER NOT NULL DEFAULT 0,
  updated_at TEXT NOT NULL DEFAULT ''
);
CREATE TABLE IF NOT EXISTS study_segments (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  day TEXT NOT NULL DEFAULT '',
  kind TEXT NOT NULL DEFAULT 'focus',
  goal_id INTEGER NOT NULL DEFAULT 0,
  node_id INTEGER NOT NULL DEFAULT 0,
  node_title TEXT NOT NULL DEFAULT '',
  goal_title TEXT NOT NULL DEFAULT '',
  started_at TEXT NOT NULL DEFAULT '',
  ended_at TEXT NOT NULL DEFAULT '',
  seconds INTEGER NOT NULL DEFAULT 0,
  updated_at TEXT NOT NULL DEFAULT ''
);
CREATE INDEX IF NOT EXISTS idx_study_segments_day ON study_segments(day);`;

/* 本地日期 / 本地时间（跟用户过日子的时区一致，不用 UTC） */
function localDay(d) {
  const t = d || new Date();
  const p = n => String(n).padStart(2, '0');
  return t.getFullYear() + '-' + p(t.getMonth() + 1) + '-' + p(t.getDate());
}
function localTime(d) {
  const t = d || new Date();
  const p = n => String(n).padStart(2, '0');
  return localDay(t) + ' ' + p(t.getHours()) + ':' + p(t.getMinutes()) + ':' + p(t.getSeconds());
}
function shiftTime(secAgo) { return localTime(new Date(Date.now() - Math.max(0, secAgo) * 1000)); }

/* 统一落账：bucket = focus | rest | away */
function applyReport(bucket, nodeId, sec) {
  sec = Math.round(sec);
  if (!(sec >= 1)) return null;
  sec = Math.min(sec, 600);
  bucket = (bucket === 'rest' || bucket === 'away') ? bucket : 'focus';
  nodeId = Number(nodeId) || 0;
  const day = localDay();
  const t = nowISO();
  let nodeTitle = '', goalTitle = '', goalId = 0;
  if (nodeId > 0) {
    const n = db.prepare('SELECT id, goal_id, title FROM nodes WHERE id = ?').get(nodeId);
    if (!n) return { error: '节点不存在' };
    const g = db.prepare('SELECT id, title FROM goals WHERE id = ?').get(n.goal_id);
    goalId = n.goal_id;
    nodeTitle = String(n.title || '').slice(0, 120);
    goalTitle = g ? String(g.title || '').slice(0, 120) : '';
  }
  if (bucket === 'focus' && nodeId > 0) {
    db.prepare(`INSERT INTO study_records (day, goal_id, node_id, node_title, goal_title, focus_sec, created_at, updated_at)
      VALUES (?,?,?,?,?,?,?,?)
      ON CONFLICT(day, node_id) DO UPDATE SET focus_sec = focus_sec + excluded.focus_sec,
        node_title = excluded.node_title, goal_title = excluded.goal_title, updated_at = excluded.updated_at`)
      .run(day, goalId, nodeId, nodeTitle, goalTitle, sec, t, t);
  }
  // 注意：INSERT 分支必须带上本次秒数（首笔无冲突时直接落盘，不能写全 0 丢掉）
  const f = bucket === 'focus' ? sec : 0, r = bucket === 'rest' ? sec : 0, a = bucket === 'away' ? sec : 0;
  db.prepare(`INSERT INTO study_days (day, focus_sec, rest_sec, away_sec, updated_at) VALUES (?, ?, ?, ?, ?)
    ON CONFLICT(day) DO UPDATE SET focus_sec = focus_sec + excluded.focus_sec, rest_sec = rest_sec + excluded.rest_sec, away_sec = away_sec + excluded.away_sec, updated_at = excluded.updated_at`)
    .run(day, f, r, a, t);
  // 时间段：同天同类同节点、前后脚（180 秒内）就接到一段里，否则另起一段
  const last = db.prepare('SELECT * FROM study_segments WHERE day = ? AND kind = ? AND node_id = ? ORDER BY id DESC LIMIT 1').get(day, bucket, nodeId);
  const lt = localTime();
  if (last && last.ended_at && (Date.parse(lt.replace(' ', 'T')) - Date.parse(String(last.ended_at).replace(' ', 'T')) <= 180000)) {
    db.prepare('UPDATE study_segments SET ended_at = ?, seconds = seconds + ?, updated_at = ? WHERE id = ?').run(lt, sec, t, last.id);
  } else {
    db.prepare(`INSERT INTO study_segments (day, kind, goal_id, node_id, node_title, goal_title, started_at, ended_at, seconds, updated_at)
      VALUES (?,?,?,?,?,?,?,?,?,?)`)
      .run(day, bucket, goalId, nodeId, nodeTitle || (bucket === 'rest' ? '休息' : (bucket === 'away' ? '暂离应用' : '')), goalTitle, shiftTime(sec), lt, sec, t);
  }
  try {
    const nowMs = Date.now();
    if (nowMs - lastBackupAt > 5 * 60 * 1000) { lastBackupAt = nowMs; if (typeof backup === 'function') backup(); }
  } catch (e) {}
  return { ok: true, day, bucket, credited: sec };
}

module.exports = {
  id: 'studystats',
  name: '学习统计',
  icon: '📊',
  category: '其它',
  desc: '统计每天学/休息/暂离多久、细到每个节点，几点到几点一目了然：开着番茄钟专注时，看哪篇教程就记到哪（可绑定节点全局同步）；切出应用记暂离；日历页按天查看',
  order: 44,
  version: '1.1.0',
  author: '思而行内置',
  goalToggle: false,          // 非按目标启用：应用级开关
  defaultEnabled: true,
  client: '/plugins/studystats.js',

  /** 建表（宿主启动时调用一次；IF NOT EXISTS，老库直接升级） */
  init(ctx) {
    bind(ctx);
    db.exec(SCHEMA);
  },

  /** 目标被删除时清理该目标的学习记录 */
  onGoalDelete(goalId, ctx) {
    ctx.db.prepare('DELETE FROM study_records WHERE goal_id = ?').run(goalId);
    ctx.db.prepare('DELETE FROM study_segments WHERE goal_id = ?').run(goalId);
  },

  api: [
    {
      /* 心跳记账（兼容旧前端）：{ node_id, seconds } → 专注桶 */
      method: 'POST',
      pattern: /^\/api\/study\/credit$/,
      handler: async (req, res, u, ctx) => {
        if (u.pathname !== '/api/study/credit') return false;
        const body = await readBody(req).catch(() => ({}));
        const nodeId = Number(body.node_id) || 0;
        if (!nodeId) return sendJSON(res, 400, { error: '缺少节点' });
        const r = applyReport('focus', nodeId, Number(body.seconds) || 0);
        if (!r) return sendJSON(res, 400, { error: '时长无效' });
        if (r.error) return sendJSON(res, 404, { error: r.error });
        return sendJSON(res, 200, r);
      }
    },
    {
      /* 统一上报：{ bucket: focus|rest|away, node_id, seconds } */
      method: 'POST',
      pattern: /^\/api\/study\/report$/,
      handler: async (req, res, u, ctx) => {
        if (u.pathname !== '/api/study/report') return false;
        const body = await readBody(req).catch(() => ({}));
        const r = applyReport(body.bucket, Number(body.node_id) || 0, Number(body.seconds) || 0);
        if (!r) return sendJSON(res, 400, { error: '时长无效' });
        if (r.error) return sendJSON(res, 404, { error: r.error });
        return sendJSON(res, 200, r);
      }
    },
    {
      /* 节点查询（供番茄钟绑定用）：?id= 取单个；?q= 搜标题；都不带返回最近学过的 */
      method: 'GET',
      pattern: /^\/api\/study\/nodes$/,
      handler: async (req, res, u, ctx) => {
        if (u.pathname !== '/api/study/nodes') return false;
        const id = Number(u.searchParams.get('id')) || 0;
        const q = String(u.searchParams.get('q') || '').trim().slice(0, 40);
        const limit = Math.max(1, Math.min(30, Number(u.searchParams.get('limit')) || 10));
        const one = nid => {
          const n = db.prepare('SELECT id, goal_id, title FROM nodes WHERE id = ?').get(nid);
          if (!n) return null;
          const g = db.prepare('SELECT id, title FROM goals WHERE id = ?').get(n.goal_id);
          return { node_id: n.id, node_title: n.title, goal_id: n.goal_id, goal_title: g ? g.title : '' };
        };
        if (id) {
          const n = one(id);
          if (!n) return sendJSON(res, 404, { error: '节点不存在' });
          return sendJSON(res, 200, { node: n });
        }
        if (q) {
          const rows = db.prepare('SELECT id, goal_id, title FROM nodes WHERE title LIKE ? ORDER BY id DESC LIMIT ?').all('%' + q + '%', limit);
          return sendJSON(res, 200, {
            nodes: rows.map(n => {
              const g = db.prepare('SELECT id, title FROM goals WHERE id = ?').get(n.goal_id);
              return { node_id: n.id, node_title: n.title, goal_id: n.goal_id, goal_title: g ? g.title : '' };
            })
          });
        }
        const rows = db.prepare('SELECT node_id, MAX(updated_at) AS t FROM study_records GROUP BY node_id ORDER BY t DESC LIMIT ?').all(limit);
        return sendJSON(res, 200, { nodes: rows.map(r => one(r.node_id)).filter(Boolean) });
      }
    },
    {
      /* 月汇总：?month=YYYY-MM → 每天专注/休息/暂离 + 月总计 */
      method: 'GET',
      pattern: /^\/api\/study\/month$/,
      handler: async (req, res, u, ctx) => {
        if (u.pathname !== '/api/study/month') return false;
        let month = String(u.searchParams.get('month') || '');
        if (!/^\d{4}-\d{2}$/.test(month)) month = localDay().slice(0, 7);
        const days = {};
        let tf = 0, tr = 0, ta = 0;
        for (const r of db.prepare('SELECT day, focus_sec, rest_sec, away_sec FROM study_days WHERE day LIKE ?').all(month + '%')) {
          days[r.day] = { f: r.focus_sec, r: r.rest_sec, a: r.away_sec };
          tf += r.focus_sec; tr += r.rest_sec; ta += r.away_sec;
        }
        // 老数据只有 study_records：没有 study_days 行的天，用按节点汇总补专注数
        for (const r of db.prepare('SELECT day, SUM(focus_sec) AS sec FROM study_records GROUP BY day').all()) {
          if (!days[r.day] && String(r.day).startsWith(month)) { days[r.day] = { f: r.sec, r: 0, a: 0 }; tf += r.sec; }
        }
        return sendJSON(res, 200, { month, days, total_focus: tf, total_rest: tr, total_away: ta, active_days: Object.keys(days).length });
      }
    },
    {
      /* 日明细：?day=YYYY-MM-DD → 总量 + 时间线 + 按节点 */
      method: 'GET',
      pattern: /^\/api\/study\/day$/,
      handler: async (req, res, u, ctx) => {
        if (u.pathname !== '/api/study/day') return false;
        let day = String(u.searchParams.get('day') || '');
        if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) day = localDay();
        const drow = db.prepare('SELECT * FROM study_days WHERE day = ?').get(day);
        const rows = db.prepare('SELECT * FROM study_records WHERE day = ? AND node_id > 0 ORDER BY focus_sec DESC').all(day);
        const out = rows.map(r => {
          const n = db.prepare('SELECT id, goal_id, title FROM nodes WHERE id = ?').get(r.node_id);
          const g = db.prepare('SELECT id, title FROM goals WHERE id = ?').get(r.goal_id);
          return {
            node_id: r.node_id,
            node_title: (n && n.title) || r.node_title || ('节点 ' + r.node_id),
            node_gone: !n,
            goal_id: r.goal_id,
            goal_title: (g && g.title) || r.goal_title || '',
            focus_sec: r.focus_sec
          };
        });
        const sumRec = out.reduce((a, x) => a + x.focus_sec, 0);
        const totals = drow
          ? { focus: drow.focus_sec, rest: drow.rest_sec, away: drow.away_sec }
          : { focus: sumRec, rest: 0, away: 0 };
        const segs = db.prepare('SELECT id, kind, node_id, node_title, goal_id, goal_title, started_at, ended_at, seconds FROM study_segments WHERE day = ? ORDER BY started_at, id').all(day);
        const timeline = segs.map(s => {
          const hhmm = t => String(t || '').slice(11, 16) || '--:--';
          return {
            id: s.id,
            kind: s.kind, node_id: s.node_id,
            node_title: s.node_title || (s.kind === 'rest' ? '休息' : (s.kind === 'away' ? '暂离应用' : '')),
            goal_id: s.goal_id, goal_title: s.goal_title || '',
            from: hhmm(s.started_at), to: hhmm(s.ended_at), seconds: s.seconds
          };
        });
        return sendJSON(res, 200, { day, totals, records: out, timeline });
      }
    },
    {
      /* 删一条节点记录：?day=&node_id=（记错了可删） */
      method: 'DELETE',
      pattern: /^\/api\/study\/record$/,
      handler: async (req, res, u, ctx) => {
        if (u.pathname !== '/api/study/record') return false;
        const day = String(u.searchParams.get('day') || '');
        const nodeId = Number(u.searchParams.get('node_id')) || 0;
        if (!/^\d{4}-\d{2}-\d{2}$/.test(day) || !nodeId) return sendJSON(res, 400, { error: '参数无效' });
        db.prepare('DELETE FROM study_records WHERE day = ? AND node_id = ?').run(day, nodeId);
        return sendJSON(res, 200, { ok: true });
      }
    },
    {
      /* 清空某天：?day=（重来） */
      method: 'DELETE',
      pattern: /^\/api\/study\/day$/,
      handler: async (req, res, u, ctx) => {
        if (u.pathname !== '/api/study/day') return false;
        const day = String(u.searchParams.get('day') || '');
        if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) return sendJSON(res, 400, { error: '参数无效' });
        db.prepare('DELETE FROM study_records WHERE day = ?').run(day);
        db.prepare('DELETE FROM study_days WHERE day = ?').run(day);
        db.prepare('DELETE FROM study_segments WHERE day = ?').run(day);
        return sendJSON(res, 200, { ok: true });
      }
    }
  ]
};
