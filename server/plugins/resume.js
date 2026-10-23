'use strict';
/**
 * 思而行 · 扩展组件：简历工坊（resume）
 * ==================================================================
 * 目标：把「写简历 / 改简历 / 投递版本管理」做成一个本地可用的 AI 工作流，
 *       而不是一次性的聊天。参考并融合以下开源项目的工作流思想（详见 docs/resume-component.md）：
 *   1) https://github.com/Elowwwen/resume-evidence-workflow
 *      —— 经历证据库、追问式经历盘点、JD-证据匹配矩阵、区分事实/估计/解释、改写依据可回看；
 *   2) https://github.com/zclllyybb/lofisu-identity-engine
 *      —— 身份/定位引擎：先确定「我是谁、卖给谁」，再决定简历主线与素材取舍；
 *   3) https://github.com/Claycui828/ASu-resume-skills
 *      —— 高密度履历生成 + 证据优先审计：原子主张、证据等级、夸大模式、角色/范围边界；
 *   4) https://github.com/Elowwwen/resume-evidence-workflow （用户给出的四个链接中含一个重复项）
 *
 * 设计约束：
 *   - 零第三方依赖，数据全部存本机 SQLite；
 *   - 组件里的用户可见文案一律由前端 tr() 组装，本文件只回错误码/结构化数据；
 *   - AI 提示词正文放 language/prompts/zh-CN/packs.json（resume.* 五个包），
 *     通过提示词注册表渲染，用户可在「提示词库」里覆盖；
 *   - 测试可用 SIERXING_RESUME_FAKE=1 走假 AI（不花钱），见 scripts/test-resume-component.js。
 */

const META = (require('../../language/plugin-meta') || {}).resume || {};
const L = require('../../language/resume-labels');

let db, nowISO, safeParse, sendJSON, readBody, backup, log, aiText, currentModel, getPromptPacks, getResumeDomain;

const SCHEMA = [
  'CREATE TABLE IF NOT EXISTS resume_docs (',
  '  id INTEGER PRIMARY KEY AUTOINCREMENT,',
  '  goal_id INTEGER NOT NULL DEFAULT 0,',
  '  title TEXT NOT NULL DEFAULT \'\',',
  '  target_role TEXT NOT NULL DEFAULT \'\',',
  '  content_md TEXT NOT NULL DEFAULT \'\',',
  '  created_at TEXT NOT NULL,',
  '  updated_at TEXT NOT NULL',
  ');',
  'CREATE TABLE IF NOT EXISTS resume_evidence (',
  '  id INTEGER PRIMARY KEY AUTOINCREMENT,',
  '  doc_id INTEGER NOT NULL,',
  '  title TEXT NOT NULL DEFAULT \'\',',
  '  org TEXT NOT NULL DEFAULT \'\',',
  '  role TEXT NOT NULL DEFAULT \'\',',
  '  period TEXT NOT NULL DEFAULT \'\',',
  '  situation TEXT NOT NULL DEFAULT \'\',',
  '  task TEXT NOT NULL DEFAULT \'\',',
  '  action TEXT NOT NULL DEFAULT \'\',',
  '  result TEXT NOT NULL DEFAULT \'\',',
  '  scope TEXT NOT NULL DEFAULT \'\',',
  '  metrics TEXT NOT NULL DEFAULT \'\',',
  '  source TEXT NOT NULL DEFAULT \'\',',
  '  tags TEXT NOT NULL DEFAULT \'[]\',',
  '  created_at TEXT NOT NULL,',
  '  updated_at TEXT NOT NULL',
  ');',
  'CREATE TABLE IF NOT EXISTS resume_versions (',
  '  id INTEGER PRIMARY KEY AUTOINCREMENT,',
  '  doc_id INTEGER NOT NULL,',
  '  note TEXT NOT NULL DEFAULT \'\',',
  '  content_md TEXT NOT NULL DEFAULT \'\',',
  '  created_at TEXT NOT NULL',
  ');',
  'CREATE TABLE IF NOT EXISTS resume_reports (',
  '  id INTEGER PRIMARY KEY AUTOINCREMENT,',
  '  doc_id INTEGER NOT NULL,',
  '  kind TEXT NOT NULL DEFAULT \'\',',
  '  jd_text TEXT NOT NULL DEFAULT \'\',',
  '  output_json TEXT NOT NULL DEFAULT \'{}\',',
  '  output_md TEXT NOT NULL DEFAULT \'\',',
  '  created_at TEXT NOT NULL',
  ');'
].join('\n');

function bind(ctx) {
  db = ctx.db; nowISO = ctx.nowISO; safeParse = ctx.safeParse;
  sendJSON = ctx.sendJSON; readBody = ctx.readBody; backup = ctx.backup;
  log = ctx.log || function () {};
  aiText = ctx.aiText; currentModel = ctx.currentModel;
  getPromptPacks = ctx.getPromptPacks;
  getResumeDomain = ctx.getResumeDomain;
}

function clean(v, max) { return String(v == null ? '' : v).slice(0, max == null ? 4000 : max); }
function num(v) { const n = Number(v); return Number.isFinite(n) ? n : 0; }
function jsonArr(v) { const a = safeParse(v); return Array.isArray(a) ? a : []; }

function fail(res, code, status) { return sendJSON(res, status || 400, { error: code, code: code }); }

/* 从模型回复里抠第一个 JSON 对象（前后带话/带围栏都认） */
function firstJSON(text) {
  const s = String(text || '');
  let i = 0;
  while (i < s.length) {
    const start = s.indexOf('{', i);
    if (start < 0) return null;
    let depth = 0, inStr = false, esc = false, end = -1;
    for (let j = start; j < s.length; j++) {
      const c = s[j];
      if (inStr) {
        if (esc) esc = false;
        else if (c === '\\') esc = true;
        else if (c === '"') inStr = false;
        continue;
      }
      if (c === '"') { inStr = true; continue; }
      if (c === '{') depth++;
      else if (c === '}') {
        depth--;
        if (depth === 0) { end = j; break; }
      }
    }
    if (end < 0) return null;
    try { return JSON.parse(s.slice(start, end + 1)); } catch (e) { i = end + 1; }
  }
  return null;
}

/* ---------- 行 → 出参 ---------- */
function docOut(r) {
  if (!r) return null;
  return {
    id: num(r.id), goal_id: num(r.goal_id), title: clean(r.title, 160),
    target_role: clean(r.target_role, 160), content_md: String(r.content_md || ''),
    created_at: r.created_at, updated_at: r.updated_at,
    chars: String(r.content_md || '').length
  };
}
function evOut(r) {
  if (!r) return null;
  return {
    id: num(r.id), doc_id: num(r.doc_id), title: clean(r.title, 160), org: clean(r.org, 160),
    role: clean(r.role, 160), period: clean(r.period, 80), situation: clean(r.situation, 2000),
    task: clean(r.task, 2000), action: clean(r.action, 4000), result: clean(r.result, 3000),
    scope: clean(r.scope, 500), metrics: clean(r.metrics, 500), source: clean(r.source, 300),
    tags: jsonArr(r.tags), created_at: r.created_at, updated_at: r.updated_at
  };
}
function reportOut(r, withPayload) {
  if (!r) return null;
  const o = {
    id: num(r.id), doc_id: num(r.doc_id), kind: r.kind, created_at: r.created_at,
    jd_chars: String(r.jd_text || '').length,
    summary: ''
  };
  if (withPayload) {
    o.jd_text = String(r.jd_text || '');
    o.data = safeParse(r.output_json) || {};
    o.text = String(r.output_md || '');
  }
  return o;
}

/* ---------- 证据卡 → 提示词上下文 ---------- */
function evidenceBlock(list) {
  if (!list || !list.length) return '';
  return list.map(function (e, i) {
    const parts = [];
    if (e.org) parts.push(L.org + e.org);
    if (e.role) parts.push(L.role + e.role);
    if (e.period) parts.push(L.time + e.period);
    if (e.situation) parts.push(L.situation + e.situation);
    if (e.task) parts.push(L.task + e.task);
    if (e.action) parts.push(L.action + e.action);
    if (e.result) parts.push(L.result + e.result);
    if (e.scope) parts.push(L.scope + e.scope);
    if (e.metrics) parts.push(L.metrics + e.metrics);
    if (e.source) parts.push(L.source + e.source);
    return L.evidencePrefix + (i + 1) + '】' + (e.title || L.unnamed) + '\n' + parts.join('\n');
  }).join('\n\n');
}
function buildCtx(doc, payload) {
  const evidence = db.prepare('SELECT * FROM resume_evidence WHERE doc_id = ? ORDER BY id').all(doc.id);
  const p = payload || {};
  return {
    targetRole: clean(doc.target_role || p.targetRole, 200),
    resume: clean(doc.content_md, 14000),
    evidence: clean(evidenceBlock(evidence.map(evOut)), 9000),
    jd: clean(p.jd || '', 8000),
    answers: clean(p.answers || '', 12000),
    extra: clean(p.extra || '', 4000)
  };
}

/* ---------- AI 调用的假实现（仅测试用，省钱） ---------- */
function fakeAI(kind, ctx) {
  if (kind === 'questions') {
    return { questions: [
      { id: 'q1', q: 'What was your personal scope in this project?', why: 'separate involvement from ownership', example: 'e.g. I owned the retrieval layer, worked with 2 people' },
      { id: 'q2', q: 'What measurable result did it produce, with numerator and window?', why: 'avoid metrics without a definition', example: 'e.g. 7-day retention 22% (n=1200)' }
    ] };
  }
  if (kind === 'evidence') {
    return { cards: [{ title: clean(ctx.answers, 40) || 'Evidence card from answers', role: 'core member', result: clean(ctx.answers, 120), scope: '', metrics: '', source: 'user narrative' }] };
  }
  if (kind === 'match') {
    return { overall: 'partial', summary: 'Partial match; two evidence gaps need filling.',
      keywords: ['user research', 'A/B testing'], rows: [
        { requirement: 'User research and requirement analysis', priority: 'must', match: 'direct', evidence: ['card 1'], note: 'interview evidence available' },
        { requirement: 'Metrics and data-driven iteration', priority: 'must', match: 'gap', evidence: [], note: 'no metric definition yet' }
      ], gaps: ['missing metric evidence'], actions: ['add one metric result with a definition'] };
  }
  if (kind === 'rewrite') {
    return { summary: 'Rewrite into action + method + verifiable result; no new facts.', bullets: [
      { original: 'responsible for user interviews', rewritten: 'Ran 10 user interviews, extracted 3 pain points and turned them into 2 requirement changes (evidence: card 1)', basis: 'card 1', risk: 'interview count must match your records' }
    ], warnings: ['do not use numbers without evidence'] };
  }
  return { summary: '2 claims: 1 partially corroborated, 1 unsupported.', claims: [
    { claim: 'led the planning product from 0 to 1', type: 'role scope', status: 'partially corroborated', evidence: 'repo commits / versions', risk: 'define the module boundary of led' },
    { claim: 'task completion rate improved by 40%', type: 'metric definition', status: 'unsupported', evidence: 'none', risk: 'missing denominator and time window' }
  ], patterns: ['metric definition missing'], to_fill: ['denominator and window for completion rate'] };
}
/* 输出归一化：宁可少字段，别把奇怪结构直接塞给前端 */
function normalize(kind, data) {
  const d = data && typeof data === 'object' ? data : {};
  const arr = function (v) { return Array.isArray(v) ? v : []; };
  if (kind === 'questions') {
    return { questions: arr(d.questions).slice(0, 12).map(function (q, i) {
      if (typeof q === 'string') return { id: 'q' + (i + 1), q: clean(q, 300), why: '', example: '' };
      return { id: clean(q.id || ('q' + (i + 1)), 20), q: clean(q.q || q.question, 300), why: clean(q.why, 200), example: clean(q.example, 300) };
    }) };
  }
  if (kind === 'evidence') {
    return { cards: arr(d.cards).slice(0, 10).map(function (c) {
      return {
        title: clean(c.title, 120), org: clean(c.org, 120), role: clean(c.role, 120), period: clean(c.period, 60),
        situation: clean(c.situation, 1500), task: clean(c.task, 1500), action: clean(c.action, 3000),
        result: clean(c.result, 2000), scope: clean(c.scope, 400), metrics: clean(c.metrics, 400),
        source: clean(c.source, 200), tags: arr(c.tags).slice(0, 6).map(function (t) { return clean(t, 24); })
      };
    }) };
  }
  if (kind === 'match') {
    return {
      overall: clean(d.overall || '', 20), summary: clean(d.summary, 1200),
      keywords: arr(d.keywords).slice(0, 20).map(function (k) { return clean(k, 40); }),
      rows: arr(d.rows).slice(0, 30).map(function (r) {
        return {
          requirement: clean(r.requirement, 200), priority: clean(r.priority || 'must', 20),
          match: clean(r.match || 'gap', 20), evidence: arr(r.evidence).slice(0, 6).map(function (e) { return clean(e, 60); }),
          note: clean(r.note, 400)
        };
      }),
      gaps: arr(d.gaps).slice(0, 20).map(function (g) { return clean(g, 300); }),
      actions: arr(d.actions).slice(0, 20).map(function (a) { return clean(a, 300); })
    };
  }
  if (kind === 'rewrite') {
    return {
      summary: clean(d.summary, 1200),
      bullets: arr(d.bullets).slice(0, 20).map(function (b) {
        return {
          original: clean(b.original, 800), rewritten: clean(b.rewritten, 1000),
          basis: clean(b.basis, 400), risk: clean(b.risk, 300)
        };
      }),
      warnings: arr(d.warnings).slice(0, 20).map(function (w) { return clean(w, 300); })
    };
  }
  return {
    summary: clean(d.summary, 1200),
    claims: arr(d.claims).slice(0, 40).map(function (c) {
      return {
        claim: clean(c.claim, 400), type: clean(c.type, 40),
        status: clean(c.status, 40), evidence: clean(c.evidence, 400), risk: clean(c.risk, 400)
      };
    }),
    patterns: arr(d.patterns).slice(0, 20).map(function (x) { return clean(x, 200); }),
    to_fill: arr(d.to_fill).slice(0, 20).map(function (x) { return clean(x, 300); })
  };
}

async function runAI(kind, doc, payload) {
  const ctx = buildCtx(doc, payload);
  let text = '', data;
  if (process.env.SIERXING_RESUME_FAKE) {
    data = fakeAI(kind, ctx);
    text = JSON.stringify(data);
  } else {
    const packs = getPromptPacks && getPromptPacks();
    if (!packs) throw new Error('prompt registry unavailable');
    const prompt = packs.render('resume.' + kind, ctx);
    text = await aiText(prompt, currentModel(), 300000, null, null, 'resume');
  }
  const parsed = firstJSON(text);
  if (parsed) data = parsed;
  if (!data) {
    return { data: { summary: '', raw: clean(text, 12000) }, text: '', raw: true };
  }
  const norm = normalize(kind, data);
  return { data: norm, text: '', raw: false };
}

/* ---------- 路由 ----------
   领域逻辑全部在 server/resume-domain.js；这里只做 HTTP 适配（参数解析 / 二进制响应）。
   旧路径（/api/resume/docs/:id/ai + kind=questions|evidence|match|rewrite|audit）继续可用，
   新流水线（pipeline / upload / jd / finalize / export）走同一套领域方法。 */

function dom() {
  const d = getResumeDomain && getResumeDomain();
  if (!d) { const e = new Error('resume_unavailable'); e.code = 'resume_unavailable'; throw e; }
  return d;
}
function fail(res, code, status) { return sendJSON(res, status || 400, { error: code, code: code }); }
function errCode(e) {
  const c = String((e && e.code) || '');
  if (c) return c;
  const m = String((e && e.message) || '');
  if (/^[a-z_]+$/.test(m)) return m;
  return 'internal';
}
function sendErr(res, e) {
  const code = errCode(e);
  const detail = String((e && e.message) || '');
  const status = code === 'not_found' ? 404 : code === 'ai_failed' ? 502 : code === 'internal' ? 500 : 400;
  return sendJSON(res, status, { error: code, code: code, detail: detail === code ? '' : detail.slice(0, 600) });
}

async function handler(req, res, u) {
  const p = u.pathname;
  const method = req.method || 'GET';
  const q = new URL(u.href, 'http://x').searchParams;
  let m;
  const D = dom();

  /* 列表 / 新建 */
  if (p === '/api/resume/docs') {
    if (method === 'GET') return sendJSON(res, 200, { docs: D.listDocs({ goalId: q.get('goalId') || 0 }) });
    if (method === 'POST') {
      const body = await readBody(req).catch(function () { return {}; });
      try { return sendJSON(res, 200, { ok: true, doc: D.createDoc(body) }); } catch (e) { return sendErr(res, e); }
    }
  }

  /* 单文档 */
  m = p.match(/^\/api\/resume\/docs\/(\d+)$/);
  if (m) {
    const id = Number(m[1]);
    try {
      if (method === 'GET') return sendJSON(res, 200, D.getDoc(id));
      if (method === 'PUT' || method === 'PATCH') { const body = await readBody(req).catch(function () { return {}; }); return sendJSON(res, 200, { ok: true, doc: D.updateDoc(id, body) }); }
      if (method === 'DELETE') return sendJSON(res, 200, D.deleteDoc(id));
    } catch (e) { return sendErr(res, e); }
  }

  /* 流水线状态（前端向导每步都用它决定下一步） */
  m = p.match(/^\/api\/resume\/docs\/(\d+)\/pipeline$/);
  if (m && method === 'GET') {
    try { return sendJSON(res, 200, D.pipeline(Number(m[1]))); } catch (e) { return sendErr(res, e); }
  }

  /* 第一步：拖入 / 上传简历文件（JSON 里带 base64；也支持纯文本） */
  m = p.match(/^\/api\/resume\/docs\/(\d+)\/upload$/);
  if (m && method === 'POST') {
    const body = await readBody(req).catch(function () { return {}; });
    try { return sendJSON(res, 200, D.importFile(Number(m[1]), body)); } catch (e) { return sendErr(res, e); }
  }

  /* 第四步：JD 候选（来自目标资料库） / 选中某个 JD */
  if (p === '/api/resume/jd-sources' && method === 'GET') {
    return sendJSON(res, 200, { sources: D.listJdSources(Number(q.get('goalId') || 0)) });
  }
  m = p.match(/^\/api\/resume\/docs\/(\d+)\/jd$/);
  if (m && method === 'POST') {
    const body = await readBody(req).catch(function () { return {}; });
    try { return sendJSON(res, 200, D.pickJd(Number(m[1]), body)); } catch (e) { return sendErr(res, e); }
  }

  /* 第二 / 三 / 五 / 六步：AI 动作 */
  m = p.match(/^\/api\/resume\/docs\/(\d+)\/ai$/);
  if (m && method === 'POST') {
    const body = await readBody(req).catch(function () { return {}; });
    let kind = String(body.kind || '');
    /* 兼容旧 kind：evidence → answers（把回答整理成证据卡） */
    if (kind === 'evidence') kind = 'answers';
    try { return sendJSON(res, 200, await D.runAI(Number(m[1]), kind, body)); } catch (e) { return sendErr(res, e); }
  }

  /* 证据卡 */
  m = p.match(/^\/api\/resume\/docs\/(\d+)\/evidence$/);
  if (m) {
    try {
      if (method === 'GET') return sendJSON(res, 200, { evidence: D.listEvidence(Number(m[1])) });
      if (method === 'POST') {
        const body = await readBody(req).catch(function () { return {}; });
        return sendJSON(res, 200, D.addEvidence(Number(m[1]), Array.isArray(body.cards) ? body.cards : [body]));
      }
    } catch (e) { return sendErr(res, e); }
  }
  m = p.match(/^\/api\/resume\/evidence\/(\d+)$/);
  if (m) {
    try {
      if (method === 'PUT' || method === 'PATCH') { const body = await readBody(req).catch(function () { return {}; }); return sendJSON(res, 200, D.updateEvidence(Number(m[1]), body)); }
      if (method === 'DELETE') return sendJSON(res, 200, D.deleteEvidence(Number(m[1])));
    } catch (e) { return sendErr(res, e); }
  }

  /* 版本 */
  m = p.match(/^\/api\/resume\/docs\/(\d+)\/versions$/);
  if (m && method === 'POST') {
    const body = await readBody(req).catch(function () { return {}; });
    try { return sendJSON(res, 200, D.saveVersion(Number(m[1]), body)); } catch (e) { return sendErr(res, e); }
  }
  m = p.match(/^\/api\/resume\/versions\/(\d+)\/restore$/);
  if (m && method === 'POST') {
    try { return sendJSON(res, 200, D.restoreVersion(Number(m[1]))); } catch (e) { return sendErr(res, e); }
  }

  /* 报告 */
  m = p.match(/^\/api\/resume\/docs\/(\d+)\/reports$/);
  if (m && method === 'GET') {
    try { return sendJSON(res, 200, { reports: D.listReports(Number(m[1])) }); } catch (e) { return sendErr(res, e); }
  }
  m = p.match(/^\/api\/resume\/reports\/(\d+)$/);
  if (m) {
    try {
      if (method === 'GET') return sendJSON(res, 200, { report: D.getReport(Number(m[1])) });
      if (method === 'DELETE') return sendJSON(res, 200, D.deleteReport(Number(m[1])));
    } catch (e) { return sendErr(res, e); }
  }

  /* 第六步：导出 .html（自包含可编辑网页，可直接打印成 PDF） */
  m = p.match(/^\/api\/resume\/docs\/(\d+)\/export-html$/);
  if (m && (method === 'GET' || method === 'POST')) {
    try {
      const r = D.exportHtml(Number(m[1]));
      res.writeHead(200, {
        'Content-Type': 'text/html; charset=utf-8',
        'Content-Disposition': 'inline; filename="resume.html"; filename*=UTF-8\'\'' + encodeURIComponent(r.filename),
        'Cache-Control': 'no-cache'
      });
      return res.end(r.html);
    } catch (e) { return sendErr(res, e); }
  }

  /* 第六步：导出 .docx（二进制） */
  m = p.match(/^\/api\/resume\/docs\/(\d+)\/export$/);
  if (m && (method === 'GET' || method === 'POST')) {
    try {
      const r = D.exportDocx(Number(m[1]), {});
      res.writeHead(200, {
        'Content-Type': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
        'Content-Disposition': 'attachment; filename="resume.docx"; filename*=UTF-8\'\'' + encodeURIComponent(r.filename),
        'Content-Length': r.buffer.length,
        'Cache-Control': 'no-cache'
      });
      return res.end(r.buffer);
    } catch (e) { return sendErr(res, e); }
  }

  return false;
}

module.exports = {
  id: 'resume',
  name: META.name || 'resume',
  icon: META.icon || '📄',
  category: META.category || 'extra',
  desc: META.desc || '',
  version: '2.1.0',
  author: 'SiErXing',
  order: 60,
  /* 和「🎯 达成条件」一样按目标开关：入口在目标页顶栏（收藏栏），页 = `#/g/:id/resume`。
     开关只决定「这个目标显不显示入口」；数据是**全目标共享的一份简历库**
     （前端列表接口不带 goalId 就返回全部文档）——所以 onGoalDelete 不能再按 goal_id
     级联删，否则删掉一个目标会把大家共用的简历一起删掉。 */
  goalToggle: true,
  defaultEnabled: true,
  client: '/plugins/resume.js',

  init(ctx) {
    bind(ctx);
    /* 建表 + 老库补列都由领域层负责（组件初始化早于领域？不，领域在 server.js 里先建，
       所以这里只是兜底 ensureSchema，幂等） */
    try { const d = getResumeDomain && getResumeDomain(); if (d && d.ensureSchema) d.ensureSchema(); } catch (e) {}
  },

  /* 简历库全目标共享：删除目标不动简历数据（组件拉不起来时也不要级联删）。 */
  onGoalDelete() {},

  api: [
    { method: 'GET', pattern: /^\/api\/resume\//, handler: handler },
    { method: 'POST', pattern: /^\/api\/resume\//, handler: handler },
    { method: 'PUT', pattern: /^\/api\/resume\//, handler: handler },
    { method: 'PATCH', pattern: /^\/api\/resume\//, handler: handler },
    { method: 'DELETE', pattern: /^\/api\/resume\//, handler: handler }
  ]
};
