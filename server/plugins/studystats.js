'use strict';
/**
 * 思而行 · 扩展组件：学习统计
 * ------------------------------------------------------------------
 * 统计每天学了多久、细到每个节点学了多久。
 * 计分方式：番茄钟专注计时开着、且正停在某篇教程上时，
 * 流过的专注秒数就记到该教程对应的节点名下（前端每 ~15 秒上报一次）。
 * 注意：上报接口故意不调 backup()——心跳频率高，全量备份吃不消；
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
);`;

/* 本地日期（YYYY-MM-DD）：跟用户过日子的时区一致，不用 UTC */
function localDay(d) {
  const t = d || new Date();
  const p = n => String(n).padStart(2, '0');
  return t.getFullYear() + '-' + p(t.getMonth() + 1) + '-' + p(t.getDate());
}

module.exports = {
  id: 'studystats',
  name: '学习统计',
  icon: '📊',
  category: '其它',
  desc: '统计每天学了多久、细到每个节点：开着番茄钟专注时，看哪篇教程就把时间记到哪个节点名下；日历页按天查看',
  order: 44,
  version: '1.0.0',
  author: '思而行内置',
  goalToggle: false,          // 非按目标启用：应用级开关
  defaultEnabled: true,
  client: '/plugins/studystats.js',

  /** 建表（宿主启动时调用一次） */
  init(ctx) {
    bind(ctx);
    db.exec(SCHEMA);
  },

  /** 目标被删除时清理该目标的学习记录 */
  onGoalDelete(goalId, ctx) {
    ctx.db.prepare('DELETE FROM study_records WHERE goal_id = ?').run(goalId);
  },

  api: [
    {
      /* 心跳记账：{ node_id, seconds } */
      method: 'POST',
      pattern: /^\/api\/study\/credit$/,
      handler: async (req, res, u, ctx) => {
        if (u.pathname !== '/api/study/credit') return false;
        const body = await readBody(req).catch(() => ({}));
        const nodeId = Number(body.node_id) || 0;
        let sec = Math.round(Number(body.seconds) || 0);
        if (!nodeId) return sendJSON(res, 400, { error: '缺少节点' });
        if (!(sec >= 1)) return sendJSON(res, 400, { error: '时长无效' });
        sec = Math.min(sec, 600);
        const n = db.prepare('SELECT id, goal_id, title FROM nodes WHERE id = ?').get(nodeId);
        if (!n) return sendJSON(res, 404, { error: '节点不存在' });
        const g = db.prepare('SELECT id, title FROM goals WHERE id = ?').get(n.goal_id);
        const day = localDay();
        const t = nowISO();
        db.prepare(`INSERT INTO study_records (day, goal_id, node_id, node_title, goal_title, focus_sec, created_at, updated_at)
          VALUES (?,?,?,?,?,?,?,?)
          ON CONFLICT(day, node_id) DO UPDATE SET focus_sec = focus_sec + excluded.focus_sec,
            node_title = excluded.node_title, goal_title = excluded.goal_title, updated_at = excluded.updated_at`)
          .run(day, n.goal_id, nodeId, String(n.title || '').slice(0, 120), g ? String(g.title || '').slice(0, 120) : '', sec, t, t);
        // 节流备份：长时间专注时也定期落盘 + 触发同步（5 分钟一次，避免 WAL 只进不出）
        try {
          const nowMs = Date.now();
          if (nowMs - lastBackupAt > 5 * 60 * 1000) { lastBackupAt = nowMs; if (typeof backup === 'function') backup(); }
        } catch (e) {}
        return sendJSON(res, 200, { ok: true, day, credited: sec });
      }
    },
    {
      /* 月汇总：?month=YYYY-MM → 每天秒数 + 月总计 */
      method: 'GET',
      pattern: /^\/api\/study\/month$/,
      handler: async (req, res, u, ctx) => {
        if (u.pathname !== '/api/study/month') return false;
        let month = String(u.searchParams.get('month') || '');
        if (!/^\d{4}-\d{2}$/.test(month)) month = localDay().slice(0, 7);
        const rows = db.prepare("SELECT day, SUM(focus_sec) AS sec FROM study_records WHERE day LIKE ? GROUP BY day").all(month + '%');
        const days = {};
        let total = 0;
        for (const r of rows) { days[r.day] = r.sec; total += r.sec; }
        return sendJSON(res, 200, { month, days, total_sec: total, active_days: rows.length });
      }
    },
    {
      /* 日明细：?day=YYYY-MM-DD → 按节点列出（标题用实时标题，节点删改后也对得上） */
      method: 'GET',
      pattern: /^\/api\/study\/day$/,
      handler: async (req, res, u, ctx) => {
        if (u.pathname !== '/api/study/day') return false;
        let day = String(u.searchParams.get('day') || '');
        if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) day = localDay();
        const rows = db.prepare('SELECT * FROM study_records WHERE day = ? ORDER BY focus_sec DESC').all(day);
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
        const total = out.reduce((a, x) => a + x.focus_sec, 0);
        return sendJSON(res, 200, { day, records: out, total_sec: total });
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
      /* 删一条记录：?day=YYYY-MM-DD&node_id=（记错了可删） */
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
    }
  ]
};
