/**
 * 思而行 · 插件：用自己的话（把教程知识点内化成用户自己的语言）
 * ------------------------------------------------------------------
 * 和随堂测验的区别：测验考「你记住了吗」，这个组件解决「我记得但说不出来」。
 *
 * 设计要点是**循序渐进**，不是一上来就问细节。AI 提大纲时，为每个知识点同时
 * 生成一条「理解阶梯」（默认四级）：
 *   ① 缘起 —— 为什么会遇到这个问题？在此之前卡在哪？（先建立动机）
 *   ② 轮廓 —— 它大致在做什么？（建立整体图景）
 *   ③ 关键 —— 支撑它的关键机制/前提/边界在哪里？（建立精度）
 *   ④ 串讲 —— 把前三级串成一段完整表述（这一步才叫「内化」）
 *
 * 每一级 AI 先抛一个**引导性问题**（不给答案），用户答完 AI 判「这一级到位没」，
 * 只指出**最关键的那一个**缺口并给方向提示（给方向不给答案）→ 用户可反复答、
 * 可追问、可跳过、可回退，全部由用户说了算，没有倒计时也不自动推进。
 * 走完阶梯后收尾：输出「你的版本 vs 原文要点」对照 → 沉淀成「我的话」。
 *
 * 涉及代码一律要求用 ``` 围栏包裹。
 */
'use strict';

let db, nowISO, safeParse, sendJSON, readBody, log;
let getGoal, aiText, currentModel, tasks;
function bind(ctx) {
  ({ db, nowISO, safeParse, sendJSON, readBody, log } = ctx);
  ({ getGoal, aiText, currentModel, tasks } = ctx);
}

/* 把一次 AI 调用挂到左下角「AI 任务」上 —— 提炼/判定可能要等十几秒到半分钟，
   只让按钮变灰用户完全不知道系统在干什么，挂到任务栏里才有"确实在工作"的实感，
   还能随时点「停止」。
   单次 AI 调用拿不到真实的子进度，所以进度条按**已耗时渐近逼近**（封顶 93%，永不假装完成），
   消息始终如实说明在做什么、已等多久；只有真正拿到并处理完结果才 100%。 */
function aiJob({ title, note, goalId, nodeId, message, run }) {
  const job = tasks.begin({ type: 'restate', title, note, goalId, nodeId, message });
  const t0 = Date.now();
  job.progress(4, message);
  const iv = setInterval(() => {
    const sec = Math.round((Date.now() - t0) / 1000);
    const p = Math.min(93, Math.round(100 * (1 - Math.exp(-sec / 18))));
    job.progress(Math.max(4, p), message + '（已等 ' + sec + ' 秒）');
  }, 1500);
  return Promise.resolve()
    .then(() => run(job.signal))
    .then(v => {
      clearInterval(iv);
      job.progress(98, 'AI 已返回，正在校验结果…');
      job.done(v);
      job.progress(100, '完成');
      return v;
    })
    .catch(e => {
      clearInterval(iv);
      job.fail(e);
      throw e;
    });
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS restate_arc (
  tutorial_id INTEGER PRIMARY KEY,
  arc TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS restate_points (
  tutorial_id INTEGER PRIMARY KEY,
  points TEXT NOT NULL DEFAULT '[]',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS restate_rounds (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  tutorial_id INTEGER NOT NULL,
  node_id INTEGER NOT NULL DEFAULT 0,
  goal_id INTEGER NOT NULL DEFAULT 0,
  point_idx INTEGER NOT NULL DEFAULT 0,
  point_title TEXT NOT NULL DEFAULT '',
  step_idx INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'active',
  mine TEXT NOT NULL DEFAULT '',
  gaps TEXT NOT NULL DEFAULT '[]',
  line TEXT NOT NULL DEFAULT '',
  turns INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS restate_turns (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  round_id INTEGER NOT NULL,
  seq INTEGER NOT NULL DEFAULT 0,
  user_text TEXT NOT NULL DEFAULT '',
  ai_text TEXT NOT NULL DEFAULT '',
  verdict TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_restate_rounds_tut ON restate_rounds(tutorial_id);
CREATE INDEX IF NOT EXISTS idx_restate_turns_round ON restate_turns(round_id);`;

function tutOf(tid) {
  return db.prepare('SELECT * FROM tutorials WHERE id = ?').get(Number(tid)) || null;
}
function arcOf(tid) {
  const r = db.prepare('SELECT arc FROM restate_arc WHERE tutorial_id = ?').get(Number(tid));
  if (!r) return null;
  try {
    const a = JSON.parse(r.arc || '{}');
    return (a && typeof a === 'object' && !Array.isArray(a)) ? a : null;
  } catch (e) { return null; }
}
function saveArc(tid, arc) {
  const now = nowISO();
  db.prepare('INSERT INTO restate_arc (tutorial_id, arc, created_at, updated_at) VALUES (?,?,?,?) ON CONFLICT(tutorial_id) DO UPDATE SET arc = excluded.arc, updated_at = excluded.updated_at')
    .run(Number(tid), JSON.stringify(arc || {}), now, now);
}
/* 把 AI 可能给出的各种形态归一成 {thesis, spine[], branches[{id,name,gist}]} */
function normArc(v, pts) {
  const a = (v && typeof v === 'object' && !Array.isArray(v)) ? v : {};
  const branches = (Array.isArray(a.branches) ? a.branches : [])
    .filter(b => b && (b.name || b.title))
    .slice(0, 8)
    .map((b, i) => ({
      id: String(b.id || ('b' + i)),
      name: String(b.name || b.title || '').slice(0, 40),
      gist: String(b.gist || b.desc || b.summary || '').slice(0, 160)
    }));
  // 分支 id 兜底成 b0/b1…，保证每个 point 的 branch 都能对上
  if (!branches.length && pts.length) {
    pts.forEach((p, i) => branches.push({ id: 'b' + Math.floor(i / 4), name: '知识块 ' + (Math.floor(i / 4) + 1), gist: '' }));
  }
  const ids = new Set(branches.map(b => b.id));
  const out = {
    thesis: String(a.thesis || '').slice(0, 300),
    spine: (Array.isArray(a.spine) ? a.spine : []).map(x => String(x || '').slice(0, 200)).filter(Boolean).slice(0, 8),
    branches
  };
  // 重新提炼架构时保留已生成的「串联叙述」，别把用户的成果冲掉
  if (a.weave && typeof a.weave === 'object') out.weave = a.weave;
  return out;
}
function pointsOf(tid) {
  const r = db.prepare('SELECT points FROM restate_points WHERE tutorial_id = ?').get(Number(tid));
  if (!r) return [];
  try { const a = JSON.parse(r.points || '[]'); return Array.isArray(a) ? a : []; } catch (e) { return []; }
}
function savePoints(tid, pts) {
  const now = nowISO();
  db.prepare('INSERT INTO restate_points (tutorial_id, points, created_at, updated_at) VALUES (?,?,?,?) ON CONFLICT(tutorial_id) DO UPDATE SET points = excluded.points, updated_at = excluded.updated_at')
    .run(Number(tid), JSON.stringify(pts), now, now);
}
function roundsOf(tid) {
  return db.prepare('SELECT * FROM restate_rounds WHERE tutorial_id = ? ORDER BY id').all(Number(tid));
}
function turnsOf(rid) {
  return db.prepare('SELECT * FROM restate_turns WHERE round_id = ? ORDER BY seq, id').all(Number(rid));
}
function stripHtml(html) {
  return String(html || '').replace(/<[^>]+>/g, ' ').replace(/&nbsp;/g, ' ').replace(/\s+/g, ' ').trim();
}

/* ---------- 提示词 ---------- */

/* 阶梯的兜底模板：AI 没给 steps 时用，保证界面永远有台阶可走 */
const STEP_FALLBACK = [
  { t: '缘起', q: '在遇到它之前，这件事是怎么做的？卡在哪儿了？', hint: '想想没有它的时候你会怎么做、哪里别扭' },
  { t: '轮廓', q: '那它到底在做什么？用一句粗话概括。', hint: '先别管细节，说个大概就行' },
  { t: '关键', q: '它成立最关键的那一点是什么？少了哪条就不成立？', hint: '找它的前提、边界或最容易误解的地方' },
  { t: '串讲', q: '现在把前面几级连起来，用你自己的话完整讲一遍。', hint: '从「为什么要它」开始，一路讲到「它怎么做、关键在哪」' },
];
function normSteps(v) {
  const a = Array.isArray(v) ? v : [];
  const out = [];
  for (const s of a.slice(0, 5)) {
    if (!s) continue;
    const q = String((s.q != null ? s.q : s.question) || '').trim();
    if (!q) continue;
    out.push({
      t: String(s.t || s.title || '').slice(0, 12),
      q: q.slice(0, 200),
      hint: String(s.hint || s.scaffold || '').slice(0, 200)
    });
  }
  return out.length ? out : STEP_FALLBACK.slice();
}

function buildPointsPrompt(tut) {
  const body = (tut.format === 'html' ? stripHtml(tut.content) : String(tut.content || '')).slice(0, 20000);
  return [
    '你是学习教练。下面是一篇教程，请先提炼它的**整体知识架构**，再拆出知识点，供用户循序渐进地用���己的话讲出来。',
    '【教程标题】' + String(tut.title || '').slice(0, 120),
    '',
    '【第一部分：整体架构（最重要，用户要靠它把零散知识点拼成一张图）】',
    '1. thesis：这篇教程的核心主张 / 想让用户最终理解的那件事，1-2 句。',
    '2. spine：**主线推进**，3-6 步，每步一句「因为…所以…」式的推进（30 字内）。',
    '   用户走完这些点之后，应该能顺着这条线把整篇串起来。',
    '3. branches：2-4 个**知识块**，每个含 name（块名）与 gist（这块整体在讲什么，40 字内）。',
    '   块之间要有真实的包含或递进关系，不要只是分类标签。',
    '',
    '【第二部分：知识点】',
    '1. 按行文顺序提 4-12 个，每个点包含：',
    '   - title：一句话标题',
    '   - branch：归属哪个知识块（填上面 branches 里的 id，如 b0）',
    '   - summary：50 字内讲清「这个点到底在说什么」',
    '   - key_points：2-4 条「用户用自己的话讲出来时必须覆盖的要点」，每条 30 字内。',
    '     写「实质内容」而不是「原句」——它是我们判断用户漏讲了什么的依据。',
    '2. steps：**理解阶梯**。每个点给 4 级，按理解顺序排：',
    '   ① 缘起：为什么会遇到这个问题？在它之前卡在哪？（建立动机，别一上来就问细节）',
    '   ② 轮廓：它大致在做什么？（建立整体图景）',
    '   ③ 关键：最关键的机制/前提/边界在哪？（建立精度）',
    '   ④ 串讲：把前三级连起来完整表述（这一步才叫内化）',
    '   每级含：t（这一步的名字）、q（**引导性问题**，一句话，',
    '   像导师那样提问，**不要在问题里泄露答案**）、hint（方向提示，一句话，',
    '   指出该往哪想，但**不能直接把答案说出来**）。',
    '   · 步骤数可少于 4，但顺序必须是先动机后机制。',
    '3. 点与点尽量不重叠，不要拆太碎。',
    '',
    '【输出格式：只输出一个 JSON 对象，不要任何解释文字】',
    '{"thesis":"...","spine":["...","..."],"branches":[{"id":"b0","name":"...","gist":"..."}],'
    + '"points":[{"title":"...","branch":"b0","summary":"...","key_points":["...","..."],'
    + '"steps":[{"t":"缘起","q":"...","hint":"..."},{"t":"轮廓","q":"...","hint":"..."},'
    + '{"t":"关键","q":"...","hint":"..."},{"t":"串讲","q":"...","hint":"..."}]}]}',
    '',
    '【教程正文开始】\n' + body + '\n【教程正文结束】'
  ].join('\n');
}

/* 判断用户在**当前这一级**讲得怎么样；只指出最关键的一个缺口 */
function buildTurnPrompt(tut, point, step, stepIdx, stepTotal, history, userText, arc) {
  const L = [];
  L.push('你是学习教练，正在陪用户**循序渐进**地理解一个知识点。用户正处在阶梯的第 ' + (stepIdx + 1) + ' / ' + stepTotal + ' 级。');
  L.push('你的任务只有一个：判断他**这一级**讲到位没有。不要提前追问后面级别的细节——那是后面的台阶。');
  L.push('');
  // 让 AI 知道这个点在整张图上的位置：这样点评时能顺手接上前后关系，而不是孤立评价
  if (arc && (arc.thesis || (arc.spine || []).length)) {
    L.push('【整篇教程的知识架构（判断时心里有数：他在图上哪个位置，别孤立评价）】');
    if (arc.thesis) L.push('核心主张：' + String(arc.thesis).slice(0, 200));
    if ((arc.spine || []).length) {
      L.push('主线推进：');
      arc.spine.forEach((s, i) => L.push('  ' + (i + 1) + '. ' + String(s).slice(0, 120)));
    }
    L.push('');
  }
  L.push('【知识点】' + String(point.title || ''));
  L.push('【它讲的是什么】' + String(point.summary || ''));
  if ((point.key_points || []).length) {
    L.push('【最终要覆盖的要点（此刻只用来判断"有没有讲错"，不要一次性全倒给他）】');
    for (const k of point.key_points) L.push('- ' + String(k));
  }
  L.push('');
  L.push('【当前这一级】' + String(step.t || ('第' + (stepIdx + 1) + '级')) + '：' + String(step.q || ''));
  L.push('【这一级的参考方向】' + String(step.hint || '（无）'));
  L.push('');
  if (history && history.length) {
    L.push('【用户前面各级已经说过的（别重复问已经讲到的）】');
    for (const h of history.slice(-5)) L.push('- ' + String(h).slice(0, 200));
    L.push('');
  }
  L.push('【用户这一轮的表述】');
  L.push(String(userText || '').slice(0, 800));
  L.push('');
  L.push('【要求】');
  L.push('1. ok：**这一级**是否到位了（讲到了就算，不要求完整、不扣字眼）。到位为 true。');
  L.push('2. probe：如果没到位，**只针对最关键的那一个**缺口，一句话追问。');
  L.push('   · 不要罗列缺失项，不要一次问好几个问题，不要提前问下一级的内容。');
  L.push('3. scaffold：给方向去补这个缺口，**不能直接给答案**。');
  L.push('4. wrong：只有确实说反/说错才填（用户可能理解错的关键处），没有就空数组。');
  L.push('5. ai_text：两三句自然语言回应（肯定他讲对的部分，别空泛夸），末尾带上你的追问或"可以进下一级了"。');
  L.push('   写成直接对用户说的话，不要复述结构、不要说"根据评判标准"。');
  L.push('6. 语气平实，别用"太棒了""完美"这类空话。');
  L.push('7. 涉及代码一律用 ``` 围栏包裹（注明语言）。');
  L.push('');
  L.push('只输出一个 JSON 对象：');
  L.push('{"ok":false,"hit":["这一级他已讲到的"],"missed":["这一级还缺什么"],'
    + '"wrong":[{"said":"用户说的","right":"实际应该是"}],'
    + '"probe":"一句话追问","scaffold":"方向提示（不给答案）","ai_text":"两三句回应"}');
  return L.join('\n');
}

/* 收尾：把用户逐级的表达整理成一版「我的话」，并对照原文讲清差异 */
function buildFinishPrompt(tut, point, history) {
  return [
    '你是学习教练。用户已经沿着阶梯用自己的话讲过这个知识点（先讲动机，再讲轮廓、关键，最后串讲），现在做收尾对照。',
    '',
    '【知识点】' + String(point.title || ''),
    '【它讲的是什么】' + String(point.summary || ''),
    (point.key_points || []).length ? '【最终要覆盖的要点】\n' + (point.key_points || []).map(k => '- ' + String(k)).join('\n') : '',
    '',
    '【用户全程的表述（按顺序）】',
    (history || []).map((h, i) => (i + 1) + '. ' + String(h).slice(0, 300)).join('\n'),
    '',
    '【要求】',
    '1. mine：把用户的表述整理成一版通顺的「我的话」。**保留用户自己的用词、语气和类比**，',
    '   只是理顺结构、补上连接；不要替换成书上的术语（那样就失去意义了）。',
    '   最好仍然能看出「先讲为什么、再讲怎么做」这个顺序。长度和用户说的相当，别写成教科书。',
    '2. gaps：列出现在版本和「最终要覆盖的要点」之间仍然存在的缺口，每条含 key 与 why（为什么重要，1 句）。',
    '   已经讲到的不要列。没有缺口就给空数组。',
    '3. line：一句话总结，用户这一轮真正内化了什么（具体，不要套话）。',
    '4. 涉及代码一律用 ``` 围栏包裹。',
    '',
    '只输出一个 JSON 对象：{"mine":"用户自己的话（整理版）","gaps":[{"key":"...","why":"..."}],"line":"一句话"}'
  ].join('\n');
}

/* 收官：把用户在各点说过的话，按架构主线串成一份**属于他自己的**整体叙述。
   这是"把知识点变成自己的语言"的终点 —— 不是知识点之间各自成立，而是连成一张他能复述的图。 */
function buildWeavePrompt(tut, arc, done) {
  const L = [];
  L.push('你是学习教练。用户已经逐个知识点用自己的话讲过一遍。现在做最后一步：把这些话**串成一篇连贯的整体叙述**。');
  L.push('');
  if (arc && arc.thesis) L.push('【这篇教程的核心主张】' + String(arc.thesis).slice(0, 300));
  if (arc && (arc.spine || []).length) {
    L.push('【主线推进】');
    arc.spine.forEach((s, i) => L.push('  ' + (i + 1) + '. ' + String(s).slice(0, 150)));
  }
  if (arc && (arc.branches || []).length) {
    L.push('【知识块】');
    arc.branches.forEach(b => L.push('  · ' + String(b.name || '') + '：' + String(b.gist || '').slice(0, 120)));
  }
  L.push('');
  L.push('【用户逐点说过的话（这是素材，务必以他的表达为准）】');
  for (const d of done) {
    L.push('');
    L.push('◆ ' + String(d.title || ''));
    L.push(String(d.mine || '').slice(0, 800));
  }
  L.push('');
  L.push('【要求】');
  L.push('1. narrative：把这些话串成**一篇连贯的整体叙述**（400-900字）。');
  L.push('   · 必须能看出「因为…所以…」的推进关系，让读者明白这几个知识点为什么连在一起。');
  L.push('   · **保留用户自己的用词、语气和类比**，只是把它们按逻辑接起来；不要换成书上的术语。');
  L.push('   · 如果用户某几点讲得还不全，就在那里自然地留一个衔接（点到为止，不要长篇补课）。');
  L.push('2. links：2-5 条「他自己可能还没连起来的关系」，每条含 a（点A）、b（点B）、how（怎么连起来，一句）。');
  L.push('   这是这个组件最有价值的部分：帮他建立点与点之间的连接。');
  L.push('3. missing：还差哪些块没讲（按知识块算，没有就给空数组）。');
  L.push('4. 涉及代码一律用 ``` 围栏包裹（注明语言）。');
  L.push('');
  L.push('只输出一个 JSON 对象：{"narrative":"...","links":[{"a":"...","b":"...","how":"..."}],"missing":["..."]}');
  return L.join('\n');
}

/* 自由追问 */
function buildChatPrompt(tut, point, step, history, question) {
  return [
    '你是学习教练，耐心但不啰嗦。用户在理解知识点的过程中提问，请直接回答（200 字内）。',
    '【知识点】' + String(point.title || ''),
    '【他当前在理解的这一级】' + String((step && step.t) || '（未指定）') + '：' + String((step && step.q) || ''),
    '【要点清单】' + ((point.key_points || []).map(k => String(k)).join('；') || '（无）'),
    '【他前面说过的话】' + ((history || []).slice(-3).map(h => String(h).slice(0, 120)).join(' / ') || '（还没有）'),
    '【他的问题】' + String(question || '').slice(0, 300),
    '答完可以顺带用一句话指出：按他自己的话来看，这块还差点什么。涉及代码必须用 ``` 围栏包裹。'
  ].join('\n');
}

/* ---------- JSON 提取（模型常带围栏或前后废话） ---------- */
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
  if (!objs.length) return null;
  objs.sort((a, b) => Object.keys(b).length - Object.keys(a).length);
  return objs[0];
}
const strList = v => (Array.isArray(v) ? v : []).map(x => String(x || '').trim()).filter(Boolean).slice(0, 8);
const normWrong = v => (Array.isArray(v) ? v : []).map(x => ({
  said: String((x && x.said) || '').slice(0, 160), right: String((x && x.right) || '').slice(0, 200)
})).filter(x => x.said || x.right).slice(0, 5);

module.exports = {
  id: 'restate',
  name: '用自己的话',
  icon: '🧠',
  category: '其它',
  desc: '逐步引导你把教程知识点用自己的话讲出来：AI 只追问最关键的那一个缺口、给方向不给答案，最后沉淀成「我的话」',
  order: 45,
  goalToggle: false,
  defaultEnabled: true,
  client: '/plugins/restate.js',

  init(ctx) {
    bind(ctx);
    db.exec(SCHEMA);
  },

  onGoalDelete(goalId, ctx) {
    const rs = ctx.db.prepare('SELECT id FROM restate_rounds WHERE goal_id = ?').all(goalId).map(x => x.id);
    if (rs.length) {
      const ph = rs.map(() => '?').join(',');
      ctx.db.prepare(`DELETE FROM restate_turns WHERE round_id IN (${ph})`).run(...rs);
    }
    ctx.db.prepare('DELETE FROM restate_rounds WHERE goal_id = ?').run(goalId);
    ctx.db.prepare('DELETE FROM restate_points WHERE tutorial_id NOT IN (SELECT id FROM tutorials)').run();
    ctx.db.prepare('DELETE FROM restate_arc WHERE tutorial_id NOT IN (SELECT id FROM tutorials)').run();
  },

  api: [
    /* 大纲：有缓存直接读 */
    {
      method: 'GET',
      pattern: /^\/api\/tutorials\/(\d+)\/restate\/points$/,
      handler: async (req, res, u, ctx) => {
        const m = u.pathname.match(/^\/api\/tutorials\/(\d+)\/restate\/points$/);
        if (!m || req.method !== 'GET') return false;
        return sendJSON(res, 200, { points: pointsOf(m[1]), arc: arcOf(m[1]), rounds: roundsOf(m[1]) });
      }
    },
    /* 大纲：AI 提炼（覆盖） */
    {
      method: 'POST',
      pattern: /^\/api\/tutorials\/(\d+)\/restate\/points$/,
      handler: async (req, res, u, ctx) => {
        const m = u.pathname.match(/^\/api\/tutorials\/(\d+)\/restate\/points$/);
        if (!m || req.method !== 'POST') return false;
        const t = tutOf(m[1]);
        if (!t) return sendJSON(res, 404, { error: '教程不存在' });
        const body = await readBody(req).catch(() => ({}));
        if (!(body && body.force)) {
          const old = pointsOf(t.id);
          if (old.length) return sendJSON(res, 200, { points: old, arc: arcOf(t.id), rounds: roundsOf(t.id), cached: true });
        }
        const txt = await aiJob({
          title: '提炼知识架构与知识点',
          note: String(t.title || '').slice(0, 80),
          goalId: Number(t.goal_id || 0),
          nodeId: Number(t.node_id || 0),
          message: 'AI 正在读教程，梳理整体架构并设计各点的理解阶梯',
          run: signal => aiText(buildPointsPrompt(t), currentModel(), 120000, null, signal)
        });
        const data = extractJSON(txt);
        // 新格式是对象（含架构），旧格式是纯数组 —— 两种都收
        const arr = Array.isArray(data) ? data
          : (data && Array.isArray(data.points) ? data.points
            : (() => { const mm = String(txt || '').match(/\[[\s\S]*\]/); return mm ? extractJSON(mm[0]) : null; })());
        if (!Array.isArray(arr)) throw new Error('大纲提炼失败，请重试');
        const pts = arr.filter(x => x && x.title).slice(0, 12).map(x => ({
          title: String(x.title).slice(0, 60),
          branch: String(x.branch || '').slice(0, 12),
          summary: String(x.summary || '').slice(0, 120),
          key_points: strList(x.key_points || x.keyPoints).map(k => k.slice(0, 60)).slice(0, 4),
          steps: normSteps(x.steps)
        }));
        if (!pts.length) throw new Error('大纲提炼失败，请重试');
        const arc = normArc(data && !Array.isArray(data) ? data : null, pts);
        savePoints(t.id, pts);
        saveArc(t.id, arc);
        return sendJSON(res, 200, { points: pts, arc: arc, rounds: roundsOf(t.id) });
      }
    },
    /* 开一轮（同一知识点可再开新一轮；进行中的先归档，避免半截内容被覆盖） */
    {
      method: 'POST',
      pattern: /^\/api\/tutorials\/(\d+)\/restate\/round$/,
      handler: async (req, res, u, ctx) => {
        const m = u.pathname.match(/^\/api\/tutorials\/(\d+)\/restate\/round$/);
        if (!m || req.method !== 'POST') return false;
        const t = tutOf(m[1]);
        if (!t) return sendJSON(res, 404, { error: '教程不存在' });
        const body = await readBody(req).catch(() => ({}));
        const idx = Number((body && body.point_idx) || 0);
        const pts = pointsOf(t.id);
        const point = pts[idx];
        if (!point) return sendJSON(res, 400, { error: '知识点不存在，先提炼大纲' });
        const now = nowISO();
        const fresh = !!(body && body.fresh);
        // 同一知识点已有进行中的轮次 → 直接续接，把对话原样带回来。
        // （以前这里无条件把所有 active 轮次归档，导致"换个知识点再回来"，
        //   上一个点的对话被归档、新开一轮空的，看起来像记录丢了。）
        if (!fresh) {
          const ex = db.prepare("SELECT * FROM restate_rounds WHERE tutorial_id = ? AND point_idx = ? AND status = 'active' ORDER BY id DESC LIMIT 1")
            .get(t.id, idx);
          if (ex) return sendJSON(res, 200, { round: ex, point, turns: turnsOf(ex.id), resumed: true });
        }
        // 只归档「同一个知识点」的旧轮次，不动别的知识点
        db.prepare("UPDATE restate_rounds SET status = 'archived', updated_at = ? WHERE tutorial_id = ? AND point_idx = ? AND status = 'active'")
          .run(now, t.id, idx);
        const info = db.prepare('INSERT INTO restate_rounds (tutorial_id, node_id, goal_id, point_idx, point_title, status, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?)')
          .run(t.id, Number((body && body.node_id) || 0) || (t.node_id || 0), Number((body && body.goal_id) || 0) || (t.goal_id || 0),
            idx, String(point.title || '').slice(0, 60), 'active', now, now);
        const rid = Number(info.lastInsertRowid);
        return sendJSON(res, 200, { round: db.prepare('SELECT * FROM restate_rounds WHERE id = ?').get(rid), point, turns: [], resumed: false });
      }
    },
    /* 读一轮（含全部对话） */
    {
      method: 'GET',
      pattern: /^\/api\/restate-round\/(\d+)$/,
      handler: async (req, res, u, ctx) => {
        const m = u.pathname.match(/^\/api\/restate-round\/(\d+)$/);
        if (!m || req.method !== 'GET') return false;
        const r = db.prepare('SELECT * FROM restate_rounds WHERE id = ?').get(Number(m[1]));
        if (!r) return sendJSON(res, 404, { error: '轮次不存在' });
        const pts = pointsOf(r.tutorial_id);
        return sendJSON(res, 200, { round: r, point: pts[r.point_idx] || { title: r.point_title }, turns: turnsOf(r.id) });
      }
    },
    /* 移动阶梯：next 下一级 / prev 回退一级 / skip 跳过本级（都只是改指针，不调 AI） */
    {
      method: 'POST',
      pattern: /^\/api\/restate-round\/(\d+)\/step$/,
      handler: async (req, res, u, ctx) => {
        const m = u.pathname.match(/^\/api\/restate-round\/(\d+)\/step$/);
        if (!m || req.method !== 'POST') return false;
        const r = db.prepare('SELECT * FROM restate_rounds WHERE id = ?').get(Number(m[1]));
        if (!r) return sendJSON(res, 404, { error: '轮次不存在' });
        const body = await readBody(req).catch(() => ({}));
        const pts = pointsOf(r.tutorial_id);
        const point = pts[r.point_idx] || { title: r.point_title, steps: [] };
        const steps = (point.steps && point.steps.length) ? point.steps : STEP_FALLBACK;
        const cur0 = Math.max(0, Math.min(Number(r.step_idx || 0), steps.length - 1));
        const act = String((body && body.action) || 'next');
        let to = cur0;
        if (act === 'prev') to = cur0 - 1;
        else if (act === 'skip') to = cur0 + 1;
        else to = cur0 + 1;   // next
        to = Math.max(0, Math.min(to, steps.length - 1));
        const now = nowISO();
        db.prepare('UPDATE restate_rounds SET step_idx = ?, updated_at = ? WHERE id = ?').run(to, now, r.id);
        return sendJSON(res, 200, { round: db.prepare('SELECT * FROM restate_rounds WHERE id = ?').get(r.id), step_idx: to });
      }
    },
    /* 用户说一轮 → AI 判「当前这一级」到不到位 + 只追问最关键的一个缺口 */
    {
      method: 'POST',
      pattern: /^\/api\/restate-round\/(\d+)\/turn$/,
      handler: async (req, res, u, ctx) => {
        const m = u.pathname.match(/^\/api\/restate-round\/(\d+)\/turn$/);
        if (!m || req.method !== 'POST') return false;
        const r = db.prepare('SELECT * FROM restate_rounds WHERE id = ?').get(Number(m[1]));
        if (!r) return sendJSON(res, 404, { error: '轮次不存在' });
        const body = await readBody(req).catch(() => ({}));
        const userText = String((body && body.text) || '').trim().slice(0, 1000);
        if (!userText) return sendJSON(res, 400, { error: '先写下你的理解' });
        const pts = pointsOf(r.tutorial_id);
        const point = pts[r.point_idx] || { title: r.point_title, key_points: [] };
        const steps = (point.steps && point.steps.length) ? point.steps : STEP_FALLBACK;
        const stepIdx = Math.max(0, Math.min(Number(r.step_idx || 0), steps.length - 1));
        const step = steps[stepIdx];
        const prev = turnsOf(r.id);
        const history = prev.filter(x => x.user_text).map(x => x.user_text);
        const txt = await aiJob({
          title: '判断这一级讲到位没 · ' + String(step.t || ('第' + (stepIdx + 1) + '级')),
          note: String(point.title || '').slice(0, 80),
          goalId: Number(r.goal_id || 0),
          message: 'AI 正在读你这段话，判断「' + String(step.t || ('第' + (stepIdx + 1) + '级')) + '」到位没有',
          run: signal => aiText(buildTurnPrompt(tutOf(r.tutorial_id) || { title: '', content: '' }, point, step, stepIdx, steps.length, history, userText, arcOf(r.tutorial_id)), currentModel(), 60000, null, signal)
        });
        const v = extractJSON(txt) || {};
        const verdict = {
          step_idx: stepIdx, step_t: String(step.t || ''),
          ok: !!v.ok, hit: strList(v.hit), missed: strList(v.missed), wrong: normWrong(v.wrong),
          probe: String(v.probe || '').slice(0, 200), scaffold: String(v.scaffold || '').slice(0, 200),
          ai_text: String(v.ai_text || '').slice(0, 800)
        };
        if (!verdict.ai_text) verdict.ai_text = verdict.probe || '我看看你这段话……';
        const now = nowISO();
        const ins = db.prepare('INSERT INTO restate_turns (round_id, seq, user_text, ai_text, verdict, created_at) VALUES (?,?,?,?,?,?)')
          .run(r.id, prev.length + 1, userText, verdict.ai_text, JSON.stringify(verdict), now);
        db.prepare('UPDATE restate_rounds SET turns = ?, updated_at = ? WHERE id = ?').run(prev.length + 1, now, r.id);
        return sendJSON(res, 200, {
          turn: db.prepare('SELECT * FROM restate_turns WHERE id = ?').get(Number(ins.lastInsertRowid)),
          step_idx: stepIdx, step_total: steps.length
        });
      }
    },
    /* 收尾：生成「我的话」+ 缺口对照（不强制，用户随时可以主动收尾） */
    {
      method: 'POST',
      pattern: /^\/api\/restate-round\/(\d+)\/finish$/,
      handler: async (req, res, u, ctx) => {
        const m = u.pathname.match(/^\/api\/restate-round\/(\d+)\/finish$/);
        if (!m || req.method !== 'POST') return false;
        const r = db.prepare('SELECT * FROM restate_rounds WHERE id = ?').get(Number(m[1]));
        if (!r) return sendJSON(res, 404, { error: '轮次不存在' });
        const prev = turnsOf(r.id);
        const history = prev.filter(x => x.user_text).map(x => x.user_text);
        if (!history.length) return sendJSON(res, 400, { error: '至少先说一轮再收尾' });
        const pts = pointsOf(r.tutorial_id);
        const point = pts[r.point_idx] || { title: r.point_title, key_points: [] };
        const txt = await aiJob({
          title: '生成「我的话」对照',
          note: String(point.title || '').slice(0, 80),
          goalId: Number(r.goal_id || 0),
          message: 'AI 正在把你逐级说的话整理成一版，并对照原文找差距',
          run: signal => aiText(buildFinishPrompt(tutOf(r.tutorial_id) || { title: '', content: '' }, point, history), currentModel(), 60000, null, signal)
        });
        const d = extractJSON(txt) || {};
        const mine = String(d.mine || '').slice(0, 1200);
        const gaps = (Array.isArray(d.gaps) ? d.gaps : []).map(g => ({
          key: String((g && g.key) || '').slice(0, 80), why: String((g && g.why) || '').slice(0, 160)
        })).filter(g => g.key).slice(0, 5);
        const line = String(d.line || '').slice(0, 160);
        const now = nowISO();
        db.prepare("UPDATE restate_rounds SET status = 'done', mine = ?, gaps = ?, line = ?, updated_at = ? WHERE id = ?")
          .run(mine, JSON.stringify(gaps), line, now, r.id);
        return sendJSON(res, 200, { round: db.prepare('SELECT * FROM restate_rounds WHERE id = ?').get(r.id) });
      }
    },
    /* 自由追问：不计入轮次进度 */
    {
      method: 'POST',
      pattern: /^\/api\/restate-round\/(\d+)\/chat$/,
      handler: async (req, res, u, ctx) => {
        const m = u.pathname.match(/^\/api\/restate-round\/(\d+)\/chat$/);
        if (!m || req.method !== 'POST') return false;
        const r = db.prepare('SELECT * FROM restate_rounds WHERE id = ?').get(Number(m[1]));
        if (!r) return sendJSON(res, 404, { error: '轮次不存在' });
        const body = await readBody(req).catch(() => ({}));
        const text = String((body && body.text) || '').trim().slice(0, 500);
        if (!text) return sendJSON(res, 400, { error: '先写下你的问题' });
        const pts = pointsOf(r.tutorial_id);
        const point = pts[r.point_idx] || { title: r.point_title, key_points: [] };
        const steps = (point.steps && point.steps.length) ? point.steps : STEP_FALLBACK;
        const stepIdx = Math.max(0, Math.min(Number(r.step_idx || 0), steps.length - 1));
        const history = turnsOf(r.id).filter(x => x.user_text).map(x => x.user_text);
        let reply = await aiText(buildChatPrompt(tutOf(r.tutorial_id) || { title: '', content: '' }, point, steps[stepIdx], history, text), currentModel(), 60000);
        reply = String(reply || '').trim().slice(0, 1500) || '这个我暂时答不上来，换个问法试试？';
        const prev = turnsOf(r.id);
        const now = nowISO();
        const ins = db.prepare('INSERT INTO restate_turns (round_id, seq, user_text, ai_text, verdict, created_at) VALUES (?,?,?,?,?,?)')
          .run(r.id, prev.length + 1, text, reply, JSON.stringify({ kind: 'chat' }), now);
        return sendJSON(res, 200, { turn: db.prepare('SELECT * FROM restate_turns WHERE id = ?').get(Number(ins.lastInsertRowid)) });
      }
    },
    /* 收官：把各点的「我的话」按架构主线串成一篇整体叙述 */
    {
      method: 'POST',
      pattern: /^\/api\/tutorials\/(\d+)\/restate\/weave$/,
      handler: async (req, res, u, ctx) => {
        const m = u.pathname.match(/^\/api\/tutorials\/(\d+)\/restate\/weave$/);
        if (!m || req.method !== 'POST') return false;
        const t = tutOf(m[1]);
        if (!t) return sendJSON(res, 404, { error: '教程不存在' });
        const rows = db.prepare("SELECT * FROM restate_rounds WHERE tutorial_id = ? AND status = 'done' AND mine <> '' ORDER BY point_idx, id").all(t.id);
        // 同一知识点有多版时只取最新一版，避免重复素材
        const seen = new Set();
        const done = [];
        for (let i = rows.length - 1; i >= 0; i--) {
          const r = rows[i];
          if (seen.has(r.point_idx)) continue;
          seen.add(r.point_idx);
          done.unshift({ title: r.point_title, mine: r.mine });
        }
        if (!done.length) return sendJSON(res, 400, { error: '还没有沉淀，先把至少一个点走完并收尾' });
        const txt = await aiJob({
          title: '串起整篇知识架构',
          note: String(t.title || '').slice(0, 80),
          goalId: Number(t.goal_id || 0),
          message: 'AI 正在把你各点说过的话，按主线串成一篇整体叙述',
          run: signal => aiText(buildWeavePrompt(t, arcOf(t.id), done), currentModel(), 90000, null, signal)
        });
        const d = extractJSON(txt) || {};
        const weave = {
          narrative: String(d.narrative || '').slice(0, 4000),
          links: (Array.isArray(d.links) ? d.links : []).map(x => ({
            a: String((x && x.a) || '').slice(0, 80), b: String((x && x.b) || '').slice(0, 80),
            how: String((x && x.how) || '').slice(0, 200)
          })).filter(x => x.a && x.b).slice(0, 6),
          missing: strList(d.missing).slice(0, 6),
          at: nowISO()
        };
        // 串联结果挂在 arc.weave 上（arcOf 是原样 JSON.parse，不会丢字段）
        const arc = arcOf(t.id) || {};
        arc.weave = weave;
        saveArc(t.id, arc);
        return sendJSON(res, 200, { weave: weave, used: done.length });
      }
    },
    /* 读串联结果 */
    {
      method: 'GET',
      pattern: /^\/api\/tutorials\/(\d+)\/restate\/weave$/,
      handler: async (req, res, u, ctx) => {
        const m = u.pathname.match(/^\/api\/tutorials\/(\d+)\/restate\/weave$/);
        if (!m || req.method !== 'GET') return false;
        const a = arcOf(m[1]);
        return sendJSON(res, 200, { weave: (a && a.weave) || null });
      }
    },
    /* 「我的话」：本教程已沉淀的所有版本 */
    {
      method: 'GET',
      pattern: /^\/api\/tutorials\/(\d+)\/restate\/notes$/,
      handler: async (req, res, u, ctx) => {
        const m = u.pathname.match(/^\/api\/tutorials\/(\d+)\/restate\/notes$/);
        if (!m || req.method !== 'GET') return false;
        const rows = db.prepare("SELECT * FROM restate_rounds WHERE tutorial_id = ? AND status = 'done' AND mine <> '' ORDER BY id DESC").all(Number(m[1]));
        for (const r of rows) { try { r.gaps = JSON.parse(r.gaps || '[]'); } catch (e) { r.gaps = []; } }
        return sendJSON(res, 200, { notes: rows });
      }
    }
  ]
};
