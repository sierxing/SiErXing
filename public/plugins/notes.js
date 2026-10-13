'use strict';
/**
 * 思而行 · 前端扩展组件：学习笔记
 * ------------------------------------------------------------------
 * 教程页右侧栏：在对应节点记录 Markdown 笔记，一边看教程一边记；
 * 单个框体：平时直接看渲染效果，点编辑改完保存；
 * 可折叠（边缘小标签随时找回）、可拖动调宽。
 * 由 app.js 在教程页挂载/卸载（仅当组件启用时）。
 */
(function () {
  const { api, esc, toast, mdToHTML, mdPickOffset } = SiErXing;

  let tid = 0, nodeId = 0, nodeTitle = '';
  let current = '';          // 已保存的内容
  let editing = false;

  function panelEl() { return document.getElementById('nodeNotes'); }
  function tabEl() { return document.getElementById('nnTab'); }
  function isOpen() { try { return localStorage.getItem('sierxing-notes-open') !== '0'; } catch (e) { return true; } }
  function setOpen(v) { try { localStorage.setItem('sierxing-notes-open', v ? '1' : '0'); } catch (e) {} }
  function width() {
    try { const w = Number(localStorage.getItem('sierxing-notes-w')) || 340; return Math.max(280, Math.min(560, w)); }
    catch (e) { return 340; }
  }
  function applyWidth(w) {
    const p = panelEl();
    if (p) p.style.width = w + 'px';
  }
  function setWidth(w) {
    w = Math.max(280, Math.min(560, Math.round(w)));
    try { localStorage.setItem('sierxing-notes-w', String(w)); } catch (e) {}
    applyWidth(w);
  }
  function setStatus(s) {
    const el = document.getElementById('nnStatus');
    if (el) el.textContent = s;
  }
  function setCount() {
    const el = document.getElementById('nnCount');
    if (el) el.textContent = current ? ('共 ' + current.length + ' 字') : '';
  }
  /* 把"人看到的一段话"变成几个"最可能在 Markdown 源码里逐字出现"的候选片段：
     整段 + 前缀 + 按标点/换行切出来的短句（列表项被折成一行时光靠整段找不到）。 */
  function anchorCands(txt) {
    const norm = String(txt || '').replace(/[ \t\r\n]+/g, ' ').trim();
    if (!norm) return [];
    const out = [norm.slice(0, 40), norm.slice(0, 16)];
    const pieces = norm.split(/[\n，。；、,.;!?！？:：]/).map(s => s.trim()).filter(s => s.length >= 4);
    pieces.sort((a, b) => b.length - a.length);
    for (const p of pieces.slice(0, 4)) out.push(p);
    return out.filter(s => s && s.length >= 4);
  }

  /* ---- 视图态：直接看渲染效果 ---- */
  function showView() {
    editing = false;
    const body = document.getElementById('nnBody');
    if (!body) return;
    /* srcLines:true → 每个块带上 data-src（源码起始行号）。悬停描边（app.js 的
       mdPickHoverBind）与下面单击定位都靠它，两边共用 mdPickTarget/mdPickOffset，
       所以"描出来的块"= "点下去会改的那块"（教程正文同一套）。 */
    body.innerHTML = current.trim()
      ? `<div id="nnView" class="mdBody" title="点一下正文，就在这一句上开始改">${mdToHTML(current, { srcLines: true })}</div>`
      : `<div id="nnView" class="nnEmpty">还没有笔记，点右上「编辑」开始记<br><span class="muted">支持 Markdown（标题/列表/代码/加粗）</span></div>`;
    const v = document.getElementById('nnView');
    /* 笔记栏里用**单击**：用户要的就是"点哪改哪"（教程正文那边用双击，
       因为正文太长、单击容易误触；笔记就一段，单击更顺手）。链接除外，
       否则点笔记里的链接会被编辑抢走。 */
    if (v) v.addEventListener('click', ev => {
      if (ev.target && ev.target.closest && ev.target.closest('a')) return;
      showEdit(ev);
    });
    const eb = document.getElementById('nnEditBtn');
    if (eb) { eb.hidden = false; }
    const sb = document.getElementById('nnSaveBtn');
    if (sb) sb.hidden = true;
    const cb = document.getElementById('nnCancelBtn');
    if (cb) cb.hidden = true;
  }

  /* ---- 编辑态：单个框里写 ---- */
  /* 从光标处开始改：点（或点「编辑」按钮）那一下落在哪，编辑框光标就停在源码对应位置；
     定位不到就按视图态的滚动比例折算，总之不许每次都跳回开头。 */
  function showEdit(e) {
    editing = true;
    const body = document.getElementById('nnBody');
    if (!body) return;
    /* ⚠️ 下面要整体替换 DOM，选中区/滚动位置会没，所以先把"想改哪"记下来 */
    let anchor = '', word = '', ratio = 0, pick = -1;
    try {
      const view = document.getElementById('nnView');
      const target = e && e.target ? e.target : null;
      if (target && view) {
        /* ① 渲染时标的源码行号（最准；跟悬停描边同一个判据） */
        if (typeof mdPickOffset === 'function') pick = mdPickOffset(current, target, view);
        /* ② 老办法按文字匹配 —— 只在没标 data-src 的内容上兜底 */
        let d = target;
        while (d && d !== view && d.parentNode) {
          const tag = String(d.tagName || '').toLowerCase();
          if (/^(p|li|h[1-6]|pre|blockquote|td|th|dt|dd)$/.test(tag)) break;
          d = d.parentNode;
        }
        if (d && d !== view) anchor = String(d.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 40);
      }
      const sel = window.getSelection ? window.getSelection() : null;
      if (sel && !sel.isCollapsed) word = String(sel.toString() || '').replace(/\s+/g, ' ').trim();
      if (view) { const span = view.scrollHeight - view.clientHeight; ratio = span > 0 ? view.scrollTop / span : 0; }
    } catch (err) {}
    body.innerHTML = `<textarea id="nnEditor" spellcheck="false" placeholder="Markdown 笔记，Ctrl+S 保存"></textarea>`;
    const ta = document.getElementById('nnEditor');
    ta.value = current;
    let p = pick;
    if (p >= 0 && word) { const w = current.indexOf(word, p); if (w >= 0 && w < p + 400) p = w; }
    if (p < 0) for (const c of anchorCands(anchor)) { const i = current.indexOf(c); if (i >= 0) { p = i; break; } }
    if (p < 0 && word) { const i = current.indexOf(word); if (i >= 0) p = i; }
    if (p < 0) p = Math.round(ratio * current.length);
    p = Math.max(0, Math.min(current.length, p));
    ta.focus();
    try { ta.setSelectionRange(p, p); } catch (err) {}
    /* 把光标那一行滚进可视区（居中偏上），不然长笔记一进去还是开头 */
    try {
      const line = (current.slice(0, p).match(/\n/g) || []).length + 1;
      const lh = parseFloat(window.getComputedStyle(ta).lineHeight) || 20;
      ta.scrollTop = Math.max(0, (line - 1) * lh - ta.clientHeight * 0.3);
    } catch (err) {}
    ta.addEventListener('keydown', e => {
      if ((e.ctrlKey || e.metaKey) && e.key === 's') { e.preventDefault(); doSave(); }
      if (e.key === 'Escape') { doCancel(); }
    });
    const eb = document.getElementById('nnEditBtn');
    if (eb) eb.hidden = true;
    const sb = document.getElementById('nnSaveBtn');
    if (sb) { sb.hidden = false; sb.disabled = false; sb.textContent = '💾 保存'; }
    const cb = document.getElementById('nnCancelBtn');
    if (cb) cb.hidden = false;
  }

  async function doSave() {
    const ta = document.getElementById('nnEditor');
    if (!ta) return;
    const sb = document.getElementById('nnSaveBtn');
    if (sb) { sb.disabled = true; sb.textContent = '保存中…'; }
    try {
      const r = await api('/api/nodes/' + nodeId + '/note', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ content: ta.value }) });
      current = ta.value;
      setStatus('已保存 ' + (r.updated_at || '').slice(0, 16).replace('T', ' '));
      setCount();
      toast('笔记已保存');
      showView();
    } catch (e) {
      toast(e.message);
      if (sb) { sb.disabled = false; sb.textContent = '💾 保存'; }
    }
  }

  function doCancel() {
    showView();   // 丢弃未保存的修改，回到已保存版本
  }

  function flush() {
    // 切走页面时：编辑中没保存的内容尽力送出去
    if (!editing) return;
    try {
      const ta = document.getElementById('nnEditor');
      if (!ta || ta.value === current) return;
      fetch('/api/nodes/' + nodeId + '/note', {
        method: 'PUT', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ content: ta.value }), keepalive: true
      }).catch(() => {});
    } catch (e) {}
  }

  function showTab() {
    if (tabEl() || panelEl()) return;
    const t = document.createElement('button');
    t.id = 'nnTab';
    t.className = 'nnTab';
    t.title = '展开笔记栏';
    t.textContent = '🗒 笔记';
    t.addEventListener('click', () => {
      setOpen(true);
      const p = tabEl();
      if (p) p.remove();
      window.NodeNotes.mount();
    });
    document.body.appendChild(t);
  }

  function bindDrag() {
    const handle = document.getElementById('nnResize');
    if (!handle) return;
    handle.addEventListener('mousedown', e => {
      e.preventDefault();
      const move = ev => setWidth(window.innerWidth - 22 - ev.clientX);
      const up = () => {
        document.removeEventListener('mousemove', move);
        document.removeEventListener('mouseup', up);
      };
      document.addEventListener('mousemove', move);
      document.addEventListener('mouseup', up);
    });
  }

  window.NodeNotes = {
    /* 挂载右侧笔记栏（教程页渲染后调用） */
    mount(tutorialId, nid, ntitle) {
      if (tutorialId != null) tid = tutorialId;
      if (nid != null) nodeId = nid;
      if (ntitle != null) nodeTitle = ntitle;
      if (!nodeId) return;
      if (!isOpen()) { showTab(); return; }
      if (panelEl()) return;
      const tb = tabEl();
      if (tb) tb.remove();
      const div = document.createElement('aside');
      div.id = 'nodeNotes';
      div.className = 'nodeNotes';
      div.innerHTML = `<div class="nnHead"><span>🗒 笔记</span><span class="nnSub" title="${esc(nodeTitle)}">${esc(String(nodeTitle).slice(0, 18))}</span><div class="spacer"></div>
        <button class="btn tiny" id="nnEditBtn">✎ 编辑</button>
        <button class="btn tiny primary" id="nnSaveBtn" hidden>💾 保存</button>
        <button class="btn tiny" id="nnCancelBtn" hidden>取消</button>
        <button class="btn tiny" id="nnHide" title="收起（边缘小标签可再打开）">收起 »</button></div>
        <div class="nnMeta"><span id="nnStatus">…</span><span id="nnCount"></span></div>
        <div id="nnBody"></div>
        <div class="nnResize" id="nnResize" title="拖动调宽"></div>`;
      document.body.appendChild(div);
      applyWidth(width());
      div.querySelector('#nnHide').addEventListener('click', () => window.NodeNotes.hide());
      div.querySelector('#nnEditBtn').addEventListener('click', showEdit);
      div.querySelector('#nnSaveBtn').addEventListener('click', doSave);
      div.querySelector('#nnCancelBtn').addEventListener('click', doCancel);
      bindDrag();
      (async () => {
        setStatus('加载中…');
        try {
          const r = await api('/api/nodes/' + nodeId + '/note');
          current = r.content || '';
          setStatus(current ? ('已保存 ' + (r.updated_at || '').slice(0, 16).replace('T', ' ')) : '空笔记：点右上「编辑」开始记');
        } catch (e) {
          setStatus('加载失败');
        }
        setCount();
        showView();
      })();
    },
    /* 收起（保留内容，边缘小标签可再打开） */
    hide() {
      flush();
      setOpen(false);
      const p = panelEl();
      if (p) p.remove();
      showTab();
    },
    /* 顶栏按钮：展开 / 收起 */
    toggle(tutorialId, nid, ntitle) {
      if (panelEl()) { this.hide(); return; }
      const tb = tabEl();
      if (tb) tb.remove();
      setOpen(true);
      this.mount(tutorialId, nid, ntitle);
    },
    /* 路由切换时清理 */
    unmount() {
      flush();
      const p = panelEl();
      if (p) p.remove();
      const tb = tabEl();
      if (tb) tb.remove();
    }
  };

  SiErXing.registerPlugin({ id: 'notes' });
})();
