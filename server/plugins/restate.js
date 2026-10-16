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
   单次 AI 调用拿不到真实的子进度，所以进度条交给统一模型（server/task-progress.js）：
   它按**已耗时渐近逼近**（永不假装完成），前端会把它标成"估算"并如实说明在做什么、已等多久；
   只有真正拿到并处理完结果才 100%。 */
function aiJob({ title, note, goalId, nodeId, message, run }) {
  const job = tasks.begin({ type: 'restate', title, note, goalId, nodeId, message });
  return Promise.resolve()
    .then(() => run(job.signal))
    .then(v => {
      /* 只换文案不动百分比：交给时间曲线继续爬，比冻在 98% 更像"还在跑" */
      job.progress(undefined, 'AI 已返回，正在校验结果…');
      job.done(v);
      return v;
    })
    .catch(e => {
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
  draft TEXT NOT NULL DEFAULT '',      /* 用户自己写的整理稿（内化的主体） */
  kept TEXT NOT NULL DEFAULT '[]',     /* AI 认定他真讲对了的地方 */
  title TEXT NOT NULL DEFAULT '',      /* 对话名。空 = 用创建时间当名字（用户可以改） */
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
  back TEXT NOT NULL DEFAULT '',        /* 解释完「接回自己那句话」，独立存一份（即使当时还没有 pending） */
  level INTEGER NOT NULL DEFAULT 0,      /* AI 眼里的整体掌握档位 0~3 */
  verdict TEXT NOT NULL DEFAULT '',      /* 一句话整体判断 */
  weak TEXT NOT NULL DEFAULT '',         /* 当前最薄弱的那一处 */
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
/* 轮次里的 JSON 列统一解析成数组（gaps/kept）—— 前端不该拿到"[{...}]"这种字符串去 .length */
function parseJSONList(v) {
  try { const a = JSON.parse(String(v || '[]')); return Array.isArray(a) ? a : []; } catch (e) { return []; }
}
function roundOut(r) {
  if (!r) return r;
  r.gaps = parseJSONList(r.gaps);
  r.kept = parseJSONList(r.kept);
  return r;
}
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
/* 读知识点时**在源头把 dims 补齐**：老数据没有 dims（或者只有旧的 steps）。
   补在这里，服务端挑 focus 用的、接口返回给前端的、前端画覆盖清单用的就是同一份 ——
   两边各算一份的话，服务端挑到清单里没有的维度时，界面会出现光秃秃的「AI 关注「link」」，
   而且 ✓ 永远凑不齐。 */
function pointsOf(tid) {
  const r = db.prepare('SELECT points FROM restate_points WHERE tutorial_id = ?').get(Number(tid));
  if (!r) return [];
  let arr = [];
  try { const a = JSON.parse(r.points || '[]'); arr = Array.isArray(a) ? a : []; } catch (e) { arr = []; }
  return arr.map(p => (p && Array.isArray(p.dims) && p.dims.length >= 3)
    ? p
    : Object.assign({}, p, { dims: normDims(p && p.dims, p) }));
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
  if (!r) return { hit: [], focus: '', pending: null, level: 0, verdict: '', weak: '' };
  let hit = [];
  try { const a = JSON.parse(r.hit || '[]'); hit = Array.isArray(a) ? a.map(String) : []; } catch (e) { hit = []; }
  let pending = null;
  if (String(r.pending || '').trim()) { try { pending = JSON.parse(r.pending); } catch (e) { pending = null; } }
  return {
    hit, focus: String(r.focus || ''), pending: (pending && typeof pending === 'object') ? pending : null,
    level: Math.max(0, Math.min(3, Number(r.level || 0))),
    verdict: String(r.verdict || ''), weak: String(r.weak || ''),
    back: String(r.back || '')
  };
}
function saveCoach(rid, st) {
  /* 对话已被删掉就别写了（同上：没有外键，会变成幽灵行） */
  if (!db.prepare('SELECT 1 FROM restate_rounds WHERE id = ?').get(Number(rid))) return;
  const now = nowISO();
  db.prepare('INSERT INTO restate_coach (round_id, hit, focus, pending, back, level, verdict, weak, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?,?) ON CONFLICT(round_id) DO UPDATE SET hit = excluded.hit, focus = excluded.focus, pending = excluded.pending, back = excluded.back, level = excluded.level, verdict = excluded.verdict, weak = excluded.weak, updated_at = excluded.updated_at')
    .run(Number(rid), JSON.stringify((st && st.hit) || []), String((st && st.focus) || ''),
      (st && st.pending) ? JSON.stringify(st.pending) : '', String((st && st.back) || ''),
      Math.max(0, Math.min(3, Number((st && st.level) || 0))), String((st && st.verdict) || ''), String((st && st.weak) || ''), now, now);
}
function stripHtml(html) {
  return String(html || '').replace(/<[^>]+>/g, ' ').replace(/&nbsp;/g, ' ').replace(/\s+/g, ' ').trim();
}

/* ---------- 提示词 ---------- */

/* ---- 阶梯（老机制，保留用于兼容历史数据）----
   1.10.16 起在同一条线上补了三件事：AI 每轮给整体掌握判断（level/verdict/weak）、
   解释完把用户接回自己的话（back）、收尾改成用户先自己写整理稿再由 AI 对照（draft/kept）。
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
  /* 老 points 只有 steps（缘起/轮廓/关键/串讲）→ 就映射成这一套，**别退到通用底座**：
     退到底座会让服务端挑的 focus（比如 link）在前端那份清单里根本不存在，
     界面上就会出现光秃秃的「AI 关注「link」」，而且 ✓ 永远凑不齐（清单卡在 1/4 之类）。
     映射后两端用的是同一份清单（前端的 dimsOfPoint 做的是同一件事）。 */
  /* 老 points 只有 steps（缘起/轮廓/关键/串讲）→ 也走通用底座，**不把那套固定阶梯名再摆出来**。
     这份清单会补在 pointsOf 里（源头），所以服务端挑 focus 用的、前端画清单用的是同一份，
     不会再出现清单里没有的维度（界面上光秃秃的「AI 关注「link」」）。 */
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
function buildCoachPrompt(tut, point, dims, history, userText, arc, hitSoFar, hintMode, stuck) {
  const L = [];
  L.push('你是一位耐心的学习教练。用户正在把一个知识点**用自己的话讲出来**——他看得懂，但说不出来，这正是最常见的假掌握。');
  L.push('');
  /* 连着好几次"不知道"说明问题问得太高或太绕了。这时候继续换着法子问更基础的东西
     只会让他更挫败（真实反馈：问到最后用户说"我还是没搞懂啊，这是在讲啥啊"）。
     给他一个能站住的落脚点，再确认他跟上了没有 —— 仍然不是把整段答案倒给他。 */
  if (Number(stuck) >= 3) {
    L.push('【他已经连着 ' + Number(stuck) + ' 次说"不知道/不懂"了 —— 这一轮必须换打法】');
    L.push('- 不许再问更基础、更绕、或者换个说法的同一个问题（那只会让他更挫败）；');
    L.push('- 开头先**用一句话说清"我们现在在弄的这件事到底是什么"**（大白话，让他知道自己到底在学什么，别用术语）；');
    L.push('- 再用**两三句大白话正面讲清当前这一小块**（给一个能站住的落脚点，用日常比喻，别把整张图一次倒完）；');
    L.push('- 讲完只问一个"他跟上没有"的小确认问题（点头就能答的那种），别又开一个新话题；');
    L.push('- 语气上先接住他的挫败：他不知道不是他的问题，是这个点本来就缺个入口。');
    L.push('');
  }
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
    L.push('【你们刚才的往来（最近的在后）—— 已经问过的**不要再问一遍**，他已经答过的**不要再让他重说**】');
    for (const h of history.slice(-8)) {
      /* 兼容老调用（history 可能是纯字符串） */
      if (typeof h === 'string') { L.push('我：' + String(h).slice(0, 200)); continue; }
      if (h.u) L.push('我：' + String(h.u).slice(0, 200));
      if (h.a) L.push('AI：' + String(h.a).slice(0, 260));
    }
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
  L.push('7.5 **不要重复**：上面【你们刚才的往来】里 AI 问过的问题，换个说法再问一遍也算重复。');
  L.push('8. 涉及代码一律用 ``` 围栏包裹（注明语言）。');
  L.push('9. 如果他这一轮明显在**复述原文或你的话**（照抄关键词、只列名词不讲关系、答非所问），');
  L.push('   那不算真讲到 —— 这类别给 hit，要在 weak 里点名，并让 probe 逼他用自己的类比重讲一遍。');
  L.push('');
  L.push('【整体判断：每一轮都要给，用户要随时看到"AI 眼里我现在什么水平"】');
  L.push('- level：0=还没开口 / 1=能说出关键词 / 2=能讲清这块的机制 / 3=能自己组织成一段完整表述');
  L.push('- verdict：**一句话**说他现在到哪了（要具体，别写"还不错"这种废话）');
  L.push('- weak：他目前最薄弱的那一处（30 字内，点名，别泛泛而谈）');
  L.push('');
  L.push('【输出格式：只输出一个 JSON 对象，不要代码围栏、不要任何多余文字】');
  L.push('{"read":"一句话说他现在懂到哪了（40 字内）",');
  L.push(' "hit":["他已经讲到的维度 key"],');
  L.push(' "level":2,');
  L.push(' "verdict":"...",');
  L.push(' "weak":"...",');
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
  // 兜底：不填 level 时按 hit 数推一个，免得界面上的水平条永远空着
  let level = Number(j.level);
  if (!Number.isFinite(level) || level < 0 || level > 3) level = hit.length >= 2 ? 2 : (hit.length === 1 ? 1 : 0);
  /* 模型常常不填 weak（尤其输出被截断时）。别留空 —— 它接下来要问的那一条就是当前
     最薄弱处，直接用那个维度名兜住；focus 是 refine（清单已齐、转入打磨）时，
     薄弱处就是这个模式本身在说的事。不瞎编，只回落到已经有依据的说法。 */
  const focusName = (focus !== 'refine' && (dims || []).find(d => d.key === focus) || {}).name || '';
  const weak = String(j.weak || '').trim().slice(0, 120)
    || focusName
    || (focus === 'refine' ? '内容都覆盖了，表述还没讲扎实' : '')
    || String(j.read || '').trim().slice(0, 60);
  return {
    read: String(j.read || '').trim().slice(0, 200),
    hit,
    level,
    verdict: String(j.verdict || j.read || '').trim().slice(0, 200),
    weak,
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
    const j = parseAIObject(raw);
    if (j && String(j.probe || j.q || '').trim()) return normCoachTurn(j, dims);
  } catch (e) { raw = raw || ('ERR ' + (e.message || e)); }
  /* 模型没给 JSON：再试一次，并把它的原话怼回去让它自己改格式 */
  try {
    await ask('\n\n【注意】你上一次的输出不是合法 JSON，只输出 {"read":"…","hit":[…],"focus":"…","say":"…","probe":"…","done":false} 这个对象本身。');
    const j2 = parseAIObject(raw);
    if (j2 && String(j2.probe || j2.q || '').trim()) return normCoachTurn(j2, dims);
  } catch (e) { /* 两次都不听话就用第一次的原话 */ }
  /* 两次都没给出能用的 JSON。它可能把 JSON 写断了 —— 那就再抢救一次字段，
     实在捞不到也**不能把半截 JSON 当问题显示**，宁可报错（有重试键）。 */
  const salv = parseAIObject(raw) || {};
  const guess = String(salv.probe || salv.q || salv.say || salv.read || '').trim();
  if (guess) {
    return { read: String(salv.read || '').trim(), hit: [], focus: 'refine',
      say: String(salv.say || '').trim(), probe: guess.slice(0, 800), done: false, raw: true };
  }
  let plain = String(raw || '').replace(/^```[a-z]*\s*/i, '').replace(/```$/, '').trim();
  if (looksLikeJSON(plain)) plain = '';
  if (!plain) throw new Error('AI 这次没给出能用的引导问题（输出被写断了），点重试再来一次');
  return { read: '', hit: [], focus: 'refine', say: '', probe: plain.slice(0, 800), done: false, raw: true };
}


/* 引导模式的核心：跑一轮 AI，存 hit/focus/pending。
   hint=true 时只给方向（不消耗 pending 的那一问，也不推进 hit）。 */
async function coachTurnOnce(r, point, dims, st, history, userText, hint, answerTurnId, stuck) {
  const base = buildCoachPrompt(tutOf(r.tutorial_id) || { title: '', content: '' }, point, dims, history, userText, arcOf(r.tutorial_id), st.hit, hint, stuck);
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
  /* AI 跑完时这个对话可能已经被用户删了（删对话时那一轮还在跑）。
     这时候不能再往里写 —— restate_coach 没有外键，写进去就成了一条指不到轮次的幽灵行。 */
  if (!db.prepare('SELECT 1 FROM restate_rounds WHERE id = ?').get(Number(r.id))) return { insertId: null, gone: true };
  /* hint 那一轮不进 turns（它是插在当前问题上的提示，不是新一轮问答），
     但要让用户看得到 → 存成 kind='hint' 的一轮，ai_text 就是提示本身。 */
  const ver = {
    kind: hint ? 'hint' : 'ask',
    read: turn.read, hit: turn.hit, focus: turn.focus,
    level: turn.level, verdict: turn.verdict, weak: turn.weak,
    say: turn.say, probe: turn.probe, missed: [], wrong: [], scaffold: '',
    ok: false, ai_text: [turn.say, turn.probe].filter(Boolean).join('\n\n') || '……'
  };
  let ins;
  if (answerTurnId) {
    /* 他那一句已经在路由里落库了 —— 这里只把 AI 这一半补上去，不再另起一行。
       （以前是再插一行，于是同一句回答出现两遍、AI 那遍还是旧话） */
    db.prepare('UPDATE restate_turns SET ai_text = ?, verdict = ? WHERE id = ?')
      .run(ver.ai_text, JSON.stringify(ver), Number(answerTurnId));
    ins = { lastInsertRowid: Number(answerTurnId) };
  } else {
    const prev = turnsOf(r.id);
    ins = db.prepare('INSERT INTO restate_turns (round_id, seq, user_text, ai_text, verdict, created_at) VALUES (?,?,?,?,?,?)')
      .run(r.id, prev.length + 1, hint ? '' : (userText || ''), ver.ai_text, JSON.stringify(ver), now);
    if (!hint) db.prepare('UPDATE restate_rounds SET turns = ?, updated_at = ? WHERE id = ?').run(prev.length + 1, now, r.id);
  }
  st.focus = turn.focus;
  if (!hint) {
    st.hit = [...new Set(st.hit.concat(turn.hit || []))];
    st.level = turn.level;
    st.verdict = turn.verdict;
    st.weak = turn.weak;
    st.back = '';   // 上一条"接回自己说的话"已经被这一轮回答消费掉了
    st.pending = {
      read: turn.read, hit: turn.hit, focus: turn.focus, say: turn.say, probe: turn.probe, done: turn.done,
      level: turn.level, verdict: turn.verdict, weak: turn.weak
    };
  } else {
    /* 提示挂在当前那一问下面，不改 pending */
    if (st.pending) st.pending.hint = { say: turn.say, probe: turn.probe };
  }
  saveCoach(r.id, st);
  return { insertId: ins.lastInsertRowid };
}

/* 收尾：把用户逐级的表达整理成一版「我的话」，并对照原文讲清差异 */
/* 收尾对照：用户先自己整理一版（draft），AI 只做「润色 + 标出差距」。
   关键是**不替用户重写** —— 那样沉淀出来的还是书上的话，不是他的。
   draft 为空时（老数据/没写就直接收尾）退回"从他零散的回答里整理"，行为同旧版。 */
function buildFinishPrompt(tut, point, history, draft) {
  const own = String(draft || '').trim();
  return [
    '你是学习教练。用户正在把这个知识点**内化成自己的理解** —— 你要做的是帮他把已经属于他的东西整理得更清楚，',
    '而不是替他重写一遍（那样沉淀出来的还是书上的话，等于白做）。',
    '',
    '【知识点】' + String(point.title || ''),
    '【它讲的是什么】' + String(point.summary || ''),
    (point.key_points || []).length ? '【原文要点（只用来判断他漏了什么，不要往 mine 里塞）】\n'
      + (point.key_points || []).map(k => '- ' + String(k)).join('\n') : '',
    own ? '' : '【注意】他没有额外写整理稿，下面那些是他零散说过的话 —— 那就从里面提炼一版，但仍然要保留他的用词。',
    own ? '【他自己整理的版本（这是主体，只做润色）】\n' + own.slice(0, 2000) : '',
    '',
    '【他全程的表述（按顺序，做上下文用）】',
    (history || []).map((h, i) => (i + 1) + '. ' + String(h).slice(0, 300)).join('\n'),
    '',
    '【要求】',
    '1. mine：整理版。**保留用户自己的用词、语气和类比**，只理顺顺序、补上连接词。',
    '   · 他自己写的部分不许替换成书上的术语 —— 术语化就失去意义了。',
    '   · 明显不通顺或漏了因果关系的地方，可以补，但补的只能是**连接**，不能补新知识。',
    '   · 长度和他的整理稿相当，别写成教科书。',
    '2. kept：他这版里**真正讲对了**的地方（2-4 条，每条 30 字内，具体）。',
    '3. gaps：和「原文要点」比还缺的（每条含 key 与 why，why 说清为什么重要，1 句）。已讲到的不要列。',
    '4. line：一句话总结他这一轮真正内化了什么（具体，不要套话）。',
    '5. 涉及代码一律用 ``` 围栏包裹。',
    '',
    '只输出一个 JSON 对象：',
    '{"mine":"整理版","kept":["..."],"gaps":[{"key":"...","why":"..."}],"line":"一句话"}'
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
/* 解释（用户主动提问）：答完不能就这么断了 —— 得把他**接回自己的话**，
   否则解释变成"看懂却说不出来"的又一例。back 就是要他用自己的话重讲的那一句。 */
function buildChatPrompt(tut, point, step, history, question, body) {
  return [
    '你是学习教练，耐心但不啰嗦。用户在理解知识点的过程中卡住了，主动提问。',
    '',
    '【知识点】' + String(point.title || ''),
    '【它讲的是什么】' + String(point.summary || ''),
    (point.key_points || []).length ? '【要点清单】' + (point.key_points || []).map(k => String(k)).join('；') : '',
    '【他当前在理解的这一点】' + String((step && step.t) || '（未指定）') + '：' + String((step && step.ask || step.q) || ''),
    '【他前面说过的话（回答时贴合他的用词，别突然换一套术语）】'
      + ((history || []).slice(-3).map(h => String(h).slice(0, 140)).join(' / ') || '（还没有）'),
    '',
    '【教程原文（回答要贴着它，别讲 tutorial 之外的版本）】',
    String((body || '')).slice(0, 6000),
    '',
    '【他的问题】' + String(question || '').slice(0, 400),
    '',
    '【怎么输出】',
    '第一段：直接回答（150~350 字）。用他能懂的话，先给结论再给理由。',
    '  · 涉及代码必须用 ``` 围栏包裹（注明语言）。',
    '  · 他问题里有明显误解，先纠正那一句再回答。',
    '然后另起一行，写一个 【接回】 标记，后面跟一句**必须由他用自己的话重讲**的问题：',
    '  · 问的是他刚听懂的那一点，不要换话题、不要问新的知识点。',
    '  · 不能省 —— 没有它，解释就只是"又看懂了一遍"，他还是说不出来。',
    '',
    '**不要输出 JSON**，就这两段：',
    '（正文……）',
    '【接回】（一句要他用自己的话重讲的问题）',
    '',
    '例：',
    '`include` 只是把另一份文件的内容拼进来，它本身不启动任何服务；真正决定某个服务',
    '起不起的是它身上那个 `profiles` 标签。',
    '【接回】那你用一句话说：base 里放的到底是什么，profiles 又是在管什么？'
  ].join('\n');
}
/* 解析 chat 的回答：纯文本两段式（截断了也照样能显示正文），
   同时兼容模型仍按旧格式吐 JSON 的情况。 */
function splitChatReply(text) {
  const t = String(text || '').trim();
  if (!t) return { answer: '', back: '' };
  if (looksLikeJSON(t) && /"answer"\s*:/.test(t)) {
    const j = parseAIObject(t) || {};
    return { answer: String(j.answer || '').trim(), back: String(j.back || '').trim() };
  }
  const m = t.match(/(?:^|\n)[ \t]*(?:【接回】|\[接回\]|接回[:：])[ \t]*([\s\S]*)$/);
  let answer = t, back = '';
  if (m) { back = String(m[1] || '').trim(); answer = t.slice(0, m.index).trim(); }
  answer = answer.replace(/^[ \t]*(?:【答】|【回答】)[ \t]*/, '').trim();
  return { answer, back };
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
/* ---------- 抢救式解析 ----------
   模型把 JSON 写断（输出被截断，或自动续写把两段 JSON 接在一起）时，
   extractJSON 因为找不到收尾的 } 会整个放弃，上层就把 {"answer":"… 原样吐给用户。
   这里按字段把能读出来的值捞出来：截断的那个字段也读到哪算哪，总比显示 JSON 强。 */
function salvageValue(t, key) {
  const head = new RegExp('"' + key + '"\\s*:\\s*"').exec(t);
  if (!head) {
    const lit = new RegExp('"' + key + '"\\s*:\\s*(true|false|-?\\d+(?:\\.\\d+)?)').exec(t);
    if (!lit) return null;
    return lit[1] === 'true' ? true : lit[1] === 'false' ? false : Number(lit[1]);
  }
  let out = '';
  for (let i = head.index + head[0].length; i < t.length; i++) {
    const c = t[i];
    if (c === '\\') {
      const n = t[i + 1];
      if (n === 'n') { out += '\n'; i++; }
      else if (n === 't') { out += '\t'; i++; }
      else if (n === 'r') { out += '\r'; i++; }
      else if (n === 'u') {
        const hex = t.slice(i + 2, i + 6);
        if (/^[0-9a-fA-F]{4}$/.test(hex)) { out += String.fromCharCode(parseInt(hex, 16)); i += 5; }
        else i++;
      } else if (n == null) { break; }
      else { out += n; i++; }
      continue;
    }
    if (c === '"') break;   // 正常收尾
    out += c;               // 截断了：读到哪算哪
  }
  return out.trim() ? out : null;
}
function salvageArray(t, key) {
  const head = new RegExp('"' + key + '"\\s*:\\s*\\[').exec(t);
  if (!head) return null;
  const out = [];
  let i = head.index + head[0].length;
  while (i < t.length) {
    while (i < t.length && t[i] !== '{' && t[i] !== '"' && t[i] !== ']') i++;
    if (i >= t.length || t[i] === ']') break;
    if (t[i] === '"') {                       // 字符串数组
      let j = i + 1, buf = '';
      for (; j < t.length; j++) {
        const c = t[j];
        if (c === '\\') { buf += c + (t[j + 1] || ''); j++; continue; }
        if (c === '"') break;
        buf += c;
      }
      try { out.push(JSON.parse('"' + buf + '"')); } catch (e) { out.push(buf); }
      i = j + 1;
      continue;
    }
    let depth = 0, inStr = false, esc = false, end = -1;   // 对象数组：配平扫描
    for (let j = i; j < t.length; j++) {
      const c = t[j];
      if (inStr) { if (esc) esc = false; else if (c === '\\') esc = true; else if (c === '"') inStr = false; continue; }
      if (c === '"') { inStr = true; continue; }
      if (c === '{') depth++;
      else if (c === '}') { depth--; if (depth === 0) { end = j; break; } }
    }
    if (end < 0) break;                       // 这一项被截断了：不完整就别塞给用户
    try { const o = JSON.parse(t.slice(i, end + 1)); if (o && typeof o === 'object') out.push(o); } catch (e) {}
    i = end + 1;
  }
  return out.length ? out : null;
}
/* 统一入口：先正常解析，不行再抢救。所有 AI 返回 JSON 的地方都该用它。 */
function parseAIObject(text) {
  const t = String(text || '').trim();
  if (!t) return null;
  const j = extractJSON(t);
  if (j) return j;
  const o = {};
  for (const k of ['answer', 'back', 'mine', 'line', 'read', 'say', 'probe', 'q', 'verdict', 'weak', 'focus', 'title', 'summary']) {
    const v = salvageValue(t, k);
    if (v != null) o[k] = v;
  }
  for (const k of ['hit', 'kept', 'gaps', 'wrong', 'missed', 'key_points']) {
    const a = salvageArray(t, k);
    if (a) o[k] = a;
  }
  for (const k of ['done', 'ok']) {
    const v = salvageValue(t, k);
    if (typeof v === 'boolean') o[k] = v;
  }
  return Object.keys(o).length ? o : null;
}
/* 这段文本看起来是没解析成功的 JSON 吗？（宁可说"答不上来"，也不能把 {"answer":"… 给用户看） */
function looksLikeJSON(s) {
  const t = String(s || '').trim();
  return /^\s*\{\s*"/.test(t) && /"\s*:/.test(t.slice(0, 80));
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
    /* 老库补列：restate_coach 多了 back/level/verdict/weak；restate_rounds 多了 draft/kept/title */
    try {
      const rc = db.prepare('PRAGMA table_info(restate_rounds)').all().map(c => c.name);
      if (rc.length) {
        if (!rc.includes('draft')) db.exec("ALTER TABLE restate_rounds ADD COLUMN draft TEXT NOT NULL DEFAULT '';");
        if (!rc.includes('kept')) db.exec("ALTER TABLE restate_rounds ADD COLUMN kept TEXT NOT NULL DEFAULT '[]';");
        if (!rc.includes('title')) db.exec("ALTER TABLE restate_rounds ADD COLUMN title TEXT NOT NULL DEFAULT '';");
      }
      const cc = db.prepare('PRAGMA table_info(restate_coach)').all().map(c => c.name);
      if (cc.length) {
        if (!cc.includes('back')) db.exec("ALTER TABLE restate_coach ADD COLUMN back TEXT NOT NULL DEFAULT '';");
        if (!cc.includes('level')) db.exec('ALTER TABLE restate_coach ADD COLUMN level INTEGER NOT NULL DEFAULT 0;');
        if (!cc.includes('verdict')) db.exec("ALTER TABLE restate_coach ADD COLUMN verdict TEXT NOT NULL DEFAULT '';");
        if (!cc.includes('weak')) db.exec("ALTER TABLE restate_coach ADD COLUMN weak TEXT NOT NULL DEFAULT '';");
      }
      /* 完整性清扫：删对话/删目标时如果撞上"AI 还在跑"，可能留下指不到轮次的
         对话记录与引导状态（restate_coach/restate_turns 都没有外键）。启动时清一次。 */
      db.exec('DELETE FROM restate_turns WHERE round_id NOT IN (SELECT id FROM restate_rounds)');
      db.exec('DELETE FROM restate_coach WHERE round_id NOT IN (SELECT id FROM restate_rounds)');
    } catch (e) {}
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
        /* 指定了某一轮 → 回到那个对话接着聊（"会话历史"里点「继续」走这条）。
           同一个知识点只留一个「进行中」：把这个点开，别的归档；沉淀过的内容不受影响。 */
        const wantId = Number((body && body.round_id) || 0);
        if (wantId) {
          const one = db.prepare('SELECT * FROM restate_rounds WHERE id = ? AND tutorial_id = ?').get(wantId, t.id);
          if (!one) return sendJSON(res, 404, { error: '这个对话不存在（可能已被删除）' });
          db.prepare("UPDATE restate_rounds SET status = 'archived', updated_at = ? WHERE tutorial_id = ? AND point_idx = ? AND status = 'active' AND id <> ?")
            .run(now, t.id, one.point_idx, one.id);
          if (one.status !== 'active') db.prepare("UPDATE restate_rounds SET status = 'active', updated_at = ? WHERE id = ?").run(now, one.id);
          const p2 = pts[one.point_idx] || { title: one.point_title };
          const back = db.prepare('SELECT * FROM restate_rounds WHERE id = ?').get(one.id);
          return sendJSON(res, 200, {
            round: roundOut(back), point: p2, turns: turnsOf(one.id),
            coach: (() => { const c = coachOf(one.id); c.dims = dimsOf(p2); return c; })(),
            resumed: true, reopened: true
          });
        }
        // 同一知识点已有进行中的轮次 → 直接续接，把对话原样带回来。
        // （以前这里无条件把所有 active 轮次归档，导致"换个知识点再回来"，
        //   上一个点的对话被归档、新开一轮空的，看起来像记录丢了。）
        if (!fresh) {
          const ex = db.prepare("SELECT * FROM restate_rounds WHERE tutorial_id = ? AND point_idx = ? AND status = 'active' ORDER BY id DESC LIMIT 1")
            .get(t.id, idx);
          if (ex) return sendJSON(res, 200, { round: roundOut(ex), point, turns: turnsOf(ex.id), coach: (() => { const c = coachOf(ex.id); c.dims = dimsOf(point); return c; })(), resumed: true });
        }
        // 只归档「同一个知识点」的旧轮次，不动别的知识点
        db.prepare("UPDATE restate_rounds SET status = 'archived', updated_at = ? WHERE tutorial_id = ? AND point_idx = ? AND status = 'active'")
          .run(now, t.id, idx);
        const info = db.prepare('INSERT INTO restate_rounds (tutorial_id, node_id, goal_id, point_idx, point_title, status, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?)')
          .run(t.id, Number((body && body.node_id) || 0) || (t.node_id || 0), Number((body && body.goal_id) || 0) || (t.goal_id || 0),
            idx, String(point.title || '').slice(0, 60), 'active', now, now);
        const rid = Number(info.lastInsertRowid);
        return sendJSON(res, 200, {
          round: roundOut(db.prepare('SELECT * FROM restate_rounds WHERE id = ?').get(rid)),
          point, turns: [],
          coach: { hit: [], focus: '', pending: null, back: '', level: 0, verdict: '', weak: '', dims: dimsOf(point) },
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
          round: roundOut(r),
          point,
          turns: turnsOf(r.id),
          coach: (() => { const c = coachOf(r.id); c.dims = dimsOf(point); return c; })()
        });
      }
    },
    /* 对话改名（会话历史里用）。名字为空 = 回到默认的"日期时间"名 */
    {
      method: 'POST',
      pattern: /^\/api\/restate-round\/(\d+)\/rename$/,
      handler: async (req, res, u) => {
        const m = u.pathname.match(/^\/api\/restate-round\/(\d+)\/rename$/);
        if (!m || req.method !== 'POST') return false;
        const r = db.prepare('SELECT * FROM restate_rounds WHERE id = ?').get(Number(m[1]));
        if (!r) return sendJSON(res, 404, { error: '对话不存在' });
        const body = await readBody(req).catch(() => ({}));
        const title = String((body && body.title) || '').replace(/\s+/g, ' ').trim().slice(0, 40);
        db.prepare('UPDATE restate_rounds SET title = ? WHERE id = ?').run(title, r.id);
        const after = db.prepare('SELECT * FROM restate_rounds WHERE id = ?').get(r.id);
        return sendJSON(res, 200, { ok: true, round: roundOut(after) });
      }
    },
    /* 删掉一个对话（连同它的对话记录与引导状态）。不可恢复，前端会先确认。 */
    {
      method: 'DELETE',
      pattern: /^\/api\/restate-round\/(\d+)$/,
      handler: async (req, res, u) => {
        const m = u.pathname.match(/^\/api\/restate-round\/(\d+)$/);
        if (!m || req.method !== 'DELETE') return false;
        const id = Number(m[1]);
        const r = db.prepare('SELECT * FROM restate_rounds WHERE id = ?').get(id);
        if (!r) return sendJSON(res, 404, { error: '对话不存在' });
        db.prepare('DELETE FROM restate_turns WHERE round_id = ?').run(id);
        db.prepare('DELETE FROM restate_coach WHERE round_id = ?').run(id);
        db.prepare('DELETE FROM restate_rounds WHERE id = ?').run(id);
        return sendJSON(res, 200, { ok: true, deleted: id });
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
        /* 给 AI 的上下文：**往来一起给**（我：… / AI：…）。
           以前只把他自己说过的话给过去，AI 看不到自己问过什么 → 就会把同一个问题再问一遍。 */
        const history = prev.map(x => ({ u: String(x.user_text || ''), a: String(x.ai_text || '') }))
          .filter(x => x.u || x.a);
        /* 他连着说了几次"不知道"？连着 3 次以上就不能再往下问更基础的东西了（见 buildCoachPrompt）。 */
        const GIVEUP = /^\s*(不知道|不懂|不清楚|不会|没学过|没搞懂|没懂|忘了|不记得|没起过|说不出来|答不上来|想不起来)/;
        const said = prev.map(x => String(x.user_text || '').trim()).filter(Boolean);
        if (userText) said.push(String(userText).trim());   // 他刚说的这句也算
        let stuck = 0;
        for (let i = said.length - 1; i >= 0; i--) {
          if (GIVEUP.test(said[i]) || said[i].replace(/\s/g, '').length <= 4) stuck++; else break;
        }
        /* 只有真的答了一句（或明确要提示/要下一问）才继续；否则 400，
           否则用户误触一次就会白白烧掉一次 AI 调用 */
        if (!userText && !hint && !force) return sendJSON(res, 400, { error: '先写下你的理解' });
        /* 用户答了一句：**先把他这句落下来**（AI 还没回），AI 回来后补上它那一半。
           以前这里是"把上一问和这一答配成一轮"再让 AI 另插一轮 —— 结果每一答都出现两遍，
           而且 AI 那一遍放的是上一轮的旧话（用户看到的"驴头不对马嘴"就是这个）。
           他的原话必须一进来就存住：AI 那一步可能要 30 秒，中途刷新/失败也不能丢。 */
        let answerTurnId = 0;
        if (userText && !hint) {
          const now0 = nowISO();
          const ins = db.prepare('INSERT INTO restate_turns (round_id, seq, user_text, ai_text, verdict, created_at) VALUES (?,?,?,?,?,?)')
            .run(r.id, prev.length + 1, userText, '', JSON.stringify({ kind: 'coach', ok: false }), now0);
          answerTurnId = Number(ins.lastInsertRowid);
          db.prepare('UPDATE restate_rounds SET turns = ?, updated_at = ? WHERE id = ?').run(prev.length + 1, now0, r.id);
          st.pending = null;   // 那一问已经被这一答消费掉了
        }
        const turn = await coachTurnOnce(r, point, dims, st, history, userText, hint, answerTurnId, stuck);
        /* 跑这一轮的工夫里对话被删了 → 明确告诉前端，别假装成功 */
        if (turn && turn.gone) return sendJSON(res, 404, { error: '这个对话已经被删除了' });
        return sendJSON(res, 200, {
          turn: turn && turn.insertId ? db.prepare('SELECT * FROM restate_turns WHERE id = ?').get(Number(turn.insertId)) : null,
          coach: (() => { const c = coachOf(r.id); c.dims = dims; return c; })(),
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
        const reqBody = await readBody(req).catch(() => ({}));
        const draft = String((reqBody && reqBody.draft) || '').trim().slice(0, 2000);
        const prev = turnsOf(r.id);
        const history = prev.filter(x => x.user_text).map(x => x.user_text);
        if (!history.length && !draft) return sendJSON(res, 400, { error: '先说几句，或者直接写下你整理好的版本' });
        const pts = pointsOf(r.tutorial_id);
        const point = pts[r.point_idx] || { title: r.point_title, key_points: [] };
        const txt = await aiJob({
          title: '对照原文，看差在哪',
          note: String(point.title || '').slice(0, 80),
          goalId: Number(r.goal_id || 0),
          message: draft ? 'AI 正在润色你写的版本，并对照原文找差距' : 'AI 正在把你说过的话整理成一版，并对照原文找差距',
          run: signal => aiText(buildFinishPrompt(tutOf(r.tutorial_id) || { title: '', content: '' }, point, history, draft), currentModel(), 60000, null, signal)
        });
        const d = parseAIObject(txt) || {};
        let mine = String(d.mine || '').trim();
        if (!mine || looksLikeJSON(mine)) mine = String(draft || '').trim();   // 别把半截 JSON 当"我的话"
        mine = mine.slice(0, 1200);
        /* kept 模型常漏给（输出被截断/它偷懒）。兜底用引导模式里 AI 自己打的 ✓ ——
           那也是"他确实讲到了"的依据，比让页面空着强，且不是编出来的。 */
        const stF = coachOf(r.id);
        const hitNames = dimsOf(point).filter(d => stF.hit.indexOf(d.key) >= 0).map(d => d.name);
        let kept = (Array.isArray(d.kept) ? d.kept : []).map(x => String(x || '').trim()).filter(Boolean).slice(0, 5);
        if (!kept.length) kept = hitNames.slice(0, 4);
        const gaps = (Array.isArray(d.gaps) ? d.gaps : []).map(g => ({
          key: String((g && g.key) || '').slice(0, 80), why: String((g && g.why) || '').slice(0, 160)
        })).filter(g => g.key).slice(0, 5);
        const line = String(d.line || '').slice(0, 160);
        const now = nowISO();
        db.prepare("UPDATE restate_rounds SET status = 'done', mine = ?, gaps = ?, line = ?, draft = ?, kept = ?, updated_at = ? WHERE id = ?")
          .run(mine, JSON.stringify(gaps), line, draft, JSON.stringify(kept), now, r.id);
        r.gaps = gaps; r.kept = kept; r.mine = mine; r.line = line; r.draft = draft;
        return sendJSON(res, 200, { round: roundOut(db.prepare('SELECT * FROM restate_rounds WHERE id = ?').get(r.id)) });
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
        const reqBody = await readBody(req).catch(() => ({}));
        const text = String((reqBody && reqBody.text) || '').trim().slice(0, 500);
        if (!text) return sendJSON(res, 400, { error: '先写下你的问题' });
        const pts = pointsOf(r.tutorial_id);
        const point = pts[r.point_idx] || { title: r.point_title, key_points: [] };
        /* 引导模式下"当前这一级"是 AI 现挑的 focus，取不到时退回通用底座的第一条 */
        const st0 = coachOf(r.id);
        const dims0 = dimsOf(point);
        const focusDim = dimOfKey(dims0, st0.focus);
        const cur = focusDim || dims0[0] || COVER_DIMS[0];
        const history = turnsOf(r.id).filter(x => x.user_text).map(x => x.user_text);
        const tut = tutOf(r.tutorial_id) || { title: '', content: '' };
        const body = (tut.format === 'html' ? stripHtml(tut.content) : String(tut.content || ''));
        const txt = await aiJob({
          title: '解释一下 · ' + String(point.title || '').slice(0, 24),
          note: String(point.title || '').slice(0, 80),
          goalId: Number(r.goal_id || 0),
          nodeId: Number(r.node_id || 0),
          message: 'AI 正在答你的问题，答完会把你接回用自己的话',
          run: signal => aiText(buildChatPrompt(tut, point, { t: cur.name, ask: cur.ask }, history, text, body), currentModel(), 60000, null, signal)
        });
        const parsed = splitChatReply(txt);
        let answer = String(parsed.answer || '').trim().slice(0, 3000);
        /* 万一还是没解析出来、拿到的是一坨 JSON —— 宁可说"答不上来"，
           也不能把 {"answer":"… 原样显示在对话里（用户看到的就是这种）。 */
        if (!answer || looksLikeJSON(answer)) answer = '这个我一时没答好，换个问法再问一次？';
        /* back 模型常漏给。解释完如果不接回自己的话，就只是"又看懂了一遍"——
           所以兜底也要有一句：拿当前关注维度里那个"他自己答得出来"的小切口来问。 */
        let back = String(parsed.back || '').trim().slice(0, 200);
        if (!back) {
          const askTxt = String((focusDim && (focusDim.ask || focusDim.probe)) || cur.ask || '').trim();
          back = askTxt ? ('那你用自己的话说一遍：' + askTxt.slice(0, 120)) : '';
        }
        const reply = back ? (answer + '\n\n**轮到你说了** —— ' + back) : answer;
        const prev = turnsOf(r.id);
        const now = nowISO();
        const ins = db.prepare('INSERT INTO restate_turns (round_id, seq, user_text, ai_text, verdict, created_at) VALUES (?,?,?,?,?,?)')
          .run(r.id, prev.length + 1, text, reply, JSON.stringify({ kind: 'chat', back }), now);
        /* 把"接回自己那句话"挂到当前那一问下面：解释完接着用自己的话说，
           否则解释只会变成"又看懂了一遍但还是说不出来"。 */
        if (back) {
          /* 独立存一份，不依赖 pending 存在 —— 用户完全可能先提问、后被 AI 问，
             那时还没有 pending，挂上去就丢了，解释就白解释了。 */
          const st1 = coachOf(r.id);
          st1.back = back;
          if (st1.pending) st1.pending.back = back;
          saveCoach(r.id, st1);
        }
        return sendJSON(res, 200, {
          turn: db.prepare('SELECT * FROM restate_turns WHERE id = ?').get(Number(ins.lastInsertRowid)),
          back
        });
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
        const d = parseAIObject(txt) || {};
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
        for (const r of rows) {
          try { r.gaps = JSON.parse(r.gaps || '[]'); } catch (e) { r.gaps = []; }
          try { r.kept = JSON.parse(r.kept || '[]'); } catch (e) { r.kept = []; }
        }
        return sendJSON(res, 200, { notes: rows });
      }
    }
  ]
};
