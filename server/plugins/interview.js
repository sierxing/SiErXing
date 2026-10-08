'use strict';
/**
 * 思而行 · 模拟面试（interview）
 * ------------------------------------------------------------------
 * 一次面试 = 一份 JD + 一个项目 + 一串问答。
 *   1. JD：粘贴截图（视觉模型识别成文字）或直接贴文字
 *   2. 项目：给一个本地路径，按 code-read 的白名单只读读取（.env/密钥/node_modules 一律不可见），
 *      让 AI 生成项目摘要 —— 面试官据此问「项目深挖」类问题
 *   3. 面试：AI 照 JD + 项目摘要列一份考点清单，然后一轮一轮问；
 *      每答完一次，它先点评（好在哪/漏了什么/哪里说反了）再问下一题
 *   4. 结束：给总评 + 分数 + 该补的地方
 *
 * 与「用自己的话」一样，AI 每一步都给结构化判定，界面据此显示进度与点评。
 */
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { listCodeFiles, readCodeFiles } = require('../code-read');

let db, nowISO, safeParse, sendJSON, readBody, getSetting, setSetting, backup, log;
let getGoal, aiText, aiTextFiles, currentModel, currentVisionModel, tasks;

const SCHEMA = `
CREATE TABLE IF NOT EXISTS interview_sessions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  goal_id INTEGER NOT NULL DEFAULT 0,
  node_id INTEGER NOT NULL DEFAULT 0,
  title TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'setup',      /* setup 准备中 | running 面试中 | done 已结束 */
  jd_text TEXT NOT NULL DEFAULT '',          /* JD 正文（截图识别出来的或直接贴的） */
  jd_raw TEXT NOT NULL DEFAULT '',           /* 截图识别出的原始文本（没整理过的），留个底 */
  jd_note TEXT NOT NULL DEFAULT '',
  project_path TEXT NOT NULL DEFAULT '',
  project_digest TEXT NOT NULL DEFAULT '',   /* AI 读完代码后的项目摘要 */
  project_files TEXT NOT NULL DEFAULT '[]',  /* 读了哪些文件（相对路径） */
  focus TEXT NOT NULL DEFAULT '',            /* 这次面试重点问什么（一句话） */
  plan TEXT NOT NULL DEFAULT '[]',           /* 考点清单：[{key,name,why,level}] */
  covered TEXT NOT NULL DEFAULT '[]',        /* 已经问过的考点 key */
  remedied TEXT NOT NULL DEFAULT '[]',       /* 现场讲解补救过的题：[{turn,point,asked}] */
  rounds INTEGER NOT NULL DEFAULT 0,
  max_rounds INTEGER NOT NULL DEFAULT 8,
  summary TEXT NOT NULL DEFAULT '',
  score INTEGER NOT NULL DEFAULT -1,
  report TEXT NOT NULL DEFAULT '{}',         /* 总评的结构化结果 */
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS interview_turns (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id INTEGER NOT NULL,
  seq INTEGER NOT NULL DEFAULT 0,
  role TEXT NOT NULL DEFAULT 'ask',          /* ask 面试官问 | answer 我答 | feedback 点评 */
  text TEXT NOT NULL DEFAULT '',
  verdict TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL
);
`;

/* ---------- 小工具 ---------- */
function bind(ctx) {
  ({ db, nowISO, safeParse, sendJSON, readBody, getSetting, setSetting, backup, log } = ctx);
  ({ getGoal, aiText, aiTextFiles, currentModel, currentVisionModel, tasks } = ctx);
}
/* 统一的 AI 任务包装：给任务中心一条可看进度、可重试的记录 */
function aiJob({ type, title, note, goalId, nodeId, message, run, retry }) {
  const job = tasks.begin({ type: type || 'interview', title, note, goalId, nodeId, message, retry });
  const t0 = Date.now();
  job.progress(4, message);
  const iv = setInterval(() => {
    const sec = Math.round((Date.now() - t0) / 1000);
    const p = Math.min(93, Math.round(100 * (1 - Math.exp(-sec / 18))));
    job.progress(Math.max(4, p), message + '（已等 ' + sec + ' 秒）');
  }, 1500);
  return Promise.resolve()
    .then(() => run(job.signal))
    .then(v => { clearInterval(iv); job.progress(100, '完成'); job.done(v); return v; })
    .catch(e => { clearInterval(iv); job.fail(e); throw e; });
}
/* 从模型回复里抠第一个 JSON 对象（前后带话/带围栏都认） */
function firstJSON(text) {
  const s = String(text || '');
  for (let i = 0; i < s.length; i++) {
    if (s[i] !== '{') continue;
    let depth = 0, inStr = false, esc = false;
    for (let j = i; j < s.length; j++) {
      const c = s[j];
      if (inStr) { if (esc) esc = false; else if (c === '\\') esc = true; else if (c === '"') inStr = false; continue; }
      if (c === '"') { inStr = true; continue; }
      if (c === '{') depth++;
      else if (c === '}') { depth--; if (depth === 0) { try { return JSON.parse(s.slice(i, j + 1)); } catch (e) { break; } } }
    }
  }
  return null;
}
const strList = (v, n) => (Array.isArray(v) ? v : []).map(x => String(x == null ? '' : x).trim()).filter(Boolean).slice(0, n || 6);
const clip = (s, n) => String(s == null ? '' : s).trim().slice(0, n || 400);

function sessOf(id) { return db.prepare('SELECT * FROM interview_sessions WHERE id = ?').get(Number(id)); }
function turnsOf(id) { return db.prepare('SELECT * FROM interview_turns WHERE session_id = ? ORDER BY seq, id').all(Number(id)); }
function listSessions(goalId) {
  const rows = goalId
    ? db.prepare('SELECT * FROM interview_sessions WHERE goal_id = ? ORDER BY id DESC').all(Number(goalId))
    : db.prepare('SELECT * FROM interview_sessions ORDER BY id DESC').all();
  return rows.map(r => ({
    id: r.id, title: r.title, status: r.status, rounds: r.rounds, max_rounds: r.max_rounds,
    score: r.score, has_jd: !!String(r.jd_text || '').trim(), has_project: !!String(r.project_digest || '').trim(),
    remedied: (safeParse(r.remedied) || []).length,
    project_path: r.project_path, created_at: r.created_at, updated_at: r.updated_at
  }));
}
/* 出给前端的完整会话（plan/covered 解析成数组） */
function sessOut(r) {
  if (!r) return null;
  const o = Object.assign({}, r);
  o.plan = safeParse(r.plan) || [];
  o.covered = safeParse(r.covered) || [];
  o.remedied = safeParse(r.remedied) || [];
  o.project_files = safeParse(r.project_files) || [];
  o.report = safeParse(r.report) || {};
  return o;
}
function touch(id) { db.prepare('UPDATE interview_sessions SET updated_at = ? WHERE id = ?').run(nowISO(), Number(id)); }

/* ---------- 项目读取 ---------- */
/* 用户给的是本机路径：~ 展开、必须是目录、软链解开后作为只读根。
   code-read 那边还有一层白名单（.env/密钥/node_modules 不可见、路径不得逃出根）。 */
function resolveRoot(p) {
  let s = String(p || '').trim();
  if (!s) throw new Error('请填写项目路径');
  if (s === '~') s = os.homedir();
  else if (s.startsWith('~/')) s = path.join(os.homedir(), s.slice(2));
  s = path.resolve(s);
  let real = s;
  try { real = fs.realpathSync(s); } catch (e) { throw new Error('路径不存在：' + s); }
  let st = null;
  try { st = fs.statSync(real); } catch (e) { throw new Error('读不到这个路径：' + s); }
  if (!st.isDirectory()) throw new Error('这不是一个目录：' + s);
  return real;
}
/* 从文件列表里挑「最像门面」的几个文件给 AI 读：README/package.json/入口文件 + 顶层优先 */
function pickProjectFiles(root) {
  const all = listCodeFiles(root).filter(f => f && f.path);
  const base = p => String(p).split('/').pop().toLowerCase();
  const score = f => {
    const pth = String(f.path), b = base(pth), depth = pth.split('/').length;
    let s = 0;
    if (/^readme(\.md|\.txt)?$/.test(b)) s += 140;
    /* 锚到「整个文件名」或后面跟点：不锚的话 `pom` 会把 pomodoro.js 也当成 pom.xml，
       `go` 会把 google.js 当成 go.mod —— 真实踩过（挑出来的全是 pomodoro）。 */
    if (/^(package|requirements|pyproject|composer|go|pom|build\.gradle)(\.|$)/.test(b)) s += 110;
    if (/^(app|index|main|server|manage|cli)\.(js|ts|mjs|cjs|py|go|java|rb)$/.test(b)) s += 90;
    if (/(^|\/)(src|server|app|lib|core|api)\//.test(pth)) s += 30;
    if (depth <= 2) s += 26;
    if (/\.(md|json|yml|yaml|toml|sql)$/.test(b)) s += 10;
    /* 大文件只**轻微**降权：真正的预算封顶在 readCodeFiles（单文件 12KB / 总 46KB）。
       以前按 size/6000 最多扣 40 分，结果 server.js 这种核心大文件被 pomodoro.css 挤掉了。 */
    s -= Math.min(12, Math.round((f.size || 0) / 20000));
    return s;
  };
  const sorted = all.slice().sort((a, b) => score(b) - score(a));
  return sorted.slice(0, 22).map(f => f.path);
}
function buildProjectDigestPrompt(goal, root, files) {
  const L = [];
  L.push('你在帮一位求职者准备技术面试。下面是他的一个真实项目（只读读取，密钥类内容已脱敏）。');
  L.push('请读懂这个项目，然后产出一份**面试官视角**的项目摘要 —— 面试官会拿它来深挖。');
  L.push('');
  L.push('【项目路径】' + root);
  L.push('【用户的目标】' + clip((goal && goal.title) || '（未填）', 120));
  L.push('');
  L.push('【要输出什么】只输出一个 JSON 对象，不要代码围栏、不要多余文字：');
  L.push('{"what":"这个项目是做什么的（两三句，说人话）",');
  L.push(' "stack":["技术栈/框架/中间件，按重要性"],');
  L.push(' "modules":[{"name":"模块或目录名","what":"它负责什么"}],');
  L.push(' "highlights":["这个项目里最值得聊的 3-6 个点（有技术含量的设计、取舍、坑）"],');
  L.push(' "risks":["从面试官角度看，最容易被追问穿的地方（讲不清会扣分的）"]}');
  L.push('');
  L.push('要求：结合下面的真实代码，不要编造不存在的模块或接口；');
  L.push('模块名、类/函数名要对得上代码。信息不足就少写几条，别硬凑。');
  L.push('');
  L.push('=== 文件清单（相对路径）===');
  const list = listCodeFiles(root);
  L.push(list.slice(0, 260).map(f => f.path).join('\n') || '（读不到文件）');
  L.push('');
  L.push('=== 关键文件内容 ===');
  L.push(files && files.length ? files.map(f => {
    L.push('--- ' + f.path + (f.truncated ? '（超长已截断）' : '') + ' ---');
    L.push('```' + (f.path.split('.').pop() || ''));
    L.push(f.text);
    L.push('```');
  }).join('\n') : '（没有可读的关键文件）');
  return L.join('\n');
}

/* ---------- JD 识别 ---------- */
function buildJdPrompt(note) {
  const L = [];
  L.push('你在帮一位求职者整理招聘信息。用户给了一张（或多张）招聘 JD 的截图。');
  L.push('');
  L.push('【要求】');
  L.push('1. 逐字提取可见信息，不要脑补；看不清的地方标注「[不清晰]」。');
  L.push('2. 按这个顺序整理成**纯文本**（不要 JSON、不要代码块、不要额外解释）：');
  L.push('   岗位名称 / 公司 / 地点 / 薪资 / 岗位职责 / 任职要求 / 技能关键词 / 硬性条件（学历、到岗天数、实习时长等）/ 加分项');
  L.push('3. 图片里没有的项就跳过，不要写「无」。');
  if (note) { L.push(''); L.push('【用户备注】' + clip(note, 200)); }
  return L.join('\n');
}

/* ---------- 考点清单 ---------- */
function buildPlanPrompt(s, goal) {
  const L = [];
  L.push('你是一位严格但讲道理的面试官，正在给一位求职者做**模拟面试**。');
  L.push('先列一份这次面试要覆盖的考点清单 —— 这是「值得问到的检查表」，不是必须按顺序念的剧本。');
  L.push('');
  L.push('【求职目标】' + clip((goal && goal.title) || '（未填）', 120));
  L.push('');
  L.push('【岗位 JD】');
  L.push(clip(s.jd_text, 2600) || '（用户没提供 JD）');
  if (String(s.project_digest || '').trim()) {
    L.push('');
    L.push('【他的项目（面试官会深挖这里）】');
    L.push(clip(s.project_digest, 2000));
  }
  L.push('');
  L.push('【怎么列】6~9 条，覆盖这几类（按对这次面试的重要性排）：');
  L.push('- 项目深挖：简历/项目里经不起细问的点、技术选型的取舍、踩过的坑；');
  L.push('- 岗位硬技能：JD 里明确要求的、面试大概率会考的基础；');
  L.push('- 场景/工程：线上出问题怎么排查、怎么权衡；');
  L.push('- 行为面：1 条就够（自我介绍/为什么选这个方向），别多。');
  L.push('');
  L.push('只输出一个 JSON 对象，不要代码围栏、不要多余文字：');
  L.push('{"focus":"一句话说明这次面试会重点问什么（30 字内）",');
  L.push(' "points":[{"key":"英文短标识","name":"考点名（12 字内）","why":"为什么值得问（20 字内）","level":"基础|进阶|深挖"}]}');
  L.push('key 用英文小写单词，别用中文；points 的 key 不能重复。');
  return L.join('\n');
}

/* ---------- 面试官：问 + 评 ---------- */
function buildInterviewPrompt(s, goal, turns, userText, maxed) {
  const plan = safeParse(s.plan) || [];
  const covered = safeParse(s.covered) || [];
  const coveredNames = covered.map(k => { const p = plan.find(x => x.key === k); return p ? p.name : k; });
  const L = [];
  L.push('你是面试官，正在做一场真实的模拟面试。**你就是面试官本人**，不要跳出角色、不要解释你的评判方法。');
  L.push('语气：专业、直接、不客套；像真人面试一样一次只问一个问题。');
  L.push('');
  L.push('【求职目标】' + clip((goal && goal.title) || '（未填）', 100));
  L.push('【岗位 JD】');
  L.push(clip(s.jd_text, 1800) || '（未提供）');
  if (String(s.project_digest || '').trim()) {
    L.push('');
    L.push('【他的项目】');
    L.push(clip(s.project_digest, 1600));
  }
  L.push('');
  L.push('【这次要覆盖的考点清单（key｜名称｜为什么问）】');
  plan.forEach(p => L.push('- ' + p.key + '｜' + p.name + '｜' + (p.why || '')));
  if (coveredNames.length) L.push('【已经问过的考点（不要重复问同一个考点）】' + coveredNames.join('、'));
  L.push('【进度】这是第 ' + (Number(s.rounds) + 1) + ' 个问题（整场最多 ' + Number(s.max_rounds) + ' 个）。');
  if (maxed) L.push('【注意】这是**最后一个问题**，问完就把 done 置 true，并在 wrap 里给一句收尾话。');
  L.push('');
  const hist = (turns || []).slice(-10);
  if (hist.length) {
    L.push('【刚才的对话（最近的在后）】');
    for (const t of hist) {
      if (t.role === 'answer') L.push('求职者：' + clip(t.text, 600));
      else if (t.role === 'ask') L.push('面试官：' + clip(t.text, 400));
      else if (t.role === 'feedback') L.push('（上一轮你的点评：' + clip(t.text, 260) + '）');
    }
    L.push('');
  }
  if (userText) {
    L.push('【求职者这一轮的回答】');
    L.push(clip(userText, 2000));
  } else {
    L.push('【求职者还没开口】这是开场，问第一个问题（从最重要的考点开始，可以先让他做个简短自我介绍或直接进技术题）。');
  }
  L.push('');
  L.push('【怎么输出】只输出一个 JSON 对象，不要代码围栏、不要多余文字：');
  L.push('{"verdict":{"score":0到100的整数,');
  L.push('   "level":"不合格|一般|不错|很好",');
  L.push('   "good":["他答对/答好的具体点，每条 20 字内"],');
  L.push('   "missing":["该说没说到的关键点"],');
  L.push('   "wrong":[{"said":"他说的（或明显没答上）","right":"正确说法"}]},');
  L.push(' "point":"这一问考的是哪个考点 key（必须是清单里的）",');
  L.push(' "note":"一句话点评（像面试官当场说的，别客套，30 字内）",');
  L.push(' "next":"下一个问题（一个，具体、可回答）",');
  L.push(' "wrap":"如果这一场该收了，写一句收尾话；否则空字符串",');
  L.push(' "done":false}');
  L.push('');
  L.push('硬规矩：');
  L.push('1. 开场那一轮（他还没答过任何东西）verdict 各项留空、score 给 -1、done 填 false，next 只写第一个问题。');
  L.push('2. 他答得含糊时，可以就同一考点追问一层，但**不要把同一个问题原样再问一遍**；');
  L.push('   他明确说不会的，点评里点出来，然后换下一个考点，别在同一个坑上耗。');
  L.push('3. 问题必须具体到能直接回答（不要「你怎么看分布式」这种空题）；涉及代码可以用 ``` 围栏。');
  L.push('4. 不要夸客套话；good 里必须是他**实际说到的**，没说到就别硬凑。');
  L.push('5. 求职者问你问题时，可以简短回答（那不算面试题），但回答完要回到你的提问。');
  return L.join('\n');
}

/* ---------- 现场补救：不会的题单独讲 ---------- */
/* 这一轮**切到教学**：目标是让他马上能用自己的话答出来，而不是听一堂课。
   输出纯文本（Markdown）—— 长 prose 塞 JSON 容易被写断（见 1.10.17 的教训）。 */
function buildExplainPrompt(s, goal, turn, point) {
  const L = [];
  L.push('你现在**从面试官切到教学**：求职者说这道题他不会，你要现场把他讲会。');
  L.push('目标是让他**马上能用自己的话答出来**，不是听一堂完整的课。');
  L.push('');
  L.push('【刚才那道题】');
  L.push(clip(turn.text, 900));
  if (point) L.push('【它考的考点】' + point.name + (point.why ? '（' + point.why + '）' : '') + '｜难度 ' + (point.level || '进阶'));
  L.push('');
  L.push('【他的背景】');
  L.push('目标：' + clip((goal && goal.title) || '（未填）', 100));
  if (String(s.jd_text || '').trim()) L.push('岗位 JD：' + clip(s.jd_text, 700));
  if (String(s.project_digest || '').trim()) L.push('他的项目：' + clip(s.project_digest, 900));
  L.push('');
  L.push('【按这个结构讲（不要写小标题以外的废话）】');
  L.push('1. 这题到底在考什么 —— 一两句点破（别复述题目）；');
  L.push('2. 正面把答案讲出来：结论 → 为什么 → 具体怎么做/举个例子。涉及代码用 ``` 围栏，贴关键几行就行；');
  L.push('3. **面试里该怎么答** —— 给一个 30 秒能说完的版本（分点或"结论+一句理由+一个例子"），让他能直接照着说；');
  L.push('4. 最常见的错误答法是什么（一句话）。');
  L.push('');
  L.push('要求：只讲这一题相关的，不要扩散成整章教程；长度 400~700 字；用大白话，少堆术语；');
  L.push('如果他项目里正好有对应的东西，就指着他的项目讲（那样他更容易记住）。');
  L.push('直接输出正文（Markdown），不要 JSON、不要代码围栏包整篇。');
  return L.join('\n');
}
/* 讲完之后换个问法再问一遍 —— 检验他到底接住没有 */
function buildRetryPrompt(s, goal, turn, explainText) {
  const L = [];
  L.push('你是面试官。刚才这题他没答上来，你已经在上一轮**给他讲过**了。');
  L.push('现在**把同一道题换个问法再问一遍**，检验他到底接住没有。');
  L.push('');
  L.push('【原来那道题】' + clip(turn.text, 700));
  L.push('【你刚才的讲解（要点）】' + clip(explainText, 1200));
  L.push('');
  L.push('【要求】');
  L.push('1. 考的必须是同一个考点，但**问法要变**：换成具体场景、给个例子让他判断、或者让他对比/取舍；');
  L.push('2. 别提示答案、别说"我刚讲过"；');
  L.push('3. 只输出这一个问题本身（可以带一句很短的前置语），不要 JSON、不要点评。');
  return L.join('\n');
}

/* ---------- 总评 ---------- */
function buildReportPrompt(s, goal, turns) {
  const L = [];
  L.push('你是面试官。这场模拟面试结束了，请给出一份**对求职者有用**的总评。');
  L.push('');
  L.push('【求职目标】' + clip((goal && goal.title) || '（未填）', 100));
  L.push('【岗位 JD】' + clip(s.jd_text, 1200));
  if (String(s.project_digest || '').trim()) L.push('【他的项目】' + clip(s.project_digest, 900));
  L.push('');
  const remedied = safeParse(s.remedied) || [];
  if (remedied.length) {
    const plan = safeParse(s.plan) || [];
    const names = remedied.map(x => { const p = plan.find(y => y.key === x.point); return p ? p.name : (x.point || '（未知考点）'); });
    L.push('【这场里有 ' + remedied.length + ' 道题他当场说不会，是靠你现场讲解才接住的】' + names.join('、'));
    L.push('总评里要**如实反映**这一点：这些不是"会"，是"刚补的"—— 归到最该补的短板里，并建议他隔天自测一遍。');
    L.push('');
  }
  L.push('【整场问答】');
  for (const t of (turns || [])) {
    if (t.role === 'ask') L.push('面试官：' + clip(t.text, 320));
    else if (t.role === 'answer') L.push('求职者：' + clip(t.text, 600));
    else if (t.role === 'explain') L.push('（他答不上来，你现场讲解了：' + clip(t.text, 300) + '）');
    else if (t.role === 'feedback') L.push('（当场点评：' + clip(t.text, 240) + '）');
  }
  L.push('');
  L.push('只输出一个 JSON 对象，不要代码围栏、不要多余文字：');
  L.push('{"score":0到100的整数,"level":"不合格|一般|不错|很好",');
  L.push(' "summary":"两三句总评：这场面试他给人什么印象、最大的问题是什么（不要套话）",');
  L.push(' "strengths":["具体的长处，每条 20 字内"],');
  L.push(' "weak":["最该补的短板（按重要性排，3-5 条，每条 25 字内）"],');
  L.push(' "advice":["下一步怎么补，具体到可执行（每条 30 字内）"],');
  L.push(' "verdict":"一句话：按现在这个状态，这场面试能不能过"}');
  return L.join('\n');
}

/* ---------- 归一化 ---------- */
function normPlan(j, plan) {
  const pts = (j && Array.isArray(j.points)) ? j.points : [];
  const seen = new Set();
  const out = [];
  for (const p of pts) {
    const name = clip(p && p.name, 16);
    if (!name) continue;
    let key = String((p && p.key) || '').toLowerCase().replace(/[^a-z0-9_]/g, '').slice(0, 20);
    if (!key || seen.has(key)) key = 'k' + out.length;
    seen.add(key);
    out.push({ key, name, why: clip(p && p.why, 40), level: clip(p && p.level, 6) || '进阶' });
    if (out.length >= 9) break;
  }
  return out;
}
function normVerdict(v) {
  if (!v || typeof v !== 'object') return null;
  const sc = Number(v.score);
  return {
    score: Number.isFinite(sc) ? Math.max(-1, Math.min(100, Math.round(sc))) : -1,
    level: clip(v.level, 6),
    good: strList(v.good, 6),
    missing: strList(v.missing, 6),
    wrong: (Array.isArray(v.wrong) ? v.wrong : []).map(x => ({ said: clip(x && x.said, 200), right: clip(x && x.right, 240) })).filter(x => x.said || x.right).slice(0, 4)
  };
}

module.exports = {
  id: 'interview',
  name: '模拟面试',
  icon: '🎤',
  desc: '把岗位 JD（可粘贴截图）和你的项目路径交给 AI，它当面试官一轮轮问你、当场点评，最后给总评',
  category: '学习与练习',
  order: 46,
  goalToggle: true,
  defaultEnabled: true,
  client: '/plugins/interview.js',

  init(ctx) {
    bind(ctx);
    db.exec(SCHEMA);
    /* 老库补列（1.10.22 建的表没有 remedied） */
    try {
      const c = db.prepare('PRAGMA table_info(interview_sessions)').all().map(x => x.name);
      if (c.length && !c.includes('remedied')) db.exec("ALTER TABLE interview_sessions ADD COLUMN remedied TEXT NOT NULL DEFAULT '[]';");
    } catch (e) {}
  },

  onGoalDelete(goalId, ctx) {
    const ids = ctx.db.prepare('SELECT id FROM interview_sessions WHERE goal_id = ?').all(goalId).map(x => x.id);
    if (ids.length) {
      const ph = ids.map(() => '?').join(',');
      ctx.db.prepare(`DELETE FROM interview_turns WHERE session_id IN (${ph})`).run(...ids);
    }
    ctx.db.prepare('DELETE FROM interview_sessions WHERE goal_id = ?').run(goalId);
    /* 完整性清扫：删会话时若撞上"AI 还在跑"，可能留下指不到会话的轮次 */
    try { ctx.db.exec('DELETE FROM interview_turns WHERE session_id NOT IN (SELECT id FROM interview_sessions)'); } catch (e) {}
  },

  exportData(ctx) {
    return { sessions: ctx.db.prepare('SELECT * FROM interview_sessions').all(), turns: ctx.db.prepare('SELECT * FROM interview_turns').all() };
  },
  importData(data, ctx) {
    for (const s of ((data && data.sessions) || [])) {
      ctx.db.prepare('INSERT OR REPLACE INTO interview_sessions (id,goal_id,node_id,title,status,jd_text,jd_raw,jd_note,project_path,project_digest,project_files,focus,plan,covered,rounds,max_rounds,summary,score,report,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)')
        .run(s.id, s.goal_id, s.node_id, s.title, s.status, s.jd_text, s.jd_raw, s.jd_note, s.project_path, s.project_digest, s.project_files, s.focus, s.plan, s.covered, s.rounds, s.max_rounds, s.summary, s.score, s.report, s.created_at, s.updated_at);
    }
    for (const t of ((data && data.turns) || [])) {
      ctx.db.prepare('INSERT OR REPLACE INTO interview_turns (id,session_id,seq,role,text,verdict,created_at) VALUES (?,?,?,?,?,?,?)')
        .run(t.id, t.session_id, t.seq, t.role, t.text, t.verdict, t.created_at);
    }
  },

  api: [
    /* 列表 */
    {
      method: 'GET', path: '/api/interviews',
      handler: async (req, res, u) => {
        const gid = Number(u.searchParams.get('goal_id')) || 0;
        return sendJSON(res, 200, { sessions: listSessions(gid) });
      }
    },
    /* 新建一场（空白，等着贴 JD / 填项目路径） */
    {
      method: 'POST', path: '/api/interviews',
      handler: async (req, res, u, ctx) => {
        const body = await readBody(req).catch(() => ({}));
        const gid = Number(body.goal_id) || 0;
        const now = nowISO();
        const info = db.prepare('INSERT INTO interview_sessions (goal_id,node_id,title,status,max_rounds,created_at,updated_at) VALUES (?,?,?,?,?,?,?)')
          .run(gid, Number(body.node_id) || 0, '', 'setup', Math.max(3, Math.min(15, Number(body.max_rounds) || 8)), now, now);
        const r = sessOf(info.lastInsertRowid);
        return sendJSON(res, 200, { session: sessOut(r), turns: [] });
      }
    },
    /* 读一场（含全部问答） */
    {
      method: 'GET', pattern: /^\/api\/interviews\/(\d+)$/,
      handler: async (req, res, u) => {
        const m = u.pathname.match(/^\/api\/interviews\/(\d+)$/);
        const r = sessOf(m[1]);
        if (!r) return sendJSON(res, 404, { error: '这场面试不存在（可能已被删除）' });
        return sendJSON(res, 200, { session: sessOut(r), turns: turnsOf(r.id) });
      }
    },
    /* 改名 */
    {
      method: 'POST', pattern: /^\/api\/interviews\/(\d+)\/rename$/,
      handler: async (req, res, u) => {
        const m = u.pathname.match(/^\/api\/interviews\/(\d+)\/rename$/);
        const r = sessOf(m[1]);
        if (!r) return sendJSON(res, 404, { error: '这场面试不存在' });
        const body = await readBody(req).catch(() => ({}));
        const title = String(body.title || '').replace(/\s+/g, ' ').trim().slice(0, 40);
        db.prepare('UPDATE interview_sessions SET title = ? WHERE id = ?').run(title, r.id);
        return sendJSON(res, 200, { ok: true, session: sessOut(sessOf(r.id)) });
      }
    },
    /* 删除 */
    {
      method: 'DELETE', pattern: /^\/api\/interviews\/(\d+)$/,
      handler: async (req, res, u) => {
        const m = u.pathname.match(/^\/api\/interviews\/(\d+)$/);
        const r = sessOf(m[1]);
        if (!r) return sendJSON(res, 404, { error: '这场面试不存在' });
        db.prepare('DELETE FROM interview_turns WHERE session_id = ?').run(r.id);
        db.prepare('DELETE FROM interview_sessions WHERE id = ?').run(r.id);
        return sendJSON(res, 200, { ok: true, deleted: r.id });
      }
    },
    /* 贴 JD：文字直接存；截图走视觉模型识别 */
    {
      method: 'POST', pattern: /^\/api\/interviews\/(\d+)\/jd$/,
      handler: async (req, res, u) => {
        const m = u.pathname.match(/^\/api\/interviews\/(\d+)\/jd$/);
        const r = sessOf(m[1]);
        if (!r) return sendJSON(res, 404, { error: '这场面试不存在' });
        const body = await readBody(req).catch(() => ({}));
        /* 显式清空（「重贴」按钮）：不带 clear 的话，空 body 是「用户什么都没给」的报错 */
        if (body.clear) {
          db.prepare("UPDATE interview_sessions SET jd_text = '', jd_raw = '', updated_at = ? WHERE id = ?").run(nowISO(), r.id);
          return sendJSON(res, 200, { ok: true, session: sessOut(sessOf(r.id)), turns: turnsOf(r.id) });
        }
        const text = String(body.text || '').trim();
        const images = (Array.isArray(body.images) ? body.images : []).filter(x => typeof x === 'string' && x.startsWith('data:image/')).slice(0, 4);
        const note = String(body.note || '').trim();
        if (!text && !images.length) return sendJSON(res, 400, { error: '先粘贴 JD 截图，或者直接贴文字' });
        let out = text;
        let raw = '';
        if (images.length) {
          const vision = (currentVisionModel && currentVisionModel()) || '';
          let txt = '';
          try {
            txt = await aiJob({
              title: '识别招聘 JD', note: '截图 ' + images.length + ' 张', goalId: r.goal_id, nodeId: r.node_id,
              message: 'AI 正在读你的 JD 截图，把文字识别出来',
              run: signal => aiTextFiles(buildJdPrompt(note), vision, images, 300000, signal)
            });
          } catch (e) {
            const msg = String((e && e.message) || e);
            /* 两种失败要分开说，否则会误导（实测踩过：拿一张 1×1 的图去试，
               报的是 "unsupported image"，如果一律说成"模型不支持看图"，
               用户会白跑一趟设置页去换模型）。 */
            if (/unsupported image|invalid.{0,24}image|image.{0,24}invalid|too small/i.test(msg)) {
              throw new Error('这张图识别不了（太小、格式不支持，或者截图不完整）。'
                + '换一张清晰的招聘截图再试；也可以直接把 JD 文字贴进来。原始报错：' + msg.slice(0, 120));
            }
            if (/vision|multimodal|不支持.*图|image/i.test(msg)) {
              throw new Error('这个模型好像读不了图（当前识图模型：' + (vision || '未配置') + '）。'
                + '去「设置 → AI 接入 → 识图模型」换一个支持视觉的模型；或者直接把 JD 文字贴进来（一样能用）。'
                + ' 原始报错：' + msg.slice(0, 120));
            }
            throw e;
          }
          raw = String(txt || '').trim();
          if (!raw) throw new Error('截图没识别出内容，换一张更清晰的试试');
          out = raw;
        } else if (note) {
          out = text + '\n\n（备注：' + note + '）';
        }
        const now = nowISO();
        db.prepare('UPDATE interview_sessions SET jd_text = ?, jd_raw = ?, jd_note = ?, updated_at = ? WHERE id = ?')
          .run(clip(out, 8000), clip(raw, 8000), clip(note, 200), now, r.id);
        if (!String(r.title || '').trim()) {
          const first = out.split('\n').map(x => x.trim()).filter(Boolean)[0] || '';
          if (first) db.prepare('UPDATE interview_sessions SET title = ? WHERE id = ?').run(clip(first.replace(/^[#*\s]*/, ''), 30), r.id);
        }
        return sendJSON(res, 200, { ok: true, session: sessOut(sessOf(r.id)), turns: turnsOf(r.id) });
      }
    },
    /* 给项目路径：只读读取 + AI 生成项目摘要 */
    {
      method: 'POST', pattern: /^\/api\/interviews\/(\d+)\/project$/,
      handler: async (req, res, u) => {
        const m = u.pathname.match(/^\/api\/interviews\/(\d+)\/project$/);
        const r = sessOf(m[1]);
        if (!r) return sendJSON(res, 404, { error: '这场面试不存在' });
        const body = await readBody(req).catch(() => ({}));
        const raw = String(body.path || '').trim();
        if (!raw) return sendJSON(res, 400, { error: '请填写项目路径' });
        const root = resolveRoot(raw);            // 不存在/不是目录 → 400 说清楚
        const picked = pickProjectFiles(root);
        if (!picked.length) return sendJSON(res, 400, { error: '这个目录里没找到可读的代码文件（.env / node_modules / 密钥类一律不读）' });
        const files = readCodeFiles(root, picked, { perFile: 12000, total: 46000 });
        const goal = (getGoal && getGoal(r.goal_id)) || null;
        const txt = await aiJob({
          title: '读懂你的项目', note: root, goalId: r.goal_id, nodeId: r.node_id,
          message: 'AI 正在读这个项目（' + files.length + ' 个文件），生成面试官视角的摘要',
          run: signal => aiText(buildProjectDigestPrompt(goal, root, files), currentModel(), 300000, null, signal)
        });
        const j = firstJSON(txt);
        if (!j) throw new Error('项目摘要没生成出来，点重试再来一次');
        const digest = JSON.stringify({
          what: clip(j.what, 600),
          stack: strList(j.stack, 12),
          modules: (Array.isArray(j.modules) ? j.modules : []).map(x => ({ name: clip(x && x.name, 30), what: clip(x && x.what, 120) })).filter(x => x.name).slice(0, 12),
          highlights: strList(j.highlights, 8),
          risks: strList(j.risks, 8)
        });
        const now = nowISO();
        db.prepare('UPDATE interview_sessions SET project_path = ?, project_digest = ?, project_files = ?, updated_at = ? WHERE id = ?')
          .run(root, digest, JSON.stringify(files.map(f => f.path)), now, r.id);
        return sendJSON(res, 200, { ok: true, session: sessOut(sessOf(r.id)), turns: turnsOf(r.id), read: files.length });
      }
    },
    /* 生成考点清单 */
    {
      method: 'POST', pattern: /^\/api\/interviews\/(\d+)\/plan$/,
      handler: async (req, res, u) => {
        const m = u.pathname.match(/^\/api\/interviews\/(\d+)\/plan$/);
        const r = sessOf(m[1]);
        if (!r) return sendJSON(res, 404, { error: '这场面试不存在' });
        if (!String(r.jd_text || '').trim() && !String(r.project_digest || '').trim()) {
          return sendJSON(res, 400, { error: '先给它一点信息：贴一份 JD，或者填一个项目路径' });
        }
        const goal = (getGoal && getGoal(r.goal_id)) || null;
        const txt = await aiJob({
          title: '定面试考点', note: clip(r.title || '模拟面试', 40), goalId: r.goal_id, nodeId: r.node_id,
          message: 'AI 正在根据 JD 和你的项目，列这次面试要问的考点',
          run: signal => aiText(buildPlanPrompt(r, goal), currentModel(), 240000, null, signal)
        });
        const j = firstJSON(txt);
        const plan = normPlan(j, plan0(r));
        if (!plan.length) throw new Error('考点没列出来，点重试再来一次');
        db.prepare('UPDATE interview_sessions SET plan = ?, focus = ?, covered = ?, updated_at = ? WHERE id = ?')
          .run(JSON.stringify(plan), clip(j && j.focus, 80), '[]', nowISO(), r.id);
        return sendJSON(res, 200, { ok: true, session: sessOut(sessOf(r.id)), turns: turnsOf(r.id) });
      }
    },
    /* 开始面试：AI 问第一个问题 */
    {
      method: 'POST', pattern: /^\/api\/interviews\/(\d+)\/start$/,
      handler: async (req, res, u) => {
        const m = u.pathname.match(/^\/api\/interviews\/(\d+)\/start$/);
        const r = sessOf(m[1]);
        if (!r) return sendJSON(res, 404, { error: '这场面试不存在' });
        if (!(safeParse(r.plan) || []).length) return sendJSON(res, 400, { error: '先点「定考点」' });
        if (turnsOf(r.id).some(t => t.role === 'ask')) return sendJSON(res, 400, { error: '这场面试已经开始了' });
        /* 开场前允许改「问几轮」（用户在设置里填的） */
        const body = await readBody(req).catch(() => ({}));
        const mx = Number(body.max_rounds);
        if (Number.isFinite(mx) && mx >= 3 && mx <= 15) {
          db.prepare('UPDATE interview_sessions SET max_rounds = ? WHERE id = ?').run(Math.round(mx), r.id);
          r.max_rounds = Math.round(mx);
        }
        const goal = (getGoal && getGoal(r.goal_id)) || null;
        const txt = await aiJob({
          title: '面试开场', note: clip(r.title || '模拟面试', 40), goalId: r.goal_id, nodeId: r.node_id,
          message: 'AI 面试官正在问第一个问题',
          run: signal => aiText(buildInterviewPrompt(r, goal, [], '', false), currentModel(), 240000, null, signal)
        });
        const j = firstJSON(txt);
        const next = clip(j && j.next, 1200);
        if (!next) throw new Error('面试官没问出问题，点重试再来一次');
        const now = nowISO();
        const seq = turnsOf(r.id).length + 1;
        db.prepare('INSERT INTO interview_turns (session_id,seq,role,text,verdict,created_at) VALUES (?,?,?,?,?,?)')
          .run(r.id, seq, 'ask', next, JSON.stringify({ point: clip(j && j.point, 20) }), now);
        db.prepare('UPDATE interview_sessions SET status = ?, updated_at = ? WHERE id = ?').run('running', now, r.id);
        return sendJSON(res, 200, { session: sessOut(sessOf(r.id)), turns: turnsOf(r.id) });
      }
    },
    /* 答一轮：点评 + 下一问 */
    {
      method: 'POST', pattern: /^\/api\/interviews\/(\d+)\/answer$/,
      handler: async (req, res, u) => {
        const m = u.pathname.match(/^\/api\/interviews\/(\d+)\/answer$/);
        const r = sessOf(m[1]);
        if (!r) return sendJSON(res, 404, { error: '这场面试不存在' });
        const body = await readBody(req).catch(() => ({}));
        const text = String(body.text || '').trim();
        if (!text) return sendJSON(res, 400, { error: '先写下你的回答' });
        const prev = turnsOf(r.id);
        const lastAsk = prev.slice().reverse().find(t => t.role === 'ask');
        if (!lastAsk) return sendJSON(res, 400, { error: '面试还没开始' });
        const now = nowISO();
        /* 先把求职者这句话落库（AI 要跑一会儿，中途刷新也不能丢） */
        const ins = db.prepare('INSERT INTO interview_turns (session_id,seq,role,text,verdict,created_at) VALUES (?,?,?,?,?,?)')
          .run(r.id, prev.length + 1, 'answer', clip(text, 4000), '{}', now);
        const answerTurnId = Number(ins.lastInsertRowid);
        db.prepare('UPDATE interview_sessions SET rounds = ?, updated_at = ? WHERE id = ?').run(Number(r.rounds) + 1, now, r.id);

        const goal = (getGoal && getGoal(r.goal_id)) || null;
        const maxed = Number(r.rounds) + 1 >= Number(r.max_rounds);
        const txt = await aiJob({
          title: '面试 · 第 ' + (Number(r.rounds) + 1) + ' 问', note: clip(r.title || '模拟面试', 40),
          goalId: r.goal_id, nodeId: r.node_id,
          message: 'AI 面试官正在听你的回答，然后点评并追问',
          run: signal => aiText(buildInterviewPrompt(r, goal, prev, text, maxed), currentModel(), 300000, null, signal)
        });
        /* AI 跑完时这场可能已经被删了 —— 别再往里写，会留下幽灵行 */
        const still = sessOf(r.id);
        if (!still) {
          db.prepare('DELETE FROM interview_turns WHERE id = ?').run(answerTurnId);
          return sendJSON(res, 404, { error: '这场面试已经被删除了' });
        }
        const j = firstJSON(txt) || {};
        const v = normVerdict(j.verdict);
        const note = clip(j.note, 200);
        const point = clip(j.point, 20);
        const verdict = { score: v ? v.score : -1, level: v ? v.level : '', good: v ? v.good : [], missing: v ? v.missing : [], wrong: v ? v.wrong : [], note, point };
        db.prepare('UPDATE interview_turns SET verdict = ? WHERE id = ?').run(JSON.stringify(verdict), answerTurnId);

        /* 覆盖的考点：记下来，下一轮不再重复问同一个 */
        const plan = safeParse(still.plan) || [];
        const covered = safeParse(still.covered) || [];
        if (point && plan.some(p => p.key === point) && covered.indexOf(point) < 0) covered.push(point);

        const next = clip(j.next, 1200);
        const wrap = clip(j.wrap, 400);
        const done = !!j.done || maxed;
        let seq = turnsOf(r.id).length + 1;
        if (next && !done) {
          db.prepare('INSERT INTO interview_turns (session_id,seq,role,text,verdict,created_at) VALUES (?,?,?,?,?,?)')
            .run(r.id, seq++, 'ask', next, JSON.stringify({ point }), nowISO());
        }
        db.prepare('UPDATE interview_sessions SET covered = ?, updated_at = ? WHERE id = ?').run(JSON.stringify(covered), nowISO(), r.id);
        if (done) {
          const t = nowISO();
          db.prepare('UPDATE interview_sessions SET status = ?, summary = ?, updated_at = ? WHERE id = ?')
            .run('ready_report', wrap || '这场先到这。点「给总评」看整场评价。', t, r.id);
        }
        return sendJSON(res, 200, { session: sessOut(sessOf(r.id)), turns: turnsOf(r.id), done });
      }
    },
    /* 现场补救①：这道题不会 → 单独讲一遍（不计入轮次，不算他答过） */
    {
      method: 'POST', pattern: /^\/api\/interviews\/(\d+)\/explain$/,
      handler: async (req, res, u) => {
        const m = u.pathname.match(/^\/api\/interviews\/(\d+)\/explain$/);
        const r = sessOf(m[1]);
        if (!r) return sendJSON(res, 404, { error: '这场面试不存在' });
        const body = await readBody(req).catch(() => ({}));
        const all = turnsOf(r.id);
        const turnId = Number(body.turn_id) || (all.slice().reverse().find(t => t.role === 'ask') || {}).id || 0;
        const askTurn = all.find(t => Number(t.id) === turnId && t.role === 'ask');
        if (!askTurn) return sendJSON(res, 404, { error: '找不到那道题' });
        const av = safeParse(askTurn.verdict) || {};
        const plan = safeParse(r.plan) || [];
        const point = plan.find(p => p.key === av.point) || null;
        const goal = (getGoal && getGoal(r.goal_id)) || null;
        const txt = await aiJob({
          title: '现场讲解 · ' + clip(point ? point.name : '这道题', 20), note: clip(r.title || '模拟面试', 40),
          goalId: r.goal_id, nodeId: r.node_id,
          message: '面试官切到教学，正在把这道题讲明白',
          run: signal => aiText(buildExplainPrompt(r, goal, askTurn, point), currentModel(), 300000, null, signal)
        });
        if (!sessOf(r.id)) return sendJSON(res, 404, { error: '这场面试已经被删除了' });
        const text = clip(txt, 6000);
        if (!text) throw new Error('讲解没生成出来，点重试再来一次');
        const now = nowISO();
        const seq = turnsOf(r.id).length + 1;
        db.prepare('INSERT INTO interview_turns (session_id,seq,role,text,verdict,created_at) VALUES (?,?,?,?,?,?)')
          .run(r.id, seq, 'explain', text, JSON.stringify({ point: av.point || '', for_turn: askTurn.id }), now);
        /* 记进 remedied：总评要据此说清"哪些是刚补的、不是真会" */
        const remedied = safeParse(r.remedied) || [];
        if (!remedied.some(x => Number(x.turn) === Number(askTurn.id))) {
          remedied.push({ turn: askTurn.id, point: av.point || '', asked: clip(askTurn.text, 120) });
          db.prepare('UPDATE interview_sessions SET remedied = ?, updated_at = ? WHERE id = ?').run(JSON.stringify(remedied), now, r.id);
        } else {
          touch(r.id);
        }
        return sendJSON(res, 200, { session: sessOut(sessOf(r.id)), turns: turnsOf(r.id) });
      }
    },
    /* 现场补救②：讲完换个问法再问一遍（检验他到底接住没有） */
    {
      method: 'POST', pattern: /^\/api\/interviews\/(\d+)\/retry$/,
      handler: async (req, res, u) => {
        const m = u.pathname.match(/^\/api\/interviews\/(\d+)\/retry$/);
        const r = sessOf(m[1]);
        if (!r) return sendJSON(res, 404, { error: '这场面试不存在' });
        const body = await readBody(req).catch(() => ({}));
        const all = turnsOf(r.id);
        const lastAsk = all.slice().reverse().find(t => t.role === 'ask');
        if (!lastAsk) return sendJSON(res, 400, { error: '还没开始问' });
        /* 先看有没有题正等着他答 —— 这个要先判，否则换了问法之后再点，会被误报成"还没讲解过" */
        if (all[all.length - 1].role === 'ask') return sendJSON(res, 400, { error: '已经有一道题在等你了，先答它' });
        /* 再找这道题后面那条讲解（拿它当"刚讲过什么"的上下文） */
        const exp = all.filter(t => t.role === 'explain' && Number((safeParse(t.verdict) || {}).for_turn) === Number(lastAsk.id)).pop();
        if (!exp) return sendJSON(res, 400, { error: '这道题还没讲解过 —— 先点「不会，讲一下」' });
        const goal = (getGoal && getGoal(r.goal_id)) || null;
        const txt = await aiJob({
          title: '换个问法再问一遍', note: clip(r.title || '模拟面试', 40),
          goalId: r.goal_id, nodeId: r.node_id,
          message: '面试官正在把同一道题换个问法再问一次',
          run: signal => aiText(buildRetryPrompt(r, goal, lastAsk, exp.text), currentModel(), 240000, null, signal)
        });
        if (!sessOf(r.id)) return sendJSON(res, 404, { error: '这场面试已经被删除了' });
        const q = clip(txt, 1200);
        if (!q) throw new Error('没问出来，点重试再来一次');
        const av = safeParse(lastAsk.verdict) || {};
        const now = nowISO();
        db.prepare('INSERT INTO interview_turns (session_id,seq,role,text,verdict,created_at) VALUES (?,?,?,?,?,?)')
          .run(r.id, turnsOf(r.id).length + 1, 'ask', q, JSON.stringify({ point: av.point || '', retry_of: lastAsk.id }), now);
        touch(r.id);
        return sendJSON(res, 200, { session: sessOut(sessOf(r.id)), turns: turnsOf(r.id) });
      }
    },
    /* 总评 */
    {
      method: 'POST', pattern: /^\/api\/interviews\/(\d+)\/report$/,
      handler: async (req, res, u) => {
        const m = u.pathname.match(/^\/api\/interviews\/(\d+)\/report$/);
        const r = sessOf(m[1]);
        if (!r) return sendJSON(res, 404, { error: '这场面试不存在' });
        const turns = turnsOf(r.id);
        if (!turns.some(t => t.role === 'answer')) return sendJSON(res, 400, { error: '还没答过，先答一轮' });
        const goal = (getGoal && getGoal(r.goal_id)) || null;
        const txt = await aiJob({
          title: '面试总评', note: clip(r.title || '模拟面试', 40), goalId: r.goal_id, nodeId: r.node_id,
          message: 'AI 面试官正在写整场的总评',
          run: signal => aiText(buildReportPrompt(r, goal, turns), currentModel(), 300000, null, signal)
        });
        if (!sessOf(r.id)) return sendJSON(res, 404, { error: '这场面试已经被删除了' });
        const j = firstJSON(txt);
        if (!j) throw new Error('总评没生成出来，点重试再来一次');
        const sc = Number(j.score);
        const report = {
          score: Number.isFinite(sc) ? Math.max(0, Math.min(100, Math.round(sc))) : -1,
          level: clip(j.level, 6),
          summary: clip(j.summary, 800),
          strengths: strList(j.strengths, 6),
          weak: strList(j.weak, 6),
          advice: strList(j.advice, 6),
          verdict: clip(j.verdict, 200)
        };
        db.prepare('UPDATE interview_sessions SET status = ?, report = ?, score = ?, summary = ?, updated_at = ? WHERE id = ?')
          .run('done', JSON.stringify(report), report.score, report.summary, nowISO(), r.id);
        return sendJSON(res, 200, { session: sessOut(sessOf(r.id)), turns: turnsOf(r.id) });
      }
    }
  ]
};

/* plan0：留个位置给"没有 AI 时"的兜底（当前用不到，但 normPlan 需要它不报错） */
function plan0() { return []; }
