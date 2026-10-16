'use strict';
/**
 * 看懂代码 · 纯文本部分：切段 + 解析 + 语言判断
 * ------------------------------------------------------------------
 * 单独成模块是为了能白盒回归（`node scripts/test-explain.js`，纯文本、秒级、不花钱）。
 * 这两处错一个，表现就是"讲解挂到了错误的行上 / 有些行永远点不出内容"：
 *   · chunkLines：把整段代码切成"每次让 AI 讲一段"，段与段必须首尾相接、不重不漏；
 *   · parseExplain + toBlocks：把模型输出拆成 `### 第 N 行` 的块 —— 模型漏行 / 乱序 / 越界时
 *     钳到本段范围、把空隙并进相邻块，保证"范围内每一行都有讲解"。
 */
const CHUNK_TARGET_LINES = 30; // 一段大约讲多少行
const CHUNK_TARGET_CHARS = 1500;
const CHUNK_MAX_LINES = 48;    // 硬上限：再密也要断开
const CHUNK_MIN_LINES = 6;     // 不切太碎的块（先找"干净的断点"）

const NEW_STMT = /^(?:[}\])]|#|\/\/|\/\*|@|(?:def|function|class|const|let|var|for|while|if|elif|else|try|except|catch|finally|return|import|from|export|public|private|protected|static|fn|func|package|SELECT|INSERT|UPDATE|CREATE|WITH|END)\b)/;

/** 语言标签：只用来显示（badge / 提示），判错不影响讲解。 */
function detectLang(code) {
  const c = String(code || '');
  const t = re => re.test(c);
  if (t(/^\s*#!.*\b(?:bash|sh|zsh)\b/m) || (t(/\b(?:apt-get|systemctl|docker|npm|pip|brew|git)\s+\w/) && !t(/[;{}]\s*$/m) && !t(/\bfunction\b/))) return 'bash';
  if (t(/^\s*(?:from\s+[\w.]+\s+import|import\s+[\w.]+\s*$)/m) || t(/\bdef\s+\w+\s*\([^)]*\)\s*:/) || t(/^\s*class\s+\w+[\w.,() ]*:\s*$/m)) return 'python';
  if (t(/^\s*#include\b/m) || t(/\bstd::|\bcout\s*<</)) return 'cpp';
  if (t(/\bpublic\s+(?:static\s+)?(?:class|void|int|String)\b/) || t(/System\.out\./)) return 'java';
  if (t(/\bpackage\s+main\b/) || t(/\bfunc\s+\w+\s*\(/) || t(/fmt\.\w+/)) return 'go';
  if (t(/\bfn\s+\w+\s*\(/) || t(/\blet\s+mut\b/) || t(/println!/)) return 'rust';
  if (t(/\b(?:interface|type)\s+\w+\s*[={]/) || t(/:\s*(?:string|number|boolean|void)\b/)) return 'typescript';
  if (t(/\b(?:const|let|var|function)\s|=>|require\(|module\.exports/)) return 'javascript';
  if (t(/<\/?[a-zA-Z][\w-]*(?:\s[^>]*)?>/)) return 'html';
  if (t(/^\s*(?:SELECT|INSERT|UPDATE|DELETE|CREATE\s+TABLE)\b/im)) return 'sql';
  if (t(/^\s*[\w.]+:\s*(?:#.*)?$/m) && t(/^\s*-\s+\w+/m)) return 'yaml';
  return '';
}
/** 给提示词用的带行号版本（说"第 N 行"就用这个号）。
 *  ⚠️ 传进来的可能是**数组**（调用方基本都是 `String(code).split('\n')` 的结果）。
 *  以前这里写的是 `String(code).split('\n')` —— 数组进 String() 会变成"逗号连接的一行"，
 *  于是发给 AI 的代码块是 `1 | const a = 1;,console.log(a);,main();`：模型根本看不出哪里换行，
 *  "第 N 行"也就对不上（真实踩到过，所有讲解提示词都受影响）。 */
function numCode(code) {
  const lines = Array.isArray(code)
    ? code.map(x => String(x == null ? '' : x))
    : String(code == null ? '' : code).split('\n');
  const w = String(lines.length).length;
  return lines.map((l, i) => String(i + 1).padStart(w, ' ') + ' | ' + l).join('\n');
}

/** 把代码切成段：段与段首尾相接、不重不漏，尽量在"干净的断点"处断。 */
function chunkLines(lines, from) {
  const out = [];
  const n = lines.length;
  let i = Math.max(0, Number(from || 1) - 1);
  while (i < n) {
    let chars = 0, cut = -1, last = i;
    for (let j = i; j < n; j++) {
      const L = String(lines[j] || '');
      chars += L.length + 1;
      last = j;
      const count = j - i + 1;
      const next = j + 1 < n ? String(lines[j + 1] || '').trim() : '';
      const cur = L.trim();
      /* 能"干净地断"的地方：文件末尾 / 下一行是空行 / 下一行是新语句开头 / 这一行是闭合的括号或分号 */
      if (j + 1 >= n || !next || NEW_STMT.test(next) || /[{};:]\s*$/.test(cur)) {
        if (count >= CHUNK_MIN_LINES) cut = j;
      }
      if (count >= CHUNK_MAX_LINES) break;
      if ((count >= CHUNK_TARGET_LINES || chars >= CHUNK_TARGET_CHARS) && cut >= 0) break;
    }
    const cutLen = cut >= i ? cut - i + 1 : 0;
    const end = (cut >= i && cutLen >= CHUNK_MIN_LINES) ? cut : last;
    out.push({ from: i + 1, to: end + 1 });
    i = end + 1;
  }
  return out;
}

/* 契约：`### 第 N 行` / `### 第 N-M 行`（第一段另有 `### 概览` 与 `[[NAME: …]]`）。
   模型不老实（漏行 / 乱序 / 越界）时不能整段作废 —— parseExplain 只负责"读出来"，
   补洞与钳范围交给下面的 toBlocks。 */
const HEAD_RE = /^[ \t]*#{1,6}[ \t]*(?:(?:第|L)[ \t]*(\d{1,5})(?:[ \t]*(?:[-–—~至到]|--)[ \t]*(\d{1,5}))?[ \t]*行|(概览|整体|总览))([^\n]*)$/gm;
/** 标题尾巴：`### 第 5-14 行 · 建一条按行读的管道` 里的「建一条按行读的管道」 */
function cleanTitle(s) {
  return String(s || '')
    .replace(/^\s*[·:：\-—–|>]+/, '')
    .replace(/\*\*/g, '')
    .replace(/\s+/g, ' ')
    .replace(/[\s·|]+$/, '')
    .trim().slice(0, 24);
}
function parseExplain(raw) {
  const text = String(raw || '').replace(/\r\n?/g, '\n');
  let name = '';
  let body = text;
  const nm = body.match(/\[\[NAME:\s*([^\]]{1,160})\]\]/);
  if (nm) {
    name = nm[1].replace(/\s+/g, ' ').trim().replace(/^[「『"'《]+|[」』"'》]+$/g, '').slice(0, 40);
    body = body.slice(0, nm.index) + body.slice(nm.index + nm[0].length);
  }
  const hits = [];
  HEAD_RE.lastIndex = 0;
  let m;
  while ((m = HEAD_RE.exec(body))) {
    hits.push({ at: m.index, end: HEAD_RE.lastIndex, from: m[1] ? Number(m[1]) : 0, to: m[2] ? Number(m[2]) : (m[1] ? Number(m[1]) : 0), ov: !!m[3], title: cleanTitle(m[4]) });
  }
  let overview = '';
  const items = [];
  for (let k = 0; k < hits.length; k++) {
    const h = hits[k];
    const stop = k + 1 < hits.length ? hits[k + 1].at : body.length;
    const t = body.slice(h.end, stop).trim();
    if (!t) continue;
    if (h.ov) { if (!overview) overview = t; continue; }
    items.push({ from: Math.min(h.from, h.to), to: Math.max(h.from, h.to), text: t, title: h.title });
  }
  /* 第一个标题之前的内容：没有概览标题时它就是"开场白"，并进第一块讲 */
  const pre = (hits.length ? body.slice(0, hits[0].at) : body).trim();
  return { name, overview, items, pre };
}

/** 钳到本段范围 + 补洞 + 去重叠，保证 [from, to] 里每一行都有归属。 */
function toBlocks(items, from, to) {
  const picked = [];
  for (const it of items || []) {
    if (!it || it.to < from || it.from > to) continue;
    const a = Math.max(from, it.from);
    const b = Math.min(to, it.to);
    if (b < a) continue;
    picked.push({ from: a, to: b, text: String(it.text || '').trim(), title: String(it.title || '').trim() });
  }
  picked.sort((x, y) => x.from - y.from);
  /* 空隙并进这一块（它本来就要从那儿接着讲） */
  let cur = from;
  for (const blk of picked) {
    if (blk.from > cur) blk.from = cur;
    cur = Math.max(cur, blk.to + 1);
  }
  const out = [];
  for (const blk of picked) {
    const prev = out[out.length - 1];
    if (prev && blk.from <= prev.to) {
      prev.to = Math.max(prev.to, blk.to);
      prev.text = (prev.text + '\n\n' + blk.text).trim();
      if (!prev.title) prev.title = blk.title;
      continue;
    }
    out.push(blk);
  }
  if (out.length) {
    out[0].from = Math.min(out[0].from, from);
    out[out.length - 1].to = Math.max(out[out.length - 1].to, to);
  }
  return out;
}

/* ---------------- 讲解模块：让 AI 自己划，系统只做兜底 ----------------
   用户原话："有的明显是一体的代码就按照整体讲解，现在一行 } 都要被拆出来"。
   所以分块权交给 AI（先出一份模块大纲），系统只保证三件事：
     ① 模块**首尾相接、不重不漏**（覆盖每一行）；
     ② 只有空行 / 收尾符号的模块**不许单独存在**（并进相邻模块）—— 见 mergeFragments；
     ③ 按模块分批调 AI（一批 ~35 行），**批次边界永远落在模块边界上**（不把一个模块劈两半）。 */

const FRAGMENT_RE = /^[)\]};,]+$/;
/** 空行，或只有 } / }); / ) / ] 这类收尾符号的行 */
function isFragmentLine(s) {
  const t = String(s == null ? '' : s).trim();
  return !t || FRAGMENT_RE.test(t);
}
function hasContentLines(from, to, lines) {
  const src = lines || [];
  if (!src.length) return true;                     // 无从判断时保守当作有内容（宁可不动）
  for (let i = from; i <= to; i++) if (!isFragmentLine(src[i - 1])) return true;
  return false;
}
/** 把"整块都是空行/收尾符号"的块并进相邻块：优先并进上一块，首块则并进下一块。
    内容块一律不动 —— 用户要的仍然是"点哪一行看哪一行所属模块的讲解"。 */
function mergeFragments(items, lines) {
  const out = [];
  for (const it of items || []) {
    const blk = { from: it.from, to: it.to, title: String(it.title || ''), text: String(it.text || '') };
    const prev = out[out.length - 1];
    if (!hasContentLines(blk.from, blk.to, lines) && prev) {
      prev.to = Math.max(prev.to, blk.to);
      if (blk.text) prev.text = ((prev.text ? prev.text + '\n\n' : '') + blk.text).trim();
      if (!prev.title && blk.title) prev.title = blk.title;
      continue;
    }
    out.push(blk);
  }
  if (out.length > 1 && !hasContentLines(out[0].from, out[0].to, lines)) {
    const head = out.shift();
    out[0].from = Math.min(head.from, out[0].from);
    if (head.text) out[0].text = ((head.text ? head.text + '\n\n' : '') + out[0].text).trim();
  }
  return out;
}
/** 从 AI 回复里抠出模块大纲：{"modules":[{"from":1,"to":3,"title":"…"}]}（也容忍裸数组 / start-end 写法） */
function parseOutline(raw) {
  const t = String(raw || '');
  let obj = null;
  try { obj = JSON.parse(t.trim()); } catch (e) { obj = null; }
  if (obj == null) {
    const m = t.match(/\{[\s\S]*\}/);
    if (m) { try { obj = JSON.parse(m[0]); } catch (e) { obj = null; } }
  }
  const list = Array.isArray(obj) ? obj : (obj && Array.isArray(obj.modules) ? obj.modules : null);
  if (!list) return [];
  return list.map(x => ({
    from: Number(x && (x.from != null ? x.from : x.start)) || 0,
    to: Number(x && (x.to != null ? x.to : (x.end != null ? x.end : x.start))) || 0,
    title: String((x && (x.title || x.name)) || '').replace(/\s+/g, ' ').trim().slice(0, 24)
  })).filter(x => x.from >= 1 && x.to >= 1);
}
/** 大纲规范化：钳到 [1, n]、按顺序拼成"首尾相接、不重不漏"，再把碎片模块并掉。
    返回 [] = 这份大纲不可用（调用方退回机械切段）。 */
function normModules(mods, n, lines) {
  const total = Number(n) || 0;
  if (!total) return [];
  const sorted = (mods || []).slice().sort((a, b) => (a.from - b.from) || (a.to - b.to));
  const chained = [];
  for (const m of sorted) {
    if (!(Number(m && m.to) >= 1)) continue;      // 整条非法（to 都没有）→ 丢掉，别拿它凑成"一大块"
    const from = chained.length ? chained[chained.length - 1].to + 1 : 1;
    if (from > total) break;
    const to = Math.min(total, Math.max(from, Number(m.to) || from));
    chained.push({ from, to, title: String(m.title || '') });
  }
  if (!chained.length) return [];
  if (chained[chained.length - 1].to < total) chained[chained.length - 1].to = total;   // 收尾补齐
  return splitLongModules(mergeFragments(chained, lines), lines).map(m => ({ from: m.from, to: m.to, title: m.title }));
}
/** 模块太大（AI 偶尔会甩一整段 100 行过来）→ 按"干净的断点"细拆几下。
    这是**上限保护**，不是替 AI 分块：正常大小的模块一律不动。 */
const MODULE_MAX_LINES = 40;
function splitLongModules(mods, lines) {
  const out = [];
  for (const m of mods || []) {
    if (m.to - m.from + 1 <= MODULE_MAX_LINES) { out.push(m); continue; }
    const sub = chunkLines((lines || []).slice(m.from - 1, m.to), 1);
    for (const ch of sub) out.push({ from: m.from + ch.from - 1, to: m.from + ch.to - 1, title: m.title });
  }
  return out;
}
/** 兜底大纲：按"干净的断点"机械切段（AI 大纲不可用时才走这条路），标题留空 */
function fallbackModules(lines, from) {
  return chunkLines(lines, from || 1).map(ch => ({ from: ch.from, to: ch.to, title: '' }));
}
/** 按模块分批：一批 ~maxLines 行、最多 maxMods 个模块；**批次边界永远落在模块边界上**。
    fromLine 之前已经讲完的模块直接跳过（「继续讲」时用）。 */
function buildBatches(modules, fromLine, opts) {
  const maxLines = (opts && opts.maxLines) || 35;
  const maxMods = (opts && opts.maxMods) || 6;
  const pend = (modules || []).filter(m => Number(m.to) >= Number(fromLine || 1));
  const out = [];
  let cur = [];
  const flush = () => { if (cur.length) { out.push({ from: cur[0].from, to: cur[cur.length - 1].to, modules: cur.slice() }); cur = []; } };
  for (const m of pend) {
    if (!cur.length) { cur.push(m); continue; }
    if ((m.to - cur[0].from + 1) <= maxLines && cur.length < maxMods) cur.push(m);
    else { flush(); cur.push(m); }
  }
  flush();
  return out;
}

/** 他之前确认过的处境（喂给提示词的那几行）。
 *  ⚠️ clarify_answers 有**两种历史形状**：早期是数组 [{q,a}]，现在前端 collectClarifyAnswers()
 *  发的是**对象** {qid: 答案}（实测线上目标 166 存的就是 {"q1":"a","q2":"c","q3":"c"}）。
 *  按数组硬来会直接抛 "qa.slice is not a function"、整轮讲解失败（真实踩到过）。
 *  对象形状要拿 goals.clarify 里的题目文本把 qid 翻译成人话；翻不出来就只给答案。 */
function clarifyBlock(g) {
  if (!g) return '';
  let qa = null, clarify = null;
  try { qa = JSON.parse(g.clarify_answers || ''); } catch (e) { qa = null; }
  try { clarify = JSON.parse(g.clarify || ''); } catch (e) { clarify = null; }
  const qtext = new Map();
  for (const q of ((clarify && clarify.questions) || [])) {
    if (q && q.id != null) qtext.set(String(q.id), String(q.text || q.q || q.title || '').slice(0, 80));
  }
  const fmt = a => {
    if (Array.isArray(a)) return a.map(String).join(' / ').slice(0, 120);
    if (a && typeof a === 'object') return String(a.picked != null ? a.picked : JSON.stringify(a)).slice(0, 120);
    return String(a == null ? '' : a).slice(0, 120);
  };
  const rows = [];
  if (Array.isArray(qa)) {
    for (const x of qa.slice(0, 8)) {
      const q = String((x && (x.q || x.question || x.title)) || '').slice(0, 60);
      const a = fmt(x && (x.a != null ? x.a : x.answer));
      if (a) rows.push(q ? '· ' + q + ' → ' + a : '· ' + a);
    }
  } else if (qa && typeof qa === 'object') {
    for (const k of Object.keys(qa).slice(0, 8)) {
      const q = qtext.get(String(k)) || String(k);
      const a = fmt(qa[k]);
      if (a) rows.push('· ' + String(q).slice(0, 60) + ' → ' + a);
    }
  }
  return rows.length ? '他之前确认过的处境：\n' + rows.join('\n') : '';
}

module.exports = {
  detectLang, numCode, chunkLines, parseExplain, toBlocks, clarifyBlock,
  isFragmentLine, mergeFragments, parseOutline, normModules, fallbackModules, buildBatches,
  CHUNK_TARGET_LINES, CHUNK_TARGET_CHARS, CHUNK_MAX_LINES, CHUNK_MIN_LINES
};
