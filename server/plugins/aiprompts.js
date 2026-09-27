'use strict';
/**
 * 思而行 · 扩展组件：提示词库
 * ------------------------------------------------------------------
 * 把和 AI 对话时的常用提示词存下来（支持分类、排序），
 * 在 AI 对话框里点 📝 快捷选择，一键写入输入框，不用每次重打。
 * 全局数据（不属于某个目标），随多端同步与 JSON 备份。
 */
let db, sendJSON, readBody, backup, nowISO;
function bind(ctx) {
  ({ db, sendJSON, readBody, backup, nowISO } = ctx);
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS ai_prompts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  title TEXT NOT NULL DEFAULT '',
  category TEXT NOT NULL DEFAULT '',
  content TEXT NOT NULL DEFAULT '',
  sort_order INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);`;

const SEEDS = [
  { title: '展开讲讲', category: '教程修改', content: '把刚才教程里讲得太简略的部分再展开讲讲，多给完整代码示例和每一步的原理解释，保持原有结构。' },
  { title: '换更简单的练习', category: '教程修改', content: '把教程里的练习换成更简单的，循序渐进，并给每个练习加上参考答案或思路提示。' },
  { title: '加报错排查', category: '教程修改', content: '给教程加一节常见报错排查：列出新手最容易踩的 3-5 个报错（含报错信息原文）、原因和解决方法。' },
];

function listAll() {
  return db.prepare('SELECT * FROM ai_prompts ORDER BY sort_order ASC, id ASC').all();
}

module.exports = {
  id: 'aiprompts',
  name: '提示词库',
  icon: '📝',
  category: '其它',
  desc: '收藏和 AI 对话的常用提示词：支持分类、排序，对话框里点 📝 快捷选择、一键写入输入框（随多端同步）',
  order: 45,
  goalToggle: false,          // 非按目标启用：应用级开关
  defaultEnabled: true,
  client: '/plugins/aiprompts.js',

  /** 建表（宿主启动时调用一次）；空表时种几条示例 */
  init(ctx) {
    bind(ctx);
    db.exec(SCHEMA);
    try {
      const n = db.prepare('SELECT COUNT(*) AS c FROM ai_prompts').get().c;
      if (!n) {
        const t = nowISO();
        const ins = db.prepare('INSERT INTO ai_prompts (title, category, content, sort_order, created_at, updated_at) VALUES (?,?,?,?,?,?)');
        SEEDS.forEach((s, i) => ins.run(s.title, s.category, s.content, (i + 1) * 10, t, t));
      }
    } catch (e) { console.error('[aiprompts] 种子失败:', e.message); }
  },

  /** 导出/导入/清空（设置页 JSON 备份与恢复时携带） */
  exportData(ctx) {
    try { return ctx.db.prepare('SELECT * FROM ai_prompts ORDER BY sort_order ASC, id ASC').all(); }
    catch (e) { return []; }
  },
  importData(rows, ctx) {
    try {
      ctx.db.prepare('DELETE FROM ai_prompts').run();
      if (!Array.isArray(rows)) return;
      const t = nowISO();
      const ins = ctx.db.prepare('INSERT INTO ai_prompts (title, category, content, sort_order, created_at, updated_at) VALUES (?,?,?,?,?,?)');
      rows.forEach((r, i) => {
        if (!r || (!r.title && !r.content)) return;
        ins.run(String(r.title || '').slice(0, 120), String(r.category || '').slice(0, 40),
          String(r.content || '').slice(0, 8000), Number(r.sort_order) || (i + 1) * 10,
          String(r.created_at || t), String(r.updated_at || t));
      });
    } catch (e) { console.error('[aiprompts] 导入失败:', e.message); }
  },
  clearAll(ctx) {
    try { ctx.db.prepare('DELETE FROM ai_prompts').run(); } catch (e) {}
  },

  api: [
    {
      method: 'GET',
      pattern: /^\/api\/prompts$/,
      handler: async (req, res, u, ctx) => {
        if (u.pathname !== '/api/prompts') return false;
        return sendJSON(res, 200, { prompts: listAll() });
      }
    },
    {
      method: 'POST',
      pattern: /^\/api\/prompts$/,
      handler: async (req, res, u, ctx) => {
        if (u.pathname !== '/api/prompts') return false;
        const body = await readBody(req).catch(() => ({}));
        const title = String(body.title || '').trim().slice(0, 120);
        const content = String(body.content || '').trim().slice(0, 8000);
        if (!content) return sendJSON(res, 400, { error: '内容不能为空' });
        const category = String(body.category || '').trim().slice(0, 40);
        const max = db.prepare('SELECT COALESCE(MAX(sort_order), 0) AS m FROM ai_prompts').get().m;
        const t = nowISO();
        const r = db.prepare('INSERT INTO ai_prompts (title, category, content, sort_order, created_at, updated_at) VALUES (?,?,?,?,?,?)')
          .run(title || content.slice(0, 30), category, content, max + 10, t, t);
        backup();
        return sendJSON(res, 200, { ok: true, id: Number(r.lastInsertRowid) });
      }
    },
    {
      method: 'PUT',
      pattern: /^\/api\/prompts\/(\d+)$/,
      handler: async (req, res, u, ctx) => {
        const m = u.pathname.match(/^\/api\/prompts\/(\d+)$/);
        if (!m) return false;
        const id = Number(m[1]);
        const old = db.prepare('SELECT * FROM ai_prompts WHERE id = ?').get(id);
        if (!old) return sendJSON(res, 404, { error: '不存在' });
        const body = await readBody(req).catch(() => ({}));
        const title = body.title != null ? String(body.title).trim().slice(0, 120) : old.title;
        const category = body.category != null ? String(body.category).trim().slice(0, 40) : old.category;
        const content = body.content != null ? String(body.content).trim().slice(0, 8000) : old.content;
        if (!content) return sendJSON(res, 400, { error: '内容不能为空' });
        db.prepare('UPDATE ai_prompts SET title = ?, category = ?, content = ?, updated_at = ? WHERE id = ?')
          .run(title || content.slice(0, 30), category, content, nowISO(), id);
        backup();
        return sendJSON(res, 200, { ok: true });
      }
    },
    {
      method: 'DELETE',
      pattern: /^\/api\/prompts\/(\d+)$/,
      handler: async (req, res, u, ctx) => {
        const m = u.pathname.match(/^\/api\/prompts\/(\d+)$/);
        if (!m) return false;
        db.prepare('DELETE FROM ai_prompts WHERE id = ?').run(Number(m[1]));
        backup();
        return sendJSON(res, 200, { ok: true });
      }
    },
    {
      /* 整组重排：按传入 id 顺序重写 sort_order */
      method: 'PUT',
      pattern: /^\/api\/prompts\/order$/,
      handler: async (req, res, u, ctx) => {
        if (u.pathname !== '/api/prompts/order') return false;
        const body = await readBody(req).catch(() => ({}));
        const ids = Array.isArray(body.ids) ? body.ids.map(Number).filter(Boolean) : [];
        if (!ids.length) return sendJSON(res, 400, { error: '缺少 ids' });
        const t = nowISO();
        const stmt = db.prepare('UPDATE ai_prompts SET sort_order = ?, updated_at = ? WHERE id = ?');
        ids.forEach((id, i) => stmt.run((i + 1) * 10, t, id));
        backup();
        return sendJSON(res, 200, { ok: true });
      }
    },
    {
      /* 分类重命名 */
      method: 'POST',
      pattern: /^\/api\/prompt-categories\/rename$/,
      handler: async (req, res, u, ctx) => {
        if (u.pathname !== '/api/prompt-categories/rename') return false;
        const body = await readBody(req).catch(() => ({}));
        const oldName = String(body.old || '').trim().slice(0, 40);
        const newName = String(body.new || '').trim().slice(0, 40);
        if (!oldName) return sendJSON(res, 400, { error: '缺少原分类名' });
        db.prepare('UPDATE ai_prompts SET category = ?, updated_at = ? WHERE category = ?').run(newName, nowISO(), oldName);
        backup();
        return sendJSON(res, 200, { ok: true });
      }
    },
    {
      /* 删除分类：名下提示词移到“未分类”，不删内容 */
      method: 'POST',
      pattern: /^\/api\/prompt-categories\/delete$/,
      handler: async (req, res, u, ctx) => {
        if (u.pathname !== '/api/prompt-categories/delete') return false;
        const body = await readBody(req).catch(() => ({}));
        const name = String(body.name || '').trim().slice(0, 40);
        if (!name) return sendJSON(res, 400, { error: '缺少分类名' });
        const r = db.prepare("UPDATE ai_prompts SET category = '', updated_at = ? WHERE category = ?").run(nowISO(), name);
        backup();
        return sendJSON(res, 200, { ok: true, moved: r.changes || 0 });
      }
    }
  ]
};
