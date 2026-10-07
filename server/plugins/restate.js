/**
 * 思而行 · 插件：用自己的话（把教程知识点内化成用户自己的语言）
 * ------------------------------------------------------------------
 * 和随堂测验的区别：测验考「你记住了吗」，这个组件解决「我记得但说不出来」。
 *
 * 设计对齐「🧭 AI 引导提炼思路」（每日刷题里的那道题）：**不按剧本问，而是让 AI 读用户
 * 已经讲过的话，自己判断还缺哪一块，然后只补那一块。**
 *   · 每个知识点带一份「覆盖清单」（dims）—— 提炼大纲时由 AI 照着这个知识点的实质内容
 *     生成（3-6 条），不是写死的四级阶梯；
 *   · 用户每次答完，AI 判断哪些维度已经讲到（hit），**跳过**用户已讲清的，只挑**最关键的
 *     那一个**缺口追问；实在讲不下去就换一个更小的切口问；
 *   · 核心维度都覆盖到了之后进入「打磨」状态：不再补清单，改问能把他的表述变得更扎实的问题；
 *   · 卡住可以点「提示」，只给方向不给答案。
 *
 * 一切都由用户说了算：可反复答、可追问、可跳过、可随时收尾，没有倒计时也不自动推进。
 * 走完收尾：输出「你的版本 vs 原文要点」对照 → 沉淀成「我的话」。
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
/* 引导模式（1.10.15 起）：AI 自己判断掌握情况、自己挑下一个问什么，不再按固定阶梯走。
   hit     = 已覆盖的维度 key（JSON 数组，跨轮累积）
   focus   = AI 上一轮选中的关注维度（或 refine）
   pending = 当前正等着用户回答的那一问（还没配对成一轮，所以单独存一份） */
CREATE TABLE IF NOT EXISTS restate_coach (
  round_id INTEGER PRIMARY KEY,
  hit TEXT NOT NULL DEFAULT '[]',
  focus TEXT NOT NULL DEFAULT '',
  pending TEXT NOT NULL DEFAULT '',
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
/* ---------- 引导模式状态（hit / focus / pending） ----------
   和每日刷题的「AI 引导提炼思路」同一套机制：维度不是顺序剧本，是「值得覆盖到」的检查表；
   AI 每轮读用户已经讲过的话，标出 hit、挑一个 focus 追问。 */
function coachOf(rid) {
  const r = db.prepare('SELECT * FROM restate_coach WHERE round_id = ?').get(Number(rid));
  if (!r) return { hit: [], focus: '', pending: null };
  let hit = [];
  try { const a = JSON.parse(r.hit || '[]'); hit = Array.isArray(a) ? a.map(String) : []; } catch (e) { hit = []; }
  let pending = null;
  if (String(r.pending || '').trim()) { try { pending = JSON.parse(r.pending); } catch (e) { pending = null; } }
  return { hit, focus: String(r.focus || ''), pending: (pending && typeof pending === 'object') ? pending : null };
}
function saveCoach(rid, st) {
  const now = nowISO();
  db.prepare('INSERT INTO restate_coach (round_id, hit, focus, pending, created_at, updated_at) VALUES (?,?,?,?,?,?) ON CONFLICT(round_id) DO UPDATE SET hit = excluded.hit, focus = excluded.focus, pending = excluded.pending, updated_at = excluded.updated_at')
    .run(Number(rid), JSON.stringify((st && st.hit) || []), String((st && st.focus) || ''), (st && st.pending) ? JSON.stringify(st.pending) : '', now, now);
}
function stripHtml(html) {
  return String(html || '').replace(/<[^>]+>/g, ' ').replace(/&nbsp;/g, ' ').replace(/\s+/g, ' ').trim();
}

/* ---------- 提示词 ---------- */

/* ---- 阶梯（老机制，保留用于兼容历史数据）----
   1.10.15 起新会话走「引导模式」（COVER_DIMS 覆盖清单 + AI 自己挑 focus），
   这里的四段只服务已经存在的 restate_points（老库里 points 已经带了 steps）。 */
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
  return out;
}
/* 兜底阶梯：老 points 没有 steps 时仍要能走（历史数据兼容） */
const STEPS_FALLBACK = () => STEP_FALLBACK.slice();

/* ===== 引导模式的覆盖维度 =====
   刻意**不写死**「缘起→轮廓→关键→串讲」这种顺序剧本：知识点五花八门（概念、命令、
   架构、公式），统一剧本必然问些无关的问题。做法与每日刷题的「引导提炼思路」一致：
   维度是「值得覆盖到」的检查表，AI 每轮读用户已经讲过的话，**只补真正还缺的那一块**。
   下面这套是通用底座（提炼大纲时还会照着每个知识点的实质内容再生成/裁剪）。 */
const COVER_DIMS = [
  { key: 'why', name: '为什么需要它', ask: '在遇到它之前这件事怎么做的？卡在哪？它解决了什么麻烦', probe: '他想不到动机，就具体问「没有它的时候你会怎么做、哪一步最别扭」' },
  { key: 'gist', name: '它到底在做什么', ask: '用一句粗话概括它在做的事（别抠细节）', probe: '他讲得太散，就让他压成一句话，越短越好' },
  { key: 'how', name: '关键机制/怎么做到的', ask: '它靠哪条关键机制成立的，过程大致怎么走', probe: '只会说名字说不出理由，问他「换成另一个做法会在哪一点不行」' },
  { key: 'cond', name: '前提与边界', ask: '什么条件下才成立、什么输入下会失效、最容易误解的是哪一点', probe: '给一个具体小例子让他自己判断会不会出问题' },
  { key: 'contrast', name: '跟什么不一样', ask: '跟最接近的那个东西/做法比，差别到底在哪', probe: '他没想过对比，就问「如果用你熟悉的那个做法代替，会差在哪」' },
  { key: 'link', name: '和上下文怎么连起来', ask: '它在整篇/整门知识里处于什么位置，前后跟什么接得上', probe: '他完全没框架，就先问「它属于哪一类问题」，再问跟同类的还有什么' },
  { key: 'use', name: '什么时候会真的用到', ask: '什么场景下你会想起它、拿它做什么', probe: '只想得到考试答案，就反问「写代码时哪个地方你会想起这段」' }
];
/* 覆盖齐了之后不是结束，而是改问能让表述更扎实的东西（对应刷题那边的 refine） */
const REFINE_ASKS = [
  '把他这一大段压缩成 3 步有序步骤（让他自己拆，不要替他拆）',
  '指出他描述里最含糊的一个词，问清那个词到底指什么',
  '问他这段表述在什么情况下会误导别人，然后让他改那句话',
  '问他「如果只允许说一句」，他会留哪一句，凭什么留它',
  '让他用自己的话给出一个能验证对错的具体例子',
  '问他刚才说的哪一步最没把握，为什么没把握'
];
/* 维度清单兜底：AI 提炼时没给 dims（或老 points 没这字段）就用这套通用底座 */
function normDims(v, point) {
  const a = Array.isArray(v) ? v : [];
  const out = [];
  for (const d of a.slice(0, 7)) {
    if (!d) continue;
    const name = String((d.name != null ? d.name : d.t) || '').trim();
    if (!name) continue;
    out.push({
      key: String(d.key || ('k' + out.length)).slice(0, 20),
      name: name.slice(0, 14),
      ask: String(d.ask || d.q || '').slice(0, 200),
      probe: String(d.probe || d.hint || '').slice(0, 200)
    });
  }
  if (out.length >= 3) return out;
  /* 老 points 没 dims：用通用底座，但把 summary 当成「gist」的 ask，别的照旧 */
  return COVER_DIMS.map(d => ({
    key: d.key, name: d.name, ask: d.ask, probe: d.probe
  }));
}
const dimsOf = p => (p && Array.isArray(p.dims) && p.dims.length) ? p.dims : normDims(null, p);
const dimOfKey = (dims, k) => (dims || []).find(d => d.key === k) || null;
const DIM_KEYS_FALLBACK = COVER_DIMS.map(d => d.key);

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
    '2. key_points：2-4 条「用户用自己的话讲出来时必须覆盖的要点」，每条 30 字内。',
    '   写「实质内容」而不是「原句」——它是我们判断用户漏讲了什么的依据。',
    '3. dims：**覆盖清单**，3-6 条，照着这个知识点的**实质内容**来定，不要套模板。',
    '   每条含：key（短标识，如 why/gist/mech/edge，同一份里唯一）、',
    '   name（≤6 字短名，如「为什么需要它」）、ask（这一条到底要用户讲清什么）、',
    '   probe（用户答不上来时改问的更小切口）。',
    '   · 清单是**检查表不是顺序剧本**：AI 会读用户已讲的话、跳过已覆盖的，只补缺的那一块。',
    '   · 所以每条都要是这个知识点特有、真讲不出来就说明没懂的东西。',
    '   · 讲某个 API：可以是「解决什么问题」「参数怎么对应」「什么时候不能这么做」；',
    '     讲某个概念：可以是「和相邻概念的区别」「失效边界」「直觉类比」。',
    '4. 点与点尽量不重叠，不要拆太碎。',
    '',
    '【输出格式：只输出一个 JSON 对象，不要任何解释文字】',
    '{"thesis":"...","spine":["...","..."],"branches":[{"id":"b0","name":"...","gist":"..."}],'
    + '"points":[{"title":"...","branch":"b0","summary":"...","key_points":["...","..."],'
    + '"dims":[{"key":"why","name":"...","ask":"...","probe":"..."}]}]}',
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
/* ===== 引导模式：让 AI 自己判断掌握情况、自己挑下一个问什么 =====
   和每日刷题的「🧭 AI 引导提炼思路」同一套机制，用户明确要求对齐它。
   关键差别（相对老的固定四级阶梯）：维度清单是**检查表不是剧本**，
   AI 每轮先读用户已经讲过的话，把讲到的标进 hit，跳过已覆盖的，只补最关键的那一块。 */
function buildCoachPrompt(tut, point, dims, history, userText, arc, hitSoFar, hintMode) {
  const L = [];
  L.push('你是一位耐心的学习教练。用户正在把一个知识点**用自己的话讲出来**——他看得懂，但说不出来，这正是最常见的假掌握。');
  L.push('');
  L.push('【最重要：不要按清单顺序从头问】');
  L.push('下面给的是一份「值得覆盖到」的检查表，**不是剧本**。你必须先读他刚说的话，自己判断：');
  L.push('- 他已经讲到的维度，**跳过，不要再问一遍**（这是最招人烦的错：用户明明已经讲清楚了，你还逼他重说）；');
  L.push('- 只补他**真正还没说清的那一个**维度；');
  L.push('- 如果覆盖清单基本都到了（他核心已经讲成型），focus 填 "refine"，改问能把他的表述变得更扎实的东西（见下面的打磨清单）；');
  L.push('- 如果他的表述有明显错误或含糊到会影响理解，先纠这一处，别急着往下走。');
  L.push('');
  L.push('【知识点】' + String(point.title || ''));
  L.push('【它讲的是什么】' + String(point.summary || ''));
  if ((point.key_points || []).length) {
    L.push('【最终要覆盖的要点（此刻只用来判断"有没有讲错"，不要一次性全倒给他）】');
    for (const k of point.key_points) L.push('- ' + String(k));
  }
  if (arc && (arc.thesis || (arc.spine || []).length)) {
    L.push('');
    L.push('【整篇教程的知识架构（判断时心里有数：他在图上哪个位置，别孤立评价）】');
    if (arc.thesis) L.push('核心主张：' + String(arc.thesis).slice(0, 200));
    if ((arc.spine || []).length) {
      L.push('主线推进：');
      arc.spine.forEach((x, i) => L.push('  ' + (i + 1) + '. ' + String(x).slice(0, 120)));
    }
  }
  L.push('');
  if (hitSoFar && hitSoFar.length) {
    L.push('【前面几轮他已经讲到的维度（这些不要再问）】' + hitSoFar.map(k => {
      const d = dimOfKey(dims, k); return d ? d.name : k;
    }).join('、'));
  }
  if (history && history.length) {
    L.push('');
    L.push('【他前面说过的话（判断已覆盖到哪些维度时用）】');
    for (const h of history.slice(-6)) L.push('- ' + String(h).slice(0, 220));
  }
  if (userText) {
    L.push('');
    L.push('【他这一轮的表述】');
    L.push(String(userText).slice(0, 1000));
  } else {
    L.push('');
    L.push('【他还没开口】这是第一次提问，问最该先弄清的那一条。');
  }
  L.push('');
  if (hintMode) {
    L.push('【这一轮是「提示」】他卡住了。给他一个**提示**：先复述他卡在哪，再用一句更小的话把方向指出来，让他自己走完那一步。');
    L.push('绝对不能出现完整答案、代码或伪码。');
    L.push('');
    L.push('只输出一个 JSON 对象：{"read":"一句话点出他卡在哪","hit":[],"focus":"refine","say":"一句安抚 + 提示","probe":"一个提示（1~2 句）","done":false}');
    return L.join('\n');
  }
  L.push('【别的硬规矩】');
  L.push('1. hit 只填你**确实在他这段话里听到了**的维度，别因为他提到了就乐观给分。');
  L.push('2. 绝对不给答案、不给代码、不给伪码。他说「别引导了直接告诉我」才破例，而且只讲概念不给代码。');
  L.push('3. 他说「不会 / 不知道 / 卡住」时，不要重复原问题、不要给答案，换到该维度的 probe 里那个更小的切口。');
  L.push('4. probe 要具体到能一句话回答。不要列编号、不要一次抛好几个问题、不要给选项。');
  L.push('5. say 用平实的话肯定他刚才**说的那一个具体点**，不要空泛夸（「很好」是废话）。');
  L.push('6. 若他已经把剩下的维度都覆盖到了，done 填 true。');
  L.push('7. 语气平实，别用「太棒了」「完美」这类空话。');
  L.push('8. 涉及代码一律用 ``` 围栏包裹（注明语言）。');
  L.push('');
  L.push('【输出格式：只输出一个 JSON 对象，不要代码围栏、不要任何多余文字】');
  L.push('{"read":"一句话说他现在懂到哪了（40 字内）",');
  L.push(' "hit":["他已经讲到的维度 key"],');
  L.push(' "focus":"这一轮要补的那个维度 key，或 refine",');
  L.push(' "say":"两三句回应：先点出他讲对的具体那一点（顺带纠错就说错在哪），再自然地引出下面的问题",');
  L.push(' "probe":"你这一个问题（2~3 句）",');
  L.push(' "done":false}', '');
  L.push('【覆盖清单（key｜名称｜问到什么｜他答不上来时改问）】');
  L.push(dims.map(d => '- ' + d.key + '｜' + d.name + '｜' + (d.ask || '') + '｜' + (d.probe || '')).join('\n'));
  L.push('- refine｜把表述讲扎实｜覆盖清单基本都到了，从这些里挑一个最能让他的表述变扎实的：' + REFINE_ASKS.join('；'));
  return L.join('\n');
}
function normCoachTurn(j, dims) {
  const keys = (dims || []).map(d => d.key);
  const probe = String(j.probe || j.q || '').trim().slice(0, 900);
  const hit = (Array.isArray(j.hit) ? j.hit : []).map(String).filter(k => keys.includes(k));
  let focus = String(j.focus || '').trim();
  // 只认清单里的维度，模型编的名字一律当 refine（不能让它把用户带跑偏）
  if (focus !== 'refine' && !keys.includes(focus)) focus = 'refine';
  return {
    read: String(j.read || '').trim().slice(0, 200),
    hit,
    focus,
    say: String(j.say || '').trim().slice(0, 600),
    probe,
    done: !!j.done
  };
}
/** 让 AI 出一轮引导。模型不听话就重试一次，仍不行退回纯文本（至少能显示成一句话）。 */
async function coachTurn(basePrompt, dims, timeoutMs, signal) {
  let raw = '';
  const ask = async (extra) => {
    const r = await aiText(basePrompt + (extra || ''), (currentModel && currentModel()) || '', timeoutMs || 120000, null, signal);
    raw = String(r == null ? '' : r).trim();
    return raw;
  };
  try {
    await ask('');
    const j = extractJSON(raw);
    if (j && String(j.probe || j.q || '').trim()) return normCoachTurn(j, dims);
  } catch (e) { raw = raw || ('ERR ' + (e.message || e)); }
  /* 模型没给 JSON：再试一次，并把它的原话怼回去让它自己改格式 */
  try {
    await ask('\n\n【注意】你上一次的输出不是合法 JSON，只输出 {"read":"…","hit":[…],"focus":"…","say":"…","probe":"…","done":false} 这个对象本身。');
    const j2 = extractJSON(raw);
    if (j2 && String(j2.probe || j2.q || '').trim()) return normCoachTurn(j2, dims);
  } catch (e) { /* 两次都不听话就用第一次的原话 */ }
  const plain = String(raw || '').replace(/^```[a-z]*\s*/i, '').replace(/```$/, '').trim();
  if (!plain) throw new Error('AI 没有给出问题，换个模型再试');
  return { read: '', hit: [], focus: 'refine', say: '', probe: plain.slice(0, 800), done: false, raw: true };
}


/* 引导模式的核心：跑一轮 AI，存 hit/focus/pending。
   hint=true 时只给方向（不消耗 pending 的那一问，也不推进 hit）。 */
async function coachTurnOnce(r, point, dims, st, history, userText, hint) {
  const base = buildCoachPrompt(tutOf(r.tutorial_id) || { title: '', content: '' }, point, dims, history, userText, arcOf(r.tutorial_id), st.hit, hint);
  const focusName = (() => { const d = dimOfKey(dims, st.focus); return d ? d.name : '打磨'; })();
  const turn = await aiJob({
    title: (hint ? '给个提示 · ' : '接着引导 · ') + String(point.title || '').slice(0, 24),
    note: String(point.title || '').slice(0, 80),
    goalId: Number(r.goal_id || 0),
    nodeId: Number(r.node_id || 0),
    message: hint ? 'AI 正在把方向指出来（不给答案）'
      : 'AI 正在读你说的话，判断还缺哪一块（当前关注「' + focusName + '」）',
    run: signal => coachTurn(base, dims, 90000, signal)
  });
  const now = nowISO();
  /* hint 那一轮不进 turns（它是插在当前问题上的提示，不是新一轮问答），
     但要让用户看得到 → 存成 kind='hint' 的一轮，ai_text 就是提示本身。 */
  const ver = {
    kind: hint ? 'hint' : 'ask',
    read: turn.read, hit: turn.hit, focus: turn.focus,
    say: turn.say, probe: turn.probe, missed: [], wrong: [], scaffold: '',
    ok: false, ai_text: [turn.say, turn.probe].filter(Boolean).join('\n\n') || '……'
  };
  const prev = turnsOf(r.id);
  const ins = db.prepare('INSERT INTO restate_turns (round_id, seq, user_text, ai_text, verdict, created_at) VALUES (?,?,?,?,?,?)')
    .run(r.id, prev.length + 1, hint ? '' : (userText || ''), ver.ai_text, JSON.stringify(ver), now);
  if (!hint) db.prepare('UPDATE restate_rounds SET turns = ?, updated_at = ? WHERE id = ?').run(prev.length + 1, now, r.id);
  st.focus = turn.focus;
  if (!hint) {
    st.hit = [...new Set(st.hit.concat(turn.hit || []))];
    st.pending = { read: turn.read, hit: turn.hit, focus: turn.focus, say: turn.say, probe: turn.probe, done: turn.done };
  } else {
    /* 提示挂在当前那一问下面，不改 pending */
    if (st.pending) st.pending.hint = { say: turn.say, probe: turn.probe };
  }
  saveCoach(r.id, st);
  return { insertId: ins.lastInsertRowid };
}

/* 收尾：把用户逐级的表达整理成一版「我的话」，并对照原文讲清差异 */
function buildFinishPrompt(tut, point, history) {
  return [
    '你是学习教练。用户已经用自己的话讲过这个知识点（AI 判断过他的掌握情况、只补了他缺的那几块），现在做收尾对照。',
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
  desc: '把教程知识点用自己的话讲出来：AI 读你已经讲的，自己判断还缺哪一块、只补那一块（不给答案），最后沉淀成「我的话」',
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
      ctx.db.prepare(`DELETE FROM restate_coach WHERE round_id IN (${ph})`).run(...rs);
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
          message: 'AI 正在读教程，梳理整体架构并为每个知识点定覆盖清单',
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
          dims: normDims(x.dims, x),
          steps: normSteps(x.steps)     // 老字段留着只为兼容更早的数据
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
          if (ex) return sendJSON(res, 200, { round: ex, point, turns: turnsOf(ex.id), coach: (() => { const c = coachOf(ex.id); c.dims = dimsOf(point); return c; })(), resumed: true });
        }
        // 只归档「同一个知识点」的旧轮次，不动别的知识点
        db.prepare("UPDATE restate_rounds SET status = 'archived', updated_at = ? WHERE tutorial_id = ? AND point_idx = ? AND status = 'active'")
          .run(now, t.id, idx);
        const info = db.prepare('INSERT INTO restate_rounds (tutorial_id, node_id, goal_id, point_idx, point_title, status, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?)')
          .run(t.id, Number((body && body.node_id) || 0) || (t.node_id || 0), Number((body && body.goal_id) || 0) || (t.goal_id || 0),
            idx, String(point.title || '').slice(0, 60), 'active', now, now);
        const rid = Number(info.lastInsertRowid);
        return sendJSON(res, 200, {
          round: db.prepare('SELECT * FROM restate_rounds WHERE id = ?').get(rid),
          point, turns: [],
          coach: { hit: [], focus: '', pending: null, dims: dimsOf(point) },
          resumed: false
        });
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
        const point = pts[r.point_idx] || { title: r.point_title };
        return sendJSON(res, 200, {
          round: r,
          point,
          turns: turnsOf(r.id),
          coach: (() => { const c = coachOf(r.id); c.dims = dimsOf(point); return c; })()
        });
      }
    },
    /* 移动阶梯：next 下一级 / prev 回退一级 / skip 跳过本级（都只是改指针，不调 AI） */
    /* 用户说一轮 / 点提示 / 点「下一问」 → AI 自己判断掌握情况并挑下一个问题
       （对齐每日刷题的「🧭 AI 引导提炼思路」；老的固定四级阶梯已不再作为主流程）
       body: { text?: 他的表述, hint?: 只给方向, force?: 不带回答只要下一个问题 } */
    {
      method: 'POST',
      pattern: /^\/api\/restate-round\/(\d+)\/turn$/,
      handler: async (req, res, u, ctx) => {
        const m = u.pathname.match(/^\/api\/restate-round\/(\d+)\/turn$/);
        if (!m || req.method !== 'POST') return false;
        const r = db.prepare('SELECT * FROM restate_rounds WHERE id = ?').get(Number(m[1]));
        if (!r) return sendJSON(res, 404, { error: '轮次不存在' });
        const body = await readBody(req).catch(() => ({}));
        const userText = String((body && body.text) || '').trim().slice(0, 1200);
        const hint = !!(body && body.hint);
        const force = !!(body && body.force);
        const pts = pointsOf(r.tutorial_id);
        const point = pts[r.point_idx] || { title: r.point_title, key_points: [] };
        const dims = dimsOf(point);
        const st = coachOf(r.id);
        const prev = turnsOf(r.id);
        const history = prev.filter(x => x.user_text).map(x => x.user_text);
        /* 只有真的答了一句（或明确要提示/要下一问）才继续；否则 400，
           否则用户误触一次就会白白烧掉一次 AI 调用 */
        if (!userText && !hint && !force) return sendJSON(res, 400, { error: '先写下你的理解' });
        if (userText && st.pending) {
          /* 把「刚才那一问」和这个回答配成一轮：那一问问的时候还没人答，
             进不了 turns，所以先存在 pending 里（否则第一问会在页面上凭空消失）。 */
          const p0 = st.pending;
          const now = nowISO();
          const ver = {
            kind: 'coach',
            focus: String(p0.focus || ''), hit: Array.isArray(p0.hit) ? p0.hit : [],
            read: String(p0.read || ''), probe: String(p0.probe || ''), say: String(p0.say || ''),
            missed: strList(p0.missed), wrong: normWrong(p0.wrong), scaffold: String(p0.scaffold || ''),
            ok: false, ai_text: String(p0.ai_text || p0.say || p0.probe || '')
          };
          const ins = db.prepare('INSERT INTO restate_turns (round_id, seq, user_text, ai_text, verdict, created_at) VALUES (?,?,?,?,?,?)')
            .run(r.id, prev.length + 1, userText, ver.ai_text, JSON.stringify(ver), now);
          db.prepare('UPDATE restate_rounds SET turns = ?, updated_at = ? WHERE id = ?').run(prev.length + 1, now, r.id);
          st.pending = null;
          st.hit = [...new Set(st.hit.concat(Array.isArray(p0.hit) ? p0.hit : []))];
        }
        const turn = await coachTurnOnce(r, point, dims, st, history, userText, hint);
        return sendJSON(res, 200, {
          turn: turn && turn.insertId ? db.prepare('SELECT * FROM restate_turns WHERE id = ?').get(Number(turn.insertId)) : null,
          coach: { hit: st.hit, focus: st.focus, pending: st.pending, dims },
          dims,
          done: !!(st.pending && st.pending.done),
          turns: turnsOf(r.id)
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
        /* 引导模式下"当前这一级"是 AI 现挑的 focus，取不到时退回通用底座的第一条 */
        const st0 = coachOf(r.id);
        const dims0 = dimsOf(point);
        const focusDim = dimOfKey(dims0, st0.focus);
        const cur = focusDim || dims0[0] || COVER_DIMS[0];
        const history = turnsOf(r.id).filter(x => x.user_text).map(x => x.user_text);
        let reply = await aiText(buildChatPrompt(tutOf(r.tutorial_id) || { title: '', content: '' }, point, { t: cur.name, q: cur.ask }, history, text), currentModel(), 60000);
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
