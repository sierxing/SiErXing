'use strict';
/**
 * 思而行 · 扩展组件：学习笔记
 * ------------------------------------------------------------------
 * 在对应节点记录 Markdown 笔记（教程页右侧栏，一边看教程一边记）；
 * 输入即实时渲染，可折叠、可拖动调宽，随多端同步。
 */
let db, sendJSON, readBody, backup, nowISO;
function bind(ctx) {
  ({ db, sendJSON, readBody, backup, nowISO } = ctx);
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS node_notes (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  node_id INTEGER NOT NULL,
  goal_id INTEGER NOT NULL DEFAULT 0,
  content TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);`;

module.exports = {
  id: 'notes',
  name: '学习笔记',
  icon: '✍️',
  category: '其它',
  desc: '在对应节点记录 Markdown 笔记：教程页右侧边栏，一边看教程一边记，实时渲染，可折叠可调宽（随多端同步）',
  order: 41,
  goalToggle: false,          // 非按目标启用：应用级开关
  defaultEnabled: true,
  client: '/plugins/notes.js',

  /** 建表（宿主启动时调用一次） */
  init(ctx) {
    bind(ctx);
    db.exec(SCHEMA);
  },

  /** 目标被删除时清理该目标的笔记 */
  onGoalDelete(goalId, ctx) {
    ctx.db.prepare('DELETE FROM node_notes WHERE goal_id = ?').run(goalId);
  },

  api: [
    {
      method: 'GET',
      pattern: /^\/api\/nodes\/(\d+)\/note$/,
      handler: async (req, res, u, ctx) => {
        const m = u.pathname.match(/^\/api\/nodes\/(\d+)\/note$/);
        if (!m) return false;
        const row = db.prepare('SELECT * FROM node_notes WHERE node_id = ?').get(Number(m[1]));
        return sendJSON(res, 200, { content: row ? row.content : '', updated_at: row ? row.updated_at : '' });
      }
    },
    {
      method: 'PUT',
      pattern: /^\/api\/nodes\/(\d+)\/note$/,
      handler: async (req, res, u, ctx) => {
        const m = u.pathname.match(/^\/api\/nodes\/(\d+)\/note$/);
        if (!m) return false;
        const nid = Number(m[1]);
        const n = db.prepare('SELECT * FROM nodes WHERE id = ?').get(nid);
        if (!n) return sendJSON(res, 404, { error: '节点不存在' });
        const body = await readBody(req);
        const content = String(body.content || '');
        if (content.length > 200000) return sendJSON(res, 400, { error: '笔记过长（20 万字符以内）' });
        const t = nowISO();
        const old = db.prepare('SELECT id FROM node_notes WHERE node_id = ?').get(nid);
        if (old) db.prepare('UPDATE node_notes SET content = ?, updated_at = ? WHERE node_id = ?').run(content, t, nid);
        else db.prepare('INSERT INTO node_notes (node_id, goal_id, content, created_at, updated_at) VALUES (?,?,?,?,?)').run(nid, n.goal_id, content, t, t);
        db.prepare('UPDATE goals SET updated_at = ? WHERE id = ?').run(t, n.goal_id);
        backup();
        return sendJSON(res, 200, { ok: true, length: content.length, updated_at: t });
      }
    }
  ]
};
