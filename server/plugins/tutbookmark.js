'use strict';
/**
 * 思而行 · 扩展组件：教程书签
 * ------------------------------------------------------------------
 * 在教程里按章节打标签（记录读到哪、标重点/待复习，点击跳回对应章节）；
 * 节点面板可把写好的 .md / .html 文件导入为该节点的教程。
 */
let db, sendJSON, readBody, backup, nowISO, getGoal;
function bind(ctx) {
  ({ db, sendJSON, readBody, backup, nowISO, getGoal } = ctx);
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS tutorial_bookmarks (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  tutorial_id INTEGER NOT NULL,
  goal_id INTEGER NOT NULL DEFAULT 0,
  node_id INTEGER NOT NULL DEFAULT 0,
  section_idx INTEGER NOT NULL DEFAULT 0,
  section_title TEXT NOT NULL DEFAULT '',
  label TEXT NOT NULL DEFAULT '',
  note TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS tutorial_progress (
  tutorial_id INTEGER PRIMARY KEY,
  goal_id INTEGER NOT NULL DEFAULT 0,
  node_id INTEGER NOT NULL DEFAULT 0,
  section_idx INTEGER NOT NULL DEFAULT 0,
  sections_total INTEGER NOT NULL DEFAULT 0,
  updated_at TEXT NOT NULL DEFAULT ''
);`;

module.exports = {
  id: 'tutbookmark',
  name: '教程书签',
  icon: '🔖',
  category: '其它',
  desc: '在教程里按章节打标签：记录读到哪、标重点/待复习，点击跳回对应章节；节点面板可导入外部教程文件（随多端同步）',
  order: 40,
  goalToggle: false,          // 非按目标启用：应用级开关
  defaultEnabled: true,
  client: '/plugins/tutbookmark.js',

  /** 建表（宿主启动时调用一次） */
  init(ctx) {
    bind(ctx);
    db.exec(SCHEMA);
  },

  /** 目标被删除时清理该目标的书签与阅读进度 */
  onGoalDelete(goalId, ctx) {
    ctx.db.prepare('DELETE FROM tutorial_bookmarks WHERE goal_id = ?').run(goalId);
    ctx.db.prepare('DELETE FROM tutorial_progress WHERE goal_id = ?').run(goalId);
  },

  api: [
    {
      method: 'GET',
      pattern: /^\/api\/tutorials\/(\d+)\/bookmarks$/,
      handler: async (req, res, u, ctx) => {
        const m = u.pathname.match(/^\/api\/tutorials\/(\d+)\/bookmarks$/);
        if (!m) return false;
        return sendJSON(res, 200, { bookmarks: db.prepare('SELECT * FROM tutorial_bookmarks WHERE tutorial_id = ? ORDER BY id').all(Number(m[1])) });
      }
    },
    {
      method: 'POST',
      pattern: /^\/api\/tutorials\/(\d+)\/bookmarks$/,
      handler: async (req, res, u, ctx) => {
        const m = u.pathname.match(/^\/api\/tutorials\/(\d+)\/bookmarks$/);
        if (!m) return false;
        const tid = Number(m[1]);
        const tut = db.prepare('SELECT * FROM tutorials WHERE id = ?').get(tid);
        if (!tut) return sendJSON(res, 404, { error: '教程不存在' });
        const body = await readBody(req);
        const label = String(body.label || '').trim().slice(0, 60);
        const sectionTitle = String(body.section_title || body.sectionTitle || '').trim().slice(0, 80);
        const idx = Math.max(0, Number(body.section_idx ?? body.sectionIdx) || 0);
        if (!label && !sectionTitle) return sendJSON(res, 400, { error: '请填写标签或章节' });
        const r = db.prepare('INSERT INTO tutorial_bookmarks (tutorial_id, goal_id, node_id, section_idx, section_title, label, note, created_at) VALUES (?,?,?,?,?,?,?,?)')
          .run(tid, tut.goal_id, tut.node_id, idx, sectionTitle, label || sectionTitle, String(body.note || '').trim().slice(0, 300), nowISO());
        backup();
        return sendJSON(res, 200, { ok: true, id: Number(r.lastInsertRowid) });
      }
    },
    {
      /* 上报阅读进度：{ section_idx, sections_total }（滚动节流 + 切页时前端调用） */
      method: 'POST',
      pattern: /^\/api\/tutorials\/(\d+)\/progress$/,
      handler: async (req, res, u, ctx) => {
        const m = u.pathname.match(/^\/api\/tutorials\/(\d+)\/progress$/);
        if (!m) return false;
        const tid = Number(m[1]);
        const tut = db.prepare('SELECT id, goal_id, node_id FROM tutorials WHERE id = ?').get(tid);
        if (!tut) return sendJSON(res, 404, { error: '教程不存在' });
        const body = await readBody(req).catch(() => ({}));
        const idx = Math.max(0, Number(body.section_idx) || 0);
        const total = Math.max(0, Number(body.sections_total) || 0);
        // 打开教程瞬间会上报 0（人在顶部）：不许把已有的进度倒回去，只刷新时间；
        // 真正往后读到的位置（idx>0）才覆盖
        db.prepare(`INSERT INTO tutorial_progress (tutorial_id, goal_id, node_id, section_idx, sections_total, updated_at)
          VALUES (?,?,?,?,?,?) ON CONFLICT(tutorial_id) DO UPDATE SET
          section_idx = CASE WHEN excluded.section_idx > 0 THEN excluded.section_idx ELSE section_idx END,
          sections_total = excluded.sections_total, updated_at = excluded.updated_at`)
          .run(tid, tut.goal_id, tut.node_id, idx, total, nowISO());
        return sendJSON(res, 200, { ok: true });
      }
    },
    {
      /* 本目标上次看到的教程（路线图“继续学习”卡片用） */
      method: 'GET',
      pattern: /^\/api\/goals\/(\d+)\/last-tutorial$/,
      handler: async (req, res, u, ctx) => {
        const m = u.pathname.match(/^\/api\/goals\/(\d+)\/last-tutorial$/);
        if (!m) return false;
        const gid = Number(m[1]);
        // 取最近几条，顺延到第一篇还存在的教程（刚删掉的教程不挡路）
        const rows = db.prepare('SELECT * FROM tutorial_progress WHERE goal_id = ? ORDER BY updated_at DESC, tutorial_id DESC LIMIT 5').all(gid);
        for (const p of rows) {
          const t = db.prepare('SELECT id, node_id, title, format FROM tutorials WHERE id = ?').get(p.tutorial_id);
          if (!t) continue;
          const n = db.prepare('SELECT id, title FROM nodes WHERE id = ?').get(t.node_id);
          return sendJSON(res, 200, {
            tutorial: { id: t.id, node_id: t.node_id, title: t.title, node_title: n ? n.title : '', section_idx: p.section_idx, sections_total: p.sections_total, updated_at: p.updated_at }
          });
        }
        return sendJSON(res, 200, { tutorial: null });
      }
    },
    {
      method: 'DELETE',
      pattern: /^\/api\/bookmarks\/(\d+)$/,
      handler: async (req, res, u, ctx) => {
        const m = u.pathname.match(/^\/api\/bookmarks\/(\d+)$/);
        if (!m) return false;
        db.prepare('DELETE FROM tutorial_bookmarks WHERE id = ?').run(Number(m[1]));
        return sendJSON(res, 200, { ok: true });
      }
    },
    {
      method: 'POST',
      pattern: /^\/api\/nodes\/(\d+)\/tutorials\/import$/,
      handler: async (req, res, u, ctx) => {
        const m = u.pathname.match(/^\/api\/nodes\/(\d+)\/tutorials\/import$/);
        if (!m) return false;
        const nid = Number(m[1]);
        const n = db.prepare('SELECT * FROM nodes WHERE id = ?').get(nid);
        if (!n) return sendJSON(res, 404, { error: '节点不存在' });
        const body = await readBody(req);
        const format = String(body.format || 'md').toLowerCase() === 'html' ? 'html' : 'md';
        const content = String(body.content || '');
        if (!content.trim()) return sendJSON(res, 400, { error: '内容不能为空' });
        if (content.length > 300000) return sendJSON(res, 400, { error: '内容过大（30 万字符以内）' });
        const title = String(body.title || '').trim().slice(0, 120) || (String(n.title || '').slice(0, 80) + '（导入的教程）');
        const r = db.prepare('INSERT INTO tutorials (goal_id, node_id, title, format, content, created_at, updated_at) VALUES (?,?,?,?,?,?,?)')
          .run(n.goal_id, nid, title, format, content, nowISO(), nowISO());
        db.prepare('UPDATE goals SET updated_at = ? WHERE id = ?').run(nowISO(), n.goal_id);
        backup();
        return sendJSON(res, 200, { ok: true, id: Number(r.lastInsertRowid), goal: getGoal(n.goal_id) });
      }
    }
  ]
};
