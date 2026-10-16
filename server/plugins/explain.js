'use strict';
/**
 * 思而行 · 插件：看懂代码（把一段代码逐行讲明白）
 * ------------------------------------------------------------------
 * 为什么有它：教程 / 项目里的代码常常"字都认识、连起来看不懂"。而"一问一答从头聊到尾"
 * 的形态对不上真实需求 —— 用户想弄明白的是**某一行的作用**，不是陪 AI 走一遍提纲。
 * 所以这里的做法是：
 *   ① 他把代码整段贴进来，AI 在后台把它**逐行**讲完（分成几段调 AI，进度可见、可停、可续）；
 *   ② 每段讲解落库到它覆盖的行上：左边点哪一行，右边就只看这一行的讲解 ——
 *      不翻一长串聊天记录；没看懂就在那一行下面追问，追问也只挂在这一行上。
 *
 * 改这个组件先读这两条契约（它的价值全在这儿）：
 *   · 讲解必须按 `### 第 N 行` / `### 第 N-M 行` 分块输出 —— 系统靠这个把讲解挂到行上；
 *     模型漏行 / 乱序 / 越界由 toBlocks() 兜底：钳到本段范围、把空隙并进相邻块，
 *     保证"范围里的每一行都有讲解"（宁可粗一点，也不能有洞）。
 *   · `[[NAME: …]]` 是收尾标记：服务端剥掉，永远不进用户视线（模型忘写就退回默认名，用户随时可改）。
 *
 * 还有三条别松：
 *   · 每段只讲**本段范围内**的行，不许把后面的顺带讲了（`不许超过第 B 行`）；
 *   · 追问的回答只针对被点开的那一行，不顺手往下讲；
 *   · 进度 = `explained`（已经讲到第几行）。只有整段写完才推进它 —— 失败/取消停在原地，
 *     用户点「继续讲」从 `explained + 1` 接着讲，不会重复讲过的行。
 */
const EC = require('../explain-chunk');
const {
  detectLang, numCode, chunkLines, parseExplain, toBlocks, clarifyBlock,
  mergeFragments, parseOutline, normModules, fallbackModules, buildBatches
} = EC;

const MAX_LINES = 400;         // 一段代码最多多少行（太长就请他分两次贴）
const MAX_CHARS = 30000;       // 或最多多少字

let db, nowISO, safeParse, sendJSON, readBody, getSetting, setSetting, log, backup;
let getGoal, aiText, currentModel, tasks;
function bind(ctx) {
  ({ db, nowISO, safeParse, sendJSON, readBody, getSetting, setSetting, log, backup } = ctx);
  ({ getGoal, aiText, currentModel, tasks } = ctx);
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS explain_sessions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  goal_id INTEGER NOT NULL DEFAULT 0,
  node_id INTEGER NOT NULL DEFAULT 0,
  tutorial_id INTEGER NOT NULL DEFAULT 0,
  title TEXT NOT NULL DEFAULT '',        -- 名字（AI 起，用户可改）
  note TEXT NOT NULL DEFAULT '',         -- 他自己留的一句"这是哪儿来的代码"
  lang TEXT NOT NULL DEFAULT '',         -- 展示用的语言标签（前端着色/显示，不参与逻辑）
  code TEXT NOT NULL DEFAULT '',         -- 贴进来的原样代码
  lines INTEGER NOT NULL DEFAULT 0,      -- 总行数
  modules TEXT NOT NULL DEFAULT '[]',    -- AI 划的讲解模块 [{from,to,title}]（首尾相接、不重不漏）
  prereqs TEXT NOT NULL DEFAULT '[]',    -- 前置知识 [{id,title,why,state:todo|known|unknown|done,lesson}]
  explained INTEGER NOT NULL DEFAULT 0,  -- 已经讲到第几行（最后一段的 line_to）
  status TEXT NOT NULL DEFAULT 'working',-- working 正在讲 / idle 停下了（没讲完，可继续）/ done 全讲完
  last_error TEXT NOT NULL DEFAULT '',
  renamed INTEGER NOT NULL DEFAULT 0,    -- 用户自己改过名（改过就不再让 AI 覆盖）
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS explain_turns (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id INTEGER NOT NULL,
  line_from INTEGER NOT NULL DEFAULT 0,  -- 这段讲解覆盖的行（0 = 概览）
  line_to INTEGER NOT NULL DEFAULT 0,
  role TEXT NOT NULL DEFAULT 'ai',       -- ai | me
  kind TEXT NOT NULL DEFAULT 'explain',  -- overview 概览 / explain 讲解 / ask 追问 / answer 回答
  title TEXT NOT NULL DEFAULT '',        -- 模块名（标题里「### 第 N-M 行 · 模块名」那个名字）
  content TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_explain_sessions_goal ON explain_sessions(goal_id, updated_at);
CREATE INDEX IF NOT EXISTS idx_explain_turns_sid ON explain_turns(session_id, id);`;

/* 正在讲（内存态）：进程内防重入。进程重启后由 init 把库里的 working 复位。 */
const RUNNING = new Set();

/* ---------------- 小工具 ---------------- */

/** 组件开关：目标显式值 > 全局开关 > 默认（开）。界面上关了，接口也要挡住。 */
function compOn(goalId) {
  try {
    const g = db.prepare('SELECT plugins FROM goals WHERE id = ?').get(Number(goalId || 0));
    const obj = safeParse(g && g.plugins) || {};
    if (obj.explain != null) return !!obj.explain;
  } catch (e) {}
  try {
    const map = safeParse(getSetting('components', '{}')) || {};
    if (map.explain != null) return !!map.explain;
  } catch (e) {}
  return true;
}
function tutOf(tid) {
  try { return db.prepare('SELECT id, title, node_id, goal_id FROM tutorials WHERE id = ?').get(Number(tid || 0)) || null; } catch (e) { return null; }
}
/** 用户情况（基础、投入、目标）—— 讲解要照着他的处境讲，别对零基础讲行话。 */
function userBlock(goalId) {
  const g = getGoal ? getGoal(Number(goalId || 0)) : null;
  if (!g) return '';
  const L = [];
  if (g.title) L.push('学习目标：' + g.title);
  if (g.profile) L.push('他的现状：' + String(g.profile).slice(0, 400));
  if (g.weekly_hours) L.push('每周可投入：' + g.weekly_hours);
  const cb = clarifyBlock(g);
  if (cb) L.push(cb);
  return L.length ? L.join('\n') : '';
}

/* ---------------- 讲解风格示例（个性化） ----------------
   用户贴/上传一段他喜欢的讲解，之后每一段讲解都照这个风格写。
   ⚠️ 风格示例**只管语气、详略、排版**，不许照抄内容；示例里说什么代码无关紧要。
   存 settings 表（`explain_style_sample`，已进 SYNC_SETTINGS：这是用户的偏好、不是密钥）。 */
const STYLE_KEY = 'explain_style_sample';
const STYLE_MAX = 6000;
function styleSample() {
  try { return String(getSetting(STYLE_KEY, '') || '').trim().slice(0, STYLE_MAX); } catch (e) { return ''; }
}
/** 提示词里的风格块。示例太长就截断（喂的是示范，不是让他读完） */
function styleBlock() {
  const s = styleSample();
  if (!s) return '';
  return [
    '【讲解风格 —— 照他给的示例来（这是硬要求）】',
    '下面这段是他自己贴过来的、他喜欢的讲解样子。**模仿它的语气、句子长短、详略和排版**：',
    '· 示例写得短、你就写短；示例里有小标题/列表/类比/表格，你就跟着用；示例里没有「记住」这类收尾，你就别加；',
    '· 只学**风格**，不要照抄它的内容，也不要跟这段代码混在一起。',
    '【他的风格示例】',
    s
  ].join('\n');
}
const NO_STYLE_RULES = [
  '【每个块怎么讲】',
  '1. 先用一两句话说清"这块合起来在做什么"；',
  '2. 再拆开讲：从最外层讲到括号里（或从里往外），把块里的每个东西都交代清楚；跨了多行就逐行点一下谁是谁；',
  '3. 然后说清"为什么必须这么写 / 少了它会怎样"；',
  '4. 用到前面定义过的变量或函数时，一句话点明它在第几行（例："这里的 input 是第 3 行建的那条管道"）；',
  '5. 块的最后给一行 `**记住：**……`（≤25 字）。'
].join('\n');
const STYLE_RULES = [
  '【每个块怎么讲（内容要求；风格照他给的示例）】',
  '1. 说清"这块合起来在做什么"；',
  '2. 把块里的东西交代清楚（跨了多行就逐行点一下谁是谁），并说清"为什么必须这么写 / 少了它会怎样"；',
  '3. **详略和排版完全照他的示例**：示例里没有小标题就不加、没有「记住」就不写、示例一句话说完就别写三句。'
].join('\n');
/* 用户抱怨过"讲解文字太多"：默认风格也跟着收一收 —— 能一句话说清就别写三句 */
const BREVITY = '· 宁短勿长：能一句话说清就别写三句；不要把代码里已经写明的事再复述一遍。';

/* ---------------- 前置知识（开讲前先过一遍） ----------------
   用户要求："在讲解代码之前把需要理解这段代码所需要的前置知识给用户过一遍，看用户知不知道，
   不知道的就拎出来带他理解一遍。" 流程：
     ① 开讲先调 AI 列**这段代码真正卡理解的前置概念**（3~6 个）→ 落库，会话状态 = 'prereq'（等他确认）；
     ② 他在界面上逐个点「知道 / 不知道」→ POST /prereqs；
     ③ 「不知道」的那些：每个派一次 AI（并行，子任务）写成一小节课 → 存进他那一项；
     ④ 同时照旧并行讲代码（两边一起跑，他读前置课的时候代码讲解也在写）。
   概念名/为什么需要它都由 AI 给，系统只保证形状（数量上限、id、状态机）。 */
const PREREQ_MAX = 6;
function parsePrereqs(raw) {
  try {
    const a = JSON.parse(String(raw || '[]'));
    if (!Array.isArray(a)) return [];
    return a.map((p, i) => ({
      id: String((p && p.id) || ('p' + (i + 1))),
      title: String((p && p.title) || '').replace(/\s+/g, ' ').trim().slice(0, 30),
      why: String((p && p.why) || '').replace(/\s+/g, ' ').trim().slice(0, 60),
      state: ['todo', 'known', 'unknown', 'done'].includes(String(p && p.state)) ? String(p.state) : 'todo',
      lesson: String((p && p.lesson) || '')
    })).filter(p => p.title).slice(0, PREREQ_MAX);
  } catch (e) { return []; }
}
function savePrereqs(sid, arr) {
  db.prepare('UPDATE explain_sessions SET prereqs = ?, updated_at = ? WHERE id = ?').run(JSON.stringify(arr || []), nowISO(), sid);
}
/** 从 AI 回复里抠前置知识清单 */
function parsePrereqJson(raw) {
  const t = String(raw || '');
  let obj = null;
  try { obj = JSON.parse(t.trim()); } catch (e) { obj = null; }
  if (obj == null) { const m = t.match(/\{[\s\S]*\}/); if (m) { try { obj = JSON.parse(m[0]); } catch (e) {} } }
  const list = Array.isArray(obj) ? obj : (obj && Array.isArray(obj.needs) ? obj.needs : null);
  if (!list) return [];
  const out = [];
  for (const x of list) {
    const title = String((x && (x.title || x.name)) || '').replace(/\s+/g, ' ').trim().slice(0, 30);
    if (!title) continue;
    out.push({ id: 'p' + (out.length + 1), title, why: String((x && (x.why || x.desc)) || '').replace(/\s+/g, ' ').trim().slice(0, 60), state: 'todo', lesson: '' });
    if (out.length >= PREREQ_MAX) break;
  }
  return out;
}

function buildPrereqPrompt(s) {
  const lines = String(s.code || '').split('\n');
  const L = [];
  L.push('你是「代码讲解员」。用户贴了一段他要看懂的代码。**在逐行讲之前**，先判断：');
  L.push('要看懂这段代码，得提前知道哪几个概念/机制/API？（他可能不知道，所以先问清楚）');
  L.push('');
  const ub = userBlock(s.goal_id);
  if (ub) { L.push('【他的情况】'); L.push(ub); L.push(''); }
  if (s.note) L.push('【他说这段代码是】' + String(s.note).slice(0, 200));
  L.push('【完整代码（带行号）】');
  L.push(numCode(lines));
  L.push('');
  L.push('【怎么列】');
  L.push('· 只列**真的卡住理解**的：某个语法 / API / 机制 / 工具，不知道它就完全看不懂这段代码在干什么；');
  L.push('  例：回调函数、JSON.parse 与 stringify 的区别、stdin/stdout 管道、ES6 解构、Promise 与 async/await、事件循环、正则、this 指向。');
  L.push('· 3~' + PREREQ_MAX + ' 个，一个概念一条；**别列泛泛的东西**（"JavaScript 基础"这种问不出答案），也别列"看完这段代码才会关心"的东西；');
  L.push('· 如果这段代码确实不需要任何前置（例如就几行 print），就返回空数组 —— 别硬凑；');
  L.push('· why：一句话说清它出现在这段代码的**哪里**、为什么需要它（≤30 字，能带行号最好）。');
  L.push('');
  L.push('【只输出一个 JSON 对象，不要任何别的文字或代码块标记】');
  L.push('{"needs":[{"title":"回调函数","why":"第 12 行 (msg) => {…} 这种写法"}]}');
  return L.join('\n');
}

function buildPrereqLessonPrompt(s, p) {
  const lines = String(s.code || '').split('\n');
  const L = [];
  L.push('用户在看一段代码，他说**不知道「' + p.title + '」这个概念**' + (p.why ? '（它会出现在：' + p.why + '）' : '') + '。');
  L.push('请把这个概念给他讲明白 —— 这是他看懂那段代码之前必须补上的一课。');
  L.push('');
  const ub = userBlock(s.goal_id);
  if (ub) { L.push('【他的情况】'); L.push(ub); L.push(''); }
  L.push('【他正在看的代码（带行号，供你取例子）】');
  L.push(numCode(lines));
  L.push('');
  L.push('【怎么讲】');
  L.push('· 300~500 字，大白话；先一句话说"这是个什么东西 / 用来干嘛"，再拆开讲，');
  L.push('  然后用**这段代码里的那一行**当例子走一遍（让人一看就知道"原来是它"），最后一行给 `**记住：**……`（≤25 字）；');
  L.push('· 只讲这个概念，**不要顺带讲这段代码别的行在干什么**（那是下一步的事）；');
  L.push('· 讲它必须牵扯到别的概念时，一句话带过就行，不要展开成第二节课；');
  L.push('· 能用生活里的类比就用；术语第一次出现就一句话解释；不客套、不写长篇总结。');
  return L.join('\n');
}

/* ---------------- 提示词 ---------------- */

/** 第 1 步：让 AI 把整段代码划成讲解模块（这是"分块权交给 AI"的地方） */
function buildOutlinePrompt(s) {
  const lines = String(s.code || '').split('\n');
  const L = [];
  L.push('你是「代码讲解员」。用户贴了一段他看不太懂的代码。讲之前，先把它**划分成讲解模块** ——');
  L.push('他点某一行，看到的就是那一行所属模块的讲解。所以模块切得好不好，直接决定他看得顺不顺。');
  L.push('');
  const ub = userBlock(s.goal_id);
  if (ub) { L.push('【他的情况】'); L.push(ub); L.push(''); }
  if (s.note) L.push('【他说这段代码是】' + String(s.note).slice(0, 200));
  L.push('【完整代码（前面是行号；说"第 N 行"就用这个号）】');
  L.push(numCode(lines));
  L.push('');
  L.push('【怎么划模块】');
  L.push('· 一个模块 = **一个完整的意思**：一条语句 / 一个对象或数组字面量 / 一个小分支 / 一串相关的赋值 / 一个函数骨架 / 一段独立的小逻辑。');
  L.push('· **覆盖每一行**：从第 1 行到第 ' + lines.length + ' 行，首尾相接、不重不漏（不许有哪一行没人管）。');
  L.push('· 大小看意思、不看行数：常见 2~12 行；某个关键的单行（比如 `main()`、`return`、一个 `await`）可以自己一个模块。');
  L.push('· **下面这些必须并进相邻模块，不许单独成模块**（这是用户明确抱怨过的点）：');
  L.push('  - 空行，和只有 `}`、`});`、`)`、`]`、`};` 这类收尾符号的行；');
  L.push('  - 一条语句/表达式跨了多行（函数调用、链式调用、多行条件）；');
  L.push('  - 一段注释和它紧接着说明的那几行；');
  L.push('· 也别机械地两行一块、更别把整段揉成一个大块：100 行左右的代码一般 8~15 个模块。');
  L.push('· title：≤16 字的名词短语，写"这一块在做什么"（例：建一条按行读的管道 / 声明三个工具 / 收尾并退出）。别写成"第 3-5 行"这种废话。');
  L.push('');
  L.push('【只输出一个 JSON 对象，不要任何别的文字或代码块标记】');
  L.push('{"modules":[{"from":1,"to":3,"title":"引入依赖、建按行读的管道"}]}');
  return L.join('\n');
}

/** 第 2 步：按模块讲（一批一次调用；批次边界就是模块边界） */
function buildExplainPrompt(s, batch, first) {
  const lines = String(s.code || '').split('\n');
  const L = [];
  L.push('你是「代码讲解员」。用户贴了一段他看不太懂的代码，你要把它**一块一块讲明白**。');
  L.push('界面是这样的：左边是他的代码（每行都有行号、可以点），右边是你对**他点的那一行所属模块**的讲解。');
  L.push('');
  const ub = userBlock(s.goal_id);
  if (ub) { L.push('【他的情况】'); L.push(ub); L.push(''); }
  if (s.note) L.push('【他说这段代码是】' + String(s.note).slice(0, 200));
  L.push('【完整代码（前面是行号；说"第 N 行"就用这个号）】');
  L.push(numCode(lines));
  L.push('');
  L.push('【你这次只讲】第 ' + batch.from + ' 行 ~ 第 ' + batch.to + ' 行');
  if (batch.from > 1) L.push('（前面的行已经讲过了，别重复；从第 ' + batch.from + ' 行接着往下讲）');
  /* 他刚补过课的前置概念：讲到这里一句话带过，别再重讲一遍。
     ⚠️ 必须读**库里最新**的 prereqs：`s` 是这一轮任务开始时的快照，那会儿小课可能还没写出来。 */
  let learned = [];
  try {
    const fresh = db.prepare('SELECT prereqs FROM explain_sessions WHERE id = ?').get(Number(s.id));
    learned = parsePrereqs(fresh && fresh.prereqs).filter(p => p.state === 'done' && p.lesson).map(p => p.title);
  } catch (e) { learned = []; }
  if (learned.length) L.push('（他已经在你之前补过这些前置概念的小课：' + learned.join('、') + ' —— 用到时一句话带过即可，别重讲；不确定就用一句话"就是之前那节的 XXX"。）');
  const mods = batch.modules || [];
  if (mods.length) {
    L.push('');
    L.push('【这一段里要讲的模块（已按顺序排好，一块讲一段）】');
    for (const m of mods) L.push('· 第 ' + m.from + '-' + m.to + ' 行：' + (m.title || '（这块没名字，你给它起一个）'));
    L.push('标题就写成 `### 第 N-M 行 · 模块名`（N-M 用上面给的范围）。');
    L.push('如果某个模块内容多，可以在它**内部**再拆成两三块讲，但每块的范围必须落在该模块内；不许把两个模块并成一块，也不许漏掉任何一个模块。');
  } else {
    L.push('');
    L.push('【怎么分块 —— 按"意思"分，不按"行"分】');
    L.push('一块 = **一个完整的意思**（一条语句 / 一个对象字面量 / 一个小分支 / 一串连着的赋值）。标题写成 `### 第 N 行` 或 `### 第 N-M 行`。');
    L.push('空行、只有 `}`、`});`、`)`、`]` 这类收尾符号的行、一条跨多行的语句、一段注释与它说明的代码 —— **必须并进相邻那一块，不许单独成块**。');
    L.push('也别硬凑：不相干的代码不要塞进同一块，一块最多 10 行左右。');
  }
  L.push('从第 ' + batch.from + ' 行按顺序讲到第 ' + batch.to + ' 行：**不许漏行、不许乱序、不许超过第 ' + batch.to + ' 行**。');
  const sb = styleBlock();
  const hasStyle = !!sb;
  if (hasStyle) { L.push(''); L.push(sb); }
  L.push('');
  L.push(hasStyle ? STYLE_RULES : NO_STYLE_RULES);
  L.push('');
  L.push('【讲法】');
  L.push('· 大白话、短句；能用生活里的类比就用（"这行相当于给门口挂了个牌子"）；');
  L.push('· 术语第一次出现就一句话解释；不客套、不写长篇总结、不复述他已知的；');
  if (!hasStyle) L.push(BREVITY);
  L.push('· 代码用 ``` 围栏并标语言；不要输出 JSON、不要写"第几步"这类元信息，也**不要问他"能跟上吗"**');
  L.push('  （他是点开来看的，不是在这儿跟你对话）。');
  if (hasStyle) L.push('· 上面【讲解风格】那段是他的硬要求：语气、详略、排版照它来；冲突时**风格优先**。');
  if (first) {
    L.push('');
    L.push('【这次是第 1 段】他还什么都没看过，所以：');
    L.push('① 最前面先写一个概览块，标题固定写 `### 概览`：3~5 句话说清 —— 这段代码整体是干什么的、大概分成哪几块、数据从哪儿流到哪儿；不要逐行展开、不要列提纲；');
    L.push('② 整段讲解的最后另起一行附上下面这一行（系统会收走，他看不到）：');
    L.push('   [[NAME: 这段代码的名字（≤20 字，名词短语、像目录标题，例：MCP stdio 服务器的主循环）]]');
  }
  return L.join('\n');
}

function buildAskPrompt(s, anchor, line, history, text, kind) {
  const lines = String(s.code || '').split('\n');
  const L = [];
  L.push('你是「代码讲解员」。用户在看一段代码，点开了**第 ' + line + ' 行**的讲解，现在追问了一句。');
  L.push('（他的界面：左边是代码、右边是讲解；他点哪一行就看哪一行。你的回答只会出现在这一行下面。）');
  L.push('');
  L.push('【完整代码（带行号）】');
  L.push(numCode(lines));
  L.push('');
  L.push('【他点开的是】第 ' + line + ' 行：`' + String(lines[line - 1] || '').trim() + '`');
  const cover = db.prepare("SELECT content, title FROM explain_turns WHERE session_id = ? AND role = 'ai' AND kind = 'explain' AND line_from <= ? AND line_to >= ? ORDER BY line_from LIMIT 1")
    .get(Number(s.id), line, line);
  if (cover && cover.title) L.push('（这一行属于讲解模块「' + cover.title + '」）');
  if (cover && cover.content) {
    L.push('【这一行你已经讲过的内容（别整段重复它）】');
    L.push(String(cover.content).slice(0, 1600));
  }
  if (history.length) {
    L.push('【这一行的问答记录（旧 → 新）】');
    for (const t of history) L.push((t.role === 'me' ? '他：' : '你：') + String(t.content).replace(/\s+/g, ' ').slice(0, 300));
  }
  const K = {
    redo: '【他没看懂，要你重讲】换一个更小的切口或更贴生活的类比重讲这一行（可以拆到词、拆到"它在生活里相当于什么"）；别重复上次的原话，也别往下讲别的行。',
    example: '【他想要例子】给一个最小、具体、能口算或能跑的小例子（≤6 行，``` 围栏），再用一句话说"所以这一行就是…"。',
    why: '【他问为什么】讲清"不这么写会出什么问题"，最好给一个反例（一两行代码或一句话说清它会怎样）。',
    ask: ''
  };
  L.push('');
  L.push('【怎么答】');
  L.push('· 只回答他问的这一点；如果问题牵扯到别的行，先用一句话点明"这跟第 M 行有关"，再只讲这一点，别顺手把那一行也讲一遍；');
  L.push(styleSample()
    ? '· **风格照他给的示例来**（语气、详略、排版都学它：示例短就短答、示例里没有小标题就别加）；'
    : '· 3~6 句说完；要举例就给一小段（≤6 行，``` 围栏）；能用生活里的类比就用；');
  L.push('· 大白话、不客套；不要输出 JSON 或"元信息"；不要反问他"能跟上吗"（他不在跟你对话）。');
  if (K[kind]) L.push(K[kind]);
  L.push('');
  L.push('【他这次的追问（原话，别改成你理解的样子）】' + String(text).slice(0, 2000));
  return L.join('\n');
}

/* ---------------- AI 调用（挂到左下角任务栏，让"在干活"看得见、能停） ---------------- */

function aiJob({ title, note, goalId, nodeId, message, run, phases }) {
  /* 进度归统一模型（`server/task-progress.js`）：
     · 没声明 phases 的一次性 AI 调用 → 按时间平滑（前端标"估算"）；
     · 声明了 phases 的长流程 → 条照着阶段走。
     原来这里手搓了一份 `1 - exp(-秒/20)`，跟 interview / quests / restate / jdfile
     各抄的那几份还不一样 —— 现在全仓只有一份实现。 */
  const job = tasks.begin({ type: 'explain', title, note, goalId, nodeId, message, phases });
  return (async () => {
    try {
      const r = await run(job);
      job.done(r);            // done() 会把条收到 100%
      return r;
    } catch (e) {
      job.fail(e);
      throw e;
    }
  })();
}

/* ---------------- 落库 ---------------- */

function insertTurn(sid, from, to, role, kind, content, title) {
  db.prepare('INSERT INTO explain_turns (session_id,line_from,line_to,role,kind,title,content,created_at) VALUES (?,?,?,?,?,?,?,?)')
    .run(Number(sid), Math.max(0, Number(from) || 0), Math.max(0, Number(to) || 0), role, kind,
      String(title || '').slice(0, 40), String(content || '').slice(0, 20000), nowISO());
}
function turnsOf(sid, limit) {
  return db.prepare('SELECT * FROM explain_turns WHERE session_id = ? ORDER BY id LIMIT ?').all(Number(sid), limit || 600);
}
function parseModules(raw) {
  try {
    const a = JSON.parse(String(raw || '[]'));
    if (!Array.isArray(a)) return [];
    return a.map(m => ({ from: Number(m && m.from) || 0, to: Number(m && m.to) || 0, title: String((m && m.title) || '') }))
      .filter(m => m.from >= 1 && m.to >= m.from);
  } catch (e) { return []; }
}
function sessionOut(row, withCode) {
  if (!row) return null;
  const mods = parseModules(row.modules);
  const pre = parsePrereqs(row.prereqs);
  const o = {
    id: row.id, goal_id: row.goal_id, node_id: row.node_id, tutorial_id: row.tutorial_id,
    title: row.title, note: row.note, lang: row.lang, lines: row.lines, explained: row.explained,
    status: row.status, last_error: row.last_error, renamed: Number(row.renamed || 0),
    modules: mods, modules_n: mods.length,
    prereqs: pre, prereqs_n: pre.length,
    created_at: row.created_at, updated_at: row.updated_at
  };
  if (withCode) o.code = row.code;
  return o;
}
function turnsOut(rows) {
  return (rows || []).map(t => ({ id: t.id, line_from: t.line_from, line_to: t.line_to, role: t.role, kind: t.kind, title: t.title || '', content: t.content, created_at: t.created_at }));
}
/** 每一行有没有讲解（用于算"讲到哪儿了"和"哪些模块还没讲"） */
function coveredSet(sid) {
  const set = new Set();
  for (const t of db.prepare("SELECT line_from, line_to FROM explain_turns WHERE session_id = ? AND role = 'ai' AND kind = 'explain'").all(Number(sid))) {
    for (let i = Number(t.line_from); i <= Number(t.line_to); i++) set.add(i);
  }
  return set;
}
/** 已经"讲到哪儿了"= **连续**覆盖到第几行（并行讲解时中间可能有洞，进度只能算连续的段） */
function frontierOf(covered, total) {
  let n = 0;
  while (n < total && covered.has(n + 1)) n++;
  return n;
}
/** 还没讲的模块：只要有行没被讲，就算没讲完（并行时前面的模块可能先完成） */
function pendingModules(modules, covered) {
  return (modules || []).filter(m => {
    for (let i = m.from; i <= m.to; i++) if (!covered.has(i)) return true;
    return false;
  });
}
/** 这一行属于哪一段讲解（追问挂到那一段上）；没讲到就返回 null。 */
function coveredBy(sid, line) {
  const r = db.prepare("SELECT line_from, line_to, title FROM explain_turns WHERE session_id = ? AND role = 'ai' AND kind = 'explain' AND line_from <= ? AND line_to >= ? ORDER BY line_from LIMIT 1")
    .get(Number(sid), Number(line), Number(line));
  return r ? { from: Number(r.line_from), to: Number(r.line_to), title: r.title || '' } : null;
}

/* ---------------- 讲解作业 ----------------
   ① 先让 AI 把整段代码划成"讲解模块"（一次调用）；
   ② 然后**并行**把每个模块的讲解生成好（不等用户点，点开就有；一个模块一个子任务，
      折叠进主任务里显示）；批次边界永远落在模块边界上。
   ⚠️ 并行会带来"中间有洞"（第 3 块讲完了、第 2 块还在跑）：所以进度用
      produced/total 个模块算，`explained`（连续到第几行）只用来给界面显示"讲到哪儿"。
   ⚠️ 同一时刻最多 PAR_CONC 个 AI 调用：用户的接口通常扛不住十几路并发。 */

const PAR_CONC = 3;

function startJob(sid) {
  const s0 = db.prepare('SELECT * FROM explain_sessions WHERE id = ?').get(Number(sid));
  if (!s0) return { started: false, reason: 'notfound' };
  const total = Number(s0.lines || 0);
  if (!total) return { started: false, reason: 'empty' };
  if (RUNNING.has(Number(sid))) return { started: false, reason: 'running' };
  /* 已经全部讲完（点「继续讲」但没东西可讲）→ 不重复调 AI */
  try {
    const mods0 = parseModules(s0.modules);
    if (mods0.length && !pendingModules(mods0, coveredSet(sid)).length) {
      db.prepare("UPDATE explain_sessions SET status='done', last_error='', updated_at=? WHERE id=?").run(nowISO(), sid);
      return { started: false, reason: 'done' };
    }
  } catch (e) {}
  RUNNING.add(Number(sid));
  db.prepare("UPDATE explain_sessions SET status='working', last_error='', updated_at=? WHERE id=?").run(nowISO(), sid);

  const lines = String(s0.code || '').split('\n');
  const title = String(s0.title || '一段代码').slice(0, 24);
  const failStop = (msg) => {
    try {
      db.prepare("UPDATE explain_sessions SET status='idle', last_error=?, updated_at=? WHERE id=?")
        .run(String(msg || '').slice(0, 200), nowISO(), sid);
    } catch (e2) {}
    RUNNING.delete(Number(sid));
  };
  try {
    aiJob({
      title: '看懂代码：' + title, note: '', goalId: s0.goal_id, nodeId: s0.node_id,
      message: '正在逐行讲解…',
      phases: ['划分讲解模块', '逐块讲解'],
      run: async (job) => {
        const signal = job.signal;
        const aborted = () => !!(signal && signal.aborted);
        const kids = new Set();                       // 正在跑的子任务 id（主任务被停时一起停）
        /* 用户点「停止」停的是主任务：把正在跑的子任务一起停掉，否则它们会继续烧 AI 调用 */
        if (signal && signal.addEventListener) {
          signal.addEventListener('abort', () => {
            for (const id of kids) { try { tasks.cancel(id); } catch (e) {} }
          });
        }
        let modules = parseModules(s0.modules);

        /* ---------- ⓪ 前置知识：先列出来问他知不知道 ---------- */
        let prereqs = parsePrereqs(s0.prereqs);
        const needAsk = prereqs.length === 0;
        const stillTodo = prereqs.some(p => p.state === 'todo');
        if (needAsk) {
          job.progress(2, 'AI 正在看这段代码需要哪些前置知识…');
          let raw = '';
          try {
            raw = await aiText(buildPrereqPrompt(s0), currentModel(), 180000, null, signal, '前置知识');
          } catch (e) {
            if (aborted()) throw e;
            log('[explain] 列前置知识失败（跳过这一步继续讲）：' + ((e && e.message) || e));
          }
          prereqs = parsePrereqJson(raw);
          savePrereqs(sid, prereqs);
          db.prepare("UPDATE explain_sessions SET status = ?, updated_at = ? WHERE id = ?").run(prereqs.length ? 'prereq' : 'working', nowISO(), sid);
          if (prereqs.length) {
            /* 列出来了 → 停下来等他点"知道/不知道"（他会 POST /prereqs，那边再把这个任务接着跑） */
            return { session_id: Number(sid), waiting: 'prereqs', prereqs: prereqs.length };
          }
          /* 一个都不需要 → 直接照旧往下讲 */
        } else if (stillTodo) {
          db.prepare("UPDATE explain_sessions SET status = 'prereq', updated_at = ? WHERE id = ?").run(nowISO(), sid);
          return { session_id: Number(sid), waiting: 'prereqs', prereqs: prereqs.length };
        }
        db.prepare("UPDATE explain_sessions SET status = 'working', updated_at = ? WHERE id = ?").run(nowISO(), sid);

        /* 他不知道的那些前置概念：一人一小节课（并行；和代码讲解同时跑，他读课的时候代码也在写） */
        const toTeach = () => parsePrereqs(db.prepare('SELECT prereqs FROM explain_sessions WHERE id = ?').get(sid).prereqs)
          .filter(p => p.state === 'unknown' && !p.lesson);
        const teachOne = async (p) => {
          const kid = tasks.begin({
            type: 'explain', parentId: job.id, goalId: s0.goal_id, nodeId: s0.node_id,
            title: '前置知识：' + p.title, message: 'AI 正在写这一课…'
          });
          kids.add(kid.id);
          try {
            const raw = await aiText(buildPrereqLessonPrompt(s0, p), currentModel(), 180000, null, kid.signal, '前置知识讲解');
            const body = String(raw || '').trim();
            if (!body) throw new Error('这一课没写出内容');
            const cur = parsePrereqs(db.prepare('SELECT prereqs FROM explain_sessions WHERE id = ?').get(sid).prereqs);
            const i = cur.findIndex(x => x.id === p.id);
            if (i >= 0) { cur[i].lesson = body.slice(0, 8000); cur[i].state = 'done'; savePrereqs(sid, cur); }
            kid.progress(100, '完成');
            kid.done({ prereq: p.id });
            return true;
          } catch (e) {
            kid.fail(e);
            return false;
          } finally { kids.delete(kid.id); }
        };
        const lessonsJob = (async () => {
          const list = toTeach();
          let cursor = 0;
          const workers = Array.from({ length: Math.max(1, Math.min(PAR_CONC, list.length)) }, () => (async () => {
            for (;;) {
              if (aborted()) return;
              const my = cursor++;
              if (my >= list.length) return;
              await teachOne(list[my]);
            }
          })());
          await Promise.all(workers);
        })();

        /* ---------- ① 划模块（AI 决定分块；不行就退回机械切段） ---------- */
        if (!modules.length) {
          job.phase(0, 'AI 正在读整段、划分讲解模块…');
          let raw = '';
          try {
            raw = await aiText(buildOutlinePrompt(s0), currentModel(), 180000, null, signal, '划分讲解模块');
          } catch (e) {
            if (aborted()) throw e;
            log('[explain] 划模块失败，退回机械切段：' + ((e && e.message) || e));
          }
          modules = normModules(parseOutline(raw), total, lines);
          if (!modules.length) modules = fallbackModules(lines, 1);
          db.prepare('UPDATE explain_sessions SET modules = ?, updated_at = ? WHERE id = ?').run(JSON.stringify(modules), nowISO(), sid);
          log('[explain] 会话 #' + sid + ' 划出 ' + modules.length + ' 个模块');
        }

        /* ---------- ② 并行讲：每个批次一个子任务 ---------- */
        const covered = coveredSet(sid);
        const pending = pendingModules(modules, covered);
        const totalMods = modules.length;
        let doneMods = totalMods - pending.length;
        /* 相邻的小模块两个合成一次调用（省一半调用）；批次边界仍在模块边界上 */
        const batches = buildBatches(pending, 1, { maxLines: 22, maxMods: 2 });
        const mark = () => {
          const cov = coveredSet(sid);
          const front = frontierOf(cov, total);
          db.prepare('UPDATE explain_sessions SET explained = ?, updated_at = ? WHERE id = ?').run(front, nowISO(), sid);
          return { front, cov };
        };
        job.phase(1);
        job.count(doneMods, totalMods, '已讲 ' + doneMods + '/' + totalMods + ' 个模块…');

        const runOne = async (batch, idx) => {
          const label = '第 ' + batch.from + (batch.to > batch.from ? '-' + batch.to : '') + ' 行'
            + (batch.modules.length ? ' · ' + batch.modules.map(m => m.title || '（未命名）').join(' / ').slice(0, 40) : '');
          const kid = tasks.begin({
            type: 'explain', parentId: job.id, goalId: s0.goal_id, nodeId: s0.node_id,
            title: label, message: 'AI 正在写这一块…'
          });
          kids.add(kid.id);
          try {
            const raw = await aiText(buildExplainPrompt(s0, batch, Number(s0.explained || 0) === 0 && idx === 0), currentModel(), 240000, null, kid.signal, '代码讲解');
            const parsed = parseExplain(raw);
            const blocks = mergeFragments(toBlocks(parsed.items, batch.from, batch.to), lines);
            if (parsed.name && !Number(s0.renamed)) {
              db.prepare('UPDATE explain_sessions SET title = ?, updated_at = ? WHERE id = ?').run(parsed.name, nowISO(), sid);
            }
            if (parsed.overview && Number(s0.explained || 0) === 0 && idx === 0) insertTurn(sid, 0, 0, 'ai', 'overview', parsed.overview, '概览');
            /* 标题：块自己带的（`### 第 N-M 行 · 名字`）优先，否则用覆盖它的那个模块名 */
            const titleOf = (b) => {
              if (b.title) return b.title;
              const m = batch.modules.find(x => b.from >= x.from && b.to <= x.to);
              return m ? m.title : '';
            };
            if (blocks.length) {
              for (const b of blocks) insertTurn(sid, b.from, b.to, 'ai', 'explain', b.text, titleOf(b));
            } else {
              /* 一个块都没解析出来：整块存成一块（他点开还能看），标题用模块名 */
              const whole = String(parsed.pre || raw || '').trim();
              if (!whole) throw new Error('AI 这一块没写出内容');
              insertTurn(sid, batch.from, batch.to, 'ai', 'explain', whole, titleOf({ from: batch.from, to: batch.to }));
            }
            kid.done({ from: batch.from, to: batch.to, modules: batch.modules.length });
            return batch.modules.length || 1;
          } catch (e) {
            kid.fail(e);
            return 0;
          } finally {
            kids.delete(kid.id);
          }
        };

        /* 并行池：同一时刻最多 PAR_CONC 个子任务 */
        let cursor = 0;
        const workers = Array.from({ length: Math.max(1, Math.min(PAR_CONC, batches.length)) }, () => (async () => {
          for (;;) {
            if (aborted()) return;
            const my = cursor++;
            if (my >= batches.length) return;
            const got = await runOne(batches[my], my);
            if (got) {
              doneMods += got;
              const st = mark();
              job.count(doneMods, totalMods, '已讲 ' + doneMods + '/' + totalMods + ' 个模块（讲到第 ' + st.front + ' 行）');
            }
          }
        })());
        await Promise.all(workers);
        await lessonsJob;               // 前置知识的小课也等它写完（和代码讲解并行跑的）

        if (aborted()) { const e = new Error('已停止'); e.cancelled = true; throw e; }
        const st = mark();
        const left = pendingModules(modules, st.cov).length;
        if (left) {
          const e2 = new Error('还有 ' + left + ' 个模块没讲成（其它都讲好了），点「继续讲」重试');
          e2.partial = true;
          throw e2;
        }
        db.prepare("UPDATE explain_sessions SET status='done', last_error='', updated_at=? WHERE id=?").run(nowISO(), sid);
        return { session_id: Number(sid), explained: st.front, modules: totalMods };
      }
    }).catch(e => {
      const cancelled = !!(e && (e.cancelled || e.name === 'AbortError'));
      failStop(cancelled ? '已停止' : ((e && e.message) || String(e)));
    }).finally(() => {
      RUNNING.delete(Number(sid));
      try { backup(); } catch (e) {}
    });
  } catch (e) {
    /* 任务队列本身就没接住（极少见）：别让会话永远挂在"正在讲" */
    failStop('开不了后台任务：' + ((e && e.message) || e));
    return { started: false, reason: 'error' };
  }
  return { started: true };
}

/* ---------------- 路由 ---------------- */

module.exports = {
  id: 'explain',
  name: '看懂代码',
  icon: '🔍',
  desc: '把一段看不太懂的代码整段贴进来：AI 逐行讲明白 —— 左边是代码、右边是讲解，点哪一行就看哪一行，哪行没看懂就在哪行下面追问；教程里的代码块自动编上号，右键（或点编号）就能丢进来讲',
  category: '学习与练习',
  order: 45,
  goalToggle: true,
  defaultEnabled: true,
  client: '/plugins/explain.js',

  init(ctx) {
    bind(ctx);
    /* 这个组件替换掉了早先的「带练」（提纲式一问一答）：旧表直接清掉 ——
       它的形状与新数据完全不同，留着只会让后来人误读（用户已确认可以清）。 */
    try { db.exec('DROP TABLE IF EXISTS coach_turns; DROP TABLE IF EXISTS coach_sessions;'); } catch (e) {}
    db.exec(SCHEMA);
    /* 老库补列：模块大纲（modules）与模块名（title）都是后加的 */
    try {
      const sc = db.prepare('PRAGMA table_info(explain_sessions)').all().map(c => c.name);
      if (!sc.includes('modules')) db.exec("ALTER TABLE explain_sessions ADD COLUMN modules TEXT NOT NULL DEFAULT '[]';");
      if (!sc.includes('prereqs')) db.exec("ALTER TABLE explain_sessions ADD COLUMN prereqs TEXT NOT NULL DEFAULT '[]';");
      const tc = db.prepare('PRAGMA table_info(explain_turns)').all().map(c => c.name);
      if (!tc.includes('title')) db.exec("ALTER TABLE explain_turns ADD COLUMN title TEXT NOT NULL DEFAULT '';");
    } catch (e) {}
    /* 进程重启后内存里的任务没了：把库里挂着的 working 复位成 idle，用户点「继续讲」即可续上 */
    try {
      db.prepare("UPDATE explain_sessions SET status='idle', last_error=?, updated_at=? WHERE status='working'")
        .run('服务重启，讲解中断了（点「继续讲」接着讲）', nowISO());
    } catch (e) {}
  },

  onGoalDelete(goalId, ctx) {
    try {
      const ids = db.prepare('SELECT id FROM explain_sessions WHERE goal_id = ?').all(Number(goalId)).map(r => r.id);
      for (const id of ids) db.prepare('DELETE FROM explain_turns WHERE session_id = ?').run(id);
      db.prepare('DELETE FROM explain_sessions WHERE goal_id = ?').run(Number(goalId));
    } catch (e) { log('[explain] 清理失败:', e.message); }
  },

  api: [
    /* 讲解记录列表 */
    {
      method: 'GET', path: '/api/explain/sessions',
      handler: async (req, res, u, ctx) => {
        const goalId = Number(u.searchParams.get('goal_id') || 0);
        const tutId = Number(u.searchParams.get('tutorial_id') || 0);
        if (goalId && !compOn(goalId)) return sendJSON(res, 403, { error: '「看懂代码」组件已关闭' });
        let sql = `SELECT s.id, s.goal_id, s.node_id, s.tutorial_id, s.title, s.note, s.lang, s.lines, s.explained, s.modules,
          s.status, s.last_error, s.renamed, s.created_at, s.updated_at,
          (SELECT COUNT(*) FROM explain_turns t WHERE t.session_id = s.id AND t.role = 'me') AS asked
          FROM explain_sessions s WHERE 1=1`;
        const args = [];
        if (goalId) { sql += ' AND s.goal_id = ?'; args.push(goalId); }
        if (tutId) { sql += ' AND s.tutorial_id = ?'; args.push(tutId); }
        sql += ' ORDER BY s.updated_at DESC, s.id DESC LIMIT 60';
        const rows = db.prepare(sql).all(...args);
        /* 列表里要显示"已讲 x/y 个模块"：一次性把这几条会话的已讲行捞出来算覆盖，
           别一条会话一条会话地查（并行讲解时中间可能有洞，光看 explained 会低估）。 */
        const cov = new Map();
        if (rows.length) {
          try {
            const ids = rows.map(r => Number(r.id));
            const ts = db.prepare(`SELECT session_id, line_from, line_to FROM explain_turns
              WHERE role = 'ai' AND kind = 'explain' AND session_id IN (${ids.map(() => '?').join(',')})`).all(...ids);
            for (const t of ts) {
              let set = cov.get(Number(t.session_id));
              if (!set) { set = new Set(); cov.set(Number(t.session_id), set); }
              for (let i = Number(t.line_from); i <= Number(t.line_to); i++) set.add(i);
            }
          } catch (e) {}
        }
        const list = rows.map(r => {
          const o = Object.assign(sessionOut(r), { asked: Number(r.asked || 0) });
          const set = cov.get(Number(r.id));
          o.modules_done = o.modules.filter(m => {
            if (!set) return false;
            for (let i = m.from; i <= m.to; i++) if (!set.has(i)) return false;
            return true;
          }).length;
          return o;
        });
        return sendJSON(res, 200, { sessions: list });
      }
    },

    /* 新建一次讲解：立刻返回，讲解在后台逐段进行（前端轮询进度） */
    {
      method: 'POST', path: '/api/explain/sessions',
      handler: async (req, res, u, ctx) => {
        const b = await readBody(req).catch(() => ({}));
        const goalId = Number(b.goal_id || 0);
        if (!goalId) return sendJSON(res, 400, { error: '缺少目标' });
        if (!compOn(goalId)) return sendJSON(res, 403, { error: '「看懂代码」组件已关闭' });
        const code = String(b.code || '').replace(/\r\n?/g, '\n').replace(/\s+$/, '');
        if (!code.trim()) return sendJSON(res, 400, { error: '先把要讲的代码贴进来' });
        const lines = code.split('\n');
        if (lines.length > MAX_LINES) return sendJSON(res, 400, { error: '这段太长（' + lines.length + ' 行），分两次贴吧：一次最多 ' + MAX_LINES + ' 行' });
        if (code.length > MAX_CHARS) return sendJSON(res, 400, { error: '这段太长了（' + Math.round(code.length / 1000) + 'k 字），分两次贴吧' });
        const tid = Number(b.tutorial_id || 0);
        const tut = tid ? tutOf(tid) : null;
        const nid = Number(b.node_id || 0) || (tut ? Number(tut.node_id || 0) : 0);
        const note = String(b.note || '').replace(/\s+/g, ' ').trim().slice(0, 200);
        const lang = detectLang(code);
        const title = String(b.title || '').replace(/\s+/g, ' ').trim().slice(0, 40)
          || (lang ? lang + ' 代码' : '一段代码') + ' · ' + lines.length + ' 行';
        const now = nowISO();
        const info = db.prepare(`INSERT INTO explain_sessions
          (goal_id,node_id,tutorial_id,title,note,lang,code,lines,explained,status,last_error,renamed,created_at,updated_at)
          VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
          .run(goalId, nid, tid, title, note, lang, code, lines.length, 0, 'working', '', 0, now, now);
        const sid = Number(info.lastInsertRowid);
        backup();
        startJob(sid);
        return sendJSON(res, 200, { ok: true, session: sessionOut(db.prepare('SELECT * FROM explain_sessions WHERE id = ?').get(sid), true) });
      }
    },

    /* 讲解风格示例：读 / 存（空字符串 = 恢复默认风格） */
    {
      method: 'GET', path: '/api/explain/style',
      handler: async (req, res, u, ctx) => {
        const s = styleSample();
        return sendJSON(res, 200, { ok: true, sample: s, len: s.length, max: STYLE_MAX });
      }
    },
    {
      method: 'POST', path: '/api/explain/style',
      handler: async (req, res, u, ctx) => {
        const b = await readBody(req).catch(() => ({}));
        const raw = String(b.sample == null ? '' : b.sample).replace(/\r\n?/g, '\n').trim().slice(0, STYLE_MAX);
        try { setSetting(STYLE_KEY, raw); } catch (e) { return sendJSON(res, 500, { error: '保存失败：' + e.message }); }
        backup();
        return sendJSON(res, 200, { ok: true, sample: raw, len: raw.length, max: STYLE_MAX });
      }
    },

    /* 前置知识：用户点完「知道 / 不知道」→ 记下来，然后把讲解接着跑起来 */
    {
      method: 'POST', pattern: /^\/api\/explain\/sessions\/(\d+)\/prereqs$/,
      handler: async (req, res, u, ctx) => {
        const sid = Number(u.pathname.match(/(\d+)/)[1]);
        const row = db.prepare('SELECT * FROM explain_sessions WHERE id = ?').get(sid);
        if (!row) return sendJSON(res, 404, { error: '这次讲解不存在' });
        if (row.goal_id && !compOn(row.goal_id)) return sendJSON(res, 403, { error: '「看懂代码」组件已关闭' });
        if (RUNNING.has(Number(sid))) return sendJSON(res, 409, { error: '正在生成，稍等一下再点' });
        const b = await readBody(req).catch(() => ({}));
        const list = parsePrereqs(row.prereqs);
        if (!list.length) return sendJSON(res, 400, { error: '这次讲解没有待确认的前置知识' });
        const skip = !!b.skip;
        const unknown = new Set((Array.isArray(b.unknown) ? b.unknown : []).map(String));
        for (const p of list) {
          if (skip) p.state = 'known';
          else p.state = unknown.has(p.id) ? 'unknown' : 'known';
          if (p.state === 'known') p.lesson = '';
        }
        savePrereqs(sid, list);
        backup();
        const r = startJob(sid);
        return sendJSON(res, 200, {
          ok: true, started: !!r.started, reason: r.reason || '',
          session: sessionOut(db.prepare('SELECT * FROM explain_sessions WHERE id = ?').get(sid), true)
        });
      }
    },

    /* 详情（含代码与全部讲解 / 追问） */
    {
      method: 'GET', pattern: /^\/api\/explain\/sessions\/(\d+)$/,
      handler: async (req, res, u, ctx) => {
        const sid = Number(u.pathname.match(/(\d+)/)[1]);
        const row = db.prepare('SELECT * FROM explain_sessions WHERE id = ?').get(sid);
        if (!row) return sendJSON(res, 404, { error: '这次讲解不存在' });
        if (row.goal_id && !compOn(row.goal_id)) return sendJSON(res, 403, { error: '「看懂代码」组件已关闭' });
        const tut = row.tutorial_id ? tutOf(row.tutorial_id) : null;
        const st = styleSample();
        return sendJSON(res, 200, {
          session: sessionOut(row, true),
          tutorial: tut ? { id: tut.id, title: tut.title, node_id: tut.node_id } : null,
          style: { custom: !!st, len: st.length },
          turns: turnsOut(turnsOf(sid, 600))
        });
      }
    },

    /* 按新风格重讲这一段：把已讲好的讲解丢掉重来（追问记录保留） */
    {
      method: 'POST', pattern: /^\/api\/explain\/sessions\/(\d+)\/redo$/,
      handler: async (req, res, u, ctx) => {
        const sid = Number(u.pathname.match(/(\d+)/)[1]);
        const row = db.prepare('SELECT * FROM explain_sessions WHERE id = ?').get(sid);
        if (!row) return sendJSON(res, 404, { error: '这次讲解不存在' });
        if (row.goal_id && !compOn(row.goal_id)) return sendJSON(res, 403, { error: '「看懂代码」组件已关闭' });
        if (RUNNING.has(Number(sid))) return sendJSON(res, 409, { error: '这一条正在讲，等它停下来再重讲' });
        db.prepare("DELETE FROM explain_turns WHERE session_id = ? AND role = 'ai' AND kind IN ('explain','overview')").run(sid);
        /* 前置知识的小课也一起作废（让他按新风格重写），但"知不知道"的判断留着 */
        const pre0 = parsePrereqs(row.prereqs);
        for (const p of pre0) if (p.state === 'done') { p.state = 'unknown'; p.lesson = ''; }
        if (pre0.length) savePrereqs(sid, pre0);
        db.prepare("UPDATE explain_sessions SET explained = 0, status = 'idle', last_error = '', updated_at = ? WHERE id = ?").run(nowISO(), sid);
        backup();
        const r = startJob(sid);
        return sendJSON(res, 200, { ok: true, started: !!r.started, session: sessionOut(db.prepare('SELECT * FROM explain_sessions WHERE id = ?').get(sid), true) });
      }
    },

    /* 继续讲（停下 / 中断 / 失败之后接着讲，从 explained+1 行起） */
    {
      method: 'POST', pattern: /^\/api\/explain\/sessions\/(\d+)\/continue$/,
      handler: async (req, res, u, ctx) => {
        const sid = Number(u.pathname.match(/(\d+)/)[1]);
        const row = db.prepare('SELECT * FROM explain_sessions WHERE id = ?').get(sid);
        if (!row) return sendJSON(res, 404, { error: '这次讲解不存在' });
        if (row.goal_id && !compOn(row.goal_id)) return sendJSON(res, 403, { error: '「看懂代码」组件已关闭' });
        const r = startJob(sid);
        return sendJSON(res, 200, { ok: true, started: !!r.started, reason: r.reason || '', session: sessionOut(db.prepare('SELECT * FROM explain_sessions WHERE id = ?').get(sid), true) });
      }
    },

    /* 对某一行追问（回答只挂在这一行 / 这一段的记录里） */
    {
      method: 'POST', pattern: /^\/api\/explain\/sessions\/(\d+)\/ask$/,
      handler: async (req, res, u, ctx) => {
        const sid = Number(u.pathname.match(/(\d+)/)[1]);
        const row = db.prepare('SELECT * FROM explain_sessions WHERE id = ?').get(sid);
        if (!row) return sendJSON(res, 404, { error: '这次讲解不存在' });
        if (row.goal_id && !compOn(row.goal_id)) return sendJSON(res, 403, { error: '「看懂代码」组件已关闭' });
        const b = await readBody(req).catch(() => ({}));
        const total = Number(row.lines || 0);
        const line = Math.min(Math.max(1, Number(b.line || 1)), Math.max(1, total));
        const kind = ['redo', 'example', 'why', 'ask'].includes(String(b.kind)) ? String(b.kind) : 'ask';
        const text = String(b.text || '').slice(0, 2000).trim();
        if (!text) return sendJSON(res, 400, { error: '先写一句要问什么' });
        const cover = coveredBy(sid, line);
        if (!cover) return sendJSON(res, 400, { error: '第 ' + line + ' 行还没讲到，先点「继续讲」把它讲完' });
        insertTurn(sid, cover.from, cover.to, 'me', 'ask', text);
        const history = db.prepare("SELECT role, content FROM explain_turns WHERE session_id = ? AND line_from = ? AND line_to = ? ORDER BY id DESC LIMIT 8")
          .all(sid, cover.from, cover.to).reverse();
        const got = await aiJob({
          title: '看懂代码：第 ' + line + ' 行追问', note: '', goalId: row.goal_id, nodeId: row.node_id,
          message: 'AI 正在答第 ' + line + ' 行的追问…',
          run: async (job) => aiText(buildAskPrompt(row, cover, line, history, text, kind), currentModel(), 180000, null, job.signal, '代码追问')
        });
        const body = String(got || '').trim();
        if (!body) throw new Error('AI 这次没写出内容，请重试');
        insertTurn(sid, cover.from, cover.to, 'ai', 'answer', body);
        db.prepare('UPDATE explain_sessions SET updated_at = ? WHERE id = ?').run(nowISO(), sid);
        backup();
        return sendJSON(res, 200, { ok: true, turns: turnsOut(turnsOf(sid, 600)) });
      }
    },

    /* 改名 */
    {
      method: 'POST', pattern: /^\/api\/explain\/sessions\/(\d+)\/rename$/,
      handler: async (req, res, u, ctx) => {
        const sid = Number(u.pathname.match(/(\d+)/)[1]);
        const s = db.prepare('SELECT id FROM explain_sessions WHERE id = ?').get(sid);
        if (!s) return sendJSON(res, 404, { error: '这次讲解不存在' });
        const b = await readBody(req).catch(() => ({}));
        const title = String(b.title || '').replace(/\s+/g, ' ').trim().slice(0, 60);
        if (!title) return sendJSON(res, 400, { error: '名字不能为空' });
        db.prepare('UPDATE explain_sessions SET title = ?, renamed = 1, updated_at = ? WHERE id = ?').run(title, nowISO(), sid);
        backup();
        return sendJSON(res, 200, { ok: true, session: sessionOut(db.prepare('SELECT * FROM explain_sessions WHERE id = ?').get(sid)) });
      }
    },

    /* 删除 */
    {
      method: 'DELETE', pattern: /^\/api\/explain\/sessions\/(\d+)$/,
      handler: async (req, res, u, ctx) => {
        const sid = Number(u.pathname.match(/(\d+)/)[1]);
        db.prepare('DELETE FROM explain_turns WHERE session_id = ?').run(sid);
        db.prepare('DELETE FROM explain_sessions WHERE id = ?').run(sid);
        backup();
        return sendJSON(res, 200, { ok: true });
      }
    }
  ]
};
