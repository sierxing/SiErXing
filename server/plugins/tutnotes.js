'use strict';
/**
 * 思而行 · 教程划线笔记（tutnotes）
 * ------------------------------------------------------------------
 * 像 WPS 阅读那样：在教程正文里选中一段文字 → 浮出小工具栏 → 高亮 / 下划线 / 写批注；
 * 右侧一个清单，列出这篇教程里做过的全部笔记，点一条就跳过去。
 *
 * 定位方式：记「相对正文纯文本的字符区间」+ 原文 + 前后各一小段上下文。
 *   · 教程没变 → 区间直接命中
 *   · 教程被 AI 改过 → 拿原文 + 上下文在正文里找回位置，并把新区间写回去（自愈）
 *   只记区间不记上下文的话，教程一改，所有批注就全错位了。
 */
let db, nowISO, sendJSON, readBody, backup, log;

const SCHEMA = `
CREATE TABLE IF NOT EXISTS tut_notes (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  tutorial_id INTEGER NOT NULL,
  goal_id INTEGER NOT NULL DEFAULT 0,
  start INTEGER NOT NULL DEFAULT 0,
  end INTEGER NOT NULL DEFAULT 0,
  text TEXT NOT NULL DEFAULT '',
  prefix TEXT NOT NULL DEFAULT '',
  suffix TEXT NOT NULL DEFAULT '',
  color TEXT NOT NULL DEFAULT 'yellow',      /* yellow | green | blue | pink */
  style TEXT NOT NULL DEFAULT 'highlight',   /* highlight | underline */
  note TEXT NOT NULL DEFAULT '',             /* 批注正文（可以只划线不写批注） */
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_tut_notes_tut ON tut_notes (tutorial_id);
`;

const COLORS = new Set(['yellow', 'green', 'blue', 'pink']);
const STYLES = new Set(['highlight', 'underline']);

function bind(ctx) {
  ({ db, nowISO, sendJSON, readBody, backup, log } = ctx);
}
const clip = (s, n) => String(s == null ? '' : s).slice(0, n);

module.exports = {
  id: 'tutnotes',
  name: '划线笔记',
  icon: '📌',
  desc: '像 WPS 那样在教程里划重点：选中一段文字就能高亮 / 下划线 / 写批注，右侧列出这篇教程的全部笔记，点一条跳过去',
  category: '学习与练习',
  order: 47,
  goalToggle: true,
  defaultEnabled: true,
  client: '/plugins/tutnotes.js',

  init(ctx) {
    bind(ctx);
    db.exec(SCHEMA);
  },
  onGoalDelete(goalId, ctx) {
    ctx.db.prepare('DELETE FROM tut_notes WHERE goal_id = ?').run(goalId);
    /* 教程被单独删掉时留下的笔记（按 tutorial_id 清） */
    try { ctx.db.exec('DELETE FROM tut_notes WHERE tutorial_id NOT IN (SELECT id FROM tutorials)'); } catch (e) {}
  },
  exportData(ctx) { return { notes: ctx.db.prepare('SELECT * FROM tut_notes').all() }; },
  importData(data, ctx) {
    for (const n of ((data && data.notes) || [])) {
      ctx.db.prepare('INSERT OR REPLACE INTO tut_notes (id,tutorial_id,goal_id,start,end,text,prefix,suffix,color,style,note,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)')
        .run(n.id, n.tutorial_id, n.goal_id, n.start, n.end, n.text, n.prefix, n.suffix, n.color, n.style, n.note, n.created_at, n.updated_at);
    }
  },

  api: [
    /* 某篇教程的全部笔记（按位置排序，侧栏就按阅读顺序列） */
    {
      method: 'GET', path: '/api/tutnotes',
      handler: async (req, res, u) => {
        const tid = Number(u.searchParams.get('tutorial_id')) || 0;
        if (!tid) return sendJSON(res, 400, { error: '缺少 tutorial_id' });
        const notes = db.prepare('SELECT * FROM tut_notes WHERE tutorial_id = ? ORDER BY start, id').all(tid);
        return sendJSON(res, 200, { notes });
      }
    },
    /* 划一条（选完文字就调它；批注可以先空着） */
    {
      method: 'POST', path: '/api/tutnotes',
      handler: async (req, res) => {
        const body = await readBody(req).catch(() => ({}));
        const tid = Number(body.tutorial_id) || 0;
        if (!tid) return sendJSON(res, 400, { error: '缺少 tutorial_id' });
        const t = db.prepare('SELECT id, goal_id FROM tutorials WHERE id = ?').get(tid);
        if (!t) return sendJSON(res, 404, { error: '教程不存在' });
        const text = clip(body.text, 2000).trim();
        if (!text) return sendJSON(res, 400, { error: '没有选中文字' });
        const start = Math.max(0, Number(body.start) || 0);
        const end = Math.max(start + 1, Number(body.end) || 0);
        const color = COLORS.has(String(body.color)) ? String(body.color) : 'yellow';
        const style = STYLES.has(String(body.style)) ? String(body.style) : 'highlight';
        const now = nowISO();
        const info = db.prepare('INSERT INTO tut_notes (tutorial_id,goal_id,start,end,text,prefix,suffix,color,style,note,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)')
          .run(tid, Number(t.goal_id) || 0, start, end, text, clip(body.prefix, 40), clip(body.suffix, 40), color, style, clip(body.note, 2000), now, now);
        backup();
        return sendJSON(res, 200, { note: db.prepare('SELECT * FROM tut_notes WHERE id = ?').get(Number(info.lastInsertRowid)) });
      }
    },
    /* 改：颜色 / 样式 / 批注 / （自愈后的）区间 */
    {
      method: 'PUT', pattern: /^\/api\/tutnotes\/(\d+)$/,
      handler: async (req, res, u) => {
        const m = u.pathname.match(/^\/api\/tutnotes\/(\d+)$/);
        const n = db.prepare('SELECT * FROM tut_notes WHERE id = ?').get(Number(m[1]));
        if (!n) return sendJSON(res, 404, { error: '这条笔记不存在' });
        const body = await readBody(req).catch(() => ({}));
        const color = COLORS.has(String(body.color)) ? String(body.color) : n.color;
        const style = STYLES.has(String(body.style)) ? String(body.style) : n.style;
        const note = body.note === undefined ? n.note : clip(body.note, 2000);
        const start = body.start === undefined ? n.start : Math.max(0, Number(body.start) || 0);
        const end = body.end === undefined ? n.end : Math.max(start + 1, Number(body.end) || 0);
        db.prepare('UPDATE tut_notes SET color=?, style=?, note=?, start=?, end=?, updated_at=? WHERE id=?')
          .run(color, style, note, start, end, nowISO(), n.id);
        backup();
        return sendJSON(res, 200, { note: db.prepare('SELECT * FROM tut_notes WHERE id = ?').get(n.id) });
      }
    },
    /* 删 */
    {
      method: 'DELETE', pattern: /^\/api\/tutnotes\/(\d+)$/,
      handler: async (req, res, u) => {
        const m = u.pathname.match(/^\/api\/tutnotes\/(\d+)$/);
        const n = db.prepare('SELECT id FROM tut_notes WHERE id = ?').get(Number(m[1]));
        if (!n) return sendJSON(res, 404, { error: '这条笔记不存在' });
        db.prepare('DELETE FROM tut_notes WHERE id = ?').run(n.id);
        backup();
        return sendJSON(res, 200, { ok: true, deleted: n.id });
      }
    }
  ]
};
