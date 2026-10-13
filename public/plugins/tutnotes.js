/**
 * 思而行 · 前端插件：教程划线笔记（像 WPS 那样划重点）
 * ------------------------------------------------------------------
 * · 在教程正文里选中一段文字 → **右键** → 高亮 / 下划线 / 写批注 / 复制
 * · 划完立刻弹一张小卡，可以写批注（不写也行，只划重点）
 * · 点正文里的高亮 → 重新打开那张卡改批注 / 换颜色 / 删掉
 * · 清单不自己开浮窗了：并入右侧「🗒 笔记」栏的「📌 划线笔记」页签
 *   （notes.js 调用 window.TutNotes.renderInto(el) 把清单渲染进它的容器，
 *     状态机仍然只在这里一份；同时正文里的划线 / 右键能力不受影响）
 *
 * 定位：记「相对正文纯文本的字符区间」+ 原文 + 前后各 24 字上下文。
 *   教程没变 → 区间直接命中；教程被 AI 改过 → 用原文+上下文找回位置并写回（自愈）。
 * ⚠️ 正文可能在 iframe 里（HTML 教程），所以一律走宿主提供的
 *   tutDoc() / tutWin() / tutRoot()，不要直接用 document / window。
 * ⚠️ 教程正文会被**就地重画**（tutRerenderBody 直接换 .tutBody.innerHTML：改一块、
 *   AI 改一版都会）。那一刻：① 上方的 <mark> 全被抹掉 ② 我们缓存的 index/nodeMap
 *   指向的是**已经从文档里摘掉的旧文本节点** —— 于是后面读选区时 absOf 一律返回 -1，
 *   表现就是「改了教程内容后划线失效（选中不出现任何东西）」。所以这里有两道自愈：
 *   读选区前 ensureIndex()（索引脏了就重建，不碰 DOM、不影响选区），
 *   以及 MutationObserver → 正文被重画后自动 apply() 把高亮画回来。
 */
'use strict';
(function () {
  const { api, esc, toast } = SiErXing;

  const COLORS = [
    { k: 'yellow', name: '重点（黄）' },
    { k: 'green', name: '已懂（绿）' },
    { k: 'blue', name: '存疑（蓝）' },
    { k: 'pink', name: '待复习（粉）' }
  ];

  let tid = 0;
  let notes = [];
  let index = [];              // [{node, start, end}] 正文纯文本的字符区间 → 文本节点
  let nodeMap = new Map();
  let ft = '';                 // 正文纯文本（缓存，apply/detect 都用它）
  let panelEl = null, barEl = null, cardEl = null, ctxEl = null;
  let embedded = false;        // 清单是渲染进别人的容器（notes.js 的页签）还是自带浮窗
  let onChange = null;         // 渲染进容器后的回调（页签上的条数徽标用它刷新）
  let pending = null;          // 当前选中的内容
  let bound = false;
  let flashTimer = null, hintTimer = null;
  let mo = null, syncTimer = null;

  /* ================= 正文定位 ================= */
  const X = () => (window.tutDoc ? tutDoc() : document);
  const W = () => (window.tutWin ? tutWin() : window);
  const R = () => (window.tutRoot ? tutRoot() : document.body);
  const inFrame = () => { const f = document.getElementById('tutFrame'); return !!(f && f.contentDocument === X()); };

  function textNodes(root) {
    const out = [];
    try {
      const w = X().createTreeWalker(root, 4, null);   // SHOW_TEXT
      let n;
      while ((n = w.nextNode())) {
        const p = n.parentNode;
        if (!p) continue;
        const tag = String(p.nodeName || '').toUpperCase();
        if (tag === 'SCRIPT' || tag === 'STYLE' || tag === 'NOSCRIPT') continue;
        if (!n.nodeValue) continue;
        out.push(n);
      }
    } catch (e) {}
    return out;
  }
  function buildIndex(root) {
    index = []; nodeMap = new Map();
    let pos = 0;
    for (const n of textNodes(root)) {
      const len = n.nodeValue.length;
      index.push({ node: n, start: pos, end: pos + len });
      nodeMap.set(n, { start: pos, end: pos + len });
      pos += len;
    }
    ft = index.map(x => x.node.nodeValue).join('');
    return pos;
  }
  /* 索引是否已经过期：正文被重画后，index 里的文本节点都不在文档里了。
     过期就重建 —— buildIndex **不动 DOM**，所以当前选区不会被打乱。 */
  function ensureIndex(root) {
    try { if (index.length && root && root.contains(index[0].node)) return false; } catch (e) {}
    buildIndex(root);
    return true;
  }
  /* 去掉上次画的高亮，把正文还原成纯文本（索引才稳定） */
  function unwrap(root) {
    try {
      const marks = Array.from(root.querySelectorAll('mark.tnm'));
      for (const m of marks) {
        const p = m.parentNode;
        if (!p) continue;
        while (m.firstChild) p.insertBefore(m.firstChild, m);
        p.removeChild(m);
      }
      root.normalize();
    } catch (e) {}
  }
  function firstText(el) { let d = el; while (d && d.nodeType !== 3 && d.firstChild) d = d.firstChild; return (d && d.nodeType === 3) ? d : null; }
  function lastText(el) { let d = el; while (d && d.nodeType !== 3 && d.lastChild) d = d.lastChild; return (d && d.nodeType === 3) ? d : null; }
  /* (容器, 偏移) → 正文纯文本里的绝对位置 */
  function absOf(c, off) {
    if (!c) return -1;
    if (c.nodeType === 3) { const r = nodeMap.get(c); return r ? r.start + off : -1; }
    const kids = Array.from(c.childNodes || []);
    for (let i = off; i < kids.length; i++) { const t = firstText(kids[i]); if (t) { const r = nodeMap.get(t); if (r) return r.start; } }
    for (let i = Math.min(off, kids.length) - 1; i >= 0; i--) { const t = lastText(kids[i]); if (t) { const r = nodeMap.get(t); if (r) return r.end; } }
    return -1;
  }
  function rangeAbs(range) {
    const s = absOf(range.startContainer, range.startOffset);
    const e = absOf(range.endContainer, range.endOffset);
    if (s < 0 || e < 0 || e <= s) return null;
    return { start: s, end: e };
  }
  /* 教程被改过：用「原文 + 前后文」把位置找回来 */
  function locate(text, prefix, suffix, prefer) {
    if (!ft || !text) return null;
    const hits = [];
    let i = ft.indexOf(text);
    while (i >= 0 && hits.length < 300) { hits.push(i); i = ft.indexOf(text, i + 1); }
    if (!hits.length) return null;
    if (hits.length === 1) return { start: hits[0], end: hits[0] + text.length };
    let best = hits[0], bestScore = -1e9;
    for (const s of hits) {
      let sc = 0;
      const before = ft.slice(Math.max(0, s - 12), s);
      const after = ft.slice(s + text.length, s + text.length + 12);
      if (prefix && before && prefix.slice(-6) === before.slice(-6)) sc += 3;
      if (suffix && after && suffix.slice(0, 6) === after.slice(0, 6)) sc += 3;
      sc -= Math.abs(s - (prefer || 0)) / 100000;
      if (sc > bestScore) { bestScore = sc; best = s; }
    }
    return { start: best, end: best + text.length };
  }

  /* HTML 教程的正文在 iframe 里，主文档的 CSS 管不到它 —— 把高亮样式注入进去 */
  function ensureFrameStyle() {
    try {
      if (!inFrame()) return;
      const doc = X();
      if (!doc || !doc.head || doc.getElementById('tnmStyle')) return;
      const st = doc.createElement('style');
      st.id = 'tnmStyle';
      st.textContent = [
        'mark.tnm{background:rgba(255,214,64,.45);color:inherit;border-radius:3px;padding:1px 1px 2px;cursor:pointer;box-decoration-break:clone;-webkit-box-decoration-break:clone;}',
        'mark.tnm-yellow{background:rgba(255,214,64,.45);}',
        'mark.tnm-green{background:rgba(93,222,140,.42);}',
        'mark.tnm-blue{background:rgba(96,176,255,.40);}',
        'mark.tnm-pink{background:rgba(255,143,183,.42);}',
        'mark.tnm.tnm-u{background:none;border-bottom:2px solid rgba(255,180,40,.85);border-radius:0;padding-bottom:0;}',
        'mark.tnm.tnm-u.tnm-green{border-bottom-color:rgba(60,190,110,.9);}',
        'mark.tnm.tnm-u.tnm-blue{border-bottom-color:rgba(70,150,240,.9);}',
        'mark.tnm.tnm-u.tnm-pink{border-bottom-color:rgba(240,110,160,.9);}',
        'mark.tnm.tnFlash{animation:tnFlash 1.5s ease;}',
        '@keyframes tnFlash{0%,100%{box-shadow:none;}15%,55%{box-shadow:0 0 0 3px rgba(120,110,255,.45);}}'
      ].join('');
      doc.head.appendChild(st);
    } catch (e) {}
  }
  /* 把某条笔记的区间包进 <mark>；返回画出来的 mark 元素 */
  function wrapParts(root, parts) {
    const made = [];
    /* 从后往前切：切后面的不会影响前面记录的偏移 */
    parts.sort((p, q) => q.abs - p.abs);
    for (const p of parts) {
      const node = p.node;
      if (!node || !node.nodeValue) continue;
      if (p.a < 0 || p.b > node.nodeValue.length || p.b <= p.a) continue;
      let target = node;
      try {
        if (p.a > 0) target = node.splitText(p.a);
        if (p.b - p.a < target.nodeValue.length) target.splitText(p.b - p.a);
      } catch (e) { continue; }
      const parent = target.parentNode;
      if (!parent) continue;
      const mark = target.ownerDocument.createElement('mark');
      mark.className = 'tnm tnm-' + (p.note.color || 'yellow') + (p.note.style === 'underline' ? ' tnm-u' : '');
      mark.setAttribute('data-tnid', String(p.note.id));
      mark.title = p.note.note ? p.note.note.slice(0, 180) : '点我写批注';
      parent.insertBefore(mark, target);
      mark.appendChild(target);
      made.push(mark);
    }
    return made;
  }
  function apply(root) {
    if (!root) return;
    ensureFrameStyle();
    unwrap(root);
    buildIndex(root);
    const parts = [];
    for (const n of notes) {
      if (!n.text) continue;
      let s = Number(n.start) || 0, e = Number(n.end) || 0;
      if (ft.slice(s, e) !== n.text) {
        const loc = locate(n.text, n.prefix, n.suffix, s);
        if (!loc) continue;                     // 正文里确实找不到了 —— 先不画（侧栏仍能看到）
        if (loc.start !== s || loc.end !== e) {
          s = loc.start; e = loc.end; n.start = s; n.end = e;
          /* 自愈：把校准后的区间写回去，下次不用再找 */
          api('/api/tutnotes/' + n.id, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ start: s, end: e }) }).catch(() => {});
        }
      }
      for (const rec of index) {
        if (rec.end <= s || rec.start >= e) continue;
        parts.push({ note: n, node: rec.node, a: Math.max(s, rec.start) - rec.start, b: Math.min(e, rec.end) - rec.start, abs: Math.max(s, rec.start) });
      }
    }
    wrapParts(root, parts);
    /* ⚠️ 画完之后必须重建一次索引：上面 splitText 切出来的**新文本节点**不在旧 nodeMap 里，
       于是"在已划线的段落里再选一段"会算不出偏移（真实踩到：选中的是切出来的后半段，
       absOf 返回 -1，小条死活不浮出来）。重建后 offsets 不变（mark 不改文字），但映射补齐了。 */
    buildIndex(root);
  }

  /* ================= 正文被重画后的自愈 ================= */
  /* 正文被 tutRerenderBody / 整页重画换掉后，<mark> 会全部消失（innerHTML 直接换了）。
     没有这一步，用户改完教程内容就再也划不上 —— 这正是用户报的那个 bug。 */
  function needReapply(root) {
    try {
      if (!root || !tid) return false;
      if (!notes.some(n => n.text)) return false;
      return !root.querySelector('mark.tnm');
    } catch (e) { return false; }
  }
  function scheduleSync() {
    if (syncTimer) return;
    syncTimer = setTimeout(() => {
      syncTimer = null;
      const root = R();
      if (!needReapply(root)) return;
      apply(root);
      renderPanel();
    }, 60);
  }
  function watch(root) {
    if (mo) { try { mo.disconnect(); } catch (e) {} mo = null; }
    if (!root || !root.nodeType) return;
    try {
      mo = new MutationObserver(() => scheduleSync());
      mo.observe(root, { childList: true, subtree: true });
    } catch (e) { mo = null; }
  }

  /* ================= 读选区 ================= */
  /* 排查用：记录上一次"为什么没读到选区 / 没出现菜单"（划不动时先看这里） */
  let lastWhy = '（还没读过选区）';
  const why = w => { lastWhy = w; hideHint(); };
  /* 读当前选区 → {root, range, abs, text}；读不到返回 null（lastWhy 说明原因）。
     ⚠️ 不碰 DOM（除了可能的索引重建），选区原样保留。 */
  function grabSelection() {
    /* 监听是绑在 document 上的、离开教程页也不会自动解绑 —— 必须自己挡一道：
       否则在别的页面（引用资料/汇报卡里到处是 .mdBody）选中一段文字，
       tutRoot() 会退化成那个 .mdBody，提示签和菜单就会冒出来，点下去还带着上一篇教程的 id。 */
    if (!tid) { why('没有挂载教程'); return null; }
    try {
      const rr = SiErXing.parseRoute ? SiErXing.parseRoute() : null;
      if (rr && rr.view !== 'tutorial') { why('不在教程页'); return null; }
    } catch (e) {}
    const root = R();
    if (!root) { why('拿不到正文根（tutRoot 为空）'); return null; }
    let sel = null;
    try { sel = W().getSelection ? W().getSelection() : null; } catch (e) { sel = null; }
    if (!sel || !sel.rangeCount || sel.isCollapsed) { why('没有选中内容'); return null; }
    const range = sel.getRangeAt(0);
    try {
      if (!root.contains(range.startContainer) || !root.contains(range.endContainer)) return why('选区不在正文里'), null;
    } catch (e) { return why('读选区出错：' + e.message), null; }
    /* 正文被重画过 → 缓存的索引指向已摘掉的旧文本节点，先重建（不碰 DOM，选区不受影响） */
    ensureIndex(root);
    const abs = rangeAbs(range);
    if (!abs) return why('算不出偏移（选中的不是正文文本）'), null;
    const text = ft.slice(abs.start, abs.end);
    if (!String(text || '').trim()) return why('选中的是空白'), null;
    lastWhy = '已读出选区';
    return { root, range, abs, text: String(text) };
  }
  function setPending(g) {
    pending = {
      start: g.abs.start, end: g.abs.end,
      text: String(g.text).slice(0, 2000),
      prefix: ft.slice(Math.max(0, g.abs.start - 24), g.abs.start),
      suffix: ft.slice(g.abs.end, g.abs.end + 24)
    };
    return pending;
  }

  /* ================= 选中后的提示小签 + 右键菜单 ================= */
  /* 提示小签：只提示"右键可以划线"，**pointer-events:none** ——
     它盖在文字上也点不到（用户报的痛点是误触，不是小条本身），2.5 秒后自己缩回去。 */
  function hideHint() { if (barEl) { barEl.remove(); barEl = null; } if (hintTimer) { clearTimeout(hintTimer); hintTimer = null; } }
  function showHint(rect) {
    hideHint();
    if (!rect || (!rect.width && !rect.height)) return;
    barEl = document.createElement('div');
    barEl.className = 'tnHint';
    barEl.setAttribute('aria-hidden', 'true');
    barEl.innerHTML = '<span class="tnHintDot"></span>右键 → 高亮 / 下划线 / 写批注';
    document.body.appendChild(barEl);
    place(barEl, rect);
    hintTimer = setTimeout(hideHint, 2500);
  }
  /* 浮层定位：正文在 iframe 里时要加上 iframe 的偏移 */
  function place(el, rect) {
    const f = document.getElementById('tutFrame');
    const off = inFrame() && f ? f.getBoundingClientRect() : { left: 0, top: 0 };
    const cx = off.left + rect.left + rect.width / 2;
    const cy = off.top + rect.top;
    el.style.visibility = 'hidden';
    el.style.left = '0px'; el.style.top = '0px';
    const w = el.offsetWidth, h = el.offsetHeight;
    el.style.left = Math.max(8, Math.min(cx - w / 2, window.innerWidth - w - 8)) + 'px';
    el.style.top = Math.max(8, Math.min(cy - h - 8, window.innerHeight - h - 8)) + 'px';
    el.style.visibility = '';
  }
  function hideCtx() { if (ctxEl) { ctxEl.remove(); ctxEl = null; } }
  const noteDisplay = n => {
    const t = String((n && n.text) || '').replace(/\s+/g, ' ').trim();
    return t.length > 80 ? t.slice(0, 80) + '…' : t;
  };
  /* 右键菜单：**复用应用既有的 .ctxMenu**（app.js 里 route()/点别处/Esc/滚动 都会把它收掉，
     这里只管建和定位，别再造一套关闭逻辑）。x/y 用鼠标坐标 —— 隐藏元素的 rect 全是 0，
     用它定位菜单会跑到页面左上角。*/
  function showCtx(x, y) {
    hideCtx();
    if (!pending) return;
    const swatches = attr => COLORS.map(c =>
      '<button class="tnSw tnSw-' + c.k + '" ' + attr + '="' + c.k + '" title="' + esc(c.name) + '"></button>').join('');
    const el = document.createElement('div');
    el.className = 'ctxMenu tnCtxMenu';
    el.innerHTML =
      '<div class="ctxTitle" title="' + esc(pending.text) + '">划线笔记｜' + esc(noteDisplay(pending)) + '</div>'
      + '<div class="tnCtxRow"><span class="tnCtxLb">高亮</span>' + swatches('data-tnctx-hl') + '</div>'
      + '<div class="tnCtxRow"><span class="tnCtxLb">下划线</span>' + swatches('data-tnctx-ul') + '</div>'
      + '<div class="ctxSep"></div>'
      + '<button data-tnctx="note">✎ 写批注</button>'
      + '<button data-tnctx="copy">⧉ 复制</button>'
      + '<button data-tnctx="cancel">✕ 取消</button>';
    /* 先清掉别的右键菜单（同一时刻只留一个），再按 app.js openMoreMenu 的同一套夹取算法定位 */
    document.querySelectorAll('.ctxMenu').forEach(m => m.remove());
    document.body.appendChild(el);
    el.style.left = '0px'; el.style.top = '0px'; el.style.visibility = 'hidden';
    const w = el.offsetWidth || 240, h = el.offsetHeight || 170;
    el.style.left = Math.max(8, Math.min(x, window.innerWidth - w - 8)) + 'px';
    el.style.top = Math.max(8, Math.min(y, window.innerHeight - h - 8)) + 'px';
    el.style.visibility = '';
    ctxEl = el;
    /* ⚠️ 菜单里的按钮用 mousedown 处理：click 之前浏览器可能先把选区清掉（右键后的左键点击），
       在 mousedown 就把活干完最稳。 */
    const act = (fn) => ev => { ev.preventDefault(); ev.stopPropagation(); hideCtx(); fn(); };
    el.querySelectorAll('[data-tnctx-hl]').forEach(b => b.addEventListener('mousedown', act(() => create(b.getAttribute('data-tnctx-hl'), 'highlight', { keepSel: true }))));
    el.querySelectorAll('[data-tnctx-ul]').forEach(b => b.addEventListener('mousedown', act(() => create(b.getAttribute('data-tnctx-ul'), 'underline', { keepSel: true }))));
    const q = s => el.querySelector('[data-tnctx="' + s + '"]');
    q('note').addEventListener('mousedown', act(() => create('yellow', 'highlight', { keepSel: true, card: true })));
    q('copy').addEventListener('mousedown', act(copySel));
    q('cancel').addEventListener('mousedown', act(() => {}));
  }
  async function copySel() {
    const t = pending ? pending.text : '';
    if (!t) return;
    try {
      if (navigator.clipboard && navigator.clipboard.writeText) await navigator.clipboard.writeText(t);
      else {
        const ta = document.createElement('textarea');
        ta.value = t;
        ta.style.cssText = 'position:fixed;left:-9999px;top:0;opacity:0';
        document.body.appendChild(ta);
        ta.select();
        document.execCommand('copy');
        ta.remove();
      }
      toast('已复制选中的文字');
    } catch (e) { toast('复制失败：' + ((e && e.message) || '浏览器拒绝了剪贴板')); }
  }
  /* 划完把选区**还回**高亮那一段：用户要求"选区不用清，能看到刚才选的是哪"。
     正文被拆过文本节点，原来的 range 多半已经失效，所以直接用高亮元素重选一次。 */
  function reselect(id) {
    try {
      const m = R().querySelector('mark.tnm[data-tnid="' + id + '"]');
      if (!m) return;
      const doc = X();
      const sel = W().getSelection();
      if (!sel) return;
      const r = doc.createRange();
      r.selectNodeContents(m);
      sel.removeAllRanges();
      sel.addRange(r);
    } catch (e) {}
  }
  /* ================= 建一条划线 ================= */
  /* opts.keepSel：从右键菜单进来的不清选区（用户还要看得见自己选的是哪）
     opts.card   ：是否立刻弹批注卡（右键菜单里的「高亮 / 下划线」不弹 —— 卡一弹就抢焦点，
                   选区看着就没了；要写批注有单独的「✎ 写批注」，过后点一下高亮也能改）。 */
  async function create(color, style, opts) {
    opts = opts || {};
    if (!pending) return;
    const p = pending;
    hideCtx(); hideHint();
    if (!opts.keepSel) { try { W().getSelection && W().getSelection().removeAllRanges(); } catch (e) {} }
    try {
      const r = await api('/api/tutnotes', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ tutorial_id: tid, start: p.start, end: p.end, text: p.text, prefix: p.prefix, suffix: p.suffix, color, style })
      });
      notes.push(r.note);
      notes.sort((a, b) => (Number(a.start) || 0) - (Number(b.start) || 0) || (a.id - b.id));
      apply(R());
      renderPanel();
      if (opts.keepSel) reselect(r.note.id);
      const m = R().querySelector('mark.tnm[data-tnid="' + r.note.id + '"]');
      if (opts.card && m) openCard(m, r.note);
      else toast(style === 'underline' ? '已加下划线（点一下可写批注）' : '已高亮（点一下可写批注）');
    } catch (e) { toast(e.message); }
  }

  /* ================= 批注卡片 ================= */
  function closeCard() { if (cardEl) { cardEl.remove(); cardEl = null; } }
  function openCard(mark, note) {
    closeCard();
    cardEl = document.createElement('div');
    cardEl.className = 'tnCard';
    cardEl.innerHTML = `
      <div class="tnCardQ">${esc(noteDisplay(note))}</div>
      <textarea class="tnCardTa" rows="3" placeholder="写点批注（可留空，只划重点也行）。Ctrl/⌘+Enter 保存">${esc(note.note || '')}</textarea>
      <div class="tnCardRow">
        ${COLORS.map(c => '<button class="tnSw tnSw-' + c.k + (note.color === c.k ? ' on' : '') + '" data-tnccolor="' + c.k + '" title="' + esc(c.name) + '"></button>').join('')}
        <button class="tnBtn" data-tncstyle="underline" title="切换下划线 / 高亮">${note.style === 'underline' ? '改高亮' : '改下划线'}</button>
        <span style="flex:1"></span>
        <button class="tnBtn danger" data-tncdel="1">删除</button>
        <button class="tnBtn" data-tncclose="1">关闭</button>
      </div>`;
    document.body.appendChild(cardEl);
    let rect = null;
    try { rect = mark.getBoundingClientRect(); } catch (e) {}
    if (rect) place(cardEl, { left: rect.left, top: rect.bottom, width: rect.width, height: 0 });
    const ta = cardEl.querySelector('.tnCardTa');
    const save = async () => {
      const v = String(ta.value || '').trim();
      if (v === String(note.note || '').trim()) return;
      try {
        const r = await api('/api/tutnotes/' + note.id, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ note: v }) });
        note.note = r.note.note;
        renderPanel();
        const m = R().querySelector('mark.tnm[data-tnid="' + note.id + '"]');
        if (m) m.title = note.note ? note.note.slice(0, 180) : '点我写批注';
      } catch (e) { toast(e.message); }
    };
    ta.addEventListener('keydown', e => { if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') { e.preventDefault(); save().then(closeCard); } });
    ta.addEventListener('blur', save);
    setTimeout(() => ta.focus(), 30);
    cardEl.querySelectorAll('[data-tnccolor]').forEach(b => b.addEventListener('click', async () => {
      try {
        const r = await api('/api/tutnotes/' + note.id, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ color: b.getAttribute('data-tnccolor') }) });
        note.color = r.note.color;
        apply(R()); renderPanel();
        const m = R().querySelector('mark.tnm[data-tnid="' + note.id + '"]');
        if (m) openCard(m, note);
      } catch (e) { toast(e.message); }
    }));
    cardEl.querySelectorAll('[data-tncstyle]').forEach(b => b.addEventListener('click', async () => {
      try {
        const want = note.style === 'underline' ? 'highlight' : 'underline';
        const r = await api('/api/tutnotes/' + note.id, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ style: want }) });
        note.style = r.note.style;
        apply(R()); renderPanel();
        const m = R().querySelector('mark.tnm[data-tnid="' + note.id + '"]');
        if (m) openCard(m, note);
      } catch (e) { toast(e.message); }
    }));
    cardEl.querySelector('[data-tncdel]').addEventListener('click', () => del(note));
    cardEl.querySelector('[data-tncclose]').addEventListener('click', closeCard);
  }
  async function del(note) {
    if (!confirm('删掉这条笔记？\n\n「' + noteDisplay(note) + '」')) return;
    try {
      await api('/api/tutnotes/' + note.id, { method: 'DELETE' });
      notes = notes.filter(x => Number(x.id) !== Number(note.id));
      closeCard(); apply(R()); renderPanel();
      toast('已删除');
    } catch (e) { toast(e.message); }
  }

  /* ================= 清单（可渲染进别人的容器） ================= */
  let onlyNotes = false;
  const countOf = () => ({ all: notes.length, withNote: notes.filter(x => String(x.note || '').trim()).length });
  function renderPanel() {
    const n = countOf();
    if (onChange) { try { onChange(n); } catch (e) {} }
    if (!panelEl) return;
    const list = notes.filter(x => !onlyNotes || String(x.note || '').trim());
    const box = panelEl.querySelector('.tnPanelList');
    box.innerHTML = list.length ? list.map(x => `
      <div class="tnItem" data-tnitem="${x.id}">
        <span class="tnItemBar tnSw-${x.color}${x.style === 'underline' ? ' u' : ''}"></span>
        <div class="tnItemB">
          <div class="tnItemQ">${esc(noteDisplay(x))}</div>
          ${String(x.note || '').trim() ? '<div class="tnItemN">' + esc(String(x.note).slice(0, 300)) + '</div>' : '<div class="tnItemN muted">（只划了重点，没写批注）</div>'}
          <div class="tnItemT">${esc(String(x.created_at || '').slice(5, 16).replace('T', ' '))}</div>
        </div>
        <button class="tnBtn tiny danger" data-tndel="${x.id}" title="删除">×</button>
      </div>`).join('')
      : '<p class="tnEmpty">' + (onlyNotes ? '还没有写过批注的笔记。' : '在正文里选中一段文字 → 右键 → 高亮 / 下划线 / 写批注。') + '</p>';
    const c = panelEl.querySelector('.tnCount');
    if (c) c.textContent = n.all ? (n.all + ' 条' + (n.withNote ? '（' + n.withNote + ' 条带批注）' : '')) : '';
    box.querySelectorAll('[data-tnitem]').forEach(el => el.addEventListener('click', e => {
      if (e.target.closest('[data-tndel]')) return;
      jumpTo(Number(el.getAttribute('data-tnitem')));
    }));
    box.querySelectorAll('[data-tndel]').forEach(b => b.addEventListener('click', () => {
      const x = notes.find(v => Number(v.id) === Number(b.getAttribute('data-tndel')));
      if (x) del(x);
    }));
    const f = panelEl.querySelector('.tnOnlyCb');
    if (f) f.checked = onlyNotes;
  }
  /* 把清单渲染进指定容器（notes.js 的「📌 划线笔记」页签用它）。
     状态机留在这里，notes.js 不需要知道 notes/index/mark 这些事。 */
  function renderInto(el, opts) {
    if (!el) return;
    onChange = (opts && opts.onChange) || null;
    if (panelEl === el) { renderPanel(); return; }
    if (embedded && panelEl) { try { panelEl.innerHTML = ''; panelEl.classList.remove('tnPanel', 'tnEmbed'); } catch (e) {} }
    panelEl = el;
    embedded = true;
    el.classList.add('tnPanel', 'tnEmbed');
    el.innerHTML = `<div class="tnPanelHd"><b>📌 划线笔记</b><span class="tnCount"></span><span style="flex:1"></span>
        <label class="tnOnly"><input type="checkbox" class="tnOnlyCb"> 只看带批注的</label></div>
      <div class="tnPanelList"></div>`;
    const cb = el.querySelector('.tnOnlyCb');
    if (cb) cb.addEventListener('change', e => { onlyNotes = !!e.target.checked; renderPanel(); });
    renderPanel();
  }
  /* 容器没了（收起笔记栏 / 路由切换）：把引用清掉，别往已经摘掉的节点上写 */
  function detachPanel() {
    onChange = null;
    if (embedded && panelEl) {
      try { panelEl.innerHTML = ''; panelEl.classList.remove('tnPanel', 'tnEmbed'); } catch (e) {}
    }
    panelEl = null;
    embedded = false;
  }
  /* 旧的浮窗形态：兼容外部调用（现在入口已并进笔记栏，默认不再用） */
  function togglePanel(force) {
    if (panelEl && !embedded && force !== true) { panelEl.remove(); panelEl = null; return; }
    if (panelEl) return;
    panelEl = document.createElement('div');
    panelEl.className = 'tnPanel';
    panelEl.innerHTML = `<div class="tnPanelHd"><b>📌 划线笔记</b><span class="tnCount"></span><span style="flex:1"></span>
        <label class="tnOnly"><input type="checkbox" class="tnOnlyCb"> 只看带批注的</label>
        <button class="tnBtn" data-tnpanelclose="1">×</button></div>
      <div class="tnPanelList"></div>`;
    document.body.appendChild(panelEl);
    panelEl.querySelector('[data-tnpanelclose]').addEventListener('click', () => togglePanel(false));
    panelEl.querySelector('.tnOnlyCb').addEventListener('change', e => { onlyNotes = !!e.target.checked; renderPanel(); });
    renderPanel();
  }
  function jumpTo(id) {
    const m = R().querySelector('mark.tnm[data-tnid="' + id + '"]');
    if (!m) return toast('正文里找不到这段了（教程可能被改过）');
    try { m.scrollIntoView({ block: 'center', behavior: 'smooth' }); } catch (e) { try { m.scrollIntoView(); } catch (e2) {} }
    m.classList.add('tnFlash');
    if (flashTimer) clearTimeout(flashTimer);
    flashTimer = setTimeout(() => { try { m.classList.remove('tnFlash'); } catch (e) {} }, 1600);
  }

  /* ================= 挂载 / 卸载 ================= */
  /* 一个文档（主文档 or iframe 文档）上的监听：
     · contextmenu → 正文里**有选中文字**才接管：弹划线菜单；没选中就放行系统菜单
     · mouseup → 点高亮打开批注卡；顺带读一次选区（只为把 why 记进 debug，便于排查）
     · selectionchange → 同上（键盘选中也要能出提示签） */
  function attachDoc(doc) {
    if (!doc || doc.__tnBound) return;
    doc.__tnBound = true;
    /* ⚠️ 拖选过程中 selectionchange 会**连续触发**，每触发一次就把提示签
       重画一遍 —— 用户看到的就是一直闪。所以按住鼠标时一律不响应，
       等松开（mouseup）再处理；键盘选（shift+方向键）没有按下鼠标，照常提示。 */
    let pointerDown = false;
    doc.addEventListener('mousedown', () => { pointerDown = true; }, true);
    doc.addEventListener('mouseup', () => { pointerDown = false; }, true);   // 先于下面那个 mouseup 执行
    const onSel = () => { if (pointerDown) return; probe(); };
    doc.addEventListener('mouseup', e => {
      const m = e.target && e.target.closest && e.target.closest('mark.tnm');
      if (m) {
        const n = notes.find(x => Number(x.id) === Number(m.getAttribute('data-tnid')));
        if (n) { hideHint(); hideCtx(); openCard(m, n); return; }
      }
      probe();
    }, true);
    doc.addEventListener('selectionchange', onSel, true);
    /* 右键：只有"正文里有选中文字"才接管，其余一律放行系统菜单
       （用户还要用系统菜单复制 / 搜索 / 翻译，别一律劫持）。 */
    doc.addEventListener('contextmenu', e => {
      const g = grabSelection();
      if (!g) return;                       // 没选中 → 原生菜单
      e.preventDefault();
      e.stopPropagation();
      setPending(g);
      const f = document.getElementById('tutFrame');
      const off = inFrame() && f ? f.getBoundingClientRect() : { left: 0, top: 0 };
      hideHint();
      showCtx(off.left + e.clientX, off.top + e.clientY);
    }, true);
  }
  /* 松开鼠标 / 键盘选中后：读一次选区、浮出提示签（不弹菜单，用户要右键才动） */
  function probe() { setTimeout(readSel, 10); }
  function readSel() {
    const g = grabSelection();
    if (!g) return;
    setPending(g);
    let rect = null;
    try { rect = g.range.getBoundingClientRect(); } catch (e) { rect = null; }
    if (!rect || (!rect.width && !rect.height)) return why('选区没有可见位置（rect 为空）');
    lastWhy = '已浮出提示签';
    showHint(rect);
  }
  function bindOnce() {
    if (bound) return;
    bound = true;
    attachDoc(document);
    /* 点别处 → 收起提示签 / 卡片 / 右键菜单（浮层都在主文档里，绑主文档就够）。
       ⚠️ 右键（button=2）也要走这里：先把上一次的菜单收掉，本次的由 contextmenu 再弹。 */
    document.addEventListener('mousedown', e => {
      if (e.target && e.target.closest && (e.target.closest('.tnHint') || e.target.closest('.tnCard') || e.target.closest('.tnPanel') || e.target.closest('.tnCtxMenu') || e.target.closest('mark.tnm'))) return;
      hideHint(); closeCard(); hideCtx();
    });
  }
  function mount(tutorialId) {
    tid = Number(tutorialId) || 0;
    if (!tid) return;
    closeCard(); hideHint();
    bindOnce();
    /* HTML 教程正文在 iframe 里：等它 load 完（最多等 3 秒），别对着空文档建索引 */
    let tries = 0;
    const boot = () => {
      tries++;
      const root = R();
      const okRoot = root && (root.childNodes || []).length > 3;
      if (!okRoot && tries < 15) return setTimeout(boot, 200);
      watch(root);                       // 正文被重画 → 自动把高亮画回来
      load().then(() => {
        /* 正文在 iframe 里 → 把监听也绑到 iframe 的 document 上 */
        attachDoc(X());
        apply(root);
        renderPanel();
        badge(tid);
      }).catch(e => toast('划线笔记加载失败：' + e.message));
    };
    boot();
  }
  async function load() {
    const r = await api('/api/tutnotes?tutorial_id=' + tid);
    notes = (r.notes || []).map(n => Object.assign({}, n));
    notes.sort((a, b) => (Number(a.start) || 0) - (Number(b.start) || 0) || (a.id - b.id));
  }
  function unmount() {
    closeCard(); hideHint(); hideCtx();
    if (syncTimer) { clearTimeout(syncTimer); syncTimer = null; }
    if (mo) { try { mo.disconnect(); } catch (e) {} mo = null; }
    if (panelEl && !embedded) { try { panelEl.remove(); } catch (e) {} }
    onChange = null; panelEl = null; embedded = false;
    tid = 0; notes = []; ft = ''; index = []; nodeMap = new Map(); pending = null;
  }
  /* 教程页工具条上的条数徽标（按钮已并入笔记栏，这里同时兼容旧按钮） */
  async function badge(tutorialId) {
    let n = notes.length;
    try {
      const r = await api('/api/tutnotes?tutorial_id=' + (tutorialId || tid));
      n = (r.notes || []).length;
    } catch (e) {}
    const btn = document.getElementById('tutNoteMarkBtn');
    if (btn) {
      btn.textContent = n ? ('📌 划线笔记 ' + n) : '📌 划线笔记';
      btn.title = n ? (n + ' 条划线笔记 —— 点开看清单') : '在正文里选中文字 → 右键就能划线、写批注';
    }
    if (onChange) { try { onChange(countOf()); } catch (e) {} }
  }

  window.TutNotes = {
    mount, unmount, toggle: togglePanel, badge,
    renderInto, detach: detachPanel,
    count: countOf,
    refresh: () => { apply(R()); renderPanel(); },
    /* 调试：为何没读到选区 / 索引与笔记数量 / 高亮有没有画上 / 菜单是不是开着 */
    debug: () => ({
      why: lastWhy, ft: ft.length, notes: notes.length, nodes: index.length, id: tid,
      marks: (() => { try { return R().querySelectorAll('mark.tnm').length; } catch (e) { return -1; } })(),
      bound: !!document.__tnBound, embedded, panel: !!panelEl, menu: !!ctxEl, pending: !!pending
    })
  };
})();
