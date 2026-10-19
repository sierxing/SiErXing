'use strict';
/**
 * 思而行 · 界面文案提取器
 * ============================================================================
 * 作用：扫描源码，找出**可能显示给用户看的文字**，产出语言目录（zh-CN/ui.json）。
 * 它同时被两处用：
 *   ① `npm run build:lang` —— 生成/更新源语言目录；
 *   ② `npm run check:i18n` —— 守卫（新写的文案必须进目录 / 不许绕过 tr()）。
 *
 * 提取规则（宁可多收、不可漏收）：
 *   · 字符串字面量 / 模板字面量里的中文都算候选；
 *   · 模板里如果像 HTML，就只取「标签之间的文字」和 title/placeholder/aria-label/alt
 *     这些会显示出来的属性值（避免把 class 名、data-* 之类的代码当文案）；
 *   · 模板里的 `${...}` 变量变成占位符 {0} {1}…（运行时用同一套规则做模式匹配）；
 *   · 明显不是文案的（JSON、代码、超长提示词、markdown 围栏）自动排除。
 *
 * ⚠️ 这个文件必须保持**纯函数 / 零依赖**：build 脚本、守卫、测试都会 require 它。
 */

const fs = require('node:fs');
const path = require('node:path');

const CJK_RE = /[\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff]/;
const MAX_EXACT = 200;        // 普通字符串 / 属性值上限（超过多半是提示词，不算界面文案）
const MAX_TEXT_RUN = 500;     // HTML 标签之间文字上限（帮助段落可以长一点）
const MAX_TEMPLATE = 300;     // 非 HTML 模板整体作为一条文案时的上限（toast / 拼接提示）

/* ---------------------------------------------------------------------------
 * 一、扫描：把源码拆成字符串/模板字面量 token（跳过注释、正则；模板里 ${} 递归扫）
 * ------------------------------------------------------------------------- */

function isRegexStart(text, i) {
  let p = i - 1;
  while (p >= 0 && /\s/.test(text[p])) p--;
  if (p < 0) return true;
  return '(,=:[!&|?{};+-*%~^<>'.indexOf(text[p]) >= 0;
}

/** 从 i（指向 ` 或引号）开始读一个普通字符串；返回 {value, end} */
function readPlainString(text, i) {
  const quote = text[i];
  let raw = '';
  i++;
  while (i < text.length) {
    const c = text[i];
    if (c === '\\') { raw += text[i] + (text[i + 1] || ''); i += 2; continue; }
    if (c === quote) { i++; break; }
    if (c === '\n') break;                       /* 普通字符串不跨行（容错） */
    raw += c;
    i++;
  }
  return { raw: raw, end: i };
}

/** 跳过一段代码，返回匹配的 `}` 之后的下标（用于模板里的 ${...}） */
function matchExprEnd(text, i) {
  let depth = 1;
  while (i < text.length) {
    const c = text[i];
    if (c === "'" || c === '"') { i = readPlainString(text, i).end; continue; }
    if (c === '`') { i = readTemplate(text, i, []).end; continue; }
    if (c === '/' && text[i + 1] === '/') { const nl = text.indexOf('\n', i); i = nl < 0 ? text.length : nl; continue; }
    if (c === '/' && text[i + 1] === '*') { const e = text.indexOf('*/', i + 2); i = e < 0 ? text.length : e + 2; continue; }
    if (c === '/' && isRegexStart(text, i)) {
      i++;
      let inClass = false;
      while (i < text.length) {
        const d = text[i];
        if (d === '\\') { i += 2; continue; }
        if (d === '[') inClass = true;
        else if (d === ']') inClass = false;
        else if (d === '/' && !inClass) { i++; break; }
        else if (d === '\n') break;
        i++;
      }
      while (i < text.length && /[a-z]/i.test(text[i])) i++;
      continue;
    }
    if (c === '{') depth++;
    else if (c === '}') { depth--; if (depth === 0) return i + 1; }
    i++;
  }
  return i;
}

/** 读模板字面量；nested 用来收集 ${...} 里的嵌套字面量 token */
function readTemplate(text, i, nested) {
  i++;                                            /* 跳过开头 ` */
  const parts = [];
  let cur = '';
  let interps = 0;
  while (i < text.length) {
    const c = text[i];
    if (c === '\\') { cur += text[i] + (text[i + 1] || ''); i += 2; continue; }
    if (c === '`') { i++; break; }
    if (c === '$' && text[i + 1] === '{') {
      parts.push(cur); cur = '';
      interps++;
      const end = matchExprEnd(text, i + 2);
      scanRange(text, i + 2, end - 1, nested);    /* 递归扫描表达式里的字面量 */
      i = end;
      continue;
    }
    cur += c;
    i++;
  }
  parts.push(cur);
  return { parts: parts, interps: interps, end: i };
}

/** 扫描 [from, to) 区间的代码，把字面量 token 推进 out */
function scanRange(text, from, to, out) {
  let i = from;
  while (i < to) {
    const c = text[i];
    if (c === '/' && text[i + 1] === '/') { const nl = text.indexOf('\n', i); i = nl < 0 || nl > to ? to : nl; continue; }
    if (c === '/' && text[i + 1] === '*') { const e = text.indexOf('*/', i + 2); i = e < 0 || e + 2 > to ? to : e + 2; continue; }
    if (c === "'" || c === '"') {
      const r = readPlainString(text, i);
      out.push({ kind: 'string', raw: r.raw, value: decodeEscapes(r.raw), start: i, end: r.end });
      i = r.end;
      continue;
    }
    if (c === '`') {
      const nested = [];
      const r = readTemplate(text, i, nested);
      out.push({
        kind: 'template',
        raw: text.slice(i, r.end),
        parts: r.parts.map(decodeEscapes),
        interps: r.interps,
        start: i,
        end: r.end
      });
      for (const n of nested) out.push(n);
      i = r.end;
      continue;
    }
    if (c === '/' && isRegexStart(text, i)) {
      i++;
      let inClass = false;
      while (i < to) {
        const d = text[i];
        if (d === '\\') { i += 2; continue; }
        if (d === '[') inClass = true;
        else if (d === ']') inClass = false;
        else if (d === '/' && !inClass) { i++; break; }
        else if (d === '\n') break;
        i++;
      }
      while (i < to && /[a-z]/i.test(text[i])) i++;
      continue;
    }
    i++;
  }
  return out;
}

/** 扫描整个 JS 源码 → 字面量 token 列表 */
function scanTokens(text) {
  return scanRange(String(text || ''), 0, String(text || '').length, []);
}

/* ---------------------------------------------------------------------------
 * 二、解码与归一化
 * ------------------------------------------------------------------------- */

function decodeEscapes(raw) {
  return String(raw || '').replace(/\\(u\{[0-9a-fA-F]+\}|u[0-9a-fA-F]{4}|x[0-9a-fA-F]{2}|[nrtbfv0'"`\\])/g, function (all, seq) {
    if (seq[0] === 'u') {
      const hex = seq[1] === '{' ? seq.slice(2, -1) : seq.slice(1);
      const code = parseInt(hex, 16);
      return isFinite(code) ? String.fromCodePoint(code) : '';
    }
    if (seq[0] === 'x') {
      const code = parseInt(seq.slice(1), 16);
      return isFinite(code) ? String.fromCharCode(code) : '';
    }
    const map = { n: '\n', r: '\r', t: '\t', b: '\b', f: '\f', v: '\v', '0': '\0' };
    return map[seq] != null ? map[seq] : seq;
  })
    /* JS 里未知转义 \d 之类等于去掉反斜杠；上面没匹配到的统一处理 */
    .replace(/\\(.)/g, '$1');
}

const HTML_ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', hellip: '…', mdash: '—', ndash: '–', middot: '·', times: '×', check: '✓', rarr: '→', larr: '←', uarr: '↑', darr: '↓', laquo: '«', raquo: '»', copy: '©', reg: '®' };

/** 把 HTML 实体解码成真实字符：源码里写 &nbsp; 的地方，DOM 里拿到的是真实字符 */
function decodeEntities(value) {
  return String(value == null ? '' : value).replace(/&(#x?[0-9a-fA-F]+|[a-zA-Z]+);/g, function (all, body) {
    if (body[0] === '#') {
      const code = body[1] === 'x' || body[1] === 'X' ? parseInt(body.slice(2), 16) : parseInt(body.slice(1), 10);
      return isFinite(code) && code > 0 && code < 0x110000 ? String.fromCodePoint(code) : all;
    }
    const v = HTML_ENTITIES[body.toLowerCase()];
    return v != null ? v : all;
  });
}

/** 运行时的匹配键：trim + 空白折叠（两端保留由调用方处理） */
function normalizeKey(value) {
  return String(value == null ? '' : value)
    .replace(/[\u00a0]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/** 含中文？ */
function hasCJK(value) { return CJK_RE.test(String(value == null ? '' : value)); }

/** 明显不是界面文案的过滤（JSON / 代码 / 提示词 / 日志 / 路由等） */
function looksNonDisplay(value) {
  const s = String(value == null ? '' : value).trim();
  if (!s || !hasCJK(s)) return true;
  if (s.length > MAX_TEXT_RUN) return true;
  if (/^[{[]/.test(s) && /[}\]]$/.test(s)) return true;            /* JSON / 数组 */
  if (/```/.test(s)) return true;                                  /* markdown 围栏 */
  if (/^(?:\/|#\/|https?:\/\/)/i.test(s)) return true;             /* 路径 / 路由 / URL */
  if (/[A-Za-z_$][\w$]*\s*\([^)]*\)\s*[{;]?$/.test(s) && /function|=>|return/.test(s)) return true;
  if (/(?:^|\s)(?:function|const|let|var|return|await|async)\s/.test(s) && s.length > 40) return true;
  if (/<\/(?:script|style)>/i.test(s)) return true;
  if (/^(?:console\.|require\(|module\.exports)/.test(s)) return true;
  /* 提示词 / 日志的典型句子：不可能是界面文案（UI 文案不会写"请挑出/只输出/【要求】"） */
  /* 提示词 / 日志的典型句子：不可能是界面文案。
     ⚠️ 不要用单个词（如"提示词"）一刀切 —— 界面上真有叫「提示词」的按钮。只在句子够长时才判定。 */
  if (s.length > 24 && /(?:请挑|请把|请根据|请只|只输出|不要输出|不要解释|你的任务|【要求】|\bJSON\s*对象|JSON\s*格式|===)/.test(s)) return true;
  if (s.length > 60 && /(?:你是(?:一个)?|提示词)/.test(s)) return true;
  if (/^\[[a-z][\w-]*\]/i.test(s)) return true;                         /* 日志前缀：[kernel] xxx */
  if (/^【[^】]{0,40}】/.test(s)) return true;                          /* 提示词分节标记：【要求】/【你的任务】 */
  /* 源码里拆开拼的 HTML 属性 / JSON 残片（不是用户看到的整句文案） */
  if (/^[A-Za-z-]+\s*=/.test(s)) return true;                           /* placeholder="..." */
  if (/="[^"]*"?>?$/.test(s) && s.length < 200) return true;           /* ...="xxx"> */
  if (/^[,\]\}\s]*["']?[\w$-]+["']?\s*:\s*["']/.test(s)) return true;  /* name: "...  这种 JSON 片段 */
  if (/^[\]\},;]+/.test(s)) return true;
  if (/^(?:===|---|##)/.test(s)) return true;
  if (/[\\/](?:plugins|api|ui-dist|node_modules)[\\/]/.test(s)) return true;  /* 文件路径 */
  return false;
}

/** `${...}` 占位标记：用不可见字符避免和真实文案冲突 */
const PH = '\u0000';
function partsJoined(parts) { return parts.join(PH); }

/** 把带 ∪占位标记的文本转成"匹配键"：{0} {1}… + 空白折叠 */
function keyFromMarked(marked) {
  let n = 0;
  const withPh = String(marked).replace(/\u0000/g, function () { return '{' + (n++) + '}'; });
  /* 占位符两侧的空白折叠成单空格，方便运行时正则 */
  return normalizeKey(withPh.replace(/\s*(\{\d+\})\s*/g, ' $1 '));
}

const HTML_TAG_RE = /<\/?(?:div|span|p|a|b|i|em|strong|br|button|input|label|select|option|textarea|ul|ol|li|table|tr|td|th|thead|tbody|h[1-6]|section|article|header|footer|main|nav|small|code|pre|details|summary|form|img|svg|path|style|script|hr|dl|dt|dd|figure|figcaption|blockquote|kbd|mark|dialog|template|slot)\b/i;
const HTML_CLOSE_RE = /<\/[a-z][\w-]*\s*>/i;

function looksLikeHtml(marked) {
  const s = String(marked || '');
  return HTML_TAG_RE.test(s) || HTML_CLOSE_RE.test(s);
}

const DISPLAY_ATTRS = ['title', 'placeholder', 'aria-label', 'aria-placeholder', 'alt', 'value'];

/** 从一段 HTML 文本里提取「标签之间的文字」+ 会显示的属性值 */
function extractFromHtml(marked, sink) {
  let s = String(marked || '');
  /* 去掉 <script>/<style> 里的内容（它们不是界面文字） */
  s = s.replace(/<(script|style)\b[\s\S]*?<\/\1\s*>/gi, PH);
  /* 标签之间的文字 */
  const tagRe = /<[^<>]*>/g;
  let last = 0;
  let m;
  const runs = [];
  while ((m = tagRe.exec(s))) {
    if (m.index > last) runs.push(s.slice(last, m.index));
    last = tagRe.lastIndex;
  }
  if (last < s.length) runs.push(s.slice(last));
  for (var run of runs) {
    /* 源码里常把一段 HTML 拆成字符串拼：'>卸载</button>' 这种从标签中间开始的，
       文本 run 会带上游离的 '>'；去掉它才是 DOM 里真正的文字节点内容。 */
    run = String(run).replace(/^[>"'\\]+/, '').replace(/[<"'\\]+$/, '');
    if (run) sink.text(run);
  }
  /* 属性值 */
  const attrRe = /\b([a-zA-Z-]+)\s*=\s*(?:"([^"]*)"|'([^']*)')/g;
  while ((m = attrRe.exec(s))) {
    const name = String(m[1] || '').toLowerCase();
    if (DISPLAY_ATTRS.indexOf(name) < 0) continue;
    const val = m[2] != null ? m[2] : m[3];
    sink.attr(name, val);
  }
}

/** 一条规范化后的候选；返回 key 或 '' */
function candidateFromText(marked, kind, opts) {
  const o = opts || {};
  let markedText = decodeEntities(String(marked == null ? '' : marked));
  if (!hasCJK(markedText.replace(/\u0000/g, ''))) return '';
  /* 纯占位符 / 纯符号的文本 run 不算 */
  const rawKey = keyFromMarked(markedText);
  if (!hasCJK(rawKey)) return '';
  const key = rawKey;
  const max = o.maxLen || (kind === 'attr' ? MAX_EXACT : kind === 'template' ? MAX_TEMPLATE : MAX_TEXT_RUN);
  if (key.length > max) return '';
  if (looksNonDisplay(key)) return '';
  /* 只有一个标点/符号夹着中文（例如「·」）也不是文案 */
  if (key.replace(/[\s\p{P}\p{S}]/gu, '').length === 0) return '';
  if (o.minLen && key.length < o.minLen) return '';
  return key;
}

/* ---------------------------------------------------------------------------
 * 三、从 token / 源码产出候选
 * ------------------------------------------------------------------------- */

/**
 * @param {string} src
 * @param {{label?:string, mode?:'ui'|'server', includeWholeTemplates?:boolean}} opts
 * @returns {{entries: Object<string,{files:string[],count:number}>, tokens:Array}}
 *   entries：key → {files, count}（count = 出现次数）
 */
function extractFromSource(src, opts) {
  const o = opts || {};
  const label = o.label || '';
  const includeWhole = o.includeWholeTemplates !== false;
  const tokenAllowed = typeof o.tokenAllowed === 'function' ? o.tokenAllowed : null;
  const entries = {};
  const tokens = scanTokens(src);

  const add = function (key) {
    if (!key) return;
    const cur = entries[key];
    if (cur) { cur.count++; if (cur.files.indexOf(label) < 0) cur.files.push(label); return; }
    entries[key] = { files: label ? [label] : [], count: 1 };
  };

  for (const tok of tokens) {
    if (tokenAllowed && !tokenAllowed(tok, src)) continue;
    if (tok.kind === 'string') {
      const val = tok.value;
      if (!hasCJK(val)) continue;
      /* HTML 被拆成多段字符串拼接时（'... title="' + x + '">'），单段里没有完整标签；
         只看有没有会显示的属性赋值，有就收属性值。 */
      if (/\b(?:title|placeholder|aria-label|aria-placeholder|alt)\s*=\s*["']/.test(val)) {
        extractFromHtml(val, {
          text: function () {},
          attr: function (name, val2) { add(candidateFromText(val2, 'attr', o)); }
        });
      }
      if (/<[a-zA-Z][^<>]*>/.test(val) || HTML_CLOSE_RE.test(val)) {
        /* 字符串里拼 HTML（如 '<b>已保存</b>'）：只取会显示的部分 */
        extractFromHtml(val, {
          text: function (run) { add(candidateFromText(run, 'text', o)); },
          attr: function (name, val2) { add(candidateFromText(val2, 'attr', o)); }
        });
      } else {
        const key = candidateFromText(val, 'string', o);
        add(key);
      }
      continue;
    }
    if (tok.kind === 'template') {
      const marked = partsJoined(tok.parts);
      if (/\b(?:title|placeholder|aria-label|aria-placeholder|alt)\s*=\s*["']/.test(marked)) {
        extractFromHtml(marked, {
          text: function () {},
          attr: function (name, val) { add(candidateFromText(val, 'attr', o)); }
        });
      }
      if (looksLikeHtml(marked)) {
        extractFromHtml(marked, {
          text: function (run) { add(candidateFromText(run, 'text', o)); },
          attr: function (name, val) { add(candidateFromText(val, 'attr', o)); }
        });
      } else if (includeWhole && tok.interps >= 1) {
        /* 拼接用的模板（toast / 提示语）：整体作为一条带占位符的文案 */
        const key = candidateFromText(marked, 'template', o);
        add(key);
      } else if (includeWhole && tok.interps === 0) {
        const key = candidateFromText(marked, 'template', o);
        add(key);
      }
    }
  }
  return { entries: entries, tokens: tokens };
}

/** 合并多个文件的结果 */
function mergeEntries(list) {
  const out = {};
  for (const item of list || []) {
    for (const key of Object.keys(item.entries || {})) {
      const cur = out[key];
      if (!cur) { out[key] = { files: item.entries[key].files.slice(), count: item.entries[key].count }; continue; }
      cur.count += item.entries[key].count;
      for (const f of item.entries[key].files) if (cur.files.indexOf(f) < 0) cur.files.push(f);
    }
  }
  return out;
}

/**
 * 生成语言目录（key → key 的源语言包）。
 * @param {Array<{file:string,label?:string}>} fileList
 * @returns {{source:Object<string,string>, raw:Object<string,{files:string[],count:number}>, tokensByFile:Object}}
 */
function buildCatalog(fileList) {
  const perFile = [];
  const tokensByFile = {};
  for (const item of fileList) {
    let src = '';
    try { src = fs.readFileSync(item.file, 'utf8'); } catch (e) { continue; }
    const label = item.label || path.relative(process.cwd(), item.file).split(path.sep).join('/');
    const r = extractFromSource(src, { label: label, mode: item.mode || 'ui' });
    perFile.push(r);
    tokensByFile[label] = { entries: r.entries, tokens: r.tokens, src: src };
  }
  const merged = mergeEntries(perFile);
  const source = {};
  const keys = Object.keys(merged).sort(function (a, b) { return a.localeCompare(b, 'zh'); });
  for (const k of keys) source[k] = k;
  return { source: source, raw: merged, tokensByFile: tokensByFile };
}

/* ---------------------------------------------------------------------------
 * 四、守卫用：这个字面量 token 是否被 tr(...) 包住了
 * ------------------------------------------------------------------------- */

const MANAGED_RE = /(?:^|[^\w$])tr\s*\(\s*$/;

function isManagedToken(src, tok) {
  const before = src.slice(Math.max(0, tok.start - 48), tok.start);
  return MANAGED_RE.test(before);
}

/** 这个 token 会不会产出界面文案（守卫只统计"会产出候选且没包 tr()"的 token） */
function tokenYieldsDisplay(tok) {
  if (tok.kind === 'string') {
    const val = tok.value;
    if (!hasCJK(val)) return false;
    if (/<[a-zA-Z][^<>]*>/.test(val)) {
      const found = [];
      extractFromHtml(val, {
        text: function (run) { const k = candidateFromText(run, 'text'); if (k) found.push(k); },
        attr: function (name, v) { const k = candidateFromText(v, 'attr'); if (k) found.push(k); }
      });
      return found.length > 0;
    }
    return !!candidateFromText(val, 'string');
  }
  if (tok.kind === 'template') {
    const marked = partsJoined(tok.parts);
    if (looksLikeHtml(marked)) {
      const found = [];
      extractFromHtml(marked, {
        text: function (run) { const k = candidateFromText(run, 'text'); if (k) found.push(k); },
        attr: function (name, v) { const k = candidateFromText(v, 'attr'); if (k) found.push(k); }
      });
      return found.length > 0;
    }
    return !!candidateFromText(marked, 'template');
  }
  return false;
}


/* ---------------------------------------------------------------------------
 * 五、上下文辅助（服务端文案筛选 / 守卫共用）
 * ------------------------------------------------------------------------- */

const PROMPT_FN_RE = /(?:Prompt|prompt|Rules|RULES|Instruction|INSTRUCTIONS|SysPrompt|BuildSys)/;
/* 服务端里这些函数几乎全是"拼提示词"的（builder），里面的字面量不是界面文案 */
const SERVER_PROMPT_FN_RE = /^(?:build|make|gen|prompt|ask|judge|review|outline|clean|digest|collect|tutorial|explain|evaluate|score|plan|refine|expand|split|parse|write|instruct|visual|points|finish|weave|retry|chat)/i;
const SERVER_UI_CONTEXT_RE = /\b(error|message|label|title|desc|note|toast|hint|alert|confirm|sendJSON|pipelineError|fail\(|throw new Error|tasks?\.|task\b|status|progress|phase|step|msg|write\(|send\(|name|category|mechanism)/i;
const CONSOLE_RE = /console\.(?:log|warn|error|info|debug)\s*\(/;

/* 跳过字符串/模板/注释/正则用的最小扫描器（与 scanRange 同一套规则） */
function skipNonCode(text, i) {
  const c = text[i];
  if (c === "'" || c === '"') return readPlainString(text, i).end;
  if (c === '`') return readTemplate(text, i, []).end;
  if (c === '/' && text[i + 1] === '/') { const nl = text.indexOf('\n', i); return nl < 0 ? text.length : nl; }
  if (c === '/' && text[i + 1] === '*') { const e = text.indexOf('*/', i + 2); return e < 0 ? text.length : e + 2; }
  if (c === '/' && isRegexStart(text, i)) {
    let j = i + 1;
    let inClass = false;
    while (j < text.length) {
      const d = text[j];
      if (d === '\\') { j += 2; continue; }
      if (d === '[') inClass = true;
      else if (d === ']') inClass = false;
      else if (d === '/' && !inClass) { j++; break; }
      else if (d === '\n') break;
      j++;
    }
    while (j < text.length && /[a-z]/i.test(text[j])) j++;
    return j;
  }
  return i;
}

/** 匹配配对的大括号（跳过字符串/注释/正则） */
function matchBraceIn(text, openIdx) {
  let depth = 0;
  let i = openIdx;
  while (i < text.length) {
    const step = skipNonCode(text, i);
    if (step !== i) { i = step; continue; }
    const c = text[i];
    if (c === '{') depth++;
    else if (c === '}') { depth--; if (depth === 0) return i + 1; }
    i++;
  }
  return text.length;
}

const FN_RANGE_CACHE = new Map();
function functionRanges(src) {
  if (FN_RANGE_CACHE.has(src)) return FN_RANGE_CACHE.get(src);
  const ranges = [];
  let i = 0;
  while (i < src.length) {
    const step = skipNonCode(src, i);
    if (step !== i) { i = step; continue; }
    if (src[i] === 'f' && /^function\s+([A-Za-z_$][\w$]*)\s*\(/.test(src.slice(i, i + 200))) {
      const m = /^function\s+([A-Za-z_$][\w$]*)\s*\(/.exec(src.slice(i, i + 200));
      const parenIdx = src.indexOf('(', i + m[0].length - 1);
      let j = parenIdx;
      let depth = 0;
      while (j < src.length) {
        const st = skipNonCode(src, j);
        if (st !== j) { j = st; continue; }
        if (src[j] === '(') depth++;
        else if (src[j] === ')') { depth--; if (depth === 0) { j++; break; } }
        j++;
      }
      const braceIdx = src.indexOf('{', j);
      if (braceIdx >= 0) {
        const end = matchBraceIn(src, braceIdx);
        ranges.push({ name: m[1], start: i, end: end });
        /* ⚠️ 不能直接跳过整个函数体：嵌套 function（server/tut-plan.js 这种
           "外层工厂函数里再定义一堆 buildXxxPrompt"）会因此漏掉，提示词就被当界面文案收了。 */
        i = braceIdx + 1;
        continue;
      }
    }
    i++;
  }
  /* 只留最近 3 份缓存，避免大仓库扫两次把内存撑大 */
  if (FN_RANGE_CACHE.size > 3) FN_RANGE_CACHE.clear();
  FN_RANGE_CACHE.set(src, ranges);
  return ranges;
}

/** 位置所在的**最内层** function（范围感知；不在函数里返回 ''） */
function enclosingFunction(src, start) {
  const ranges = functionRanges(src);
  let best = null;
  for (const r of ranges) {
    if (start >= r.start && start < r.end) {
      if (!best || (r.end - r.start) < (best.end - best.start)) best = r;
    }
  }
  return best ? best.name : '';
}

/** token 前后的一小段源码（用来判断这个字面量是"给用户看的"还是日志/提示词/代码） */
function tokenContext(src, tok, before, after) {
  const b = before == null ? 120 : before;
  const a = after == null ? 80 : after;
  return src.slice(Math.max(0, tok.start - b), Math.min(src.length, tok.end + a));
}

/** 服务端文件：过滤掉日志、提示词函数、长指令片段，只留"可能出现在界面上"的文案 */
function serverTokenAllowed(src, tok) {
  const ctx = tokenContext(src, tok);
  if (CONSOLE_RE.test(ctx)) return false;
  const fn = enclosingFunction(src, tok.start);
  if (PROMPT_FN_RE.test(fn) || SERVER_PROMPT_FN_RE.test(fn)) return false;
  if (!SERVER_UI_CONTEXT_RE.test(ctx)) return false;
  return true;
}

/** 界面文件：只过滤提示词函数里的字面量 */
function uiTokenAllowed(src, tok) {
  return !PROMPT_FN_RE.test(enclosingFunction(src, tok.start));
}

module.exports = {
  CJK_RE,
  PH,
  MAX_EXACT,
  MAX_TEXT_RUN,
  MAX_TEMPLATE,
  DISPLAY_ATTRS,
  scanTokens,
  decodeEscapes,
  normalizeKey,
  hasCJK,
  keyFromMarked,
  looksLikeHtml,
  extractFromHtml,
  candidateFromText,
  extractFromSource,
  mergeEntries,
  buildCatalog,
  isManagedToken,
  tokenYieldsDisplay,
  looksNonDisplay,
  decodeEntities,
  enclosingFunction,
  functionRanges,
  tokenContext,
  serverTokenAllowed,
  uiTokenAllowed,
  PROMPT_FN_RE,
  SERVER_PROMPT_FN_RE,
  SERVER_UI_CONTEXT_RE
};
