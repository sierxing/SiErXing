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

  function jump(idx) {
    const h = document.getElementById('tutsec-' + idx);
    if (!h) return toast('该章节不在当前渲染中');
    window.scrollTo({ top: h.getBoundingClientRect().top + window.scrollY - 110, behavior: 'smooth' });
  }

  async function init(tid) {
    const listEl = document.getElementById('tutBmList');
    if (!listEl) return;
    const load = async () => {
      let items = [];
      try { const r = await api('/api/tutorials/' + tid + '/bookmarks'); items = r.bookmarks || []; } catch (e) {}
      listEl.innerHTML = items.length ? items.map(b => `<div class="tutBmRow">
        <span class="chip">${esc(b.label || '标签')}</span>
        <span class="tutBmSec">${esc(b.section_title || ('第 ' + (Number(b.section_idx) + 1) + ' 节'))}</span>
        ${b.note ? `<span class="muted" style="font-size:11.5px;">${esc(b.note)}</span>` : ''}
        <div class="spacer"></div>
        <button class="btn tiny" data-bm-go="${b.section_idx}">跳转</button>
        <button class="btn tiny danger" data-bm-del="${b.id}">删除</button>
      </div>`).join('') : '<span class="muted" style="font-size:12.5px;">还没有标签：在上面点「＋ 标记当前章节」（会自动定位到你正在读的章节）</span>';
      listEl.querySelectorAll('[data-bm-go]').forEach(x => x.addEventListener('click', () => jump(Number(x.getAttribute('data-bm-go')))));
      listEl.querySelectorAll('[data-bm-del]').forEach(x => x.addEventListener('click', async () => {
        if (!confirm('删除这个标签？')) return;
        try { await api('/api/bookmarks/' + x.getAttribute('data-bm-del'), { method: 'DELETE' }); load(); } catch (e) { toast(e.message); }
      }));
    };
    await load();
    const addBtn = document.getElementById('tutBmAdd');
    if (addBtn) addBtn.addEventListener('click', async () => {
      let cur = window.__tutCur || { idx: 0, title: '' };
      if (!cur.title) {   // 目录还没建好时的兜底：读高亮目录项
        const act = document.querySelector('#tutToc .tutTocItem.active');
        if (act) cur = { idx: Number(act.getAttribute('data-toc')) || 0, title: act.textContent.trim().slice(0, 80) };
      }
      const label = (document.getElementById('tutBmLabel').value || '').trim();
      const note = (document.getElementById('tutBmNote').value || '').trim();
      try {
        await api('/api/tutorials/' + tid + '/bookmarks', { method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ section_idx: cur.idx || 0, section_title: cur.title || '', label, note }) });
        document.getElementById('tutBmLabel').value = '';
        document.getElementById('tutBmNote').value = '';
        toast('已标记：' + (label || cur.title || ('第 ' + ((cur.idx || 0) + 1) + ' 节')));
        load();
      } catch (e) { toast(e.message); }
    });
  }

  window.TutBookmark = {
    /* 教程页书签区 HTML */
    sectionHTML() {
      return `<div class="sec" id="tutBmSec">
        <div class="secTitle">🔖 阅读标签 <span class="muted" style="font-weight:400;font-size:11.5px;">· 记录读到哪、标重点/待复习（组件可开关）</span>
          <div class="spacer"></div><button class="btn tiny primary" id="tutBmAdd">＋ 标记当前章节</button></div>
        <div class="tutBmForm">
          <input id="tutBmLabel" placeholder="标签（如：已读 / 重点 / 待复习，默认用章节名）">
          <input id="tutBmNote" placeholder="备注（可选）">
        </div>
        <div id="tutBmList"><span class="muted" style="font-size:12.5px;">加载中…</span></div>
      </div>`;
    },
    init,
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
