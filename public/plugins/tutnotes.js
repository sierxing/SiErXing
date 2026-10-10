/**
 * 思而行 · 前端插件：教程划线笔记（像 WPS 那样划重点）
 * ------------------------------------------------------------------
 * · 在教程正文里选中一段文字 → 浮出小条 → 点颜色即高亮（也可下划线）
 * · 划完立刻弹一张小卡，可以写批注（不写也行，只划重点）
 * · 点正文里的高亮 → 重新打开那张卡改批注 / 换颜色 / 删掉
 * · 右侧清单列出这篇教程的全部笔记，点一条跳到正文对应位置
 *
 * 定位：记「相对正文纯文本的字符区间」+ 原文 + 前后各 24 字上下文。
 *   教程没变 → 区间直接命中；教程被 AI 改过 → 用原文+上下文找回位置并写回（自愈）。
 * ⚠️ 正文可能在 iframe 里（HTML 教程），所以一律走宿主提供的
 *   tutDoc() / tutWin() / tutRoot()，不要直接用 document / window。
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
  let panelEl = null, barEl = null, cardEl = null;
  let pending = null;          // 当前选中的内容
  let bound = false;
  let flashTimer = null;

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

  /* ================= 选区浮条 ================= */
  function hideBar() { if (barEl) { barEl.remove(); barEl = null; } }
  function showBar(rect) {
    hideBar();
    barEl = document.createElement('div');
    barEl.className = 'tnBar';
    barEl.innerHTML = COLORS.map(c => '<button class="tnSw tnSw-' + c.k + '" data-tncolor="' + c.k + '" title="' + esc(c.name) + '"></button>').join('')
      + '<span class="tnSep"></span>'
      + '<button class="tnBtn" data-tnstyle="underline" title="只画下划线，不铺底色">下划线</button>';
    document.body.appendChild(barEl);
    place(barEl, rect);
    barEl.querySelectorAll('[data-tncolor]').forEach(b => b.addEventListener('mousedown', ev => { ev.preventDefault(); ev.stopPropagation(); create(b.getAttribute('data-tncolor'), 'highlight'); }));
    barEl.querySelectorAll('[data-tnstyle]').forEach(b => b.addEventListener('mousedown', ev => { ev.preventDefault(); ev.stopPropagation(); create('yellow', b.getAttribute('data-tnstyle')); }));
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
  /* 排查用：记录上一次"为什么没浮出小条"（划不动时先看这里） */
  let lastWhy = '（还没读过选区）';
  const why = w => { lastWhy = w; hideBar(); };
  function onUp() { setTimeout(readSel, 10); }
  function readSel() {
    const root = R();
    if (!root) return why('拿不到正文根（tutRoot 为空）');
    let sel = null;
    try { sel = W().getSelection ? W().getSelection() : null; } catch (e) { sel = null; }
    if (!sel || !sel.rangeCount || sel.isCollapsed) return why('没有选中内容');
    if (!index.length) return why('正文索引是空的（mount 可能还没跑完）');
    const range = sel.getRangeAt(0);
    try {
      if (!root.contains(range.startContainer) || !root.contains(range.endContainer)) return why('选区不在正文里');
    } catch (e) { return why('读选区出错：' + e.message); }
    const abs = rangeAbs(range);
    if (!abs) return why('算不出偏移（选中的不是正文文本）');
    const text = ft.slice(abs.start, abs.end);
    if (!String(text || '').trim()) return why('选中的是空白');
    pending = {
      start: abs.start, end: abs.end,
      text: String(text).slice(0, 2000),
      prefix: ft.slice(Math.max(0, abs.start - 24), abs.start),
      suffix: ft.slice(abs.end, abs.end + 24)
    };
    let rect = null;
    try { rect = range.getBoundingClientRect(); } catch (e) { rect = null; }
    if (!rect || (!rect.width && !rect.height)) return why('选区没有可见位置（rect 为空）');
    lastWhy = '已浮出';
    showBar(rect);
  }
  async function create(color, style) {
    if (!pending) return;
    const p = pending;
    hideBar();
    try { W().getSelection && W().getSelection().removeAllRanges(); } catch (e) {}
    try {
      const r = await api('/api/tutnotes', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ tutorial_id: tid, start: p.start, end: p.end, text: p.text, prefix: p.prefix, suffix: p.suffix, color, style })
      });
      notes.push(r.note);
      notes.sort((a, b) => (Number(a.start) || 0) - (Number(b.start) || 0) || (a.id - b.id));
      apply(R());
      renderPanel();
      /* 划完立刻给张卡写批注（不写也行） */
      const m = R().querySelector('mark.tnm[data-tnid="' + r.note.id + '"]');
      if (m) openCard(m, r.note);
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
  const noteDisplay = n => {
    const t = String((n && n.text) || '').replace(/\s+/g, ' ').trim();
    return t.length > 80 ? t.slice(0, 80) + '…' : t;
  };
  async function del(note) {
    if (!confirm('删掉这条笔记？\n\n「' + noteDisplay(note) + '」')) return;
    try {
      await api('/api/tutnotes/' + note.id, { method: 'DELETE' });
      notes = notes.filter(x => Number(x.id) !== Number(note.id));
      closeCard(); apply(R()); renderPanel();
      toast('已删除');
    } catch (e) { toast(e.message); }
  }

  /* ================= 右侧清单 ================= */
  let onlyNotes = false;
  function renderPanel() {
    if (!panelEl) return;
    const list = notes.filter(n => !onlyNotes || String(n.note || '').trim());
    const box = panelEl.querySelector('.tnPanelList');
    box.innerHTML = list.length ? list.map(n => `
      <div class="tnItem" data-tnitem="${n.id}">
        <span class="tnItemBar tnSw-${n.color}${n.style === 'underline' ? ' u' : ''}"></span>
        <div class="tnItemB">
          <div class="tnItemQ">${esc(noteDisplay(n))}</div>
          ${String(n.note || '').trim() ? '<div class="tnItemN">' + esc(String(n.note).slice(0, 300)) + '</div>' : '<div class="tnItemN muted">（只划了重点，没写批注）</div>'}
          <div class="tnItemT">${esc(String(n.created_at || '').slice(5, 16).replace('T', ' '))}</div>
        </div>
        <button class="tnBtn tiny danger" data-tndel="${n.id}" title="删除">×</button>
      </div>`).join('')
      : '<p class="tnEmpty">' + (onlyNotes ? '还没有写过批注的笔记。' : '在正文里选中一段文字，就能划线、写批注。') + '</p>';
    const n1 = notes.length, n2 = notes.filter(x => String(x.note || '').trim()).length;
    panelEl.querySelector('.tnCount').textContent = n1 ? (n1 + ' 条' + (n2 ? '（' + n2 + ' 条带批注）' : '')) : '';
    box.querySelectorAll('[data-tnitem]').forEach(el => el.addEventListener('click', e => {
      if (e.target.closest('[data-tndel]')) return;
      jumpTo(Number(el.getAttribute('data-tnitem')));
    }));
    box.querySelectorAll('[data-tndel]').forEach(b => b.addEventListener('click', () => {
      const n = notes.find(x => Number(x.id) === Number(b.getAttribute('data-tndel')));
      if (n) del(n);
    }));
    const f = panelEl.querySelector('#tnOnly');
    if (f) f.checked = onlyNotes;
  }
  function jumpTo(id) {
    const m = R().querySelector('mark.tnm[data-tnid="' + id + '"]');
    if (!m) return toast('正文里找不到这段了（教程可能被改过）');
    try { m.scrollIntoView({ block: 'center', behavior: 'smooth' }); } catch (e) { try { m.scrollIntoView(); } catch (e2) {} }
    m.classList.add('tnFlash');
    if (flashTimer) clearTimeout(flashTimer);
    flashTimer = setTimeout(() => { try { m.classList.remove('tnFlash'); } catch (e) {} }, 1600);
  }
  function togglePanel(force) {
    if (panelEl && force !== true) { panelEl.remove(); panelEl = null; return; }
    if (panelEl) return;
    panelEl = document.createElement('div');
    panelEl.className = 'tnPanel';
    panelEl.innerHTML = `
      <div class="tnPanelHd"><b>📌 划线笔记</b><span class="tnCount"></span><span style="flex:1"></span>
        <label class="tnOnly"><input type="checkbox" id="tnOnly"> 只看带批注的</label>
        <button class="tnBtn" data-tnpanelclose="1">×</button></div>
      <div class="tnPanelList"></div>`;
    document.body.appendChild(panelEl);
    panelEl.querySelector('[data-tnpanelclose]').addEventListener('click', () => togglePanel(false));
    panelEl.querySelector('#tnOnly').addEventListener('change', e => { onlyNotes = !!e.target.checked; renderPanel(); });
    renderPanel();
  }

  /* ================= 挂载 / 卸载 ================= */
  /* 一个文档（主文档 or iframe 文档）上的监听：
     · mouseup → 点高亮打开批注卡；否则读选区决定要不要浮出小条
     · selectionchange → 同上（键盘选中也要能浮出来） */
  function attachDoc(doc) {
    if (!doc || doc.__tnBound) return;
    doc.__tnBound = true;
    doc.addEventListener('mouseup', e => {
      const m = e.target && e.target.closest && e.target.closest('mark.tnm');
      if (m) {
        const n = notes.find(x => Number(x.id) === Number(m.getAttribute('data-tnid')));
        if (n) { hideBar(); openCard(m, n); return; }
      }
      onUp();
    }, true);
    doc.addEventListener('selectionchange', onUp, true);
  }
  function bindOnce() {
    if (bound) return;
    bound = true;
    attachDoc(document);
    /* 点别处 → 收起浮条/卡片（浮层都在主文档里，绑主文档就够） */
    document.addEventListener('mousedown', e => {
      if (e.target && e.target.closest && (e.target.closest('.tnBar') || e.target.closest('.tnCard') || e.target.closest('.tnPanel') || e.target.closest('mark.tnm'))) return;
      hideBar(); closeCard();
    });
  }
  function mount(tutorialId) {
    tid = Number(tutorialId) || 0;
    if (!tid) return;
    closeCard(); hideBar();
    bindOnce();
    /* HTML 教程正文在 iframe 里：等它 load 完（最多等 3 秒），别对着空文档建索引 */
    let tries = 0;
    const boot = () => {
      tries++;
      const root = R();
      const okRoot = root && (root.childNodes || []).length > 3;
      if (!okRoot && tries < 15) return setTimeout(boot, 200);
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
  function unmount() { closeCard(); hideBar(); if (panelEl) { panelEl.remove(); panelEl = null; } tid = 0; notes = []; ft = ''; index = []; nodeMap = new Map(); }
  async function badge(tutorialId) {
    try {
      const r = await api('/api/tutnotes?tutorial_id=' + (tutorialId || tid));
      const n = (r.notes || []).length;
      const btn = document.getElementById('tutNoteMarkBtn');
      if (btn) {
        btn.textContent = n ? ('📌 划线笔记 ' + n) : '📌 划线笔记';
        btn.title = n ? (n + ' 条划线笔记 —— 点开看清单') : '在正文里选中文字就能划线、写批注';
      }
    } catch (e) {}
  }

  window.TutNotes = {
    mount, unmount, toggle: togglePanel, badge,
    refresh: () => { apply(R()); renderPanel(); },
    /* 调试：为何没浮出小条 / 索引与笔记数量 */
    debug: () => ({ why: lastWhy, ft: ft.length, notes: notes.length, nodes: index.length, id: tid })
  };
})();
