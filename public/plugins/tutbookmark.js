'use strict';
/**
 * 思而行 · 前端扩展组件：教程书签
 * ------------------------------------------------------------------
 * 在教程页按章节打标签（记录读到哪、标重点/待复习，点击跳回对应章节）；
 * 节点面板可把写好的 .md / .html 文件导入为该节点的教程。
 * 由 app.js 在教程页 / 节点面板中调用（仅当组件启用时挂载）。
 */
(function () {
  const { api, esc, toast } = SiErXing;

  /* ⚠️ HTML 教程的正文在 <iframe id="tutFrame"> 里（srcdoc、同源），而且那个 iframe 是固定高度、
     滚动发生在它内部。tutsec-N 这些标题 id 是 tutTocBuild 打的，打在 iframe 的文档里。
     所以「找标题」和「滚动」都得认 iframe，不能一律用 document / window ——
     否则 HTML 教程上标签跳转会直接报「该章节不在当前渲染中」。 */
  function tutCtx() {
    const f = document.getElementById('tutFrame');
    if (f && f.contentDocument && f.contentWindow) return { doc: f.contentDocument, win: f.contentWindow };
    return { doc: document, win: window };
  }

  function jump(idx) {
    const { doc, win } = tutCtx();
    const h = doc.getElementById('tutsec-' + idx);
    if (!h) return toast('该章节不在当前渲染中');
    try { win.scrollTo({ top: h.getBoundingClientRect().top + win.scrollY - 110, behavior: 'smooth' }); }
    catch (e) { win.scrollTo(0, h.getBoundingClientRect().top + win.scrollY - 110); }
  }

  /* 浮动面板：随时呼出，不用翻到底部 */
  function panelEl() { return document.getElementById('tutBmPanel'); }
  function curSection() {
    let cur = window.__tutCur || { idx: 0, title: '' };
    if (!cur.title) {
      const act = document.querySelector('#tutToc .tutTocItem.active');
      if (act) cur = { idx: Number(act.getAttribute('data-toc')) || 0, title: act.textContent.trim().slice(0, 80) };
    }
    return cur;
  }
  async function refreshList(tid) {
    const listEl = document.getElementById('tutBmList');
    if (!listEl) return 0;
    let items = [];
    try { const r = await api('/api/tutorials/' + tid + '/bookmarks'); items = r.bookmarks || []; } catch (e) {}
    listEl.innerHTML = items.length ? items.map(b => `<div class="tutBmRow">
      <span class="chip">${esc(b.label || '标签')}</span>
      <span class="tutBmSec">${esc(b.section_title || ('第 ' + (Number(b.section_idx) + 1) + ' 节'))}</span>
      ${b.note ? `<span class="muted" style="font-size:11.5px;">${esc(b.note)}</span>` : ''}
      <div class="spacer"></div>
      <button class="btn tiny" data-bm-go="${b.section_idx}">跳转</button>
      <button class="btn tiny danger" data-bm-del="${b.id}">删除</button>
    </div>`).join('') : '<span class="muted" style="font-size:12.5px;">还没有标签：填个标签点「标记当前章节」</span>';
    listEl.querySelectorAll('[data-bm-go]').forEach(x => x.addEventListener('click', () => jump(Number(x.getAttribute('data-bm-go')))));
    listEl.querySelectorAll('[data-bm-del]').forEach(x => x.addEventListener('click', async () => {
      if (!confirm('删除这个标签？')) return;
      try { await api('/api/bookmarks/' + x.getAttribute('data-bm-del'), { method: 'DELETE' }); refreshList(tid); updateBadge(tid); } catch (e) { toast(e.message); }
    }));
    return items.length;
  }
  async function updateBadge(tid) {
    const btn = document.getElementById('tutBmBtn');
    if (!btn) return;
    try {
      const r = await api('/api/tutorials/' + tid + '/bookmarks');
      const n = (r.bookmarks || []).length;
      btn.innerHTML = n ? `🔖 标签 (${n})` : '🔖 标签';
    } catch (e) {}
  }
  function refreshCur() {
    const el = document.getElementById('tutBmCurSec');
    if (!el) return;
    const cur = curSection();
    el.textContent = cur.title || ('第 ' + ((cur.idx || 0) + 1) + ' 节');
  }
  window.TutBookmark = {
    /* 打开/关闭浮动面板（顶栏按钮调用，随时可用） */
    toggle(tid) {
      const old = panelEl();
      if (old) { old.remove(); return; }
      const div = document.createElement('div');
      div.id = 'tutBmPanel';
      div.className = 'tutBmPanel';
      div.innerHTML = `<div class="tutBmPanelHead"><span>🔖 阅读标签</span><button class="btn tiny" id="tutBmClose">×</button></div>
        <div class="tutBmCur">当前章节：<b id="tutBmCurSec">…</b></div>
        <div class="tutBmForm">
          <input id="tutBmLabel" placeholder="标签（如：已读 / 重点 / 待复习）">
          <input id="tutBmNote" placeholder="备注（可选）">
        </div>
        <button class="btn tiny primary" id="tutBmAdd" style="width:100%;">＋ 标记当前章节</button>
        <div id="tutBmList" style="margin-top:8px;"><span class="muted" style="font-size:12.5px;">加载中…</span></div>`;
      document.body.appendChild(div);
      div.querySelector('#tutBmClose').addEventListener('click', () => div.remove());
      div.querySelector('#tutBmAdd').addEventListener('click', async () => {
        const cur = curSection();
        const label = (div.querySelector('#tutBmLabel').value || '').trim();
        const note = (div.querySelector('#tutBmNote').value || '').trim();
        try {
          await api('/api/tutorials/' + tid + '/bookmarks', { method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ section_idx: cur.idx || 0, section_title: cur.title || '', label, note }) });
          div.querySelector('#tutBmLabel').value = '';
          div.querySelector('#tutBmNote').value = '';
          toast('已标记：' + (label || cur.title || ('第 ' + ((cur.idx || 0) + 1) + ' 节')));
          refreshList(tid); updateBadge(tid);
        } catch (e) { toast(e.message); }
      });
      refreshCur(); refreshList(tid);
    },
    /* 路由切换时清理 */
    unmount() { const p = panelEl(); if (p) p.remove(); },
    init(tid) { this.toggle(tid); },
    badge: updateBadge,
    jump,
    /* 节点面板：导入教程按钮 HTML */
    nodeImportHTML() {
      return `<label class="btn small" style="margin-top:8px;" title="把写好的 .md / .html 文件导入为该节点的教程">⬆ 导入教程<input type="file" id="npTutFile" accept=".md,.markdown,.html,.htm,.txt" hidden></label>`;
    },
    /* 节点面板：绑定文件选择，成功后调 onDone(r)（由宿主刷新面板） */
    bindNodeImport(root, nodeId, onDone) {
      const tutFile = (root || document).querySelector('#npTutFile');
      if (!tutFile) return;
      tutFile.addEventListener('change', async () => {
        const file = (tutFile.files || [])[0];
        tutFile.value = '';
        if (!file) return;
        const ext = String(file.name || '').split('.').pop().toLowerCase();
        const format = (ext === 'html' || ext === 'htm') ? 'html' : 'md';
        try {
          const text = await file.text();
          if (!text.trim()) return toast('文件是空的');
          const r = await api('/api/nodes/' + nodeId + '/tutorials/import', { method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ title: String(file.name).replace(/\.[^.]+$/, '').slice(0, 100), format, content: text }) });
          toast('已导入教程');
          if (typeof onDone === 'function') onDone(r);
        } catch (e) { toast(e.message); }
      });
    }
  };
  SiErXing.registerPlugin({ id: 'tutbookmark' });
})();
