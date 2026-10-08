/**
 * 思而行 · 插件：信息源导入（图片 / 电子书 → 资料源）
 * ------------------------------------------------------------------
 * 能力：截图粘贴 / 批量多选 / 整个文件夹 → 图片走视觉模型提炼、
 *       电子书本地解析后走文本模型提炼 → 自动写入资料源，
 *       优先参与规划决策（资料源按 kind='JD' 排序靠前）。
 */
'use strict';
const { parseEbook, MAX_FILE } = require('./lib/ebook-parse');
const { resolveRoot, readProject, buildStudyDigestPrompt, digestToText } = require('./lib/code-digest');
let db, nowISO, safeParse, sendJSON, readBody, getSetting, setSetting, backup, log;
let fs, path, os, spawn, APP_DIR, DATA_DIR, UPLOAD_DIR, PUBLIC_DIR;
let getGoal, sourcesOf, aiText, aiTextFiles, currentModel, currentVisionModel, tasks;
function bind(ctx) {
  ({ db, nowISO, safeParse, sendJSON, readBody, getSetting, setSetting, backup, log } = ctx);
  ({ fs, path, os, spawn, APP_DIR, DATA_DIR, UPLOAD_DIR, PUBLIC_DIR } = ctx);
  ({ getGoal, sourcesOf, aiText, aiTextFiles, currentModel, currentVisionModel, tasks } = ctx);
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
  name: '信息源导入',
  category: '基础功能组件',
  scope: 'base',        // 与问卷/约束等一样，属于内置基础功能组件（不是扩展组件）
  builtin: true,        // 随应用分发：不显示"第三方组件"标签，也不提供卸载
  icon: '📥',
  desc: '向信息源导入资料：截图粘贴/批量多选/整个文件夹（图片走视觉模型识别，txt/pdf/epub/mobi 本地解析后提炼），自动入库并优先参与规划',
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
    // 重试识别：失败/不满意的图片可以用当前（新配置的）视觉模型重新识别一次
    method: 'POST',
    pattern: /^\/api\/jd-images\/(\d+)\/retry$/,
    handler: async (req, res, u, ctx) => {
      const m = u.pathname.match(/^\/api\/jd-images\/(\d+)\/retry$/);
      if (!m || req.method !== 'POST') return false;
      const row = db.prepare('SELECT * FROM jd_images WHERE id = ?').get(Number(m[1]));
      if (!row) return sendJSON(res, 404, { error: '图片不存在' });
      const g = db.prepare('SELECT * FROM goals WHERE id = ?').get(row.goal_id);
      if (!g) return sendJSON(res, 404, { error: '目标不存在' });
      const fpath = path.join(UPLOAD_DIR, row.file);
      if (!row.file || !fs.existsSync(fpath)) return sendJSON(res, 404, { error: '原文件已不在，请重新上传' });
      const reuseSourceId = row.source_id || 0;   // 重试后原地更新同一条资料源，避免重复入库
      // 电子书走文本重解析 + 文本模型重提炼；图片走视觉模型
      if (isEbookRow(row)) {
        try { db.prepare('DELETE FROM jd_images WHERE id = ?').run(row.id); } catch (e) {}
        const buf = fs.readFileSync(fpath);
        return streamEbook(req, res, g, buf, row.file, '', reuseSourceId);
      }
      try { db.prepare('DELETE FROM jd_images WHERE id = ?').run(row.id); } catch (e) {}
      const buf = fs.readFileSync(fpath);
      const dataUrl = 'data:' + (row.mime || 'image/png') + ';base64,' + buf.toString('base64');
      return streamJDImage(req, res, g, dataUrl, '', reuseSourceId);
    }
  },
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
    // 电子书导入：txt / md / pdf / epub / mobi（本地解析 → 文本模型提炼 → 资料源）
    method: 'POST',
    pattern: /^\/api\/goals\/(\d+)\/ebook$/,
    handler: async (req, res, u, ctx) => {
      const p = u.pathname, method = req.method;
        const ebAddMatch = p.match(/^\/api\/goals\/(\d+)\/ebook$/);
        if (ebAddMatch && method === 'POST') {
          const g = db.prepare('SELECT * FROM goals WHERE id = ?').get(Number(ebAddMatch[1]));
          if (!g) return sendJSON(res, 404, { error: '目标不存在' });
          const body = await readBody(req);
          const filename = String(body.filename || '').slice(0, 120);
          const dataUrl = String(body.dataUrl || body.dataBase64 || '');
          if (!dataUrl) return sendJSON(res, 400, { error: '没有收到文件' });
          const b64 = dataUrl.includes('base64,') ? dataUrl.slice(dataUrl.indexOf('base64,') + 7) : dataUrl;
          let buf = null;
          try { buf = Buffer.from(b64, 'base64'); } catch (e) { buf = null; }
          if (!buf || !buf.length) return sendJSON(res, 400, { error: '文件内容为空' });
          if (buf.length > MAX_FILE) return sendJSON(res, 400, { error: '文件过大（请控制在 12MB 以内；大部头可拆分章节导入）' });
          return streamEbook(req, res, g, buf, filename, String(body.note || '').trim().slice(0, 300));
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
          // 标注资料源是否还在（在信息源面板里被删掉时，前端提示重新导入）
          for (const r of rows) r.source_exists = r.source_id ? !!db.prepare('SELECT 1 FROM sources WHERE id = ?').get(r.source_id) : false;
          return sendJSON(res, 200, { images: rows });
        }
    }
  },
  {
    // 一键导出图片资料（纯文字）：识别结果打包成 JSON，可发给别人
    method: 'GET',
    pattern: /^\/api\/goals\/(\d+)\/jd-images\/export$/,
    handler: async (req, res, u, ctx) => {
      const m = u.pathname.match(/^\/api\/goals\/(\d+)\/jd-images\/export$/);
      if (!m || req.method !== 'GET') return false;
      const g = db.prepare('SELECT * FROM goals WHERE id = ?').get(Number(m[1]));
      if (!g) return sendJSON(res, 404, { error: '目标不存在' });
      const imgs = db.prepare('SELECT * FROM jd_images WHERE goal_id = ? ORDER BY id').all(g.id);
      const out = { format: 'sierxing-sources', version: 1, exportedAt: nowISO(), from: { goal: g.title }, count: 0, sources: [] };
      for (const img of imgs) {
        const src = img.source_id ? db.prepare('SELECT * FROM sources WHERE id = ?').get(img.source_id) : null;
        if (!src) continue;
        out.sources.push({
          title: src.title, kind: src.kind, site: src.site, snippet: src.snippet,
          content: src.content, published_at: src.published_at, extracted: img.extracted || '', image: img.file,
          file: img.file, fileKind: isEbookRow(img) ? 'ebook' : 'image'
        });
      }
      out.count = out.sources.length;
      const fname = encodeURIComponent('信息源-' + String(g.title).replace(/[\\/:*?"<>|]/g, '').slice(0, 20) + '.sources.json');
      res.writeHead(200, {
        'Content-Type': 'application/json; charset=utf-8',
        'Content-Disposition': "attachment; filename=\"sources.json\"; filename*=UTF-8''" + fname
      });
      return res.end(JSON.stringify(out, null, 2));
    }
  },
  {
    // 一键导入资料（别人发来的 *.sources.json）→ 直接进当前目标的信息源库
    method: 'POST',
    pattern: /^\/api\/goals\/(\d+)\/sources\/import$/,
    handler: async (req, res, u, ctx) => {
      const m = u.pathname.match(/^\/api\/goals\/(\d+)\/sources\/import$/);
      if (!m || req.method !== 'POST') return false;
      const g = db.prepare('SELECT * FROM goals WHERE id = ?').get(Number(m[1]));
      if (!g) return sendJSON(res, 404, { error: '目标不存在' });
      const body = await readBody(req);
      const list = Array.isArray(body.sources) ? body.sources : (Array.isArray(body) ? body : []);
      if (!list.length) return sendJSON(res, 400, { error: '文件里没有资料（需要 *.sources.json）' });
      let added = 0, skipped = 0;
      for (const s of list.slice(0, 500)) {
        const title = String((s && s.title) || '').trim().slice(0, 200);
        const content = String((s && (s.content || s.text)) || '').trim().slice(0, 20000);
        if (!title && !content) { skipped++; continue; }
        const dup = db.prepare("SELECT id FROM sources WHERE goal_id = ? AND ((title != '' AND title = ?) OR (content != '' AND content = ?)) LIMIT 1").get(g.id, title, content);
        if (dup) { skipped++; continue; }
        db.prepare('INSERT INTO sources (goal_id,title,url,site,kind,snippet,content,published_at,created_at) VALUES (?,?,?,?,?,?,?,?,?)')
          .run(g.id, title || '导入的资料', String(s.url || ''), '导入的资料',
            String(s.kind || '资料').slice(0, 10), String(s.snippet || content.slice(0, 300)).slice(0, 300),
            content, String(s.published_at || ''), nowISO());
        added++;
      }
      if (added) { db.prepare('UPDATE goals SET updated_at = ? WHERE id = ?').run(nowISO(), g.id); backup(); }
      return sendJSON(res, 200, { ok: true, added, skipped, total: list.length, goal: getGoal(g.id), sources: sourcesOf(g.id) });
    }
  },
  {
    /* 导入代码库：给一个本机路径 → 只读读完 → AI 出「怎么读懂它」的摘要 → 进资料库。
       为什么要有这条：目标是"搞懂某个项目的源码"时，唯一的一手资料就是这个代码库本身，
       去网上搜 JD/面经毫无意义。摘要是**学习导向**的（要掌握哪些概念、按什么顺序读），
       规划会直接照它排阶段。 */
    method: 'POST',
    pattern: /^\/api\/goals\/(\d+)\/code-repo$/,
    handler: async (req, res, u, ctx) => {
      const m = u.pathname.match(/^\/api\/goals\/(\d+)\/code-repo$/);
      if (!m || req.method !== 'POST') return false;
      const g = db.prepare('SELECT * FROM goals WHERE id = ?').get(Number(m[1]));
      if (!g) return sendJSON(res, 404, { error: '目标不存在' });
      const body = await readBody(req).catch(() => ({}));
      const raw = String(body.path || '').trim();
      if (!raw) return sendJSON(res, 400, { error: '请填写代码库路径' });
      const root = resolveRoot(raw);                     // 不存在 / 不是目录 → 400 说清楚
      const proj = readProject(root, { limit: 22, perFile: 12000, total: 46000 });
      if (!proj.files.length) return sendJSON(res, 400, { error: '这个目录里没找到可读的代码文件（.env / 密钥 / node_modules 一律不读）' });
      const name = String(root).split(/[\\/]/).filter(Boolean).pop() || '代码库';
      const title = '代码库：' + name;

      /* 已经导过同一个路径就不重复导（用户常手滑点两次） */
      const dup = db.prepare("SELECT id FROM sources WHERE goal_id = ? AND site = '导入的代码库' AND url = ? LIMIT 1").get(g.id, root);
      if (dup && !body.force) {
        return sendJSON(res, 200, { ok: true, already: true, goal: getGoal(g.id), sources: sourcesOf(g.id) });
      }

      const job = tasks.begin({ type: 'jdfile', title: '读懂代码库 · ' + name, note: root, goalId: g.id, message: 'AI 正在读这个代码库，整理成学习路径能用的摘要' });
      let txt = '';
      try {
        const t0 = Date.now();
        const iv = setInterval(() => {
          const sec = Math.round((Date.now() - t0) / 1000);
          job.progress(Math.min(93, Math.round(100 * (1 - Math.exp(-sec / 18)))), 'AI 正在读这个代码库（已等 ' + sec + ' 秒）');
        }, 1500);
        try { txt = await aiText(buildStudyDigestPrompt(root, proj.files, proj.all, g.title), currentModel(), 300000, null, job.signal); }
        finally { clearInterval(iv); }
        job.done(txt);
      } catch (e) { job.fail(e); throw e; }

      const d = extractJSON(txt);
      if (!d || typeof d !== 'object') throw new Error('代码库摘要没生成出来，点重试再来一次');
      const digestText = digestToText(d);
      if (!digestText) throw new Error('代码库摘要没生成出来，点重试再来一次');
      const fileList = proj.files.map(f => f.path);
      const snippet = '读了 ' + proj.files.length + ' 个文件：' + fileList.slice(0, 8).join('、') + (fileList.length > 8 ? ' 等' : '');
      const now = nowISO();
      db.prepare('INSERT INTO sources (goal_id,title,url,site,kind,snippet,content,published_at,created_at) VALUES (?,?,?,?,?,?,?,?,?)')
        .run(g.id, title, root, '导入的代码库', '代码库', snippet.slice(0, 300), digestText, '', now);
      /* 也写进「提炼汇总」：规划时按 4000 字带进去（原始资料列表只带 700 字，装不下） */
      db.prepare('INSERT INTO source_digests (goal_id,topic,title,content,sources_count,created_at) VALUES (?,?,?,?,?,?)')
        .run(g.id, '代码库', title, digestText, 1, now);
      db.prepare('UPDATE goals SET updated_at = ? WHERE id = ?').run(now, g.id);
      backup();
      return sendJSON(res, 200, {
        ok: true, read: proj.files.length, files: fileList,
        digest: d, goal: getGoal(g.id), sources: sourcesOf(g.id)
      });
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
function extractJSON(text) {
  const t = String(text || '').trim();
  if (!t) return null;
  const tryParse = raw => {
    if (!raw) return null;
    const cleaned = String(raw)
      .replace(/^\uFEFF/, '')
      .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, '')
      .replace(/,\s*([}\]])/g, '$1');
    try { return JSON.parse(cleaned); } catch (e) { return null; }
  };
  let r = tryParse(t);
  if (r) return r;
  const fence = t.match(/```(?:json|JSON)?\s*([\s\S]*?)```/);
  if (fence) { r = tryParse(fence[1]); if (r) return r; }
  const objs = [];
  let i = 0;
  while (i < t.length) {
    const start = t.indexOf('{', i);
    if (start < 0) break;
    let depth = 0, inStr = false, esc = false, end = -1;
    for (let j = start; j < t.length; j++) {
      const c = t[j];
      if (inStr) {
        if (esc) esc = false;
        else if (c === '\\') esc = true;
        else if (c === '"') inStr = false;
        continue;
      }
      if (c === '"') { inStr = true; continue; }
      if (c === '{') depth++;
      else if (c === '}') { depth--; if (depth === 0) { end = j; break; } }
    }
    if (end < 0) break;
    const o = tryParse(t.slice(start, end + 1));
    if (o && typeof o === 'object' && !Array.isArray(o)) objs.push(o);
    i = end + 1;
  }
  if (!objs.length) {
    // 可能是输出被截断：从第一个 { 到末尾，尽力补齐后解析
    const start = t.indexOf('{');
    if (start >= 0) {
      let cut = t.slice(start).replace(/\n\s*$/, '').replace(/,\s*$/, '');
      let inStr = false, esc = false;
      const stack = [];
      for (let j = 0; j < cut.length; j++) {
        const c = cut[j];
        if (inStr) {
          if (esc) esc = false;
          else if (c === '\\') esc = true;
          else if (c === '"') inStr = false;
          continue;
        }
        if (c === '"') { inStr = true; continue; }
        if (c === '{' || c === '[') stack.push(c === '{' ? '}' : ']');
        else if (c === '}' || c === ']') stack.pop();
      }
      if (inStr) cut += '"';
      while (stack.length) cut += stack.pop();
      const fixed = tryParse(cut);
      if (fixed && typeof fixed === 'object' && !Array.isArray(fixed)) return fixed;
    }
    return null;
  }
  objs.sort((a, b) => Object.keys(b).length - Object.keys(a).length);
  return objs[0];
}
/* 模型压根读不到图时的典型回复（此时不该把没用的原文当资料导入） */
function looksNoVision(text) {
  const t = String(text || '');
  if (/无法(查看|看到|读取|识别|访问|解析)图片|看不到图片|不支持(图片|图像|读图|视觉)|未(收到|提供|附带)图片|没有(收到|看到)图片|cannot (view|see|read|process|access) (the )?(image|picture)|unable to (view|see|read|process)|no image (was )?(provided|attached)/i.test(t)) return true;
  return false;
}
function noVisionError() {
  return new Error('当前模型不支持读图。请在「设置 → 视觉模型」里配置一个支持图片的模型（opencode 用户可填 opencode-go/deepseek-v4-flash-vision-exp，其他服务商如 qwen-vl-max / gpt-4o / glm-4v-plus），然后点这张图的「重试识别」。');
}
/* 提炼结果是否可用：任意关键字段有内容即可 */
function hasExtract(data) {
  if (!data || typeof data !== 'object' || Array.isArray(data)) return false;
  for (const k of ['title', 'summary', 'raw_text', 'type', 'source', 'company']) {
    if (typeof data[k] === 'string' && data[k].trim()) return true;
  }
  for (const k of ['points', 'sections', 'keywords', 'skills', 'hard_conditions', 'priority', 'actions', 'duties', 'requirements', 'modules']) {
    if (Array.isArray(data[k]) && data[k].length) return true;
  }
  return false;
}
/* 结构化提炼的输出契约（图片 / 电子书共用，改一处即可） */
const EXTRACT_SCHEMA = '{"type":"JD / 大纲 / 教材 / 笔记 / 表格 / 书籍 / 文章 / 其他","title":"一句话标题（如：字节跳动 Agent 实习 JD、机器学习课程大纲）","source":"来源机构/公司/学校/作者，没有就留空","location":"","salary":"","summary":"3 句以内总结","points":["关键要点"],"sections":["结构化条目（章节/职责/要求等，按原结构）"],"keywords":["关键词"],"hard_conditions":["硬性条件 / 门槛 / 前置知识"],"priority":["对目标最关键的前 3-5 项"],"actions":["据此应该做什么"],"raw_text":"尽可能完整的原文文本"}';
function buildImagePrompt(note) {
  const lines = [];
  lines.push('这是一张（或几张）与用户目标相关的图片资料，可能是：招聘 JD、课程大纲、教材/笔记、文章或表格截图、思维导图、代码截图等。');
  lines.push('请先判断图片类型，再把其中有价值的信息准确提炼出来，作为目标规划的参考资料。');
  lines.push('');
  lines.push('【提取要求】');
  lines.push('1. 逐字准确提取可见信息，不要脑补；看不清的地方标注「[不清晰]」。');
  lines.push('2. 按图片类型归纳内容：');
  lines.push('   · 招聘 JD：岗位、公司、地点、薪资、职责、任职要求、技能关键词、硬性条件（学历/到岗天数/实习时长等）、加分项；');
  lines.push('   · 大纲 / 教材 / 笔记：章节与知识模块、核心概念、学习目标、重点难点、前置知识、练习作业；');
  lines.push('   · 表格 / 清单：字段与条目，尽量保持原结构；');
  lines.push('   · 其他：关键事实、数据、结论。');
  lines.push('3. 判断这份资料对「用户目标」最关键的内容（按重要性排序），供规划参考。');
  lines.push('4. 只输出一个 JSON 对象：');
  lines.push(EXTRACT_SCHEMA);
  if (note) { lines.push(''); lines.push('【用户备注】' + note); }
  return lines.join('\n');
}
/* ---------- 电子书（txt / pdf / epub / mobi）：本地解析 + 文本模型提炼 ---------- */
const EBOOK_EXTS = ['txt', 'md', 'markdown', 'text', 'log', 'pdf', 'epub', 'mobi', 'azw', 'azw3'];
const EBOOK_MIMES = {
  txt: 'text/plain', md: 'text/markdown', markdown: 'text/markdown', text: 'text/plain', log: 'text/plain',
  pdf: 'application/pdf', epub: 'application/epub+zip',
  mobi: 'application/x-mobipocket-ebook', azw: 'application/x-mobipocket-ebook', azw3: 'application/x-mobipocket-ebook'
};
function ebookExtOf(filename) {
  const m = String(filename || '').toLowerCase().match(/\.([a-z0-9]+)$/);
  return m ? m[1] : '';
}
function isEbookRow(row) {
  if (!row) return false;
  if (row.mime && !String(row.mime).startsWith('image/')) return true;
  return EBOOK_EXTS.includes(ebookExtOf(row.file));
}
function safeEbookName(goalId, filename) {
  const ext = ebookExtOf(filename) || 'txt';
  const base = String(filename || '').split(/[\\/]/).pop().replace(/\.[a-z0-9]+$/i, '').replace(/[\\/:*?"<>|]/g, '').slice(0, 40) || 'ebook';
  return `eb-${goalId}-${Date.now()}-${Math.random().toString(36).slice(2, 7)}-${base}.${ext}`;
}
/* 电子书提炼提示词：正文只喂前 2 万字（超长截断已注记），输出契约与图片共用 */
const EBOOK_PROMPT_CAP = 20000;
function buildEbookPrompt(parsed, filename, note) {
  const L = [];
  L.push('这是一本用户导入的电子书（已在本地解析成纯文本），请把它提炼成结构化资料，作为目标规划的参考。');
  L.push('【书籍信息】');
  L.push('文件名：' + String(filename || '').slice(0, 100));
  if (parsed.title) L.push('书名：' + String(parsed.title).slice(0, 100));
  if (parsed.author) L.push('作者：' + String(parsed.author).slice(0, 100));
  L.push('格式：' + (parsed.meta && parsed.meta.kind ? parsed.meta.kind : ebookExtOf(filename)));
  L.push('正文字数：约 ' + parsed.text.length + ' 字' + (parsed.meta && parsed.meta.truncated ? '（超长，只取了前 12 万字）' : ''));
  if (parsed.meta && Array.isArray(parsed.meta.chapters) && parsed.meta.chapters.length) {
    L.push('章节目录：\n' + parsed.meta.chapters.slice(0, 60).map((c, i) => `第${i + 1}章 ${c}`.slice(0, 80)).join('\n'));
  }
  if (parsed.warnings && parsed.warnings.length) L.push('解析注记：' + parsed.warnings.join('；'));
  L.push('');
  L.push('【提取要求】');
  L.push('1. 按书籍提炼：核心主题、章节知识结构、关键概念与结论、可直接用的方法/清单；不要逐句复述。');
  L.push('2. type 字段请填「书籍」；source 填作者或出版社（没有就留空）；title 用书名（一句话概括）。');
  L.push('3. 只输出一个 JSON 对象：');
  L.push(EXTRACT_SCHEMA);
  if (note) { L.push(''); L.push('【用户备注】' + note); }
  L.push('');
  const body = parsed.text.length > EBOOK_PROMPT_CAP
    ? parsed.text.slice(0, EBOOK_PROMPT_CAP) + `\n（正文共约 ${parsed.text.length} 字，此处只给出前 ${EBOOK_PROMPT_CAP} 字，请据此提炼）`
    : parsed.text;
  L.push('【正文开始】\n' + body + '\n【正文结束】');
  return L.join('\n');
}
function imageToText(data) {
  // 注意顺序：规划最关心的字段（硬性条件 / 最关键内容 / 建议行动）放最前面，
  // 这样即使提示词只截取前若干字符，也不会把关键要求切掉。
  const L = [];
  const line = (label, v) => { if (v) L.push(label + '：' + v); };
  const list = (label, arr) => { if (Array.isArray(arr) && arr.length) L.push(label + '：\n' + arr.map(x => '· ' + x).join('\n')); };
  line('资料类型', data.type);
  line('标题', data.title);
  line('来源', data.source || data.company);
  if (Array.isArray(data.hard_conditions) && data.hard_conditions.length) L.push('硬性条件（必须满足）：' + data.hard_conditions.join('；'));
  list('最关键内容', data.priority);
  list('建议行动', data.actions);
  line('地点', data.location);
  line('薪资', data.salary);
  list('关键要点', data.points);
  list('结构化内容', data.sections || data.duties || data.requirements);
  const kw = data.keywords || data.skills;
  if (Array.isArray(kw) && kw.length) L.push('关键词：' + kw.join('、'));
  line('总结', data.summary);
  if (data.raw_text) L.push('\n原文摘录：\n' + String(data.raw_text).slice(0, 3000));
  return L.join('\n');
}
function streamJDImage(req, res, goal, dataUrl, note, reuseSourceId) {
  res.writeHead(200, { 'Content-Type': 'text/event-stream; charset=utf-8', 'Cache-Control': 'no-cache', 'Connection': 'keep-alive' });
  const tk = (typeof tasks !== 'undefined' && tasks) ? tasks.begin({ type: 'image', title: '识别图片：' + String(goal.title || '').slice(0, 20), goalId: goal.id, nodeId: 0, note: note || '' }) : null;
  const send = obj => { try { res.write(`data: ${JSON.stringify(obj)}\n\n`); } catch (e) {} if (tk && obj && obj.status) tk.progress(undefined, obj.status); };
  (async () => {
    let fname = '', buf = null, mime = '';
    try {
      const m = String(dataUrl || '').match(/^data:(image\/[a-zA-Z0-9.+-]+);base64,(.+)$/);
      if (!m) throw new Error('图片格式不支持（请粘贴 PNG/JPG/WebP 图片）');
      mime = m[1].toLowerCase();
      buf = Buffer.from(m[2], 'base64');
      if (!buf.length) throw new Error('图片内容为空');
      if (buf.length > 8 * 1024 * 1024) throw new Error('图片过大（请压缩到 8MB 以内）');
      const ext = mime.includes('png') ? 'png' : mime.includes('webp') ? 'webp' : mime.includes('gif') ? 'gif' : 'jpg';
      fs.mkdirSync(UPLOAD_DIR, { recursive: true });
      fname = `jd-${goal.id}-${Date.now()}-${Math.random().toString(36).slice(2, 7)}.${ext}`;
      const fpath = path.join(UPLOAD_DIR, fname);
      fs.writeFileSync(fpath, buf);
      send({ status: '图片已收到，AI 正在识别并提炼信息…', file: fname });
      const model = currentVisionModel();
      let txt = await aiTextFiles(buildImagePrompt(note), model, [fpath], 300000);
      let data = extractJSON(txt);
      let notice = '';
      if (looksNoVision(txt)) throw noVisionError();
      if (!hasExtract(data)) {
        console.log('[jdfile] 结构化提炼失败，原始输出前 500 字:', String(txt || '').slice(0, 500).replace(/\n/g, ' '));
        send({ status: '第一次没解析成功，正在重新整理…' });
        try {
          txt = await aiTextFiles(buildImagePrompt(note) + '\n\n【重要】上一次的输出不是合法 JSON。请严格只输出一个 JSON 对象：不要解释文字、不要前后缀、不要多个对象，字符串内不要出现未转义的换行。', model, [fpath], 300000);
          if (looksNoVision(txt)) throw noVisionError();
          data = extractJSON(txt);
        } catch (e) {
      if (tk) tk.fail(e);
          console.log('[jdfile] 重试失败:', e.message);
          if (/不支持读图/.test(e.message)) throw e;
        }
      }
      if (!hasExtract(data)) {
        const raw = String(txt || '').trim();
        console.log('[jdfile] 重试后仍未解析。原始输出前 500 字:', raw.slice(0, 500).replace(/\n/g, ' '));
        if (looksNoVision(raw) || raw.length < 40) throw new Error('没能从这张图里提炼出内容：请确认「设置 → 视觉模型」配置的是支持图片的模型，或换一张更清晰的截图后重试。');
        const firstLine = raw.split('\n').map(x => x.trim()).find(Boolean) || '图片资料';
        data = { type: '资料', title: firstLine.slice(0, 40), summary: '', raw_text: raw.slice(0, 4000) };
        notice = '结构化提炼没成功，已按图片原文导入资料库（可重试或换一张更清晰的截图）';
      }
      const t = nowISO();
      const type = String(data.type || '').trim() || '资料';
        const from = data.source || data.company || '';
        const title = (type !== '资料' ? type + '：' : '') + String(data.title || '图片资料').slice(0, 60) + (from ? '（' + String(from).slice(0, 30) + '）' : '');
      const content = imageToText(data);
      const snippet = String(data.summary || '').slice(0, 300);
      const kind = /JD/i.test(type) ? 'JD' : type.slice(0, 10);
      let sourceId = 0;
      if (reuseSourceId) {
        // 重新识别：把原来的资料源就地更新（信息源库里的内容跟着变新）
        const old = db.prepare('SELECT id FROM sources WHERE id = ? AND goal_id = ?').get(reuseSourceId, goal.id);
        if (old) {
          db.prepare('UPDATE sources SET title=?, site=?, kind=?, snippet=?, content=?, created_at=? WHERE id=?')
            .run(title, '用户提供的图片', kind, snippet, content, t, old.id);
          sourceId = old.id;
        }
      }
      if (!sourceId) {
        const sr = db.prepare('INSERT INTO sources (goal_id,title,url,site,kind,snippet,content,published_at,created_at) VALUES (?,?,?,?,?,?,?,?,?)')
          .run(goal.id, title, '', '用户提供的图片', kind, snippet, content, '', t);
        sourceId = Number(sr.lastInsertRowid);
      }
      const jr = db.prepare('INSERT INTO jd_images (goal_id,file,mime,size,title,extracted,status,error,source_id,created_at) VALUES (?,?,?,?,?,?,?,?,?,?)')
        .run(goal.id, fname, mime, buf.length, title, JSON.stringify(data), 'done', '', sourceId, t);
      db.prepare('UPDATE goals SET updated_at = ? WHERE id = ?').run(t, goal.id);
      backup();
      send({ done: true, notice, jd: { id: Number(jr.lastInsertRowid), file: fname, title, source_id: sourceId }, extracted: data, goal: getGoal(goal.id), sources: sourcesOf(goal.id) });
    } catch (e) {
      try {
        db.prepare('INSERT INTO jd_images (goal_id,file,mime,size,title,extracted,status,error,source_id,created_at) VALUES (?,?,?,?,?,?,?,?,?,?)')
          .run(goal.id, fname || '', mime || '', buf ? buf.length : 0, '未识别：' + String(fname || '').slice(0, 40), '', 'failed', e.message, 0, nowISO());
      } catch (e2) {}
      send({ error: e.message });
    }
    if (tk) tk.done({ ok: true });
    res.end();
  })();
}
/* 电子书 → 资料源：本地解析（不经过视觉模型）→ 文本模型提炼 → 写入资料源。
 * 解析失败是确定性失败（格式不对/扫描版/加密），直接报错不落库；AI 阶段失败才落 failed 行。 */
/* 电子书入库核心（上传 / 自动下载共用，无 SSE）：本地解析 → AI 提炼 → 写入资料源。
 * 成功返回 { sourceId, title, notice, file }；解析失败等确定性错误直接 throw（由调用方决定落不落库）。 */
async function ingestEbookBuffer(goal, buf, filename, note, onStatus, reuseSourceId, origin, kindOverride, opts) {
  const ext = ebookExtOf(filename);
  if (!EBOOK_EXTS.includes(ext)) throw new Error('格式不支持：目前支持 .txt / .md / .pdf / .epub / .mobi（' + (ext ? '.' + ext + ' 不在其中' : '没有扩展名') + '）');
  const parsed = parseEbook(buf, filename);   // 确定性失败直接抛
  if (opts && opts.rejectGarbled && parsed.meta && parsed.meta.garbled) {
    throw new Error('PDF 文字层乱码（内嵌字体缺编码表），无法提炼：建议截图走图片识别');
  }
  const mime = EBOOK_MIMES[parsed.meta.kind] || EBOOK_MIMES[ext] || 'application/octet-stream';
  fs.mkdirSync(UPLOAD_DIR, { recursive: true });
  const fname = safeEbookName(goal.id, filename);
  fs.writeFileSync(path.join(UPLOAD_DIR, fname), buf);
  const warnTxt = (parsed.warnings && parsed.warnings.length) ? '（' + parsed.warnings.join('；') + '）' : '';
  if (onStatus) onStatus(`解析成功：约 ${parsed.text.length} 字${warnTxt}，AI 正在提炼…`);
  const model = currentModel();
  let txt = await aiText(buildEbookPrompt(parsed, filename, note), model, 300000);
  let data = extractJSON(txt);
  let notice = (parsed.warnings && parsed.warnings.length) ? parsed.warnings.join('；') : '';
  if (!hasExtract(data)) {
    console.log('[jdfile] 电子书提炼失败，原始输出前 500 字:', String(txt || '').slice(0, 500).replace(/\n/g, ' '));
    if (onStatus) onStatus('第一次没解析成功，正在重新整理…');
    try {
      txt = await aiText(buildEbookPrompt(parsed, filename, note) + '\n\n【重要】上一次的输出不是合法 JSON。请严格只输出一个 JSON 对象：不要解释文字、不要前后缀、不要多个对象，字符串内不要出现未转义的换行。', model, 300000);
      data = extractJSON(txt);
    } catch (e) {
      console.log('[jdfile] 电子书重试失败:', e.message);
    }
  }
  if (!hasExtract(data)) {
    const raw = String(txt || '').trim();
    console.log('[jdfile] 电子书重试后仍未解析。原始输出前 500 字:', raw.slice(0, 500).replace(/\n/g, ' '));
    if (raw.length < 40) {
      const err = new Error('AI 没能提炼出内容：请确认「设置」里的文本模型可用，或稍后点「重试识别」。原文已保存在上传文件里。');
      err.savedFile = fname;
      throw err;
    }
    data = { type: '书籍', title: (parsed.title || String(filename || '').split(/[\\/]/).pop() || '电子书').slice(0, 60), source: parsed.author || '', summary: '', raw_text: raw.slice(0, 4000) };
    notice = (notice ? notice + '；' : '') + '结构化提炼没成功，已按原文导入资料库（可重试）';
  }
  const t = nowISO();
  const from = data.source || parsed.author || '';
  const kindName = kindOverride || '书籍';
  const title = (kindName === '书籍' ? '书籍：' : kindName + '：') + String(data.title || parsed.title || filename || '电子书').slice(0, 60) + (from ? '（' + String(from).slice(0, 30) + '）' : '');
  data._ebook = {
    filename: String(filename || '').slice(0, 100), kind: parsed.meta.kind,
    chars: parsed.text.length, truncated: !!parsed.meta.truncated,
    chapters: Array.isArray(parsed.meta.chapters) ? parsed.meta.chapters.slice(0, 60) : [],
    author: parsed.author || '', file: fname,
    origin: origin || ''
  };
  const content = imageToText(data);
  const snippet = String(data.summary || '').slice(0, 300);
  let sourceId = 0;
  if (reuseSourceId) {
    const old = db.prepare('SELECT id FROM sources WHERE id = ? AND goal_id = ?').get(reuseSourceId, goal.id);
    if (old) {
      db.prepare('UPDATE sources SET title=?, site=?, kind=?, snippet=?, content=?, created_at=? WHERE id=?')
        .run(title, '用户提供的电子书', kindName, snippet, content, t, old.id);
      sourceId = old.id;
    }
  }
  if (!sourceId) {
    const sr = db.prepare('INSERT INTO sources (goal_id,title,url,site,kind,snippet,content,published_at,created_at) VALUES (?,?,?,?,?,?,?,?,?)')
      .run(goal.id, title, '', '用户提供的电子书', kindName, snippet, content, '', t);
    sourceId = Number(sr.lastInsertRowid);
  }
  db.prepare('INSERT INTO jd_images (goal_id,file,mime,size,title,extracted,status,error,source_id,created_at) VALUES (?,?,?,?,?,?,?,?,?,?)')
    .run(goal.id, fname, mime, buf.length, title, JSON.stringify(data), 'done', '', sourceId, t);
  db.prepare('UPDATE goals SET updated_at = ? WHERE id = ?').run(t, goal.id);
  backup();
  return { sourceId, title, notice, file: fname, extracted: data };
}
function streamEbook(req, res, goal, buf, filename, note, reuseSourceId) {
  res.writeHead(200, { 'Content-Type': 'text/event-stream; charset=utf-8', 'Cache-Control': 'no-cache', 'Connection': 'keep-alive' });
  const tk = (typeof tasks !== 'undefined' && tasks) ? tasks.begin({ type: 'image', title: '提炼电子书：' + String(filename || '').slice(0, 20), goalId: goal.id, nodeId: 0, note: note || '' }) : null;
  const send = obj => { try { res.write(`data: ${JSON.stringify(obj)}\n\n`); } catch (e) {} if (tk && obj && obj.status) tk.progress(undefined, obj.status); };
  (async () => {
    let info = null;
    try {
      send({ status: '正在本地解析电子书…' });
      info = await ingestEbookBuffer(goal, buf, filename, note,
        st => send({ status: st }), reuseSourceId, '');
      const jr = db.prepare('SELECT id FROM jd_images WHERE goal_id = ? AND file = ?').get(goal.id, info.file);
      send({ done: true, notice: info.notice, jd: { id: jr ? jr.id : 0, file: info.file, title: info.title, source_id: info.sourceId }, extracted: info.extracted, goal: getGoal(goal.id), sources: sourcesOf(goal.id) });
    } catch (e) {
      if (/格式不支持|文件过大|是空的|文件头不对|不是有效|结构异常|头损坏|没提取到文字|加密|不受支持/.test(e.message)) {
        // 确定性失败（解析层）：不落库，前端直接 toast 原因
        if (tk) tk.fail(e);
        send({ error: e.message });
        res.end();
        return;
      }
      try {
        db.prepare('INSERT INTO jd_images (goal_id,file,mime,size,title,extracted,status,error,source_id,created_at) VALUES (?,?,?,?,?,?,?,?,?,?)')
          .run(goal.id, (info && info.file) || e.savedFile || '', '', buf ? buf.length : 0, '未识别：' + String(filename || '').slice(0, 40), '', 'failed', e.message, 0, nowISO());
      } catch (e2) {}
      send({ error: e.message });
    }
    if (tk) tk.done({ ok: true });
    res.end();
  })();
}

/* 供服务端搜集流程复用：不经过 SSE，直接入库 */
module.exports.ingestEbookBuffer = ingestEbookBuffer;
