#!/usr/bin/env node
'use strict';
/**
 * 页面插件构建器 v4
 * ============================================================================
 * 作用：把 public/app.js 的原版 render* 实现（及其依赖闭包）搬进
 *       ui/plugins/builtin/<page>/，让每个页面都变成可替换的插件，
 *       同时保证 DOM 结构 / CSS 类名 / 交互与原版逐字一致（像素级对齐）。
 *
 * 演进史（每一步都是踩坑换来的，改之前先读）：
 *   v1 手工列函数清单 → 漏一个就 ReferenceError（node --check 查不出运行时错）。
 *   v2 自动依赖闭包 → 按「行首 const/function」判断边界，页面里渲染的示例代码
 *      字符串会把函数**截断**，生成的文件直接语法错误。
 *   v3 字符级扫描（字符串/模板串/注释/括号配平）→ 正则字面量里的 {} 仍会破坏
 *      配平，导致函数边界越界、把邻居函数一起吞进来。
 *   v4 加上**正则字面量识别**（启发式）+ **声明名保护**（改写外部依赖时不碰
 *      function NAME / const NAME 的声明位置）。
 *
 * 用法：
 *   node scripts/build-page-plugin.js <page>           构建单页
 *   node scripts/build-page-plugin.js --all            构建全部
 *   node scripts/build-page-plugin.js --report <page>  只看依赖报告（不写文件）
 *   node scripts/build-page-plugin.js --list           看页面配置
 */
const fs = require('node:fs');
const path = require('node:path');

const APP_DIR = path.resolve(__dirname, '..');
const APP_JS = path.join(APP_DIR, 'public', 'app.js');
const OUT_ROOT = path.join(APP_DIR, 'ui', 'plugins', 'builtin');

/** 由 host 提供、不复制实现的名字 */
const HOST_BINDINGS = [
  'esc', 'api', 'toast', 'mdToHTML', 'mdOneLine', 'fmtDate', 'buildTree', 'goalCompOn',
  'ST_LABEL', 'reportCardHTML', 'tutorialCardHTML', 'expandPanelHTML', 'tutProgressHTML',
  'bindPlanPanel', 'bindReportCard', 'bindTutorialCard', 'showVersionsPanel', 'startClarify',
  'aiToggle', 'showNodePanel', 'startExpand', 'applyBarOverflow', 'loadGoal', 'loadComponents',
  'rerenderCurrent', 'setHeader', 'parseRoute', 'pluginEnabled', 'assetUrl'
];

/** 跨页渲染器 / 路由 / 全局单例：不搬 */
const STOP_EXACT = new Set([
  'renderHome', 'renderGoal', 'renderTutorialPage', 'renderLibraryPage', 'renderComponentsPage',
  'renderAiTasksPage', 'renderMapPage', 'renderDiffPage', 'renderVersionsPage', 'renderSettings',
  'renderRail', 'showGuide', 'drawGuide',
  'route', 'parseRoute', 'go', 'rerenderCurrent', 'setHeader', 'currRoute', 'navTrack',
  'navCurHash', 'NavHist', 'sxiSelify', 'applyBarOverflow',
  'applyTheme', 'applyThemeStyles', 'themeFor', 'currentThemeEff', 'toggleTheme',
  'seedThemeMapOnce', 'setThemeFor', 'ensureCiteCache', 'withCiteHook',
  'app', 'state', 'SXI_PATHS', 'GUIDE_STEPS', 'AI_PROVIDERS', 'AI_PROVIDERS_FALLBACK',
  'AI_AGENTS', 'AI_AGENTS_FALLBACK', 'AI_MODES', 'mdInlineSt', 'themeMap', 'HL_ALIAS',
  'HL_LANGS', 'MD_TAGS', 'MD_STYLE_OK', 'MD_COLOR_MAP', 'ST_LABEL', 'ST_NEXT', 'LEVEL_NAME',
  'TASK_META', 'PAGE_LABELS', 'PRIMARY_KINDS', 'CALL_LABELS', 'AIT_PAGE_OPTS', 'AITASK_ST',
  'WHY_MARK', 'HOW_MARK', 'TASK_STALL_HINT_MS', 'RAIL_LOGO_SVG', '_aiTutGoalCache',
  '_aiSyncToken', '_aiNodesSaving', 'sxPageHostMap', '_sxPageHostMap'
]);
const STOP_PATTERNS = [
  /Vue$/, /VueEnabled$/, /VueUnmount$/, /^ensure[A-Z]\w*VueCss$/,
  /^ai[A-Z]/, /^AI_/, /^_ai/, /^chat[A-Z]/,
  /^tut[A-Z]/, /^md[A-Z]/, /^hl[A-Z]/, /^sxi[A-Z]/, /^task[A-Z]/
];
function isStopped(name) {
  if (STOP_EXACT.has(name)) return true;
  if (HOST_BINDINGS.indexOf(name) >= 0) return true;
  for (const re of STOP_PATTERNS) if (re.test(name)) return true;
  return false;
}

const PAGES = {
  diff: { title: '版本对比页', route: '#/g/:id/diff/:vid', roots: ['renderDiffPage'], render: 'renderDiffPage(H.__vid)' },
  versions: { title: '版本管理页', route: '#/g/:id/versions', roots: ['renderVersionsPage'], render: 'renderVersionsPage(H.__gid)' },
  aitasks: { title: '任务中心', route: '#/aitasks', roots: ['renderAiTasksPage'], render: 'renderAiTasksPage()' },
  home: { title: '主页', route: '#/', roots: ['renderHome'], render: 'renderHome()' },
  components: { title: '组件管理页', route: '#/components', roots: ['renderComponentsPage'], render: 'renderComponentsPage()' },
  library: { title: '资源库', route: '#/library', roots: ['renderLibraryPage'], render: 'renderLibraryPage()' },
  tutorial: { title: '教程阅读页', route: '#/t/:id', roots: ['renderTutorialPage'], render: 'renderTutorialPage(H.__tid)' },
  goal: { title: '目标执行页', route: '#/g/:id', roots: ['renderGoal'], render: 'renderGoal()' },
  settings: { title: '设置页', route: '#/settings', roots: ['renderSettings'], render: 'renderSettings()' },
  guide: { title: '使用引导', route: '#/guide/:step', roots: ['showGuide', 'drawGuide'], render: 'showGuide(Number(H.__step) || 0)' }
};

/* ============================ 字符级扫描 ============================ */

function skipString(text, i) {
  const quote = text[i];
  i++;
  while (i < text.length) {
    const c = text[i];
    if (c === '\\') { i += 2; continue; }
    if (c === quote) return i + 1;
    if (c === '\n') return i + 1;          /* 普通字符串不该跨行，容错 */
    i++;
  }
  return i;
}

function regexAllowed(prev) {
  if (!prev) return true;
  return '(,=:[!&|?{};+-*%~^<>'.indexOf(prev) >= 0;
}

function skipRegex(text, i) {
  i++;
  let inClass = false;
  while (i < text.length) {
    const c = text[i];
    if (c === '\\') { i += 2; continue; }
    if (c === '[') inClass = true;
    else if (c === ']') inClass = false;
    else if (c === '/' && !inClass) { i++; break; }
    else if (c === '\n') break;
    i++;
  }
  while (i < text.length && /[a-z]/i.test(text[i])) i++;
  return i;
}

function skipTemplate(text, i) {
  i++;
  while (i < text.length) {
    const c = text[i];
    if (c === '\\') { i += 2; continue; }
    if (c === '`') return i + 1;
    if (c === '$' && text[i + 1] === '{') { i = skipBraceExpr(text, i + 2); continue; }
    i++;
  }
  return i;
}

function skipBraceExpr(text, i) {
  let depth = 1;
  while (i < text.length) {
    const step = scanCode(text, i);
    if (step !== i) { i = step; continue; }
    const c = text[i];
    if (c === '{') depth++;
    else if (c === '}') { depth--; if (depth === 0) return i + 1; }
    i++;
  }
  return i;
}

/** 代码上下文里跳过"非结构字符"（字符串/模板/注释/正则）；返回新下标（未跳则原值） */
function scanCode(text, i) {
  const c = text[i];
  if (c === "'" || c === '"') return skipString(text, i);
  if (c === '`') return skipTemplate(text, i);
  if (c === '/' && text[i + 1] === '/') { const nl = text.indexOf('\n', i); return nl < 0 ? text.length : nl; }
  if (c === '/' && text[i + 1] === '*') { const e = text.indexOf('*/', i + 2); return e < 0 ? text.length : e + 2; }
  if (c === '/') {
    let p = i - 1;
    while (p >= 0 && /\s/.test(text[p])) p--;
    if (regexAllowed(p >= 0 ? text[p] : '')) return skipRegex(text, i);
  }
  return i;
}

function matchBrace(text, i) {
  let depth = 0;
  while (i < text.length) {
    const step = scanCode(text, i);
    if (step !== i) { i = step; continue; }
    const c = text[i];
    if (c === '{') depth++;
    else if (c === '}') { depth--; if (depth === 0) return i + 1; }
    i++;
  }
  return i;
}

function matchStatement(text, i) {
  let depth = 0;
  while (i < text.length) {
    const step = scanCode(text, i);
    if (step !== i) { i = step; continue; }
    const c = text[i];
    if ('([{'.indexOf(c) >= 0) depth++;
    else if (')]}'.indexOf(c) >= 0) depth--;
    else if (c === ';' && depth <= 0) return i + 1;
    i++;
  }
  return i;
}

/* ============================== 行号换算 ============================== */

let LINE_STARTS = [];
function buildLineIndex(text) {
  LINE_STARTS = [0];
  for (let i = 0; i < text.length; i++) if (text[i] === '\n') LINE_STARTS.push(i + 1);
}
function lineOf(offset) {
  let lo = 0, hi = LINE_STARTS.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (LINE_STARTS[mid] <= offset) lo = mid; else hi = mid - 1;
  }
  return lo;
}

/* ============================== 索引 / 闭包 ============================== */

/**
 * 索引 app.js 的顶层声明。
 *
 * ⚠️ 不能用「行首正则」扫全文：页面里渲染的示例代码是**模板字符串**，
 *    里面照样有行首的 const/function（真实踩到：'const card = ...' 被当成真的顶层声明，
 *    生成 host 表后每次插件渲染都 ReferenceError: card is not defined）。
 * 这里按字面扫描：只在「括号深度 0 + 行首 + 不在字符串/注释/模板里」时认声明。
 */
function buildIndex(text) {
  const decls = new Map();
  let i = 0;
  let depth = 0;
  let lineStart = true;
  while (i < text.length) {
    const step = scanCode(text, i);
    if (step !== i) { i = step; lineStart = false; continue; }
    const c = text[i];
    if (c === '\n') { lineStart = true; i++; continue; }
    if (lineStart && c === ' ') { i++; continue; }

    if (lineStart && depth === 0) {
      const head = text.slice(i, i + 240);
      let m = /^(?:async\s+)?function\s+([A-Za-z_$][\w$]*)\s*\(/.exec(head);
      if (m) {
        const name = m[1];
        const braceIdx = text.indexOf('{', i + m[0].length - 1);
        if (braceIdx >= 0) {
          const end = matchBrace(text, braceIdx);
          if (!decls.has(name)) decls.set(name, { start: lineOf(i), end: lineOf(Math.max(end - 1, i)), kind: 'function' });
          i = end; lineStart = false; continue;
        }
      }
      m = /^(const|let|var)\s+([A-Za-z_$][\w$]*)\s*=/.exec(head);
      if (m) {
        const kw = m[1];
        const name = m[2];
        const end = matchStatement(text, i + m[0].length);
        if (!decls.has(name)) decls.set(name, { start: lineOf(i), end: lineOf(Math.max(end - 1, i)), kind: kw });
        i = end; lineStart = false; continue;
      }
    }

    lineStart = false;
    if (c === '{') depth++;
    else if (c === '}') depth--;
    i++;
  }
  return decls;
}

/** 供 scripts/gen-host-map.js 复用同一套索引逻辑 */
function declNamesOf(text) {
  const decls = buildIndex(text);
  return Array.from(decls.keys());
}

function refsIn(text, decls) {
  const out = new Set();
  const re = /(?<![.\w$])([A-Za-z_$][\w$]*)/g;
  let m;
  while ((m = re.exec(text))) if (decls.has(m[1])) out.add(m[1]);
  return out;
}

function closure(roots, decls, lines) {
  const need = new Set();
  const queue = [];
  for (const r of roots) if (decls.has(r)) { need.add(r); queue.push(r); }
  while (queue.length) {
    const name = queue.shift();
    if (roots.indexOf(name) < 0 && isStopped(name)) continue;
    const d = decls.get(name);
    const body = lines.slice(d.start, d.end + 1).join('\n');
    for (const ref of refsIn(body, decls)) {
      if (need.has(ref) || isStopped(ref)) continue;
      need.add(ref); queue.push(ref);
    }
  }
  return need;
}

function declText(lines, name, decls) {
  const d = decls.get(name);
  let start = d.start;
  while (start > 0 && /^\s*(\/\*|\*|\/\/)/.test(lines[start - 1])) start--;
  return lines.slice(start, d.end + 1).join('\n');
}

/* ============================== 依赖改写 ============================== */

/**
 * 只在**代码区**做文本改写。
 * 字符串 / 注释 / 正则字面量原样保留；模板字符串的字面量部分原样保留，只递归处理 ${...}。
 *
 * 为什么必须区分：页面 HTML 基本都是模板字符串，属性名里就可能出现顶层函数名
 * （如 data-go="…" 的 go）。上一版为写全局变量加的「赋值目标改写」不区分字面量，
 * 把 data-go= 改成了 data-H.go= —— 属性名被改坏，事件委托的选择器全部失配，
 * 目标卡片就点不动了（真实踩到）。同理不能把 title= / value= 之类改坏。
 */
function rewriteCode(text, transform) {
  const BT = String.fromCharCode(96);
  let out = '';
  let i = 0;
  let codeStart = 0;
  while (i < text.length) {
    const c = text[i];
    if (c === "'" || c === '"') {
      out += transform(text.slice(codeStart, i));
      const end = skipString(text, i);
      out += text.slice(i, end);
      i = codeStart = end;
      continue;
    }
    if (c === BT) {
      out += transform(text.slice(codeStart, i));
      out += BT;
      i++;
      let litStart = i;
      while (i < text.length) {
        if (text[i] === '\\') { i += 2; continue; }
        if (text[i] === BT) { out += text.slice(litStart, i) + BT; i++; break; }
        if (text[i] === '$' && text[i + 1] === '{') {
          out += text.slice(litStart, i);
          const exprEnd = skipBraceExpr(text, i + 2);
          out += '${' + rewriteCode(text.slice(i + 2, exprEnd - 1), transform) + '}';
          i = exprEnd; litStart = i; continue;
        }
        i++;
      }
      codeStart = i;
      continue;
    }
    if (c === '/' && (text[i + 1] === '/' || text[i + 1] === '*')) {
      out += transform(text.slice(codeStart, i));
      const end = scanCode(text, i);
      out += text.slice(i, end);
      i = codeStart = end;
      continue;
    }
    if (c === '/') {
      let p = i - 1;
      while (p >= 0 && /\s/.test(text[p])) p--;
      if (regexAllowed(p >= 0 ? text[p] : '')) {
        out += transform(text.slice(codeStart, i));
        const end = skipRegex(text, i);
        out += text.slice(i, end);
        i = codeStart = end;
        continue;
      }
    }
    i++;
  }
  out += transform(text.slice(codeStart));
  return out;
}

/**
 * 把外部依赖改写成 H.*。
 * 只改「调用位置 name(」「属性/下标位置 name. / name[」「赋值目标 name =」，
 * 且只在代码区改（见 rewriteCode）：
 *   · 裸名字全替换会把函数参数 state 改成 H.state（真实踩到 → 语法错误）
 *   · 声明位置（function NAME / const NAME =）先遮蔽，避免改成 function H.NAME
 *   · 字符串里不能改：data-go= / title= 这类 HTML 属性名会被改成 data-H.go=
 */
function adapt(text, externals) {
  const masked = [];
  let out = text.replace(/(\bfunction\s+)([A-Za-z_$][\w$]*)/g, function (m, p1, p2) {
    masked.push(p2);
    return p1 + '\u0001D' + (masked.length - 1) + '\u0001';
  });
  out = out.replace(/(\b(?:const|let|var)\s+)([A-Za-z_$][\w$]*)(?=\s*=)/g, function (m, p1, p2) {
    masked.push(p2);
    return p1 + '\u0001D' + (masked.length - 1) + '\u0001';
  });

  const rules = [];
  for (const info of externals) {
    const n = info.name;
    rules.push([new RegExp('(?<![.\\w$])' + n + '(?=\\s*\\()', 'g'), 'H.' + n]);
    rules.push([new RegExp('(?<![.\\w$])' + n + '(?=\\s*[.\\[])', 'g'), 'H.' + n]);
    /* 赋值目标：设置页会写 AI_PROVIDERS / AI_AGENTS 这类全局 let。
       不改的话插件里就是「给未声明变量赋值」→ ReferenceError。
       host 表对 let/var 用取值器/设值器，H.X = v 会真正写回原版全局。 */
    rules.push([new RegExp('(?<![.\\w$])' + n + '(?=\\s*=(?!=))', 'g'), 'H.' + n]);
  }
  rules.push([/(?<![.\w$])app\./g, 'H.app.']);
  rules.push([/(?<![.\w$])state\./g, 'H.state.']);

  out = rewriteCode(out, function (code) {
    for (const pair of rules) code = code.replace(pair[0], pair[1]);
    return code;
  });
  out = out.replace(/H\.H\./g, 'H.');
  return out.replace(/\u0001D(\d+)\u0001/g, function (m, idx) { return masked[Number(idx)]; });
}

const JS_WORDS = new Set(['if', 'for', 'while', 'switch', 'catch', 'return', 'typeof', 'function',
  'new', 'await', 'async', 'delete', 'void', 'in', 'of', 'instanceof', 'do', 'else', 'try', 'finally',
  'throw', 'case', 'default', 'break', 'continue', 'var', 'let', 'const', 'class', 'extends', 'super',
  'this', 'true', 'false', 'null', 'undefined', 'yield', 'import', 'export', 'from', 'as', 'get', 'set',
  'Number', 'String', 'Boolean', 'Object', 'Array', 'Set', 'Map', 'WeakMap', 'WeakSet', 'Date',
  'Error', 'TypeError', 'RangeError', 'Promise', 'JSON', 'Math', 'RegExp', 'Symbol', 'Proxy',
  'Reflect', 'BigInt', 'parseInt', 'parseFloat', 'isNaN', 'isFinite', 'setTimeout', 'clearTimeout',
  'setInterval', 'clearInterval', 'requestAnimationFrame', 'cancelAnimationFrame', 'queueMicrotask',
  'fetch', 'confirm', 'alert', 'prompt', 'encodeURIComponent', 'decodeURIComponent', 'encodeURI',
  'decodeURI', 'structuredClone', 'URLSearchParams', 'URL', 'Blob', 'File', 'FileReader', 'FormData',
  'AbortController', 'TextEncoder', 'TextDecoder', 'Intl', 'Image', 'Audio', 'CustomEvent', 'Event',
  'MutationObserver', 'IntersectionObserver', 'ResizeObserver', 'getComputedStyle', 'matchMedia',
  'scrollTo', 'scrollBy', 'open', 'close', 'print', 'btoa', 'atob', 'crypto', 'performance',
  'navigator', 'document', 'window', 'console']);

function cap(s) { return s.charAt(0).toUpperCase() + s.slice(1); }

function buildPage(id, cfg, opts) {
  const text = fs.readFileSync(APP_JS, 'utf8');
  const lines = text.split('\n');
  buildLineIndex(text);
  const decls = buildIndex(text);
  const roots = cfg.roots || [];
  const missing = roots.filter(function (r) { return !decls.has(r); });
  if (missing.length) { console.error('  ERROR 找不到根函数: ' + missing.join(', ')); return false; }

  const need = closure(roots, decls, lines);
  const nonRoot = Array.from(need).filter(function (n) { return roots.indexOf(n) < 0; });
  const ordered = nonRoot.concat(roots.filter(function (r) { return need.has(r); }));
  const rawTexts = ordered.map(function (n) { return declText(lines, n, decls); });

  const referenced = new Set();
  for (const t of rawTexts) for (const ref of refsIn(t, decls)) referenced.add(ref);
  const externals = [];
  for (const ref of referenced) {
    if (need.has(ref)) continue;
    externals.push({ name: ref, kind: decls.get(ref).kind });
  }
  const adapted = rawTexts.map(function (t) { return adapt(t, externals); });

  const unresolved = new Map();
  for (const t of adapted) {
    const re = /(?<![.\w$])([A-Za-z_$][\w$]*)\s*\(/g;
    let m;
    while ((m = re.exec(t))) {
      const n = m[1];
      if (JS_WORDS.has(n) || need.has(n) || HOST_BINDINGS.indexOf(n) >= 0 || decls.has(n)) continue;
      unresolved.set(n, (unresolved.get(n) || 0) + 1);
    }
  }

  if (opts && opts.report) {
    console.log('页面 ' + id + '：闭包 ' + need.size + ' 个声明');
    console.log('  搬入: ' + Array.from(need).join(', '));
    console.log('  外部注入: ' + externals.map(function (e) { return e.name; }).join(', '));
    console.log('  局部/参数（忽略）: ' + Array.from(unresolved.keys()).join(', '));
    return true;
  }

  const mountName = 'mount' + cap(id);
  const header = [
    "'use strict';",
    '/**',
    ' * 内置 UI 插件 · ' + (cfg.title || id) + '（' + (cfg.route || '') + '）',
    ' * ---------------------------------------------------------------------------',
    ' * 本文件由 scripts/build-page-plugin.js 生成，**不要直接改这里**：',
    ' *   要改就改 public/app.js 里的原版实现，然后重新跑构建。',
    ' *',
    ' * 实现逐字来自原版 render* 及其依赖闭包（只把全局依赖改为 host 注入），',
    ' * 因此 DOM 结构 / CSS 类名 / 交互与原版一致 —— 外观像素级相同。',
    ' * 用户可在 DATA_DIR/ui-plugins/' + id + '/ 放同名插件整页覆盖。',
    ' */',
    '(function () {',
    '  var H = null;',
    ''
  ].join('\n');
  const footer = [
    '',
    '  function ' + mountName + '(host) {',
    '    H = host || {};',
    '    return {',
    '      render: function () { return ' + (cfg.render || ('render' + cap(id) + 'Page()')) + '; },',
    '      unmount: function () {}',
    '    };',
    '  }',
    '',
    '  window.SXUIPlugin = window.SXUIPlugin || {};',
    "  window.SXUIPlugin['" + id + "'] = { id: '" + id + "', mount: " + mountName + ' };',
    '})();',
    ''
  ].join('\n');
  const js = header + '\n' + adapted.join('\n\n') + '\n' + footer;

  /* 生成时自检：属性名/属性值里绝不该出现 `H.` —— 那是 adapter 改到了字符串字面量的信号。
     真实翻车：`data-go="#/g/166"` 被改成 `data-H.go=...`，外观不变、控件全点不动。
     宁可构建失败，也不要生成一个「看起来对、点不动」的插件。 */
  const CORRUPT_PATTERNS = [
    /\bdata-H\.[a-zA-Z]/,
    /\baria-H\.[a-zA-Z]/,
    /(?:id|class|for|name|title|alt|href|src|value|role|type)="H\./,
    /\sH\.(?:class|id|innerHTML|textContent)\s*=]/,
    /class="[^"]*\bH\./
  ];
  for (const re of CORRUPT_PATTERNS) {
    const m = js.match(re);
    if (m) {
      console.error('  ERROR ' + id + ' 生成结果疑似被改坏（' + m[0] + '）—— 检查 adapt/rewriteCode 是否只改代码区');
      return false;
    }
  }

  const dir = path.join(OUT_ROOT, id);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'index.js'), js);
  fs.writeFileSync(path.join(dir, 'manifest.json'), JSON.stringify({
    id: id,
    name: (cfg.title || id) + '（内置）',
    apiVersion: 'sierxing.ui/1',
    version: '1.0.0',
    description: (cfg.title || id) + '：原版实现的插件化版本（' + (cfg.route || '') + '）。',
    entry: 'index.js'
  }, null, 2) + '\n');
  console.log('  ok ' + id + '  ' + need.size + ' decls / ' + js.length + ' bytes');
  return true;
}

module.exports = { buildIndex, declNamesOf, PAGES };

if (require.main !== module) return;

const argv = process.argv.slice(2);
if (argv.indexOf('--list') >= 0) {
  Object.keys(PAGES).forEach(function (id) { console.log(id.padEnd(12) + (PAGES[id].route || '').padEnd(24) + (PAGES[id].roots || []).join(',')); });
  process.exit(0);
}
if (argv.indexOf('--report') >= 0) {
  const id = argv[argv.indexOf('--report') + 1];
  if (!PAGES[id]) { console.error('未配置: ' + id); process.exit(1); }
  buildPage(id, PAGES[id], { report: true });
  process.exit(0);
}
const targets = argv.indexOf('--all') >= 0 ? Object.keys(PAGES) : argv.filter(function (a) { return a.indexOf('-') !== 0; });
if (!targets.length) { console.error('usage: <page...> | --all | --report <page> | --list'); process.exit(1); }
let ok = 0;
targets.forEach(function (id) {
  if (!PAGES[id]) { console.error('  ERROR 未配置 ' + id); return; }
  console.log('building ' + id + ' ...');
  if (buildPage(id, PAGES[id], {})) ok++;
});
console.log('done: ' + ok + '/' + targets.length);