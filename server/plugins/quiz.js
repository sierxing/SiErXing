/**
 * 思而行 · 插件：随堂测验（按节点教程逐点考察掌握情况）
 * ------------------------------------------------------------------
 * 流程：AI 从教程提知识点大纲（导图展示，可勾选跳过）→ 用户选 Chess题型 →
 * 一次出一题（即时反馈）→ 答错可追问/再来一道（用户说了算，无强制上限，
 * 连续错 3 道仅温和建议回看）→ 报告页（掌握/薄弱/跳过 + 薄弱再练）。
 * 单选/判断前端…不，后端直接判（确定性）；简答调 AI 判分。
 */
'use strict';
let db, nowISO, safeParse, sendJSON, readBody, backup, log;
let getGoal, sourcesOf, aiText, currentModel;
function bind(ctx) {
  ({ db, nowISO, safeParse, sendJSON, readBody, backup, log } = ctx);
  ({ getGoal, sourcesOf, aiText, currentModel } = ctx);
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS quiz_outlines (
  tutorial_id INTEGER PRIMARY KEY,
  outline TEXT NOT NULL DEFAULT '[]',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS quiz_sessions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  tutorial_id INTEGER NOT NULL,
  node_id INTEGER NOT NULL DEFAULT 0,
  goal_id INTEGER NOT NULL DEFAULT 0,
  qtypes TEXT NOT NULL DEFAULT '[]',
  skip_idx TEXT NOT NULL DEFAULT '[]',
  status TEXT NOT NULL DEFAULT 'active',
  point_idx INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS quiz_records (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id INTEGER NOT NULL,
  point_idx INTEGER NOT NULL DEFAULT 0,
  point TEXT NOT NULL DEFAULT '',
  kind TEXT NOT NULL DEFAULT 'qa',
  qtype TEXT NOT NULL DEFAULT '',
  question TEXT NOT NULL DEFAULT '',
  options TEXT NOT NULL DEFAULT '[]',
  answer TEXT NOT NULL DEFAULT '',
  explain TEXT NOT NULL DEFAULT '',
  user_text TEXT NOT NULL DEFAULT '',
  correct INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_quiz_sessions_tut ON quiz_sessions(tutorial_id);
CREATE INDEX IF NOT EXISTS idx_quiz_records_ses ON quiz_records(session_id);`;

function tutOf(tid) {
  const t = db.prepare('SELECT * FROM tutorials WHERE id = ?').get(Number(tid));
  return t || null;
}
function outlineOf(tid) {
  const r = db.prepare('SELECT * FROM quiz_outlines WHERE tutorial_id = ?').get(Number(tid));
  if (!r) return [];
  try { const a = JSON.parse(r.outline || '[]'); return Array.isArray(a) ? a : []; } catch (e) { return []; }
}
function activeSession(tid) {
  return db.prepare("SELECT * FROM quiz_sessions WHERE tutorial_id = ? AND status = 'active' ORDER BY id DESC LIMIT 1").get(Number(tid)) || null;
}
function recordsOf(sid) {
  return db.prepare('SELECT * FROM quiz_records WHERE session_id = ? ORDER BY id').all(Number(sid));
}
function stripHtml(html) {
  return String(html || '').replace(/<[^>]+>/g, ' ').replace(/&nbsp;/g, ' ').replace(/\s+/g, ' ').trim();
}

function buildOutlinePrompt(tut) {
  const body = (tut.format === 'html' ? stripHtml(tut.content) : String(tut.content || '')).slice(0, 20000);
  const L = [];
  L.push('你是资深出题人。下面是一篇教学教程的正文，请提炼出「知识点大纲」，供随堂测验逐点考察。');
  L.push('【教程标题】' + String(tut.title || '').slice(0, 120));
  L.push('');
  L.push('【要求】');
  L.push('1. 按教程行文顺序提 4-12 个知识点，每个点一句话标题 + 50 字内摘要（只写本教程讲到的，不发散）。');
  L.push('2. 点与点尽量不重叠；实操步骤类内容合并为一个点，不要拆太碎。');
  L.push('3. 只输出一个 JSON 数组：');
  L.push('[{"title":"知识点标题","summary":"50字内摘要"}]');
  L.push('');
  L.push('【教程正文开始】\n' + body + '\n【教程正文结束】');
  return L.join('\n');
}
function buildQuestionPrompt(tut, point, qtype, wrongHist) {
  const ctx = (tut.format === 'html' ? stripHtml(tut.content) : String(tut.content || '')).slice(0, 12000);
  const L = [];
  L.push('你是耐心严谨的考官。针对下面这个知识点出一道' + (qtype === 'judge' ? '判断题' : qtype === 'text' ? '简答题' : '单选题') + '，考察用户是否真掌握（考理解不考死记）。');
  L.push('【知识点】' + String(point.title || '') + '：' + String(point.summary || ''));
  if (wrongHist && wrongHist.length) {
    L.push('【用户刚在这块答错的情况（换角度出，别出原题）】');
    for (const w of wrongHist.slice(-2)) L.push('- 题：' + String(w.question || '').slice(0, 120) + ' / 用户答：' + String(w.user_text || '').slice(0, 60));
  }
  L.push('');
  L.push('【要求】');
  if (qtype === 'judge') {
    L.push('1. 题目是一句陈述，用户判断对错；answer 填 "对" 或 "错"。');
    L.push('2. 只输出一个 JSON 对象：{"question":"陈述句","answer":"对","explain":"一句话讲解"}');
  } else if (qtype === 'text') {
    L.push('1. 题目开放作答，一两句话能答完；answer 写参考答案要点（100字内）。');
    L.push('2. 只输出一个 JSON 对象：{"question":"题目","answer":"参考答案要点","explain":"一句话讲解"}');
  } else {
    L.push('1. 4 个选项（v 为 A/B/C/D），只有一个正确；题干+选项不泄露答案。');
    L.push('2. 只输出一个 JSON 对象：{"question":"题干","options":[{"v":"A","label":"选项1"},{"v":"B","label":"选项2"},{"v":"C","label":"选项3"},{"v":"D","label":"选项4"}],"answer":"A","explain":"一句话讲解"}');
  }
  L.push('');
  L.push('【教程相关内容（出题依据，不要超纲）】\n' + ctx);
  L.push('');
  L.push('【排版铁律】题目/讲解里凡是出现代码，一律用 ``` 围栏包裹（注明语言），不许把代码挤在正文行内。');
  return L.join('\n');
}
function buildJudgePrompt(point, question, refAnswer, userText) {
  return [
    '你是宽容但严谨的阅卷人。判断用户的简答是否掌握了知识点（抓核心意思，不扣字眼；答到关键点即算对）。',
    '【知识点】' + String(point.title || '') + '：' + String(point.summary || ''),
    '【题目】' + String(question || '').slice(0, 300),
    '【参考答案要点】' + String(refAnswer || '').slice(0, 300),
    '【用户作答】' + String(userText || '').slice(0, 500),
    '只输出一个 JSON 对象：{"correct":true,"explain":"一句话点评（含讲对/错在哪）"}（没答对 correct 为 false）'
  ].join('\n');
}
function extractJSON(text) {
  const t = String(text || '').trim();
  if (!t) return null;
  const tryParse = raw => {
    if (!raw) return null;
    try { return JSON.parse(String(raw).replace(/^\uFEFF/, '')); } catch (e) { return null; }
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
      if (inStr) { if (esc) esc = false; else if (c === '\\') esc = true; else if (c === '"') inStr = false; continue; }
      if (c === '"') { inStr = true; continue; }
      if (c === '{') depth++;
      else if (c === '}') { depth--; if (depth === 0) { end = j; break; } }
    }
    if (end < 0) break;
    const o = tryParse(t.slice(start, end + 1));
    if (o && typeof o === 'object' && !Array.isArray(o)) objs.push(o);
    i = end + 1;
  }
  if (!objs.length && t.trim().startsWith('[')) {
    const m = t.match(/\[[\s\S]*\]/);
    if (m) { const a = tryParse(m[0]); if (Array.isArray(a)) return a; }
  }
  if (!objs.length) return null;
  objs.sort((a, b) => Object.keys(b).length - Object.keys(a).length);
  return objs[0];
}
const QTYPES = ['single', 'judge', 'text'];

module.exports = {
  id: 'quiz',
  name: '随堂测验',
  icon: '📝',
  category: '其它',
  desc: '按教程逐点考察掌握情况：大纲导图选题型，一次一题即时反馈，答错可追问/再来一道，全程由你控制节奏',
  order: 44,
  goalToggle: false,
  defaultEnabled: true,
  client: '/plugins/quiz.js',

  init(ctx) {
    bind(ctx);
    db.exec(SCHEMA);
  },
  onGoalDelete(goalId, ctx) {
    const ses = ctx.db.prepare('SELECT id FROM quiz_sessions WHERE goal_id = ?').all(goalId).map(x => x.id);
    if (ses.length) {
      const ph = ses.map(() => '?').join(',');
      ctx.db.prepare(`DELETE FROM quiz_records WHERE session_id IN (${ph})`).run(...ses);
    }
    ctx.db.prepare('DELETE FROM quiz_sessions WHERE goal_id = ?').run(goalId);
    const tids = ctx.db.prepare('SELECT id FROM tutorials WHERE goal_id = ?').all(goalId).map(x => x.id);
    void tids;
    ctx.db.prepare("DELETE FROM quiz_outlines WHERE tutorial_id NOT IN (SELECT id FROM tutorials)").run();
  },

  api: [
    {
      // 大纲：有缓存直接读
      method: 'GET',
      pattern: /^\/api\/tutorials\/(\d+)\/quiz\/outline$/,
      handler: async (req, res, u, ctx) => {
        const m = u.pathname.match(/^\/api\/tutorials\/(\d+)\/quiz\/outline$/);
        if (!m || req.method !== 'GET') return false;
        return sendJSON(res, 200, { outline: outlineOf(m[1]) });
      }
    },
    {
      // 大纲：AI 提炼（覆盖）
      method: 'POST',
      pattern: /^\/api\/tutorials\/(\d+)\/quiz\/outline$/,
      handler: async (req, res, u, ctx) => {
        const m = u.pathname.match(/^\/api\/tutorials\/(\d+)\/quiz\/outline$/);
        if (!m || req.method !== 'POST') return false;
        const t = tutOf(m[1]);
        if (!t) return sendJSON(res, 404, { error: '教程不存在' });
        const body = await readBody(req).catch(() => ({}));
        const force = body && body.force;
        if (!force) {
          const old = outlineOf(t.id);
          if (old.length) return sendJSON(res, 200, { outline: old, cached: true });
        }
        const model = currentModel();
        const txt = await aiText(buildOutlinePrompt(t), model, 120000);
        let arr = extractJSON(txt);
        if (!Array.isArray(arr)) {
          const mm = String(txt || '').match(/\[[\s\S]*\]/);
          arr = mm ? extractJSON(mm[0]) : null;
        }
        if (!Array.isArray(arr)) throw new Error('大纲提炼失败，请重试');
        const pts = arr.filter(x => x && x.title).slice(0, 12).map(x => ({
          title: String(x.title).slice(0, 60), summary: String(x.summary || '').slice(0, 120)
        }));
        if (!pts.length) throw new Error('大纲提炼失败，请重试');
        const now = nowISO();
        db.prepare('INSERT INTO quiz_outlines (tutorial_id, outline, created_at, updated_at) VALUES (?,?,?,?) ON CONFLICT(tutorial_id) DO UPDATE SET outline = excluded.outline, updated_at = excluded.updated_at')
          .run(t.id, JSON.stringify(pts), now, now);
        return sendJSON(res, 200, { outline: pts });
      }
    },
    {
      // 会话：读进行中的（含答题记录 + 各点统计）
      method: 'GET',
      pattern: /^\/api\/tutorials\/(\d+)\/quiz\/session$/,
      handler: async (req, res, u, ctx) => {
        const m = u.pathname.match(/^\/api\/tutorials\/(\d+)\/quiz\/session$/);
        if (!m || req.method !== 'GET') return false;
        const s = activeSession(m[1]);
        if (!s) return sendJSON(res, 200, { session: null });
        return sendJSON(res, 200, { session: s, records: recordsOf(s.id) });
      }
    },
    {
      // 会话：新建（旧的自动归档，可反复开新一轮）
      method: 'POST',
      pattern: /^\/api\/tutorials\/(\d+)\/quiz\/session$/,
      handler: async (req, res, u, ctx) => {
        const m = u.pathname.match(/^\/api\/tutorials\/(\d+)\/quiz\/session$/);
        if (!m || req.method !== 'POST') return false;
        const t = tutOf(m[1]);
        if (!t) return sendJSON(res, 404, { error: '教程不存在' });
        const body = await readBody(req).catch(() => ({}));
        let qtypes = Array.isArray(body.qtypes) ? body.qtypes.filter(x => QTYPES.includes(x)) : [];
        if (!qtypes.length) qtypes = QTYPES.slice();
        let skip = Array.isArray(body.skip) ? body.skip.map(Number).filter(x => x >= 0) : [];
        const now = nowISO();
        db.prepare("UPDATE quiz_sessions SET status = 'done', updated_at = ? WHERE tutorial_id = ? AND status = 'active'").run(now, t.id);
        const r = db.prepare('INSERT INTO quiz_sessions (tutorial_id, node_id, goal_id, qtypes, skip_idx, status, point_idx, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?)')
          .run(t.id, t.node_id || 0, t.goal_id || 0, JSON.stringify(qtypes), JSON.stringify(skip), 'active', 0, now, now);
        const s = db.prepare('SELECT * FROM quiz_sessions WHERE id = ?').get(Number(r.lastInsertRowid));
        backup();
        return sendJSON(res, 200, { session: s, records: [] });
      }
    },
    {
      // 会话：推进指针 / 结束
      method: 'POST',
      pattern: /^\/api\/quiz-session\/(\d+)\/(move|finish)$/,
      handler: async (req, res, u, ctx) => {
        const m = u.pathname.match(/^\/api\/quiz-session\/(\d+)\/(move|finish)$/);
        if (!m || req.method !== 'POST') return false;
        const s = db.prepare('SELECT * FROM quiz_sessions WHERE id = ?').get(Number(m[1]));
        if (!s) return sendJSON(res, 404, { error: '会话不存在' });
        const body = await readBody(req).catch(() => ({}));
        const now = nowISO();
        if (m[2] === 'finish') {
          db.prepare("UPDATE quiz_sessions SET status = 'done', updated_at = ? WHERE id = ?").run(now, s.id);
        } else {
          db.prepare('UPDATE quiz_sessions SET point_idx = ?, updated_at = ? WHERE id = ?')
            .run(Math.max(0, Number(body.point_idx) || 0), now, s.id);
        }
        const fresh = db.prepare('SELECT * FROM quiz_sessions WHERE id = ?').get(s.id);
        return sendJSON(res, 200, { session: fresh, records: recordsOf(s.id) });
      }
    },
    {
      // 出题：指定知识点出一道（题型轮换该点用得最少的；失败抛错由前端 toast）
      method: 'POST',
      pattern: /^\/api\/quiz-session\/(\d+)\/question$/,
      handler: async (req, res, u, ctx) => {
        const m = u.pathname.match(/^\/api\/quiz-session\/(\d+)\/question$/);
        if (!m || req.method !== 'POST') return false;
        const s = db.prepare('SELECT * FROM quiz_sessions WHERE id = ?').get(Number(m[1]));
        if (!s) return sendJSON(res, 404, { error: '会话不存在' });
        if (s.status !== 'active') return sendJSON(res, 400, { error: '本轮已结束，可再开一轮' });
        const body = await readBody(req).catch(() => ({}));
        const t = tutOf(s.tutorial_id);
        if (!t) return sendJSON(res, 404, { error: '教程不存在' });
        const outline = outlineOf(s.tutorial_id);
        const pi = Math.max(0, Number(body.point_idx) || 0);
        const point = outline[pi];
        if (!point) return sendJSON(res, 400, { error: '知识点不存在' });
        let qtypes = [];
        try { qtypes = JSON.parse(s.qtypes || '[]'); } catch (e) {}
        qtypes = qtypes.filter(x => QTYPES.includes(x));
        if (!qtypes.length) qtypes = QTYPES.slice();
        const recs = recordsOf(s.id).filter(r => r.point_idx === pi && r.kind === 'qa');
        const used = {};
        for (const r of recs) used[r.qtype] = (used[r.qtype] || 0) + 1;
        let qtype = qtypes.slice().sort((a, b) => (used[a] || 0) - (used[b] || 0))[0];
        if (body.qtype && qtypes.includes(body.qtype)) qtype = body.qtype;
        const wrongHist = recs.filter(r => !r.correct).map(r => ({ question: r.question, user_text: r.user_text }));
        const model = currentModel();
        const txt = await aiText(buildQuestionPrompt(t, point, qtype, wrongHist), model, 120000);
        const data = extractJSON(txt) || {};
        if (!data.question) throw new Error('出题失败，请重试');
        let options = [];
        if (qtype === 'single') {
          options = (Array.isArray(data.options) ? data.options : []).slice(0, 4).map(o => ({
            v: String((o && o.v) || '').slice(0, 4), label: String((o && o.label) || '').slice(0, 120)
          })).filter(o => o.v && o.label);
          if (options.length < 2 || !options.some(o => o.v === String(data.answer || '').trim())) throw new Error('出题失败，请重试');
        }
        const now = nowISO();
        const ins = db.prepare('INSERT INTO quiz_records (session_id, point_idx, point, kind, qtype, question, options, answer, explain, created_at) VALUES (?,?,?,?,?,?,?,?,?,?)')
          .run(s.id, pi, String(point.title || '').slice(0, 60), 'qa', qtype, String(data.question).slice(0, 1000),
            JSON.stringify(options), String(data.answer || '').slice(0, 500), String(data.explain || '').slice(0, 500), now);
        db.prepare('UPDATE quiz_sessions SET point_idx = ?, updated_at = ? WHERE id = ?').run(pi, now, s.id);
        const rec = db.prepare('SELECT * FROM quiz_records WHERE id = ?').get(Number(ins.lastInsertRowid));
        return sendJSON(res, 200, { record: rec });
      }
    },
    {
      // 作答：单选/判断直接判，简答 AI 判
      method: 'POST',
      pattern: /^\/api\/quiz-records\/(\d+)\/answer$/,
      handler: async (req, res, u, ctx) => {
        const m = u.pathname.match(/^\/api\/quiz-records\/(\d+)\/answer$/);
        if (!m || req.method !== 'POST') return false;
        const r = db.prepare('SELECT * FROM quiz_records WHERE id = ?').get(Number(m[1]));
        if (!r) return sendJSON(res, 404, { error: '题目不存在' });
        const body = await readBody(req).catch(() => ({}));
        const userText = String((body && (body.text != null ? body.text : body.choice)) || '').trim().slice(0, 500);
        if (!userText) return sendJSON(res, 400, { error: '先写下你的答案' });
        let correct = 0, explain = r.explain || '';
        if (r.qtype === 'text') {
          const s = db.prepare('SELECT * FROM quiz_sessions WHERE id = ?').get(r.session_id);
          const t = s ? tutOf(s.tutorial_id) : null;
          const outline = s ? outlineOf(s.tutorial_id) : [];
          const point = outline[r.point_idx] || { title: r.point };
          const model = currentModel();
          const txt = await aiText(buildJudgePrompt(point, r.question, r.answer, userText), model, 60000);
          const data = extractJSON(txt) || {};
          correct = data.correct ? 1 : 0;
          if (data.explain) explain = String(data.explain).slice(0, 500);
        } else {
          correct = userText === String(r.answer || '').trim() ? 1 : 0;
        }
        db.prepare('UPDATE quiz_records SET user_text = ?, correct = ?, explain = ? WHERE id = ?')
          .run(userText, correct, explain, r.id);
        const fresh = db.prepare('SELECT * FROM quiz_records WHERE id = ?').get(r.id);
        return sendJSON(res, 200, { record: fresh });
      }
    }
    /* ⚠️ 这里原来还有 `POST /api/quiz-session/:id/chat`（就本知识点追问 AI）。
       已删除：一百来个组件各写一套 AI 问答，效果一定参差不齐，还各花各的提示词与费用。
       现在统一走**已有的 AI 助手**（常驻每个页面 + 能读到当前页面内容），
       测验页只留一个「问 AI」按钮把上下文带过去。
       历史 `quiz_records` 里 kind='chat' 的旧记录仍留在库里（同步照旧），只是不再显示。 */
  ]
};
