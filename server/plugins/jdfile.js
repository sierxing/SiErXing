/**
 * 思而行 · 插件：图片资料（JD / 大纲 / 教材截图 → 资料源）
 * ------------------------------------------------------------------
 * 能力：粘贴/拖拽/选择图片 → 视觉模型提炼结构化信息 → 自动写入资料源，
 *       优先参与规划决策（资料源按 kind='JD' 排序靠前）。
 * 说明：演示了「视觉模型 + SSE 进度 + 资料源写入」的插件写法。
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
CREATE TABLE IF NOT EXISTS jd_images (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  goal_id INTEGER NOT NULL,
  file TEXT NOT NULL DEFAULT '',
  mime TEXT NOT NULL DEFAULT '',
  size INTEGER NOT NULL DEFAULT 0,
  title TEXT NOT NULL DEFAULT '',
  extracted TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'done',
  error TEXT NOT NULL DEFAULT '',
  source_id INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL
);`;

module.exports = {
  id: 'jdfile',
  name: '图片资料',
  category: '基础功能组件',
  scope: 'base',        // 与问卷/约束等一样，属于内置基础功能组件（不是扩展组件）
  builtin: true,        // 随应用分发：不显示"第三方组件"标签，也不提供卸载
  icon: '📷',
  desc: '粘贴 JD / 大纲 / 教材截图，视觉模型提炼成结构化资料源，辅助规划决策',
  order: 30,
  goalToggle: true,
  defaultEnabled: true,
  client: '/plugins/jdfile.js',

  init(ctx) {
    bind(ctx);
    db.exec(SCHEMA);
  },
  onGoalDelete(goalId, ctx) {
    for (const jd of ctx.db.prepare('SELECT file FROM jd_images WHERE goal_id = ?').all(goalId)) {
      try { ctx.fs.unlinkSync(ctx.path.join(ctx.UPLOAD_DIR, jd.file)); } catch (e) {}
    }
    ctx.db.prepare('DELETE FROM jd_images WHERE goal_id = ?').run(goalId);
  },

  exportData(ctx) {
    return { images: ctx.db.prepare('SELECT * FROM jd_images').all() };
  },
  importData(data, ctx) {
    if (!data) return;
    for (const x of (data.images || [])) ctx.db.prepare('INSERT OR REPLACE INTO jd_images (id,goal_id,file,mime,size,title,extracted,status,error,source_id,created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)')
      .run(x.id, x.goal_id, x.file, x.mime, x.size, x.title, x.extracted, x.status, x.error, x.source_id, x.created_at);
  },
  clearAll(ctx) {
    ctx.db.exec('DELETE FROM jd_images;');
  },

  api: [
  {
    method: 'POST',
    pattern: /^\/api\/goals\/(\d+)\/jd-image$/,
    handler: async (req, res, u, ctx) => {
      const p = u.pathname, method = req.method;
        const jdAddMatch = p.match(/^\/api\/goals\/(\d+)\/jd-image$/);
        if (jdAddMatch && method === 'POST') {
          const g = db.prepare('SELECT * FROM goals WHERE id = ?').get(Number(jdAddMatch[1]));
          if (!g) return sendJSON(res, 404, { error: '目标不存在' });
          const body = await readBody(req);
          const dataUrl = String(body.dataUrl || '');
          if (!dataUrl) return sendJSON(res, 400, { error: '没有收到图片' });
          return streamJDImage(req, res, g, dataUrl, String(body.note || '').trim().slice(0, 300));
        }
    }
  },
  {
    method: 'GET',
    pattern: /^\/api\/goals\/(\d+)\/jd-images$/,
    handler: async (req, res, u, ctx) => {
      const p = u.pathname, method = req.method;
        const jdListMatch = p.match(/^\/api\/goals\/(\d+)\/jd-images$/);
        if (jdListMatch && method === 'GET') {
          const rows = db.prepare('SELECT id, goal_id, file, mime, size, title, extracted, status, error, source_id, created_at FROM jd_images WHERE goal_id = ? ORDER BY id DESC').all(Number(jdListMatch[1]));
          return sendJSON(res, 200, { images: rows });
        }
    }
  },
  {
    method: 'DELETE',
    pattern: /^\/api\/jd-images\/(\d+)$/,
    handler: async (req, res, u, ctx) => {
      const p = u.pathname, method = req.method;
        const jdDelMatch = p.match(/^\/api\/jd-images\/(\d+)$/);
        if (jdDelMatch && method === 'DELETE') {
          const id = Number(jdDelMatch[1]);
          const jd = db.prepare('SELECT * FROM jd_images WHERE id = ?').get(id);
          if (!jd) return sendJSON(res, 404, { error: '记录不存在' });
          if (jd.source_id) db.prepare('DELETE FROM sources WHERE id = ?').run(jd.source_id);
          try { fs.unlinkSync(path.join(UPLOAD_DIR, jd.file)); } catch (e) {}
          db.prepare('DELETE FROM jd_images WHERE id = ?').run(id);
          return sendJSON(res, 200, { ok: true });
        }
    }
  }
  ]
};

/* ===================== 以下为插件实现 ===================== */
/* ===== JD 图片 → 资料源 ===== */
function buildJDPrompt(note) {
  const lines = [];
  lines.push('这是一张（或几张）招聘 JD 的截图。请准确提取其中的岗位信息，作为职业规划的参考资料。');
  lines.push('');
  lines.push('【提取要求】');
  lines.push('1. 逐字准确提取可见信息，不要脑补；看不清的地方标注「[不清晰]」。');
  lines.push('2. 归纳：岗位名称、公司、地点、薪资、岗位职责、任职要求、技能关键词、硬性条件（学历/到岗天数/实习时长等）、加分项。');
  lines.push('3. 判断这份 JD 反映的「招聘方最看重什么」（按重要性排序），供规划参考。');
  lines.push('4. 只输出一个 JSON 对象：');
  lines.push('{"title":"岗位名","company":"","location":"","salary":"","duties":[""],"requirements":[""],"skills":[""],"hard_conditions":[""],"priority":["招聘方最看重的前 3-5 项"],"summary":"3 句以内总结","raw_text":"尽可能完整的原文文本"}');
  if (note) { lines.push(''); lines.push('【用户备注】' + note); }
  return lines.join('\n');
}
function jdToText(data) {
  const L = [];
  if (data.title) L.push('岗位：' + data.title);
  if (data.company) L.push('公司：' + data.company);
  if (data.location) L.push('地点：' + data.location);
  if (data.salary) L.push('薪资：' + data.salary);
  if (Array.isArray(data.duties) && data.duties.length) L.push('岗位职责：\n' + data.duties.map(x => '· ' + x).join('\n'));
  if (Array.isArray(data.requirements) && data.requirements.length) L.push('任职要求：\n' + data.requirements.map(x => '· ' + x).join('\n'));
  if (Array.isArray(data.skills) && data.skills.length) L.push('技能关键词：' + data.skills.join('、'));
  if (Array.isArray(data.hard_conditions) && data.hard_conditions.length) L.push('硬性条件：' + data.hard_conditions.join('；'));
  if (Array.isArray(data.priority) && data.priority.length) L.push('招聘方最看重：' + data.priority.join('；'));
  if (data.summary) L.push('总结：' + data.summary);
  if (data.raw_text) L.push('\n原文摘录：\n' + String(data.raw_text).slice(0, 3000));
  return L.join('\n');
}
function streamJDImage(req, res, goal, dataUrl, note) {
  res.writeHead(200, { 'Content-Type': 'text/event-stream; charset=utf-8', 'Cache-Control': 'no-cache', 'Connection': 'keep-alive' });
  const send = obj => { try { res.write(`data: ${JSON.stringify(obj)}\n\n`); } catch (e) {} };
  (async () => {
    try {
      const m = String(dataUrl || '').match(/^data:(image\/[a-zA-Z0-9.+-]+);base64,(.+)$/);
      if (!m) throw new Error('图片格式不支持（请粘贴 PNG/JPG/WebP 图片）');
      const mime = m[1].toLowerCase();
      const buf = Buffer.from(m[2], 'base64');
      if (!buf.length) throw new Error('图片内容为空');
      if (buf.length > 8 * 1024 * 1024) throw new Error('图片过大（请压缩到 8MB 以内）');
      const ext = mime.includes('png') ? 'png' : mime.includes('webp') ? 'webp' : mime.includes('gif') ? 'gif' : 'jpg';
      fs.mkdirSync(UPLOAD_DIR, { recursive: true });
      const fname = `jd-${goal.id}-${Date.now()}-${Math.random().toString(36).slice(2, 7)}.${ext}`;
      const fpath = path.join(UPLOAD_DIR, fname);
      fs.writeFileSync(fpath, buf);
      send({ status: '图片已收到，AI 正在识别并提炼 JD 信息…', file: fname });
      const model = currentVisionModel();
      const txt = await aiTextFiles(buildJDPrompt(note), model, [fpath], 300000);
      const data = extractJSON(txt);
      if (!data || !data.title) throw new Error('JD 信息提炼失败，请重试（建议换一张更清晰的截图）');
      const t = nowISO();
      const title = '岗位JD：' + String(data.title).slice(0, 60) + (data.company ? '（' + String(data.company).slice(0, 30) + '）' : '');
      const content = jdToText(data);
      const snippet = String(data.summary || '').slice(0, 300);
      const sr = db.prepare('INSERT INTO sources (goal_id,title,url,site,kind,snippet,content,published_at,created_at) VALUES (?,?,?,?,?,?,?,?,?)')
        .run(goal.id, title, '', '用户提供的JD图片', 'JD', snippet, content, '', t);
      const sourceId = Number(sr.lastInsertRowid);
      const jr = db.prepare('INSERT INTO jd_images (goal_id,file,mime,size,title,extracted,status,error,source_id,created_at) VALUES (?,?,?,?,?,?,?,?,?,?)')
        .run(goal.id, fname, mime, buf.length, title, JSON.stringify(data), 'done', '', sourceId, t);
      db.prepare('UPDATE goals SET updated_at = ? WHERE id = ?').run(t, goal.id);
      backup();
      send({ done: true, jd: { id: Number(jr.lastInsertRowid), file: fname, title, source_id: sourceId }, extracted: data, goal: getGoal(goal.id), sources: sourcesOf(goal.id) });
    } catch (e) {
      send({ error: e.message });
    }
    res.end();
  })();
}
