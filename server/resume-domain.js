'use strict';
/**
 * 思而行 · 简历工作流领域（resume domain）
 * ==================================================================
 * 一份简历 = 一条流水线，六个步骤（stage），用户可以「一步只做一件事」，
 * Agent 也可以通过命令总线逐步调用同一套领域方法：
 *
 *   upload     上传/拖入简历文件 → 解析成正文
 *   review     AI 审查：结构化问题清单（severity / type / detail / fix）
 *   supplement AI 追问缺失信息 → 用户回答 → 自动沉淀成经历证据卡
 *   jd         选岗位：从目标资料库里的 JD 直接挑（不用重贴），或粘贴
 *   match      JD-证据匹配矩阵 + 缺口
 *   finalize   AI 生成修改并排版好的终版简历（Markdown）→ 可导出 .docx
 *
 * 参考的开源工作流（用户指定 4 个链接，含 1 个重复）：
 *   https://github.com/Elowwwen/resume-evidence-workflow
 *   https://github.com/zclllyybb/lofisu-identity-engine
 *   https://github.com/Claycui828/ASu-resume-skills
 *   https://github.com/Elowwwen/resume-evidence-workflow
 *
 * 约束：零第三方依赖；数据全在本机 SQLite；本文件不写用户可见中文界面文案
 *（错误只回 code，文案由前端 tr() / 命令层组装）。
 */
const L = require('../language/resume-labels');
const fileUtil = require('./plugins/lib/resume-file');
const render = require('./plugins/lib/resume-render');
const schoolTitles = require('../language/school-titles');
const enhance = require('../language/resume-enhance');
const contentFilter = require('./plugins/lib/resume-filter');

const STAGES = ['upload', 'review', 'supplement', 'jd', 'match', 'finalize'];
const STAGE_NEXT = { upload: 'review', review: 'supplement', supplement: 'jd', jd: 'match', match: 'finalize', finalize: 'finalize' };

const SCHEMA_DOCS = [
  'CREATE TABLE IF NOT EXISTS resume_docs (',
  '  id INTEGER PRIMARY KEY AUTOINCREMENT,',
  '  goal_id INTEGER NOT NULL DEFAULT 0,',
  '  title TEXT NOT NULL DEFAULT \'\',',
  '  target_role TEXT NOT NULL DEFAULT \'\',',
  '  content_md TEXT NOT NULL DEFAULT \'\',',
  '  stage TEXT NOT NULL DEFAULT \'upload\',',
  '  source_file TEXT NOT NULL DEFAULT \'\',',
  '  issues TEXT NOT NULL DEFAULT \'[]\',',
  '  answers TEXT NOT NULL DEFAULT \'[]\',',
  '  jd_text TEXT NOT NULL DEFAULT \'\',',
  '  jd_source_id INTEGER NOT NULL DEFAULT 0,',
  '  match_json TEXT NOT NULL DEFAULT \'{}\',',
  '  final_md TEXT NOT NULL DEFAULT \'\',',
  "  excluded TEXT NOT NULL DEFAULT '[]',",
  "  final_data TEXT NOT NULL DEFAULT '{}',",
  '  created_at TEXT NOT NULL,',
  '  updated_at TEXT NOT NULL',
  ');'
].join('\n');
const SCHEMA_REST = [
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
  '  stage TEXT NOT NULL DEFAULT \'\',',
  '  content_md TEXT NOT NULL DEFAULT \'\',',
  '  created_at TEXT NOT NULL',
  ');',
  'CREATE TABLE IF NOT EXISTS resume_reports (',
  '  id INTEGER PRIMARY KEY AUTOINCREMENT,',
  '  doc_id INTEGER NOT NULL,',
  '  kind TEXT NOT NULL DEFAULT \'\',',
  '  jd_text TEXT NOT NULL DEFAULT \'\',',
  '  output_json TEXT NOT NULL DEFAULT \'{}\',',
  '  created_at TEXT NOT NULL',
  ');'
].join('\n');

const ALTERS = [
  'ALTER TABLE resume_docs ADD COLUMN stage TEXT NOT NULL DEFAULT \'upload\'',
  'ALTER TABLE resume_docs ADD COLUMN source_file TEXT NOT NULL DEFAULT \'\'',
  'ALTER TABLE resume_docs ADD COLUMN issues TEXT NOT NULL DEFAULT \'[]\'',
  'ALTER TABLE resume_docs ADD COLUMN answers TEXT NOT NULL DEFAULT \'[]\'',
  'ALTER TABLE resume_docs ADD COLUMN jd_text TEXT NOT NULL DEFAULT \'\'',
  'ALTER TABLE resume_docs ADD COLUMN jd_source_id INTEGER NOT NULL DEFAULT 0',
  'ALTER TABLE resume_docs ADD COLUMN match_json TEXT NOT NULL DEFAULT \'{}\'',
  'ALTER TABLE resume_docs ADD COLUMN final_md TEXT NOT NULL DEFAULT \'\'',
  /* 旧库（v1）的 resume_versions 没有 stage 列：直接 INSERT 会报 no column named stage。
     这里也补上，保证老数据平滑升级。 */
  'ALTER TABLE resume_versions ADD COLUMN stage TEXT NOT NULL DEFAULT \'\'',
  'ALTER TABLE resume_docs ADD COLUMN excluded TEXT NOT NULL DEFAULT \'[]\'',
];

function fail(code, message) {
  const e = new Error(message || code);
  e.code = code;
  return e;
}
function clean(v, max) { return String(v == null ? '' : v).slice(0, max == null ? 4000 : max); }
function numOf(v) { const n = Number(v); return Number.isFinite(n) ? n : 0; }

/* 从模型回复里抠第一个 JSON 对象（前后带话 / 带围栏都认） */
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
      else if (c === '}') { depth--; if (depth === 0) { end = j; break; } }
    }
    if (end < 0) return null;
    try { return JSON.parse(s.slice(start, end + 1)); } catch (e) { i = end + 1; }
  }
  return null;
}

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

function fakeAI(kind, ctx) {
  if (kind === 'review') {
    return { summary: '2 issues found', issues: [
      { type: 'metric', severity: 'high', where: 'project bullet 1', detail: 'result has no metric definition', fix: 'add numerator, denominator and time window' },
      { type: 'density', severity: 'medium', where: 'project bullet 2', detail: 'too long, mixes two claims', fix: 'split into two bullets, one claim each' }
    ], missing: ['user research evidence', 'JD keyword coverage'] };
  }
  if (kind === 'questions') {
    return { questions: [
      { id: 'q1', q: 'What was your personal scope in this project?', why: 'separate involvement from ownership', example: 'I owned the retrieval layer, worked with 2 people' },
      { id: 'q2', q: 'What measurable result, with numerator and window?', why: 'avoid metrics without definition', example: '7-day retention 22% (n=1200)' }
    ] };
  }
  if (kind === 'answers') {
    return { cards: [{ title: 'evidence from answers', role: 'core member', result: clean(ctx.answers, 120), scope: '', metrics: '', source: 'user narrative' }] };
  }
  if (kind === 'match') {
    return { overall: 'partial', summary: 'Partial match; two evidence gaps.', keywords: ['user research', 'A/B testing'], rows: [
      { requirement: 'user research', priority: 'must', match: 'direct', evidence: ['card 1'], note: 'interview evidence' },
      { requirement: 'metrics', priority: 'must', match: 'gap', evidence: [], note: 'no metric definition' }
    ], gaps: ['missing metric evidence'], actions: ['add one metric result with definition'] };
  }
  if (kind === 'rewrite') {
    return { summary: 'rewrite to action + method + result', bullets: [
      { original: 'responsible for interviews', rewritten: 'Ran 10 interviews, extracted 3 pain points into 2 requirement changes', basis: 'card 1', jd: 'user research', risk: 'count must match records' }
    ], warnings: ['no numbers without evidence'] };
  }
  if (kind === 'finalize') {
    return {
      name: 'Fake Name',
      title: (ctx.targetRole || 'Target role') + ' | strongest evidence',
      contacts: ['Phone 10000000000', 'Email a@b.c'],
      summary: 'Positioning sentence with **one hard metric**.',
      sections: [
        { title: 'Experience', items: [
          { left: 'Project A | owner', right: '2026.09-2026.10', bullets: ['**Metric**: designed 5 verifiable metrics, PAR 63.6%', 'Split one bullet = one claim'] },
          { left: 'Project B | contributor', right: '2025', bullets: ['Shipped a thing with a testable outcome'] }
        ] },
        { title: 'Skills', items: [{ left: '', right: '', bullets: ['AI / Agent: prompt design and evaluation'] }] }
      ],
      notes: ['kept facts only'],
      removed: []
    };
  }
  if (kind === 'audit') {
    return { summary: '2 claims: 1 partially corroborated, 1 unsupported.', claims: [
      { claim: 'led the product from 0 to 1', type: 'role scope', status: 'partially corroborated', evidence: 'repo commits', risk: 'define the module boundary', confidence: 'medium' },
      { claim: 'completion rate up 40%', type: 'metric definition', status: 'unsupported', evidence: 'none', risk: 'missing denominator and window', confidence: 'low' }
    ], patterns: ['metric definition missing'], to_fill: ['denominator and window'] };
  }
  return { summary: '', claims: [], patterns: [], to_fill: [] };
}


function normalize(kind, data) {
  const d = data && typeof data === 'object' ? data : {};
  const arr = function (v) { return Array.isArray(v) ? v : []; };
  const S = function (v, n) { return clean(v, n); };
  if (kind === 'review') {
    return {
      summary: S(d.summary, 1200),
      issues: arr(d.issues).slice(0, 30).map(function (x) {
        return { type: S(x.type, 40), severity: S(x.severity || 'medium', 20), where: S(x.where, 200), detail: S(x.detail, 600), fix: S(x.fix, 600) };
      }),
      missing: arr(d.missing).slice(0, 20).map(function (x) { return S(x, 300); })
    };
  }
  if (kind === 'questions') {
    return { questions: arr(d.questions).slice(0, 12).map(function (q, i) {
      if (typeof q === 'string') return { id: 'q' + (i + 1), q: S(q, 300), why: '', example: '' };
      return { id: S(q.id || ('q' + (i + 1)), 20), q: S(q.q || q.question, 300), why: S(q.why, 200), example: S(q.example, 300) };
    }) };
  }
  if (kind === 'answers') {
    return { cards: arr(d.cards).slice(0, 10).map(function (c) {
      return {
        title: S(c.title, 120), org: S(c.org, 120), role: S(c.role, 120), period: S(c.period, 60),
        situation: S(c.situation, 1500), task: S(c.task, 1500), action: S(c.action, 3000),
        result: S(c.result, 2000), scope: S(c.scope, 400), metrics: S(c.metrics, 400),
        source: S(c.source, 200), tags: arr(c.tags).slice(0, 6).map(function (t) { return S(t, 24); })
      };
    }) };
  }
  if (kind === 'match') {
    return {
      overall: S(d.overall, 20), summary: S(d.summary, 1200),
      keywords: arr(d.keywords).slice(0, 20).map(function (k) { return S(k, 40); }),
      rows: arr(d.rows).slice(0, 30).map(function (x) {
        return { requirement: S(x.requirement, 200), priority: S(x.priority || 'must', 20), match: S(x.match || 'gap', 20), evidence: arr(x.evidence).slice(0, 6).map(function (e) { return S(e, 60); }), note: S(x.note, 400) };
      }),
      gaps: arr(d.gaps).slice(0, 20).map(function (x) { return S(x, 300); }),
      actions: arr(d.actions).slice(0, 20).map(function (x) { return S(x, 300); })
    };
  }
  if (kind === 'rewrite') {
    return {
      summary: S(d.summary, 1200),
      bullets: arr(d.bullets).slice(0, 30).map(function (b) {
        return { original: S(b.original, 800), rewritten: S(b.rewritten, 1000), basis: S(b.basis, 400), jd: S(b.jd, 200), risk: S(b.risk, 300) };
      }),
      warnings: arr(d.warnings).slice(0, 20).map(function (w) { return S(w, 300); })
    };
  }
  if (kind === 'finalize') {
    /* 新格式：结构化 resume_data（能排出真简历）；老格式只有 markdown 时转成结构化 */
    const norm = render.normData(d);
    const hasStruct = !!(norm.sections && norm.sections.length);
    const dataOut = hasStruct ? norm : render.markdownToData(String(d.markdown != null ? d.markdown : (d.resume_md != null ? d.resume_md : '')));
    return {
      data: dataOut,
      markdown: render.dataToMarkdown(dataOut).slice(0, 60000),
      notes: arr(d.notes).slice(0, 20).map(function (x) { return S(x, 300); }),
      removed: arr(d.removed).slice(0, 20).map(function (x) { return S(x, 300); })
    };
  }
  return { summary: S(d.summary, 1200), claims: arr(d.claims).slice(0, 40).map(function (c) {
    return { claim: S(c.claim, 400), type: S(c.type, 40), status: S(c.status, 40), evidence: S(c.evidence, 400), risk: S(c.risk, 400), confidence: S(c.confidence, 20) };
  }), patterns: arr(d.patterns).slice(0, 20).map(function (x) { return S(x, 200); }), to_fill: arr(d.to_fill).slice(0, 20).map(function (x) { return S(x, 300); }) };
}


/* 把 document.xml 包成最小可用的 .docx（复用 resume-file 的 zip 写入） */
function buildDocxZip(documentXml, title) {
  const esc = function (s) { return String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;'); };
  const contentTypes = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
    + '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">'
    + '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>'
    + '<Default Extension="xml" ContentType="application/xml"/>'
    + '<Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>'
    + '</Types>';
  const rels = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
    + '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">'
    + '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/>'
    + '</Relationships>';
  const core = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><cp:coreProperties xmlns:cp="http://schemas.openxmlformats.org/package/2006/metadata/core-properties" xmlns:dc="http://purl.org/dc/elements/1.1/"><dc:title>' + esc(title) + '</dc:title></cp:coreProperties>';
  return fileUtil.buildZip([
    { name: '[Content_Types].xml', data: contentTypes },
    { name: '_rels/.rels', data: rels },
    { name: 'word/document.xml', data: documentXml },
    { name: 'docProps/core.xml', data: core }
  ]);
}

function createResumeDomain(deps) {
  const db = deps.db;
  const nowISO = deps.nowISO || function () { return new Date().toISOString(); };
  const safeParse = deps.safeParse || function (s, d) { try { const v = JSON.parse(s); return v == null ? d : v; } catch (e) { return d; } };
  const backup = deps.backup || function () {};
  const aiText = deps.aiText;
  const currentModel = deps.currentModel || function () { return ''; };
  const getPromptPacks = deps.getPromptPacks;
  const getGoal = deps.getGoal || function () { return null; };
  const sourcesOf = deps.sourcesOf || function () { return []; };
  const log = deps.log || function () {};

  db.exec(SCHEMA_DOCS);
  db.exec(SCHEMA_REST);
  /* 老库补列：ALTER 失败（列已存在）直接忽略 */
  for (const sql of ALTERS) { try { db.exec(sql); } catch (e) {} }

  /* ---------- 出参 ---------- */
  function docOut(r, withBody) {
    if (!r) return null;
    const d = {
      id: numOf(r.id), goal_id: numOf(r.goal_id), title: clean(r.title, 160),
      target_role: clean(r.target_role, 160),
      stage: STAGES.indexOf(r.stage) >= 0 ? r.stage : 'upload',
      next_stage: STAGE_NEXT[STAGES.indexOf(r.stage) >= 0 ? r.stage : 'upload'],
      source_file: clean(r.source_file, 200),
      chars: String(r.content_md || '').length,
      has_jd: !!String(r.jd_text || '').trim(),
      jd_source_id: numOf(r.jd_source_id),
      has_match: !!Object.keys(safeParse(r.match_json, {}) || {}).length,
      has_final: !!String(r.final_md || '').trim(),
      created_at: r.created_at, updated_at: r.updated_at
    };
    if (withBody) {
      d.content_md = String(r.content_md || '');
      d.issues = safeParse(r.issues, []) || [];
      d.answers = safeParse(r.answers, []) || [];
      d.jd_text = String(r.jd_text || '');
      d.match = safeParse(r.match_json, {}) || {};
      d.final_md = String(r.final_md || '');
      d.final_data = safeParse(r.final_data, {}) || {};
      d.excluded = safeParse(r.excluded, []) || [];
    }
    return d;
  }
  function evOut(r) {
    if (!r) return null;
    return {
      id: numOf(r.id), doc_id: numOf(r.doc_id), title: clean(r.title, 160), org: clean(r.org, 160),
      role: clean(r.role, 160), period: clean(r.period, 80), situation: clean(r.situation, 2000),
      task: clean(r.task, 2000), action: clean(r.action, 4000), result: clean(r.result, 3000),
      scope: clean(r.scope, 500), metrics: clean(r.metrics, 500), source: clean(r.source, 300),
      tags: safeParse(r.tags, []) || []
    };
  }
  function reportOut(r, withPayload) {
    if (!r) return null;
    const o = { id: numOf(r.id), doc_id: numOf(r.doc_id), kind: r.kind, created_at: r.created_at, jd_chars: String(r.jd_text || '').length };
    if (withPayload) { o.data = safeParse(r.output_json, {}) || {}; o.jd_text = String(r.jd_text || ''); }
    return o;
  }

  /* ---------- 文档 ---------- */
  function docRow(id) { return db.prepare('SELECT * FROM resume_docs WHERE id = ?').get(numOf(id)) || null; }
  function listDocs(opts) {
    const o = opts || {};
    const goalId = numOf(o.goalId);
    const rows = goalId
      ? db.prepare('SELECT * FROM resume_docs WHERE goal_id = ? ORDER BY updated_at DESC').all(goalId)
      : db.prepare('SELECT * FROM resume_docs ORDER BY updated_at DESC').all();
    const evCount = {};
    db.prepare('SELECT doc_id, COUNT(*) AS n FROM resume_evidence GROUP BY doc_id').all().forEach(function (r) { evCount[r.doc_id] = r.n; });
    return rows.map(function (r) { const d = docOut(r, false); d.evidence_count = evCount[r.id] || 0; return d; });
  }
  function createDoc(input) {
    const title = clean(input && (input.title || input.name), 120);
    if (!title) throw fail('need_title');
    const t = nowISO();
    const info = db.prepare("INSERT INTO resume_docs (goal_id,title,target_role,content_md,stage,source_file,created_at,updated_at) VALUES (?,?,?,?,'upload','',?,?)")
      .run(numOf(input && (input.goalId || input.goal_id)), title, clean(input && (input.target_role || input.targetRole), 120), clean(input && (input.content_md || input.content), 400000), t, t);
    backup();
    return docOut(docRow(info.lastInsertRowid), true);
  }
  function updateDoc(id, patch) {
    const r = docRow(id);
    if (!r) throw fail('not_found');
    const p = patch || {};
    const t = nowISO();
    const next = {
      title: p.title != null ? clean(p.title, 120) || r.title : r.title,
      target_role: p.target_role != null || p.targetRole != null ? clean(p.target_role != null ? p.target_role : p.targetRole, 120) : r.target_role,
      content_md: p.content_md != null || p.content != null ? clean(p.content_md != null ? p.content_md : p.content, 400000) : r.content_md,
      stage: p.stage != null && STAGES.indexOf(p.stage) >= 0 ? p.stage : r.stage
    };
    db.prepare('UPDATE resume_docs SET title=?, target_role=?, content_md=?, stage=?, updated_at=? WHERE id=?')
      .run(next.title, next.target_role, next.content_md, next.stage, t, r.id);
    /* 终版：结构化数据（final_data）+ 由它渲染的 markdown（final_md）；
       用户/Agent 精修后可以直接 PUT 结构化数据，Word/网页渲染跟着变。 */
    if (p.excluded != null) {
      try {
        const arr = Array.isArray(p.excluded) ? p.excluded : (typeof p.excluded === 'string' ? JSON.parse(p.excluded) : []);
        db.prepare('UPDATE resume_docs SET excluded = ? WHERE id = ?').run(JSON.stringify(contentFilter.norm(arr)), r.id);
      } catch (e) {}
    }
    if (p.final_data != null || p.final_md != null) {
      try {
        const cols = db.prepare('PRAGMA table_info(resume_docs)').all().map(function (c) { return c.name; });
        if (cols.indexOf('final_data') < 0) db.exec("ALTER TABLE resume_docs ADD COLUMN final_data TEXT NOT NULL DEFAULT '{}'");
      } catch (e) {}
      let data = p.final_data;
      if (data != null && typeof data === 'string') { try { data = JSON.parse(data); } catch (e) { data = null; } }
      if (data && typeof data === 'object' && Array.isArray(data.sections)) {
        db.prepare('UPDATE resume_docs SET final_data = ?, final_md = ? WHERE id = ?')
          .run(JSON.stringify(data), String(p.final_md != null ? p.final_md : render.dataToMarkdown(data)), r.id);
      } else if (p.final_md != null) {
        db.prepare('UPDATE resume_docs SET final_md = ? WHERE id = ?').run(String(p.final_md), r.id);
      }
    }
    backup();
    return docOut(docRow(r.id), true);
  }
  function deleteDoc(id) {
    const r = docRow(id);
    if (!r) throw fail('not_found');
    for (const t of ['resume_evidence', 'resume_versions', 'resume_reports']) db.prepare('DELETE FROM ' + t + ' WHERE doc_id = ?').run(r.id);
    db.prepare('DELETE FROM resume_docs WHERE id = ?').run(r.id);
    backup();
    return { ok: true };
  }
  function getDoc(id) {
    const r = docRow(id);
    if (!r) throw fail('not_found');
    return {
      doc: docOut(r, true),
      evidence: db.prepare('SELECT * FROM resume_evidence WHERE doc_id = ? ORDER BY id').all(r.id).map(evOut),
      versions: db.prepare('SELECT id,note,stage,created_at,length(content_md) AS chars FROM resume_versions WHERE doc_id = ? ORDER BY id DESC LIMIT 50').all(r.id),
      reports: db.prepare('SELECT id,kind,created_at,length(output_json) AS chars FROM resume_reports WHERE doc_id = ? ORDER BY id DESC LIMIT 50').all(r.id).map(function (x) { return reportOut(x, false); })
    };
  }

  /* ---------- 第一步：上传 / 拖入文件 ---------- */
  function importFile(id, input) {
    const r = docRow(id);
    if (!r) throw fail('not_found');
    const p = input || {};
    const filename = clean(p.filename || p.name, 200);
    let parsed = null;
    if (p.base64 || p.data) {
      let buf;
      try {
        const raw = String(p.base64 || p.data);
        const b64 = raw.indexOf('base64,') >= 0 ? raw.slice(raw.indexOf('base64,') + 7) : raw;
        buf = Buffer.from(b64, 'base64');
      } catch (e) { throw fail('bad_base64'); }
      if (!buf || !buf.length) throw fail('empty_file');
      if (buf.length > fileUtil.MAX_INPUT) throw fail('file_too_large');
      try {
        parsed = fileUtil.parseResumeBuffer(buf, filename);
      } catch (e) {
        const code = (e && e.message) || '';
        if (code === 'unsupported-format') throw fail('unsupported_format');
        if (code === 'not-docx') throw fail('bad_docx');
        if (code === 'no-text-layer') throw fail('no_text_layer');
        if (code === 'empty-document') throw fail('empty_document');
        throw fail('parse_failed');
      }
    } else if (p.text != null) {
      const text = clean(p.text, fileUtil.MAX_TEXT);
      if (!text.trim()) throw fail('empty_document');
      parsed = { text: text, encoding: 'text', truncated: false, chars: text.length };
    } else {
      throw fail('need_file');
    }
    const t = nowISO();
    db.prepare('UPDATE resume_docs SET content_md=?, source_file=?, stage=?, updated_at=? WHERE id=?')
      .run(parsed.text, filename, 'review', t, r.id);
    db.prepare('INSERT INTO resume_versions (doc_id,note,stage,content_md,created_at) VALUES (?,?,?,?,?)')
      .run(r.id, 'upload', 'upload', parsed.text, t);
    backup();
    return { ok: true, imported: { chars: parsed.chars, truncated: !!parsed.truncated, encoding: parsed.encoding, filename: filename }, doc: docOut(docRow(r.id), true) };
  }

  /* ---------- 第四步：JD 来源（资料库里的 JD，不用重贴） ---------- */
  function listJdSources(goalId) {
    const gid = numOf(goalId);
    if (!gid) return [];
    const all = sourcesOf(gid) || [];
    const jdLike = all.filter(function (s) {
      const kind = String(s.kind || '');
      return kind.indexOf('JD') === 0 || /jd|岗位|招聘|职位/i.test(String(s.title || '') + String(s.site || ''));
    });
    return jdLike.map(function (s) {
      return {
        id: numOf(s.id), title: clean(s.title, 160), kind: clean(s.kind, 20),
        site: clean(s.site, 40), quality: numOf(s.quality),
        chars: String(s.content || s.snippet || '').length,
        snippet: clean(String(s.content || s.snippet || '').replace(/\s+/g, ' '), 160)
      };
    });
  }
  function pickJd(id, input) {
    const r = docRow(id);
    if (!r) throw fail('not_found');
    const p = input || {};
    let text = clean(p.jd, 20000);
    let sourceId = 0;
    if (p.sourceId || p.source_id) {
      const sid = numOf(p.sourceId || p.source_id);
      const row = db.prepare('SELECT * FROM sources WHERE id = ?').get(sid);
      if (!row) throw fail('not_found');
      text = clean(String(row.content || '') || String(row.snippet || ''), 20000);
      sourceId = sid;
    }
    if (!text.trim()) throw fail('need_jd');
    const t = nowISO();
    db.prepare('UPDATE resume_docs SET jd_text=?, jd_source_id=?, stage=?, updated_at=? WHERE id=?').run(text, sourceId, 'match', t, r.id);
    backup();
    return { ok: true, doc: docOut(docRow(r.id), true) };
  }

  /* ---------- 上下文 ---------- */
  function buildCtx(r, payload) {
    const p = payload || {};
    const evidence = db.prepare('SELECT * FROM resume_evidence WHERE doc_id = ? ORDER BY id').all(r.id).map(evOut);
    return {
      targetRole: clean(r.target_role || p.targetRole, 200),
      resume: clean(r.content_md, 14000),
      evidence: clean(evidenceBlock(evidence), 9000),
      jd: clean(p.jd || r.jd_text, 20000),
      answers: clean(p.answers || JSON.stringify(safeParse(r.answers, []) || []), 12000),
      finalMd: clean(r.final_md, 14000),
      extra: clean(p.extra, 4000),
      /* 增强上下文：可核验机构 Title（ASu 的学校 Title 增强）+ Owner 化拆分 + 技术链 */
      enhance: clean(p.enhance || buildEnhance(r), 4000)
    };
  }

  /** 组装「可核验增强」上下文：从简历与目标资料里找学校，再拼 Owner 化/技术链规则 */
  function buildEnhance(r) {
    const p2 = (arguments.length > 1 && arguments[1]) || {};
    let schoolText = '';
    try {
      const hit = schoolTitles.detectFromResume(String((r && r.content_md) || ''));
      if (hit) schoolText = schoolTitles.titleBlock(hit);
    } catch (e) {}
    try {
      /* 目标里显式写的学校信息优先级更高（用户可能补充过） */
      if (!schoolText && p2.school) schoolText = schoolTitles.titleBlock(schoolTitles.findSchool(p2.school));
    } catch (e) {}
    return enhance.enhancementBlock({ school: schoolText });
  }

  /* ---------- 假 AI（仅测试；SIERXING_RESUME_FAKE=1） ---------- */
  /* ---------- 结果归一化 ---------- */
  const AI_KINDS = ['review', 'questions', 'answers', 'match', 'rewrite', 'finalize', 'audit'];

  /* ---------- AI 动作 ---------- */
  async function runAI(id, kind, payload) {
    const r = docRow(id);
    if (!r) throw fail('not_found');
    if (AI_KINDS.indexOf(kind) < 0) throw fail('bad_kind');
    const p = payload || {};
    const ctx = buildCtx(r, p);
    if (kind === 'match' || kind === 'rewrite') {
      if (!ctx.jd.trim()) throw fail('need_jd');
    }
    /* answers 这一步必须真的带了「用户回答」：不能用 doc 里上一轮存下的证据卡冒充 */
    if (kind === 'answers') {
      const rawAns = String(p.answers == null ? '' : p.answers).trim();
      if (!rawAns || rawAns === '[]' || rawAns === '{}') throw fail('need_answers');
    }
    if (!ctx.resume.trim() && kind !== 'questions') throw fail('need_resume');
    let data = null, raw = '';
    if (process.env.SIERXING_RESUME_FAKE) {
      data = fakeAI(kind, ctx);
      raw = JSON.stringify(data);
    } else {
      const packs = getPromptPacks && getPromptPacks();
      if (!packs) throw fail('ai_unavailable');
      let prompt;
      try { prompt = packs.render('resume.' + kind, ctx); } catch (e) { throw fail('ai_unavailable'); }
      try {
        raw = await aiText(prompt, currentModel(), 300000, null, p.signal || null, 'resume');
      } catch (e) {
        const err = fail('ai_failed', (e && e.message) || 'ai failed');
        err.detail = clean(e && e.message, 600);
        throw err;
      }
      const parsed = firstJSON(raw);
      if (parsed) data = parsed;
    }
    const normalized = data ? normalize(kind, data) : { raw: clean(raw, 16000) };
    const at = nowISO();
    const info = db.prepare('INSERT INTO resume_reports (doc_id,kind,jd_text,output_json,created_at) VALUES (?,?,?,?,?)')
      .run(r.id, kind, clean(ctx.jd, 20000), JSON.stringify(normalized), at);
    /* 写回文档：每一步的产物落到 doc 上，刷新/换设备/Agent 下一步都能直接用 */
    if (kind === 'review') db.prepare('UPDATE resume_docs SET issues=?, stage=?, updated_at=? WHERE id=?').run(JSON.stringify(normalized.issues || []), 'supplement', at, r.id);
    else if (kind === 'questions') db.prepare('UPDATE resume_docs SET stage=?, updated_at=? WHERE id=?').run('supplement', at, r.id);
    else if (kind === 'answers') db.prepare('UPDATE resume_docs SET answers=?, stage=?, updated_at=? WHERE id=?').run(JSON.stringify(normalized.cards || []), 'jd', at, r.id);
    else if (kind === 'match') db.prepare('UPDATE resume_docs SET match_json=?, stage=?, updated_at=? WHERE id=?').run(JSON.stringify(normalized), 'finalize', at, r.id);
    else if (kind === 'finalize') {
      try {
        const cols = db.prepare('PRAGMA table_info(resume_docs)').all().map(function (c) { return c.name; });
        if (cols.indexOf('final_data') < 0) db.exec("ALTER TABLE resume_docs ADD COLUMN final_data TEXT NOT NULL DEFAULT '{}'");
      } catch (e) {}
      /* 用户要求「不写进简历」的内容：代码级硬过滤（提示词不可靠，实测会反复写回） */
      let finalData = normalized.data || {};
      let filtered = [];
      try {
        const excluded = safeParse(r.excluded, []) || [];
        const f = contentFilter.filterData(finalData, excluded);
        finalData = f.data; filtered = f.removed;
      } catch (e) {}
      const finalMd = render.dataToMarkdown(finalData);
      normalized.data = finalData;
      normalized.markdown = finalMd;
      if (filtered.length) {
        normalized.removed = (normalized.removed || []).concat(filtered.map(function (x) { return 'excluded: ' + x; }));
      }
      db.prepare('UPDATE resume_docs SET final_md=?, final_data=?, stage=?, updated_at=? WHERE id=?')
        .run(String(finalMd || ''), JSON.stringify(finalData), 'finalize', at, r.id);
    }
    backup();
    return { ok: true, kind: kind, data: normalized, raw: !!normalized.raw, reportId: numOf(info.lastInsertRowid), created_at: at, doc: docOut(docRow(r.id), false) };
  }

  /* ---------- 证据卡 ---------- */
  function listEvidence(id) {
    const r = docRow(id);
    if (!r) throw fail('not_found');
    return db.prepare('SELECT * FROM resume_evidence WHERE doc_id = ? ORDER BY id').all(r.id).map(evOut);
  }
  function addEvidence(id, cards) {
    const r = docRow(id);
    if (!r) throw fail('not_found');
    const list = (Array.isArray(cards) ? cards : [cards]).filter(function (c) { return c && typeof c === 'object'; }).slice(0, 20);
    if (!list.length) throw fail('bad_input');
    const t = nowISO();
    const ids = [];
    for (const c of list) {
      const info = db.prepare([
        'INSERT INTO resume_evidence (doc_id,title,org,role,period,situation,task,action,result,scope,metrics,source,tags,created_at,updated_at)',
        'VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)'
      ].join(' ')).run(r.id, clean(c.title, 120), clean(c.org, 120), clean(c.role, 120), clean(c.period, 60),
        clean(c.situation, 1500), clean(c.task, 1500), clean(c.action, 3000), clean(c.result, 2000),
        clean(c.scope, 400), clean(c.metrics, 400), clean(c.source, 200), JSON.stringify(Array.isArray(c.tags) ? c.tags.slice(0, 6) : []), t, t);
      ids.push(numOf(info.lastInsertRowid));
    }
    db.prepare('UPDATE resume_docs SET updated_at=? WHERE id=?').run(t, r.id);
    backup();
    return { ok: true, ids: ids, evidence: listEvidence(r.id) };
  }
  function updateEvidence(evId, patch) {
    const e = db.prepare('SELECT * FROM resume_evidence WHERE id = ?').get(numOf(evId));
    if (!e) throw fail('not_found');
    const p = patch || {};
    const t = nowISO();
    const pick = function (k, max) { return p[k] != null ? clean(p[k], max) : e[k]; };
    db.prepare('UPDATE resume_evidence SET title=?,org=?,role=?,period=?,situation=?,task=?,action=?,result=?,scope=?,metrics=?,source=?,tags=?,updated_at=? WHERE id=?')
      .run(pick('title', 120), pick('org', 120), pick('role', 120), pick('period', 60), pick('situation', 1500), pick('task', 1500),
        pick('action', 3000), pick('result', 2000), pick('scope', 400), pick('metrics', 400), pick('source', 200),
        p.tags != null ? JSON.stringify(Array.isArray(p.tags) ? p.tags.slice(0, 6) : []) : e.tags, t, e.id);
    backup();
    return { ok: true, evidence: evOut(db.prepare('SELECT * FROM resume_evidence WHERE id = ?').get(e.id)) };
  }
  function deleteEvidence(evId) {
    const e = db.prepare('SELECT * FROM resume_evidence WHERE id = ?').get(numOf(evId));
    if (!e) throw fail('not_found');
    db.prepare('DELETE FROM resume_evidence WHERE id = ?').run(e.id);
    backup();
    return { ok: true };
  }

  /* ---------- 版本 ---------- */
  function saveVersion(id, input) {
    const r = docRow(id);
    if (!r) throw fail('not_found');
    const p = input || {};
    const t = nowISO();
    const info = db.prepare('INSERT INTO resume_versions (doc_id,note,stage,content_md,created_at) VALUES (?,?,?,?,?)')
      .run(r.id, clean(p.note, 120), r.stage, String(p.content_md != null ? p.content_md : (r.final_md || r.content_md)), t);
    backup();
    return { ok: true, id: numOf(info.lastInsertRowid), created_at: t };
  }
  function restoreVersion(vId) {
    const v = db.prepare('SELECT * FROM resume_versions WHERE id = ?').get(numOf(vId));
    if (!v) throw fail('not_found');
    const r = docRow(v.doc_id);
    if (!r) throw fail('not_found');
    const t = nowISO();
    db.prepare('INSERT INTO resume_versions (doc_id,note,stage,content_md,created_at) VALUES (?,?,?,?,?)')
      .run(r.id, 'before-restore', r.stage, String(r.content_md || ''), t);
    /* 恢复的版本内容写回「正文」，终版清空，让用户/Agent 从改写步骤重跑 */
    db.prepare('UPDATE resume_docs SET content_md=?, stage=?, updated_at=? WHERE id=?').run(String(v.content_md || ''), 'review', t, r.id);
    backup();
    return { ok: true, doc: docOut(docRow(r.id), true) };
  }
  function listReports(id) {
    const r = docRow(id);
    if (!r) throw fail('not_found');
    return db.prepare('SELECT * FROM resume_reports WHERE doc_id = ? ORDER BY id DESC LIMIT 50').all(r.id).map(function (x) { return reportOut(x, false); });
  }
  function getReport(rid) {
    const r = db.prepare('SELECT * FROM resume_reports WHERE id = ?').get(numOf(rid));
    if (!r) throw fail('not_found');
    return reportOut(r, true);
  }
  function deleteReport(rid) {
    const r = db.prepare('SELECT * FROM resume_reports WHERE id = ?').get(numOf(rid));
    if (!r) throw fail('not_found');
    db.prepare('DELETE FROM resume_reports WHERE id = ?').run(r.id);
    backup();
    return { ok: true };
  }

  /* ---------- 第六步：导出 docx ---------- */
  /** 终版的结构化数据：优先 final_data，没有就从 final_md 反推 */
  function finalData(r) {
    const d = safeParse(r && r.final_data, {}) || {};
    if (d && Array.isArray(d.sections) && d.sections.length) return d;
    return render.markdownToData(String((r && r.final_md) || ''));
  }
  function exportDocx(id, opts) {
    const r = docRow(id);
    if (!r) throw fail('not_found');
    const data = (opts && opts.data) || finalData(r);
    const hasAny = data && ((data.sections && data.sections.length) || String(data.name || '').trim());
    if (!hasAny) throw fail('need_final');
    const title = String(r.title || 'resume');
    const xml = render.renderDocx(data, title);
    return { filename: title.replace(/[\\/:*?"<>|\r\n]/g, '').slice(0, 40) + '.docx', buffer: buildDocxZip(xml, title) };
  }
  function exportHtml(id) {
    const r = docRow(id);
    if (!r) throw fail('not_found');
    const data = finalData(r);
    const hasAny = data && ((data.sections && data.sections.length) || String(data.name || '').trim());
    if (!hasAny) throw fail('need_final');
    return { filename: String(r.title || 'resume').replace(/[\\/:*?"<>|\r\n]/g, '').slice(0, 40) + '.html', html: render.renderHtml(data, { title: r.title }) };
  }

  /* 目标删除时清掉挂在该目标上的简历 */
  function onGoalDelete(goalId) {
    const rows = db.prepare('SELECT id FROM resume_docs WHERE goal_id = ?').all(numOf(goalId));
    for (const r of rows) {
      for (const t of ['resume_evidence', 'resume_versions', 'resume_reports']) db.prepare('DELETE FROM ' + t + ' WHERE doc_id = ?').run(r.id);
    }
    db.prepare('DELETE FROM resume_docs WHERE goal_id = ?').run(numOf(goalId));
    return rows.length;
  }

  /* ---------- 流水线状态 ---------- */
  function pipeline(id) {
    const r = docRow(id);
    if (!r) throw fail('not_found');
    const d = docOut(r, true);
    const jdChoices = listJdSources(r.goal_id);
    const steps = STAGES.map(function (s, i) {
      let done = false;
      if (s === 'upload') done = !!String(r.content_md || '').trim();
      else if (s === 'review') done = !!(safeParse(r.issues, []) || []).length || d.stage !== 'upload' && d.stage !== 'review';
      else if (s === 'supplement') done = !!(safeParse(r.answers, []) || []).length || ['jd', 'match', 'finalize'].indexOf(d.stage) >= 0;
      else if (s === 'jd') done = !!String(r.jd_text || '').trim();
      else if (s === 'match') done = !!Object.keys(safeParse(r.match_json, {}) || {}).length;
      else if (s === 'finalize') done = !!String(r.final_md || '').trim();
      return { stage: s, index: i, done: done, current: s === d.stage };
    });
    return { doc: d, steps: steps, stage: d.stage, next_stage: d.next_stage, jd_sources: jdChoices.slice(0, 30), evidence_count: db.prepare('SELECT COUNT(*) AS n FROM resume_evidence WHERE doc_id = ?').get(r.id).n };
  }

  return {
    STAGES,
    ensureSchema: function () { db.exec(SCHEMA_DOCS); db.exec(SCHEMA_REST); },
    listDocs: listDocs,
    createDoc: createDoc,
    updateDoc: updateDoc,
    deleteDoc: deleteDoc,
    getDoc: getDoc,
    importFile: importFile,
    listJdSources: listJdSources,
    pickJd: pickJd,
    runAI: runAI,
    ai: runAI,
    listEvidence: listEvidence,
    addEvidence: addEvidence,
    updateEvidence: updateEvidence,
    deleteEvidence: deleteEvidence,
    saveVersion: saveVersion,
    restoreVersion: restoreVersion,
    listReports: listReports,
    getReport: getReport,
    deleteReport: deleteReport,
    exportDocx: exportDocx,
    exportHtml: exportHtml,
    finalData: finalData,
    /** 设置「不写进简历」的排除词（代码级过滤，finalize 时生效） */
    setExcluded: function (id, words) {
      const r = docRow(id);
      if (!r) throw fail('not_found');
      const arr = contentFilter.norm(Array.isArray(words) ? words : [words]);
      db.prepare('UPDATE resume_docs SET excluded = ?, updated_at = ? WHERE id = ?').run(JSON.stringify(arr), nowISO(), r.id);
      return { ok: true, excluded: arr, doc: docOut(docRow(r.id), false) };
    },
    pipeline: pipeline,
    onGoalDelete: onGoalDelete,
    /* 纯函数（测试用） */
    __test: { firstJSON: firstJSON, normalize: normalize, evidenceBlock: evidenceBlock, fakeAI: fakeAI, STAGES: STAGES }
  };
}

module.exports = { createResumeDomain: createResumeDomain, STAGES: STAGES, __test: { firstJSON: firstJSON, normalize: normalize, evidenceBlock: evidenceBlock, fakeAI: fakeAI, STAGES: STAGES } };
