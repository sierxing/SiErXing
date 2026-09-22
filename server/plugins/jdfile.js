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
      if (!row.file || !fs.existsSync(fpath)) return sendJSON(res, 404, { error: '原图已不在，请重新粘贴上传' });
      const reuseSourceId = row.source_id || 0;   // 重试后原地更新同一条资料源，避免重复入库
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
          content: src.content, published_at: src.published_at, extracted: img.extracted || '', image: img.file
        });
      }
      out.count = out.sources.length;
      const fname = encodeURIComponent('图片资料-' + String(g.title).replace(/[\\/:*?"<>|]/g, '').slice(0, 20) + '.sources.json');
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
  lines.push('{"type":"JD / 大纲 / 教材 / 笔记 / 表格 / 文章 / 其他","title":"一句话标题（如：字节跳动 Agent 实习 JD、机器学习课程大纲）","source":"来源机构/公司/学校/作者，没有就留空","location":"","salary":"","summary":"3 句以内总结","points":["关键要点"],"sections":["结构化条目（章节/职责/要求等，按原结构）"],"keywords":["关键词"],"hard_conditions":["硬性条件 / 门槛 / 前置知识"],"priority":["对目标最关键的前 3-5 项"],"actions":["据此应该做什么"],"raw_text":"尽可能完整的原文文本"}');
  if (note) { lines.push(''); lines.push('【用户备注】' + note); }
  return lines.join('\n');
}
function imageToText(data) {
  const L = [];
  const line = (label, v) => { if (v) L.push(label + '：' + v); };
  const list = (label, arr) => { if (Array.isArray(arr) && arr.length) L.push(label + '：\n' + arr.map(x => '· ' + x).join('\n')); };
  line('资料类型', data.type);
  line('标题', data.title);
  line('来源', data.source || data.company);
  line('地点', data.location);
  line('薪资', data.salary);
  list('关键要点', data.points);
  list('结构化内容', data.sections || data.duties || data.requirements);
  const kw = data.keywords || data.skills;
  if (Array.isArray(kw) && kw.length) L.push('关键词：' + kw.join('、'));
  if (Array.isArray(data.hard_conditions) && data.hard_conditions.length) L.push('硬性条件：' + data.hard_conditions.join('；'));
  list('最关键内容', data.priority);
  list('建议行动', data.actions);
  line('总结', data.summary);
  if (data.raw_text) L.push('\n原文摘录：\n' + String(data.raw_text).slice(0, 3000));
  return L.join('\n');
}
function streamJDImage(req, res, goal, dataUrl, note, reuseSourceId) {
  res.writeHead(200, { 'Content-Type': 'text/event-stream; charset=utf-8', 'Cache-Control': 'no-cache', 'Connection': 'keep-alive' });
  const send = obj => { try { res.write(`data: ${JSON.stringify(obj)}\n\n`); } catch (e) {} };
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
    res.end();
  })();
}
