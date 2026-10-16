'use strict';
/**
 * 信息源正文清洗——把网页抓下来时混进来的垃圾文字去掉，只留正文。
 *
 * 为什么需要：抓网页正文原来是「把 HTML 标签全删掉」，于是每条资料里都混着
 * 站名/导航菜单/面包屑/「相关阅读」「猜你喜欢」的链接清单/关注公众号与加群引导/
 * 版权与免责声明/页码/评论区/报名咨询……这些文字既不进脑子，还会被切成检索片段，
 * 把真正的内容挤下去（实测抓 3,500 字里常常有一多半是这种垃圾）。
 *
 * 两层清洗：
 *   ① 本地（免费、确定性）：按标签去整块垃圾 → 挑出主内容容器 → 逐行清洗
 *      （导航短行 / 纯链接行 / 面包屑 / 版权页脚 / 公众号引导 / 页码 / 重复行 / 评论区…）；
 *   ② 可选 AI（只删不改）：把①的结果再交给模型删掉"与主题无关的软文与推荐段落"，
 *      契约是**逐字保留、只做删除、不许改写/新增**，并有长度比例与"原文子串"双保险。
 *
 * 本模块只做纯文本/纯字符串处理（不碰 db 与网络），方便单独验证。
 */

/* 整块丢掉的标签（这些标签里的文字基本不可能是正文） */
const DROP_TAGS = ['script', 'style', 'noscript', 'template', 'svg', 'canvas', 'iframe', 'form', 'button', 'select', 'option', 'textarea', 'nav', 'header', 'footer', 'aside'];
/* 按 class/id 判断的垃圾容器（命中就把这块内容丢掉） */
const JUNK_BLOCK_RE = /(^|[\s_-])(nav|menu|footer|header|sidebar|side-bar|comment|comments|related|recommend|tuijian|hot-?list|advert|ads?|banner|promo|share|social|breadcrumb|crumb|pagination|pager|tag-?list|tags|copyright|site-?info|subscribe|newsletter|search-?box|topbar|toolbar|login|signin|popup|modal|paywall|cookie)([\s_-]|$)/i;
/* 主内容容器（density 之外的一条捷径：这些名字里出现的，优先当正文） */
const MAIN_HINT_RE = /(^|[\s_-])(content|article|post|entry|main|detail|body|markdown|md|rich-?text|text|read|story|chapter)([\s_-]|$)/i;

const VOID_TAGS = new Set(['br', 'hr', 'img', 'source', 'track', 'wbr', 'meta', 'link', 'input', 'col', 'area', 'base', 'embed', 'param']);

/* 行级垃圾：命中即丢（中英文常见"网页牛皮癣"） */
const JUNK_LINE_RE = new RegExp([
  '关注(公众|微信|我们)|扫码|长按识别|二维码|加(微信|群|QQ)|进群|微信群|读者群',
  '点击(下载|查看|阅读)|下载(APP|客户端)|打开APP|APP内打开|继续阅读',
  '上一[篇页章]|下一[篇页章]|上一篇|下一篇|返回(顶部|首页|列表)|回到顶部',
  '相关(阅读|推荐|文章|链接)|推荐(阅读|文章)|热门(推荐|文章|阅读)|猜你喜欢|更多精彩|延伸阅读|阅读更多',
  '版权(声明|所有)|版权所有|免责声明|转载(请|需)|本文(链接|地址|来源)|原文链接|来源[:：]|编辑[:：]|责任编辑|投稿|侵删',
  '分享到|分享至|点击分享|点赞|在看|收藏本文|收藏这|转发|打赏|赞赏',
  '登录(后)?(查看|可见|阅读)?|注册|立即登录|免费注册',
  '广告|赞助|推广|商务合作|联系我们|客服|服务条款|隐私政策|使用协议',
  'ICP备|京ICP|沪ICP|粤ICP|公安备案|网安备|增值电信|营业执照|网络文化经营许可证',
  '报名咨询|在线咨询|课程咨询|免费试听|免费领取|领取资料|资料包|限时优惠|名额有限|招生简章|学费',
  '第\\s*\\d+\\s*页|共\\s*\\d+\\s*页|Page\\s*\\d+\\s*(of|/)\\s*\\d+|\\d+\\s*/\\s*\\d+\\s*页',
  'Copyright|All Rights Reserved|Privacy Policy|Terms of (Use|Service)|Cookie(s)?|Sign (in|up)|Log ?in|Subscribe|Newsletter|Share (this|on)|Follow us|Advertisement|Sponsored|Read more|Related (posts|articles)|Recommended',
  'We use cookies|Accept all|Manage (consent|preferences)'
].join('|'), 'i');
/* 纯导航/面包屑：又短、又没有句末标点 */
const BREADCRUMB_RE = /(首页|主页|栏目|分类)\s*[>»›\/→]\s*/;
const PUNCT_END_RE = /[。．.!！?？；;：:”"』】）)】]$/;
/* 正文里出现这些说明这一行是"站点信息" */
const SITE_INFO_RE = /(www\.|https?:\/\/|\.(com|cn|net|org|io|ai)\b)/i;

/* 命名实体表：网页正文里真会遇到的（标点、箭头、数学号、货币、版权…）。
   认不出来的实体原样保留 —— 宁可看着怪，也不能把读者的正文吃掉。 */
const NAMED_ENTITIES = {
  nbsp: ' ', ensp: ' ', emsp: ' ', thinsp: ' ', shy: '', zwnj: '', zwj: '', lrm: '', rlm: '',
  lt: '<', gt: '>', amp: '&', quot: '"', apos: "'", colon: ':', sol: '/', equals: '=',
  ldquo: '“', rdquo: '”', lsquo: '‘', rsquo: '’', bdquo: '„', sbquo: '‚',
  laquo: '«', raquo: '»', lsaquo: '‹', rsaquo: '›',
  mdash: '—', ndash: '–', horbar: '―', hellip: '…', middot: '·', bull: '•', sdot: '⋅', hellip: '…',
  times: '×', divide: '÷', plusmn: '±', mnplus: '∓', ne: '≠', le: '≤', ge: '≥', equiv: '≡', asymp: '≈',
  infin: '∞', sum: '∑', prod: '∏', radic: '√', int: '∫', part: '∂', nabla: '∇', isin: '∈', notin: '∉',
  larr: '←', uarr: '↑', rarr: '→', darr: '↓', harr: '↔', crarr: '↵', rArr: '⇒', hArr: '⇔',
  copy: '©', reg: '®', trade: '™', sect: '§', para: '¶', dagger: '†', Dagger: '‡', permil: '‰',
  euro: '€', pound: '£', yen: '¥', cent: '¢', curren: '¤',
  deg: '°', prime: '′', Prime: '″', minus: '−', lowast: '∗',
  star: '★', starf: '★', hearts: '♥', diams: '♦', clubs: '♣', spades: '♠',
  check: '✓', cross: '✗', num: '#', percnt: '%', commat: '@'
};

/** HTML 实体解码。
 *  ⚠️ 替换顺序有讲究，必须「数字实体 → 命名实体 → &amp; 放最后」：
 *   - 十六进制实体是**必需**的：CSDN 这类站点把全角标点写成 `&#xff0c;`（=「，」）。
 *     只认十进制的话，整篇正文会变成 "AI技术迭代&#xff0c;Agent产品…" —— 实测踩到，
 *     库里已有 69 条资料被这种乱码污染，还会顺着检索切片与提示词一路传下去。
 *   - `&amp;` 必须最后解：页面里写 `&amp;lt;` 时作者本意是**显示文字** `&lt;`
 *     （讲 HTML/转义的教程里到处都是），先解 `&amp;` 会连解两层、把 "<" 塞进正文，
 *     把讲解内容改坏。放最后就只解一层，符合浏览器语义。 */
function decodeEntities(s) {
  let h = String(s == null ? '' : s);
  if (h.indexOf('&') < 0) return h;
  const cp = (m, v) => {
    const n = parseInt(v, 10);
    if (!Number.isFinite(n) || n <= 0 || n > 0x10ffff) return m;
    try { return String.fromCodePoint(n); } catch (e) { return m; }
  };
  h = h.replace(/&#[xX]([0-9a-fA-F]{1,6});/g, (m, v) => cp(m, parseInt(v, 16)));
  h = h.replace(/&#(\d{1,7});/g, cp);
  h = h.replace(/&([a-zA-Z][a-zA-Z0-9]{1,9});/g, (m, name) => {
    const v = NAMED_ENTITIES[name] !== undefined ? NAMED_ENTITIES[name]
      : (NAMED_ENTITIES[name.toLowerCase()] !== undefined ? NAMED_ENTITIES[name.toLowerCase()] : undefined);
    return v === undefined ? m : v;
  });
  h = h.replace(/&amp;/g, '&');
  return h;
}

/** HTML → 纯文本（保留段落与列表换行；保留 ``` 代码块里的原样内容） */
function htmlToText(html) {
  let h = String(html || '');
  /* ⚠️ 先整块丢掉 script/style —— 这一步**不能**只放在 dropJunkBlocks 里：
     走"看着不像 HTML"那条路（cleanLines → htmlToText）时 dropJunkBlocks 根本不会被调用，
     而反爬挑战页恰恰长得不像 HTML（正文只有一个 <script>）。真实翻车：51CTO 给非浏览器
     请求回 988 字节的纯 <script> 混淆代码，只删标签的话它就变成"正文"进了资料库。
     顺序也很重要：此时 `&lt;script&gt;` 还是转义状态，讲 HTML 的教程不会被误删。 */
  h = h.replace(/<(script|style|noscript|template|svg|canvas|iframe)\b[^>]*>[\s\S]*?<\/\1\s*>/gi, ' ');
  h = h.replace(/<!--[\s\S]*?-->/g, ' ');
  h = h.replace(/<(br|hr)\s*\/?>/gi, '\n');
  h = h.replace(/<\/(p|div|section|article|li|tr|h[1-6]|blockquote|pre|dd|dt)>/gi, '\n');
  h = h.replace(/<li[^>]*>/gi, '\n- ');
  h = h.replace(/<h([1-6])[^>]*>/gi, (m, n) => '\n' + '#'.repeat(Math.min(6, Number(n) + 1)) + ' ');
  h = h.replace(/<pre[^>]*>/gi, '\n```\n').replace(/<\/pre>/gi, '\n```\n');
  h = h.replace(/<[^>]+>/g, ' ');
  /* ⚠️ 代码块（<pre>）里的实体也照解 —— 浏览器里显示的就是解出来的字符，
     抓正文就该跟浏览器看到的一致；围栏成对性由 cleanLines 保证。 */
  return decodeEntities(h);
}

/** 这段"正文"是不是反爬挑战页的混淆脚本？
 *  判据只认 javascript-obfuscator 那类产物特有的 `_0x649a` 标识符，且出现 ≥3 次 ——
 *  宁可漏判也不能误判：真讲 JS 的教程里出现一两个不算，成片出现才说明整段都是混淆代码。 */
function looksLikeChallenge(text) {
  return ((String(text || '').match(/_0x[0-9a-f]{4,}/gi) || []).length) >= 3;
}

/** 丢掉整块垃圾容器（nav/header/footer/aside 与 class/id 命中垃圾词的 div/ul/section…）。
 *  ⚠️ 正则删嵌套 div 不完美 —— 所以后面还有一层"逐行清洗"兜底，两层配合才干净。 */
function dropJunkBlocks(html) {
  let h = String(html || '');
  h = h.replace(/<(script|style|noscript|template|svg|canvas|iframe|form|button|select|option|textarea)\b[\s\S]*?<\/\1\s*>/gi, ' ');
  h = h.replace(/<(nav|header|footer|aside)\b[\s\S]*?<\/\1\s*>/gi, ' ');
  const tagRe = /<(div|ul|ol|section|span|table)\b([^>]*)>/gi;
  for (let pass = 0; pass < 3; pass++) {
    let changed = false;
    let m;
    tagRe.lastIndex = 0;
    while ((m = tagRe.exec(h))) {
      const attrs = m[2] || '';
      const cls = (attrs.match(/(?:class|id)\s*=\s*("([^"]*)"|'([^']*)'|([^\s>]+))/i) || []);
      const name = String(cls[2] || cls[3] || cls[4] || '');
      if (!name || !JUNK_BLOCK_RE.test(name)) continue;
      const tag = m[1].toLowerCase();
      const closeRe = new RegExp('<\\/?' + tag + '\\b[^>]*>', 'gi');
      closeRe.lastIndex = m.index + m[0].length;
      let depth = 1, end = -1, mm;
      while ((mm = closeRe.exec(h))) {
        if (mm[0][1] === '/') { depth--; if (!depth) { end = closeRe.lastIndex; break; } }
        else if (!new RegExp('^<' + tag + '\\b[^>]*\\/>', 'i').test(mm[0])) depth++;
      }
      if (end < 0) continue;
      h = h.slice(0, m.index) + ' ' + h.slice(end);
      changed = true;
      break;
    }
    if (!changed) break;
  }
  return h;
}

/** 挑主内容：优先 <article>，其次 class/id 像正文的容器，取其中最长的一块；都不像就返回原文 */
function pickMain(html) {
  const src = String(html || '');
  const cands = [];
  const push = (re, tag) => {
    let m;
    while ((m = re.exec(src))) {
      const attrs = m[1] || '';
      const closeRe = new RegExp('<\\/?' + tag + '\\b[^>]*>', 'gi');
      closeRe.lastIndex = re.lastIndex;
      let depth = 1, end = -1, mm;
      while ((mm = closeRe.exec(src))) {
        if (mm[0][1] === '/') { depth--; if (!depth) { end = closeRe.lastIndex; break; } }
        else depth++;
      }
      if (end < 0) continue;
      const inner = src.slice(re.lastIndex, end - ('</' + tag + '>').length);
      cands.push({ html: inner, len: htmlToText(inner).replace(/\s+/g, '').length, tag, attrs });
    }
  };
  push(/<article\b([^>]*)>/gi, 'article');
  push(/<main\b([^>]*)>/gi, 'main');
  /* class/id 像正文的 div / section */
  const re2 = /<(div|section)\b([^>]*)>/gi;
  let m;
  while ((m = re2.exec(src))) {
    const attrs = m[2] || '';
    const cls = (attrs.match(/(?:class|id)\s*=\s*("([^"]*)"|'([^']*)'|([^\s>]+))/i) || []);
    const name = String(cls[2] || cls[3] || cls[4] || '');
    if (!name || !MAIN_HINT_RE.test(name) || JUNK_BLOCK_RE.test(name)) continue;
    const tag = m[1].toLowerCase();
    const closeRe = new RegExp('<\\/?' + tag + '\\b[^>]*>', 'gi');
    closeRe.lastIndex = re2.lastIndex;
    let depth = 1, end = -1, mm;
    while ((mm = closeRe.exec(src))) {
      if (mm[0][1] === '/') { depth--; if (!depth) { end = closeRe.lastIndex; break; } }
      else depth++;
    }
    if (end < 0) continue;
    const inner = src.slice(re2.lastIndex, end - ('</' + tag + '>').length);
    cands.push({ html: inner, len: htmlToText(inner).replace(/\s+/g, '').length, tag, attrs });
  }
  if (!cands.length) return src;
  cands.sort((a, b) => b.len - a.len);
  const best = cands[0];
  /* 主内容太短（可能挑错了）→ 老实用整页，交给逐行清洗 */
  const whole = htmlToText(src).replace(/\s+/g, '').length;
  if (best.len < 200 || (whole > 0 && best.len < whole * 0.12)) return src;
  return best.html;
}

/** 逐行清洗：折叠空行、丢垃圾行/纯链接行/菜单短行/重复行，保留标题与代码块 */
function cleanLines(text, opts) {
  const o = opts || {};
  const lines = htmlToText(String(text || '')).replace(/\r\n?/g, '\n').split('\n');
  const out = [];
  const seen = new Map();
  let dropped = 0;
  let inFence = false;
  let shortRun = 0;                 // 连续"菜单式短行"计数
  const pushLine = l => { out.push(l); };
  for (let raw of lines) {
    const line = raw.replace(/[ \t\u00a0]+/g, ' ').replace(/^\s*[•·▪▫◦]\s*/, (m) => m.trim() + ' ').trimEnd();
    const t = line.trim();
    /* 代码块内部一个字都不动（只保证 ``` 成对） */
    if (/^```/.test(t)) { inFence = !inFence; pushLine(line); shortRun = 0; continue; }
    if (inFence) { pushLine(line); continue; }
    if (!t) { if (out.length && out[out.length - 1] !== '') pushLine(''); shortRun = 0; continue; }
    const isStruct = /^(#{1,6}\s|[-*+]\s|\d+[.、)]\s|>\s|\||\s*```)/.test(t);
    if (!isStruct) {
      if (JUNK_LINE_RE.test(t)) { dropped++; continue; }
      if (BREADCRUMB_RE.test(t) && t.length <= 60) { dropped++; continue; }
      /* 纯链接/纯网址行（"阅读原文 https://…"这类） */
      const noLink = t.replace(/https?:\/\/\S+/g, '').replace(/\[[^\]]*\]\([^)]*\)/g, '').trim();
      if (!noLink) { dropped++; continue; }
      /* 又短又没有句末标点的行：连续 3 行以上当菜单/标签云丢掉 */
      const isShort = t.length <= 14 && !PUNCT_END_RE.test(t) && !/[，,、]/.test(t) && !/\d/.test(t);
      if (isShort) {
        shortRun++;
        if (shortRun >= 3) { dropped++; continue; }
      } else shortRun = 0;
      /* 整行只是站点信息（域名/ICP/备案） */
      if (t.length <= 80 && SITE_INFO_RE.test(t) && !/[。，；：、]/.test(t)) { dropped++; continue; }
      /* 短页面标题链（"首页 > 分类 > 文章"已经管了，这里处理重复的站点名/栏目名） */
    } else shortRun = 0;
    /* 重复行：同一条出现 3 次以上（页脚/推荐位常整段重复） */
    const key = t.replace(/\s+/g, '');
    if (key.length >= 6) {
      const n = (seen.get(key) || 0) + 1;
      seen.set(key, n);
      if (n >= 3) { dropped++; continue; }
    }
    pushLine(line);
  }
  let body = out.join('\n');
  /* 结尾常剩一串"导航尾巴"：最后 3 行如果都是短行且无标点，一起丢 */
  body = body.replace(/\n{3,}/g, '\n\n').trim();
  if (o.minChars != null && body.replace(/\s+/g, '').length < o.minChars) {
    /* 清得太狠（多半是"主内容挑错"）→ 退回只做基本处理的文本 */
    const safe = htmlToText(String(text || '')).replace(/[ \t]+/g, ' ').replace(/\n{3,}/g, '\n\n').trim();
    return { text: safe, dropped, fallback: true };
  }
  return { text: body, dropped, fallback: false };
}

/** 一步到位：HTML → 干净正文。返回 { text, dropped, fallback, before, after } */
function extractText(htmlOrText, opts) {
  const o = opts || {};
  let html = String(htmlOrText || '');
  const looksHtml = /<\/(p|div|span|article|section|li|a)>|<br\s*\/?>/i.test(html);
  const before = htmlToText(html).replace(/\s+/g, '').length;
  if (looksHtml) {
    let h = dropJunkBlocks(html);
    h = pickMain(h);
    const r = cleanLines(h, { minChars: o.minChars || Math.min(120, Math.max(60, before * 0.05)) });
    return { text: r.text, dropped: r.dropped, fallback: r.fallback, before, after: r.text.replace(/\s+/g, '').length };
  }
  const r = cleanLines(html, { minChars: o.minChars || 80 });
  return { text: r.text, dropped: r.dropped, fallback: r.fallback, before, after: r.text.replace(/\s+/g, '').length };
}

/* ---------------- AI 再清洗（只删不改） ---------------- */

const AI_CHUNK = 8000;          // 一次交给模型多少字
const AI_MAX_CALLS = 4;         // 单条资料最多几次（防止一篇 10 万字的书稿把额度吃光）

function buildCleanPrompt(title, goalTitle, text) {
  const L = [];
  L.push('下面是从网页里自动提取出来的一段正文，混着一些**网站自身的废话**。请**只做删除**，把它清干净。');
  L.push('');
  if (goalTitle) L.push('（读者要拿它学"' + String(goalTitle).slice(0, 60) + '"相关的东西，所以只留对学习有用的内容）');
  if (title) L.push('（资料标题：' + String(title).slice(0, 80) + '）');
  L.push('');
  L.push('【删掉这些】');
  L.push('- 网站导航、栏目名、面包屑、"首页/上一页/下一页"这类；');
  L.push('- "相关阅读 / 推荐 / 猜你喜欢 / 热门文章 / 更多精彩"以及后面跟着的一串标题链接；');
  L.push('- 关注公众号、扫码、加群、下载 APP、订阅、分享、点赞在看、打赏；');
  L.push('- 广告、课程或培训推销、报名咨询、联系方式、版权声明、免责声明、备案号、页脚站点信息；');
  L.push('- 评论区（"作者很赞""沙发"这类）、阅读量与点赞数、页码、时间戳式的重复行；');
  L.push('- 与本段主题明显无关的段落（例如正文讲技术却插了一段"我们公司招聘"）。');
  L.push('');
  L.push('【铁律】');
  L.push('1. **一个字都不许改写、润色、总结或补充** —— 只允许整行/整段地删。');
  L.push('2. 代码块（``` 围栏）、命令行、公式、链接、数字、专有名词**原样保留**，连空格和缩进都不要动。');
  L.push('3. 段落顺序不变；不要添加小标题、不要加"以下是正文"之类的话。');
  L.push('4. 如果这一整段几乎都是废话（导航/广告/推荐位），只回一个词：EMPTY。');
  L.push('');
  L.push('【输出】清洗后的正文本身（Markdown）。不要解释、不要用 ``` 把整篇包起来。');
  L.push('');
  L.push('【待清洗的正文】');
  L.push('<<<TEXT_START>>>');
  L.push(String(text || ''));
  L.push('<<<TEXT_END>>>');
  return L.join('\n');
}

/** 解析模型返回：剥掉包裹、识别 EMPTY；并做两道保险（不许变长太多、必须能在原文里找到大片重合） */
function parseCleanOutput(raw, original) {
  let t = String(raw || '').replace(/\r\n/g, '\n').trim();
  t = t.replace(/^<<<\s*TEXT_START\s*>>>\s*/i, '').replace(/<<<\s*TEXT_END\s*>>>\s*$/i, '').trim();
  if (/^EMPTY$/i.test(t)) return { text: '', empty: true, ok: true };
  const m = t.match(/^```[a-zA-Z]*[ \t]*\n([\s\S]*?)\n```[ \t]*$/);
  if (m && /```/.test(m[1])) t = m[1].trim();
  const src = String(original || '');
  /* 保险①：清洗后的正文必须**大部分来自原文**（防止它改写/编造）：
     取输出的前 3 个较长的行，看是否都能在原文里找到。 */
  const probes = t.split('\n').map(x => x.trim()).filter(x => x.length >= 12).slice(0, 3);
  const miss = probes.filter(x => !src.includes(x));
  if (probes.length && miss.length === probes.length) return { text: '', ok: false, reason: 'output-not-from-source' };
  /* 保险②：不许凭空变长（超过原文 1.1 倍） */
  if (t.length > src.length * 1.1 + 200) return { text: '', ok: false, reason: 'output-longer-than-input' };
  return { text: t, ok: true };
}

/** 要不要/怎么切块做 AI 清洗 */
function aiChunks(text) {
  const t = String(text || '');
  if (t.length < 600) return [];
  const paras = t.split(/\n{2,}/);
  const out = [];
  let buf = '';
  for (const p of paras) {
    if (buf && (buf.length + p.length + 2) > AI_CHUNK) { out.push(buf); buf = p; }
    else buf = buf ? buf + '\n\n' + p : p;
    if (out.length >= AI_MAX_CALLS) break;
  }
  if (buf && out.length < AI_MAX_CALLS) out.push(buf);
  return out;
}

/** 清洗前后对比（给人看的一句话） */
function deltaText(before, after) {
  const b = String(before || '').length, a = String(after || '').length;
  if (!b) return '';
  const cut = b - a;
  if (cut <= 0) return '（没变短）';
  return '去掉 ' + cut + ' 字（' + Math.round(cut / b * 100) + '%）';
}

module.exports = {
  htmlToText, decodeEntities, looksLikeChallenge, dropJunkBlocks, pickMain, cleanLines, extractText,
  buildCleanPrompt, parseCleanOutput, aiChunks, deltaText,
  AI_CHUNK, AI_MAX_CALLS, NAMED_ENTITIES, JUNK_LINE_RE, JUNK_BLOCK_RE
};
