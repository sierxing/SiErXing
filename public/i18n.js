'use strict';
/**
 * 思而行 · 前端语言运行时（i18n）
 * ============================================================================
 * 加载顺序（由 server 注入，见 server/server.js 的 serveStatic）：
 *   1. <script>window.__SX_I18N__ = {code,name,rtl,...}</script>
 *   2. <script src="/api/language/pack.js?...">  → window.__SX_I18N_DATA__ = {entries, patterns?}
 *   3. <script src="/i18n.js">                  → 本文件：定义 window.tr / window.SXI18N
 *   4. sdk.js / app.js
 *
 * 三种用法，按优先级：
 *   A. 新代码：`tr('中文原文', 参数…)` —— 源码里的中文原文就是 key（gettext 风格）；
 *      带变量的用 `tr('共 {0} 个', n)`；这样在渲染前就已是目标语言。
 *   B. 旧界面（大量既有代码没改）：本文件会把渲染出来的文本节点 / title、placeholder
 *      等属性做一次「字典替换」—— 源码不用动，界面也能整体切语言。字典就是
 *      language/locales/<code>/ui.json（中文原文 → 译文）。这是过渡层，不是长期方案：
 *      改动旧代码时顺手把文字包成 tr() 即可，守卫脚本会盯着新代码。
 *   C. 原生 confirm/alert/prompt：本文件包了一层，自动翻译消息。
 *
 * ⚠️ 不要翻译的区域（AI 正文 / 教程正文 / 用户数据）用 `data-i18n-skip` 或
 *    `class="no-i18n"` 标出来，SKIP 列表见下方。
 */
(function () {
  var cfg = window.__SX_I18N__ || { code: 'zh-CN', name: '中文', rtl: false };
  var data = window.__SX_I18N_DATA__ || {};
  var entries = (data && data.entries && typeof data.entries === 'object') ? data.entries : {};
  var code = String(cfg.code || 'zh-CN');
  var hasDict = Object.keys(entries).length > 0;

  /* ---------- 字典：精确匹配表 + 占位符模式表 ---------- */
  var exact = Object.create(null);
  var patterns = [];                 /* {key, re, order} 按字面部分长度从长到短匹配 */
  (function build() {
    for (var k in entries) {
      if (!Object.prototype.hasOwnProperty.call(entries, k)) continue;
      var v = entries[k];
      if (typeof v !== 'string' || !v || v === k) continue;
      if (/\{\d+\}/.test(k)) {
        var segs = k.split(/\{\d+\}/);
        var src = '^';
        for (var i = 0; i < segs.length; i++) {
          /* ⚠️ 先转义再替换空格：反过来会把 \s* 里的反斜杠也转义掉，整条模式就永远匹配不上 */
          var lit = escapeRe(segs[i]).replace(/ +/g, '\\s*');
          src += lit;
          if (i < segs.length - 1) src += '([\\s\\S]*?)';
        }
        src += '$';
        var literalLen = segs.join('').replace(/\s+/g, '').length;
        try { patterns.push({ key: k, re: new RegExp(src), literalLen: literalLen }); } catch (e) {}
      } else {
        exact[k] = v;
      }
    }
    patterns.sort(function (a, b) { return b.literalLen - a.literalLen; });
  })();

  function escapeRe(s) {
    return String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  }

  /* 运行时归一化：和 language/extract.js 的 normalizeKey 保持一致 */
  function normalize(value) {
    return String(value == null ? '' : value)
      .replace(/[\u00a0]/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();
  }
  function hasCJK(value) {
    return /[\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff]/.test(String(value == null ? '' : value));
  }

  /** 目录里的占位符 key 会规范化成 "文本 {0} 文本"（提取器统一加的），
      tr('共{0}个') 这类紧挨着的写法要先规范化再查表。 */
  function canonicalKey(value) {
    return String(value == null ? '' : value)
      .replace(/\s*(\{\d+\})\s*/g, ' $1 ')
      .replace(/\s+/g, ' ')
      .trim();
  }

  /** 模式替换：把 {0} 换成捕获到的内容 */
  function fill(tpl, args) {
    return String(tpl).replace(/\{(\d+)\}/g, function (all, idx) {
      var v = args && args[Number(idx)];
      return v == null ? all : String(v);
    });
  }

  /* ---------- 组合翻译：整段匹配不上时，按结构拆开翻 ----------
     旧界面里有大量「文案 + 变量」直接拼出来的文本（例如 "每周 " + 10 + " 周"、
     "共 " + n + " 个组件"、服务端消息 "保存失败：xxx"），静态目录里只有片段 key。
     这里按「占位符模式 → 标点分段 → 表情/标点前后缀 → 数字前缀 → 前后缀片段 → 技术串片段」
     逐层尝试；每一层都只替换目录里确实存在的片段，用户数据/AI 正文不会被改写。 */

  var prefixKeys = null;
  var suffixKeys = null;
  var fragmentKeys = null;

  function getPrefixKeys() {
    if (prefixKeys) return prefixKeys;
    prefixKeys = [];
    for (var k in entries) {
      if (!Object.prototype.hasOwnProperty.call(entries, k)) continue;
      if (/\{\d+\}/.test(k)) continue;
      if (/[：:！!？?…。；;，,]$/.test(k) || k.length >= 6) prefixKeys.push(k);
    }
    prefixKeys.sort(function (a, b) { return b.length - a.length; });
    return prefixKeys;
  }
  function getSuffixKeys() {
    if (suffixKeys) return suffixKeys;
    suffixKeys = [];
    for (var k in entries) {
      if (!Object.prototype.hasOwnProperty.call(entries, k)) continue;
      if (/\{\d+\}/.test(k)) continue;
      if (k.length >= 2 && /[）)】\]」》！!？?…。；;，,：:]$/.test(k)) suffixKeys.push(k);
    }
    suffixKeys.sort(function (a, b) { return b.length - a.length; });
    return suffixKeys;
  }
  function getFragmentKeys() {
    if (fragmentKeys) return fragmentKeys;
    fragmentKeys = [];
    for (var k in entries) {
      if (!Object.prototype.hasOwnProperty.call(entries, k)) continue;
      if (/\{\d+\}/.test(k)) continue;
      if (k.length >= 2 && k.length <= 8) fragmentKeys.push(k);
    }
    fragmentKeys.sort(function (a, b) { return b.length - a.length; });
    return fragmentKeys;
  }

  var SEP_MAP = {
    '：': ': ', ':': ': ', '，': ', ', ',': ', ', '。': '. ', '、': ', ',
    '；': '; ', ';': '; ', '！': '! ', '!': '! ', '？': '? ', '?': '? ',
    '（': ' (', '）': ')', '(': ' (', ')': ')',
    '【': ' [', '】': ']', '「': '"', '」': '"', '『': '"', '』': '"', '《': ' "', '》': '"',
    '—': ' — ', '…': '…', '·': ' · ', '｜': ' | ', '|': ' | '
  };
  var SEG_SPLIT_RE = /([（）()【】\[\]「」『』《》：:；;，,。.！!？?…—、|｜]+)/;

  function translateBySegments(core, depth) {
    var parts = core.split(SEG_SPLIT_RE);
    if (parts.length < 2) return null;
    var changed = 0;
    var out = '';
    for (var i = 0; i < parts.length; i++) {
      var part = parts[i];
      if (!part) continue;
      if (SEG_SPLIT_RE.test(part) && parts.length > 1 && part.length <= 2) {
        var sep = SEP_MAP[part];
        out += sep != null ? sep : part;
        continue;
      }
      var trimmed = part.trim();
      if (trimmed && hasCJK(trimmed) && trimmed.length > 1) {
        var nextSep = (i + 1 < parts.length && parts[i + 1] && SEG_SPLIT_RE.test(parts[i + 1])) ? parts[i + 1].trim() : '';
        var tr2 = coreTranslate(trimmed, depth + 1);
        var consumedSep = false;
        if (tr2 == null && nextSep) {
          /* 目录里的 key 常带句末标点（“…勾选。”）：把后面的标点并进来再试一次 */
          tr2 = coreTranslate(trimmed + nextSep, depth + 1);
          consumedSep = tr2 != null;
        }
        if (tr2 != null) {
          changed++;
          out += tr2;
          if (consumedSep) i++;
          continue;
        }
      }
      out += part;
    }
    return changed ? out : null;
  }

  function lookupSuffix(core, depth) {
    var keys = getSuffixKeys();
    for (var i = 0; i < keys.length; i++) {
      var k = keys[i];
      if (core.length <= k.length) continue;
      if (core.slice(core.length - k.length) !== k) continue;
      var rawPre = core.slice(0, core.length - k.length);
      var pre = normalize(rawPre);
      if (!pre) continue;
      var preTr = hasCJK(pre) ? coreTranslate(pre, depth + 1) : pre;
      if (preTr == null) continue;
      /* 保留原文 key 前的空格：不然 " · xxx" 会粘成 "·xxx" */
      var leadSpace = /\s$/.test(rawPre) ? ' ' : '';
      return preTr + leadSpace + entries[k];
    }
    return null;
  }

  function lookupPrefix(core, depth) {
    var keys = getPrefixKeys();
    for (var i = 0; i < keys.length; i++) {
      var k = keys[i];
      if (core.length <= k.length) continue;
      if (core.slice(0, k.length) !== k) continue;
      var rawTail = core.slice(k.length);
      var tail = normalize(rawTail);
      var tailTr = hasCJK(tail) ? coreTranslate(tail, depth + 1) : tail;
      var leadSpace = /^\s/.test(rawTail) ? ' ' : '';
      return entries[k] + leadSpace + (tailTr != null ? tailTr : tail);
    }
    return null;
  }

  /** 只在「技术串」里替换短的界面片段（路径/文件名/版本号等混排的文本）——
      避免把用户数据（目标标题、笔记）里恰好同名的词拆开翻译。 */
  function replaceFragments(core) {
    /* 只处理真正的"技术串"：带路径分隔符或文件扩展名（服务端/前端/样式/文件路径）。
       普通的"中英混排句子"不许按片段拆 —— 拆出来会变成 "Apply的基础能力" 这种洋泾浜。 */
    var isTech = /(?:[A-Za-z0-9_.-]+[\/\\][A-Za-z0-9_.\/\\-]*)|\.(?:js|css|json|md|html|png|svg|txt|db)\b/.test(core);
    if (!isTech) return null;
    var cjk = (core.match(/[\u3400-\u9fff]/g) || []).length;
    var total = core.replace(/\s/g, '').length;
    if (!total || cjk * 2 > total) return null;
    var out = core;
    var changed = 0;
    var keys = getFragmentKeys();
    for (var i = 0; i < keys.length; i++) {
      var k = keys[i];
      if (out.indexOf(k) < 0) continue;
      out = out.split(k).join(entries[k]);
      changed++;
    }
    return changed ? out : null;
  }

  /**
   * 核心翻译（返回 null = 保持原文）。depth 防止递归兜圈。
   */
  function coreTranslate(core, depth) {
    if (!hasDict || !core || !hasCJK(core)) return null;
    if (depth > 4) return null;
    /* 递归进来的单个汉字（多半是拼接在数据里的单位/量词，如 "6 周" 的"周"）不翻，
       否则会把用户数据改花（顶层单个字仍按目录翻译）。 */
    if (depth > 0 && core.length === 1) return null;
    if (exact[core] != null) return exact[core];
    var i, m, j;
    /* 1) 占位符模式：捕获到的变量本身也可能是一段中文界面文字，递归翻一下 */
    for (i = 0; i < patterns.length; i++) {
      var p = patterns[i];
      m = p.re.exec(core);
      if (!m) continue;
      var args = [];
      for (j = 1; j < m.length; j++) {
        var cap = normalize(m[j]);
        var capTr = (hasCJK(cap) && cap.length > 1) ? coreTranslate(cap, depth + 1) : cap;
        args.push(capTr != null ? capTr : cap);
      }
      return fill(entries[p.key], args);
    }
    /* 2) 标点分段（"目标列表：我的目标" / "AI 任务中心（…）"） */
    var seg = translateBySegments(core, depth);
    if (seg != null) return seg;
    /* 3) 前缀是 emoji/符号（"📖 使用引导"）或后缀是标点：剥掉再试 */
    m = /^([^\u3400-\u9fffA-Za-z0-9]+)([\s\S]*)$/.exec(core);
    if (m && m[2] && hasCJK(m[2])) {
      var inner = coreTranslate(m[2], depth + 1);
      if (inner != null) return m[1] + inner;
    }
    m = /^([\s\S]*[\u3400-\u9fff])([^\u3400-\u9fffA-Za-z0-9]+)$/.exec(core);
    if (m && m[1] && hasCJK(m[1])) {
      var headTr = coreTranslate(m[1], depth + 1);
      if (headTr != null) return headTr + m[2];
    }
    /* 4) 数字 / ASCII 前缀 + 中文部分（"35 个组件"） */
    m = /^([0-9][0-9A-Za-z%#\/._+\-\s]*\s+)([\s\S]*[\u3400-\u9fff][\s\S]*)$/.exec(core);
    if (m) {
      var restTr = coreTranslate(m[2], depth + 1);
      if (restTr != null) return m[1] + restTr;
    }
    /* 5) 以标点/右括号结尾的整段后缀（服务端消息的尾巴） */
    var suf = lookupSuffix(core, depth);
    if (suf != null) return suf;
    /* 6) 前缀型提示（"保存失败：xxx" → "Save failed: xxx"） */
    var pre = lookupPrefix(core, depth);
    if (pre != null) return pre;
    /* 7) 技术串里的短片段替换（文件路径 / 版本号等混排） */
    var frag = replaceFragments(core);
    if (frag != null) return frag;
    return null;
  }

  /**
   * 翻译一条完整文案（保持前后空白）。
   * @returns {string|null} null = 没有匹配到（保持原文）
   */
  function translateText(raw) {
    if (!hasDict) return null;
    var s = String(raw == null ? '' : raw);
    if (!hasCJK(s)) return null;
    var lead = (s.match(/^\s*/) || [''])[0];
    var trail = (s.match(/\s*$/) || [''])[0];
    var core = normalize(s);
    if (!core) return null;
    var out = coreTranslate(core, 0);
    if (out != null) return lead + out + trail;
    return null;
  }

  function lookup(core) { return coreTranslate(core, 0); }
  function lookupPrefixOnly(core) { return lookupPrefix(core, 0); }

  /* ---------- 公共 API ---------- */

  /**
   * 取译文。用法：
   *   tr('保存')            → 'Save'
   *   tr('共 {0} 个', n)    → '3 items in total'
   * 没有译文时原样返回（中文用户行为不变）。
   */
  function tr(source, a, b, c) {
    var s = String(source == null ? '' : source);
    if (!hasDict) return fill(s, arguments.length > 1 ? Array.prototype.slice.call(arguments, 1) : null);
    var args = arguments.length > 1 ? Array.prototype.slice.call(arguments, 1) : null;
    if (/\{\d+\}/.test(s)) {
      var hit = entries[s];
      if (hit == null) hit = entries[canonicalKey(s)];
      if (hit == null && hasCJK(s)) hit = coreTranslate(canonicalKey(s), 0);
      if (hit != null) return fill(hit, args);
      return fill(s, args);
    }
    var out = exact[s];
    if (out == null && hasCJK(s)) out = coreTranslate(normalize(s), 0);
    return out != null ? out : s;
  }

  /* ---------- DOM 翻译（旧界面过渡层） ---------- */

  /* 这些标签里面是"代码/媒体"，不是界面文案：整棵子树跳过（属性仍会翻译，如 input 的 placeholder） */
  var CONTENT_SKIP_TAGS = {
    SCRIPT: 1, STYLE: 1, NOSCRIPT: 1, TEXTAREA: 1, CODE: 1, PRE: 1, KBD: 1, SAMP: 1,
    IMG: 1, SVG: 1, CANVAS: 1, VIDEO: 1, AUDIO: 1
  };
  /* 这些区域是「内容/数据」不是界面：AI 正文、教程正文、刷题题面、图表等。
     代码里也可以用 data-i18n-skip / class="no-i18n" 主动标出来。 */
  var SKIP_SELECTOR = [
    '[data-i18n-skip]', '.no-i18n',
    '#tutFrame', '.tutBody', '.tutHtmlBody',
    '#adMsgs', '.adMsgs', '.mdBody', '.aiMsgs',
    '.hljs', '.codeBody', '.exCode', '.qBody', '.statement', '.problemStatement'
  ].join(',');

  function inSkipZone(el) {
    try {
      if (el.closest && el.closest(SKIP_SELECTOR)) return true;
    } catch (e) { return false; }
    return false;
  }

  var ATTRS = ['title', 'placeholder', 'aria-label', 'aria-placeholder', 'alt'];

  function translateElementAttrs(el) {
    if (!el || el.nodeType !== 1) return;
    if (inSkipZone(el)) return;
    for (var i = 0; i < ATTRS.length; i++) {
      var name = ATTRS[i];
      if (!el.hasAttribute || !el.hasAttribute(name)) continue;
      var v = el.getAttribute(name);
      if (!hasCJK(v)) continue;
      var out = translateText(v);
      if (out != null && out !== v) el.setAttribute(name, out);
    }
    /* <input type=button|submit value="..."> 会显示 */
    if (el.tagName === 'INPUT') {
      var type = String(el.getAttribute('type') || '').toLowerCase();
      if ((type === 'button' || type === 'submit' || type === 'reset') && hasCJK(el.value)) {
        var vv = translateText(el.value);
        if (vv != null) el.value = vv;
      }
    }
    if (el.hasAttribute && el.hasAttribute('data-i18n')) {
      var key = el.getAttribute('data-i18n');
      var val = tr(key);
      if (val !== key) el.textContent = val;
    }
  }

  var SHOW_TEXT = typeof NodeFilter !== 'undefined' && NodeFilter.SHOW_TEXT ? NodeFilter.SHOW_TEXT : 4;
  var SHOW_ELEMENT = typeof NodeFilter !== 'undefined' && NodeFilter.SHOW_ELEMENT ? NodeFilter.SHOW_ELEMENT : 1;

  function walkDom(root) {
    if (!root || !hasDict) return;
    if (root.nodeType === 3) { translateTextNode(root); return; }
    if (root.nodeType !== 1 && root.nodeType !== 9 && root.nodeType !== 11) return;
    if (root.nodeType === 1) {
      translateElementAttrs(root);
      if (root.tagName && CONTENT_SKIP_TAGS[root.tagName]) return;
      if (inSkipZone(root)) return;
    }
    var walker = document.createTreeWalker(root, SHOW_ELEMENT | SHOW_TEXT, null);
    var node = walker.nextNode();
    while (node) {
      if (node.nodeType === 1) {
        translateElementAttrs(node);
        if (CONTENT_SKIP_TAGS[node.tagName] || inSkipZone(node)) {
          /* 跳过整棵子树：TreeWalker 没有 skip 接口，直接跳到下一个不在该子树里的节点 */
          var skipRoot = node;
          node = walker.nextNode();
          while (node && skipRoot.contains && skipRoot.contains(node)) node = walker.nextNode();
          continue;
        }
      } else if (node.nodeType === 3) {
        translateTextNode(node);
      }
      node = walker.nextNode();
    }
  }

  function translateTextNode(node) {
    if (!node || node.nodeType !== 3) return;
    var parent = node.parentNode;
    if (!parent || (parent.nodeType === 1 && (CONTENT_SKIP_TAGS[parent.tagName] || inSkipZone(parent)))) return;
    var raw = node.nodeValue;
    if (!hasCJK(raw)) return;
    var out = translateText(raw);
    if (out != null && out !== raw) {
      node.nodeValue = out;
    }
  }

  /* ---------- MutationObserver：页面重绘后就地翻译 ---------- */

  var observer = null;
  var pending = [];
  var scheduled = false;

  function queueNode(node) {
    if (!node) return;
    pending.push(node);
    if (scheduled) return;
    scheduled = true;
    var run = function () {
      scheduled = false;
      var list = pending;
      pending = [];
      for (var i = 0; i < list.length; i++) {
        try { walkDom(list[i]); } catch (e) { /* 单个节点失败不影响其它 */ }
      }
    };
    if (typeof requestAnimationFrame === 'function') requestAnimationFrame(run);
    else setTimeout(run, 16);
  }

  function startObserver() {
    if (observer || !hasDict || typeof MutationObserver === 'undefined') return;
    observer = new MutationObserver(function (muts) {
      for (var i = 0; i < muts.length; i++) {
        var m = muts[i];
        if (m.type === 'childList') {
          for (var j = 0; j < m.addedNodes.length; j++) {
            var n = m.addedNodes[j];
            if (n.nodeType === 1 || n.nodeType === 3) queueNode(n);
          }
        } else if (m.type === 'characterData') {
          queueNode(m.target);
        } else if (m.type === 'attributes') {
          queueNode(m.target);
        }
      }
    });
    observer.observe(document.documentElement, {
      childList: true,
      subtree: true,
      characterData: true,
      attributes: true,
      attributeFilter: ATTRS.concat(['data-i18n'])
    });
  }

  /* ---------- 原生弹窗 / 文档标题 ---------- */

  function patchNativeDialogs() {
    try {
      var c0 = window.confirm;
      window.confirm = function (msg) { return c0.call(window, typeof msg === 'string' ? tr(msg) : msg); };
      var a0 = window.alert;
      window.alert = function (msg) { return a0.call(window, typeof msg === 'string' ? tr(msg) : msg); };
      var p0 = window.prompt;
      window.prompt = function (msg, def) {
        return p0.call(window, typeof msg === 'string' ? tr(msg) : msg, typeof def === 'string' ? tr(def) : def);
      };
    } catch (e) {}
  }

  function applyDocMeta() {
    try {
      if (cfg.code) document.documentElement.setAttribute('lang', cfg.code);
      if (cfg.rtl) document.documentElement.setAttribute('dir', 'rtl');
      var title = cfg.documentTitle || (data && data.documentTitle) || '';
      if (title) document.title = title;
      var meta = document.querySelector('meta[name="description"]');
      var desc = cfg.documentDescription || (data && data.documentDescription) || '';
      if (meta && desc) meta.setAttribute('content', desc);
    } catch (e) {}
  }

  /* ---------- 语言状态 ---------- */

  var state = {
    code: code,
    name: String(cfg.name || code),
    nativeName: String(cfg.nativeName || cfg.name || code),
    rtl: !!cfg.rtl,
    entries: entries,
    version: String(cfg.version || '')
  };

  function reload() {
    try { window.location.reload(); } catch (e) {}
  }

  /** 切换界面语言：写服务端设置后整页刷新（字典/提示词/服务端文案一起换） */
  function setLanguage(nextCode) {
    return fetch('/api/language/active', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ code: nextCode || '' })
    }).then(function (r) { return r.json(); }).then(function (j) {
      if (!j || !j.ok) throw new Error((j && j.error) || '切换语言失败');
      reload();
      return j;
    });
  }

  /* ---------- 初始化 ---------- */

  function init() {
    applyDocMeta();
    patchNativeDialogs();
    if (!hasDict) return;                    /* 中文（源语言）不做任何 DOM 处理 */
    var boot = function () {
      walkDom(document.body || document.documentElement);
      startObserver();
    };
    if (document.readyState === 'loading') {
      document.addEventListener('DOMContentLoaded', boot, { once: true });
    } else {
      boot();
    }
  }

  window.tr = tr;
  window.SXI18N = {
    code: state.code,
    name: state.name,
    nativeName: state.nativeName,
    rtl: state.rtl,
    entries: entries,
    get active() { return state.code; },
    has: function (key) { return typeof key === 'string' && key in entries; },
    tr: tr,
    translateText: translateText,
    applyDom: walkDom,
    setLanguage: setLanguage,
    reload: reload
  };

  init();
})();
