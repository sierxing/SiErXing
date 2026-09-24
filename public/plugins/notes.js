'use strict';
/**
 * 思而行 · 前端扩展组件：学习笔记
 * ------------------------------------------------------------------
 * 教程页右侧栏：在对应节点记录 Markdown 笔记，一边看教程一边记；
 * 输入即实时渲染（自动保存），可折叠、可拖动调宽。
 * 由 app.js 在教程页挂载/卸载（仅当组件启用时）。
 */
(function () {
  const { api, esc, toast, mdToHTML } = SiErXing;

  let tid = 0, nodeId = 0, nodeTitle = '';
  let dirty = false, saveTimer = 0, renderTimer = 0;

  function panelEl() { return document.getElementById('nodeNotes'); }
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
    const ta = document.getElementById('nnEditor');
    const el = document.getElementById('nnCount');
    if (ta && el) el.textContent = '共 ' + ta.value.length + ' 字';
  }

  async function load() {
    setStatus('加载中…');
    try {
      const r = await api('/api/nodes/' + nodeId + '/note');
      const ta = document.getElementById('nnEditor');
      if (ta && !ta.value) { ta.value = r.content || ''; renderPreview(); }
      setStatus(r.content ? ('已保存 ' + (r.updated_at || '').slice(0, 16).replace('T', ' ')) : '空笔记：在上面输入');
    } catch (e) {
      setStatus('加载失败');
    }
    setCount();
  }

  function renderPreview() {
    const ta = document.getElementById('nnEditor');
    const pv = document.getElementById('nnPreview');
    if (!ta || !pv) return;
    try { pv.innerHTML = ta.value.trim() ? mdToHTML(ta.value) : '<span class="muted">（预览区：输入后实时显示）</span>'; }
    catch (e) { pv.textContent = ta.value; }
  }

  function scheduleSave() {
    dirty = true;
    setStatus('保存中…');
    setCount();
    if (saveTimer) clearTimeout(saveTimer);
    saveTimer = setTimeout(async () => {
      saveTimer = 0;
      const ta = document.getElementById('nnEditor');
      if (!ta) return;
      try {
        const r = await api('/api/nodes/' + nodeId + '/note', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ content: ta.value }) });
        dirty = false;
        setStatus('已保存 ' + (r.updated_at || '').slice(0, 16).replace('T', ' '));
      } catch (e) {
        setStatus('保存失败，重试中…');
        scheduleSave();
      }
    }, 1200);
  }

  function flush() {
    // 切走页面时尽力把未保存的内容送出去
    if (!dirty) return;
    try {
      const ta = document.getElementById('nnEditor');
      if (!ta) return;
      fetch('/api/nodes/' + nodeId + '/note', {
        method: 'PUT', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ content: ta.value }), keepalive: true
      }).catch(() => {});
      dirty = false;
    } catch (e) {}
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
      tid = tutorialId; nodeId = nid; nodeTitle = ntitle || '';
      if (!nodeId || !isOpen() || panelEl()) return;
      const div = document.createElement('aside');
      div.id = 'nodeNotes';
      div.className = 'nodeNotes';
      div.innerHTML = `<div class="nnHead"><span>🗒 笔记</span><span class="nnSub" title="${esc(nodeTitle)}">${esc(String(nodeTitle).slice(0, 18))}</span><div class="spacer"></div><button class="btn tiny" id="nnHide" title="收起（内容自动保存）">收起 »</button></div>
        <div class="nnMeta"><span id="nnStatus">…</span><span id="nnCount"></span></div>
        <textarea id="nnEditor" spellcheck="false" placeholder="一边看教程一边记（Markdown，输入即渲染、自动保存）"></textarea>
        <div class="nnPrevLabel">实时预览</div>
        <div id="nnPreview" class="mdBody"></div>
        <div class="nnResize" id="nnResize" title="拖动调宽"></div>`;
      document.body.appendChild(div);
      applyWidth(width());
      div.querySelector('#nnHide').addEventListener('click', () => window.NodeNotes.hide());
      const ta = div.querySelector('#nnEditor');
      ta.addEventListener('input', () => {
        if (renderTimer) clearTimeout(renderTimer);
        renderTimer = setTimeout(renderPreview, 250);
        scheduleSave();
      });
      bindDrag();
      load();
    },
    /* 收起（保留内容，已自动保存） */
    hide() {
      flush();
      if (saveTimer) { clearTimeout(saveTimer); saveTimer = 0; }
      if (renderTimer) { clearTimeout(renderTimer); renderTimer = 0; }
      setOpen(false);
      const p = panelEl();
      if (p) p.remove();
    },
    /* 顶栏按钮：展开 / 收起 */
    toggle(tutorialId, nid, ntitle) {
      if (panelEl()) { this.hide(); return; }
      setOpen(true);
      this.mount(tutorialId == null ? tid : tutorialId, nid == null ? nodeId : nid, ntitle == null ? nodeTitle : ntitle);
    },
    /* 路由切换时清理 */
    unmount() {
      flush();
      if (saveTimer) { clearTimeout(saveTimer); saveTimer = 0; }
      if (renderTimer) { clearTimeout(renderTimer); renderTimer = 0; }
      const p = panelEl();
      if (p) p.remove();
    }
  };

  SiErXing.registerPlugin({ id: 'notes' });
})();
