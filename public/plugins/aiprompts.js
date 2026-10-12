'use strict';
/**
 * 思而行 · 前端扩展组件：提示词库
 * ------------------------------------------------------------------
 * 在 AI 对话框输入区加一个 📝 按钮，点开按分类快捷选择常用提示词，
 * 一键写入输入框（光标处插入）。弹窗里切到「管理」可新增 / 改 / 删 /
 * 上下排序，分类可重命名、删除（名下条目移到未分类）。
 */
(function () {
  const { api, esc, toast } = SiErXing;

  let cache = [];          // 全部提示词（服务端顺序）
  let tab = 'pick';        // pick | manage
  let filterCat = '';      // '' = 全部
  let query = '';
  let editingId = 0;       // 正在编辑的 id（0 = 新建）
  let timer = null;

  function compOn() {
    try { return typeof window.compOn === 'function' ? window.compOn('aiprompts') !== false : true; }
    catch (e) { return true; }
  }
  function drawer() { return document.getElementById('aiDrawer'); }
  function ta() { return document.getElementById('adText'); }

  /* 每秒自检：抽屉出现就挂入口条；组件被关就清理 */
  function ensure() {
    try {
      const on = compOn();
      const old = document.getElementById('apBtn');
      if (old) old.remove();   // 兼容旧版小图标，见到就清掉
      let bar = document.getElementById('apBar');
      if (!on) {
        if (bar) bar.remove();
        const p = document.getElementById('apPicker');
        if (p) p.remove();
        return;
      }
      const d = drawer(), input = ta();
      if (!d || !input) return;
      if (!bar) {
        bar = document.createElement('div');
        bar.id = 'apBar';
        bar.innerHTML = `<button id="apBarBtn" title="打开提示词库，快捷插入常用提示词">📝 <span>提示词</span><span class="apCount" id="apCount"></span></button>`;
        /* 并进 #adTools 那条工具栏（模式按钮在它左边），整行看起来才像一个工具栏；
           没有 #adTools（老版本前端）时退回原来的位置。 */
        const tools = d.querySelector('#adTools');
        const inputBox = d.querySelector('.adInput');
        if (tools) tools.appendChild(bar);
        else if (inputBox) inputBox.parentNode.insertBefore(bar, inputBox);
        else d.appendChild(bar);
        bar.querySelector('#apBarBtn').addEventListener('click', ev => { ev.stopPropagation(); togglePicker(); });
      }
      refreshCount();
    } catch (e) {}
  }
  async function refreshCount() {
    try {
      if (!cache.length) await load();
      const el = document.getElementById('apCount');
      if (el) el.textContent = cache.length ? cache.length + '条' : '';
    } catch (e) {}
  }

  async function load() {
    try {
      const r = await api('/api/prompts');
      cache = Array.isArray(r.prompts) ? r.prompts : [];
    } catch (e) { cache = []; }
  }
  function cats() {
    const m = new Map();
    for (const p of cache) {
      const c = (p.category || '').trim();
      if (!c) continue;
      m.set(c, (m.get(c) || 0) + 1);
    }
    return [...m.entries()].sort((a, b) => a[0].localeCompare(b[0], 'zh'));
  }
  function catName(c) { return (c || '').trim() || '未分类'; }

  function filtered() {
    const q = query.trim().toLowerCase();
    return cache.filter(p => {
      if (filterCat !== '' && (p.category || '').trim() !== filterCat) return false;
      if (!q) return true;
      return ((p.title || '') + '\n' + (p.content || '')).toLowerCase().includes(q);
    });
  }

  function closePicker() {
    const p = document.getElementById('apPicker');
    if (p) p.remove();
    document.removeEventListener('click', outsideClose, true);
  }
  function outsideClose(e) {
    const p = document.getElementById('apPicker');
    if (!p) return document.removeEventListener('click', outsideClose, true);
    if (!p.contains(e.target) && !(e.target.closest && e.target.closest('#apBar'))) closePicker();
  }
  async function togglePicker() {
    if (document.getElementById('apPicker')) { closePicker(); return; }
    await load();
    renderPicker();
    document.addEventListener('click', outsideClose, true);
  }

  function renderPicker() {
    closePickerSafe();
    const d = drawer();
    if (!d) return;
    const p = document.createElement('div');
    p.id = 'apPicker';
    p.className = 'apPicker';
    p.innerHTML =
      `<div class="apTabs"><button data-tab="pick" class="${tab === 'pick' ? 'active' : ''}">选择</button>` +
      `<button data-tab="manage" class="${tab === 'manage' ? 'active' : ''}">管理</button>` +
      `<div class="spacer"></div><button class="apX" id="apClose" title="关闭">×</button></div>` +
      `<div class="apBody" id="apBody"></div>`;
    // 定位到输入框上方（fixed，按输入框实时位置算，不依赖抽屉样式）
    const r = ta().getBoundingClientRect();
    p.style.left = Math.max(8, r.left) + 'px';
    p.style.right = Math.max(8, window.innerWidth - r.right) + 'px';
    p.style.bottom = Math.max(8, window.innerHeight - r.top + 8) + 'px';
    document.body.appendChild(p);
    p.querySelectorAll('[data-tab]').forEach(b => b.addEventListener('click', () => {
      tab = b.getAttribute('data-tab');
      editingId = 0;
      renderPicker();
      document.addEventListener('click', outsideClose, true);
    }));
    p.querySelector('#apClose').addEventListener('click', closePicker);
    renderBody();
  }
  function closePickerSafe() {
    const p = document.getElementById('apPicker');
    if (p) p.remove();
  }

  function renderBody() {
    const box = document.getElementById('apBody');
    if (!box) return;
    if (tab === 'pick') renderPick(box);
    else renderManage(box);
  }

  /* ---------- 选择 tab ---------- */
  function renderPick(box) {
    const cs = cats();
    const list = filtered();
    box.innerHTML =
      `<input id="apQ" placeholder="🔍 搜索提示词…" value="${esc(query)}">` +
      `<div class="apCats"><button data-cat="" class="${filterCat === '' ? 'active' : ''}">全部</button>` +
      cs.map(([c, n]) => `<button data-cat="${esc(c)}" class="${filterCat === c ? 'active' : ''}">${esc(c)}(${n})</button>`).join('') +
      `</div><div class="apList">` +
      (list.length ? list.map(p =>
        `<button class="apItem" data-id="${p.id}" title="${esc((p.content || '').slice(0, 200))}">` +
        `<span class="apItemT">${esc(p.title || p.content.slice(0, 30))}</span>` +
        `<span class="apItemC">${esc(catName(p.category))}</span></button>`
      ).join('') : '<div class="muted" style="padding:10px 2px;">没有匹配的提示词，去「管理」里加一条吧</div>') +
      `</div>`;
    const q = box.querySelector('#apQ');
    q.addEventListener('input', () => { query = q.value; renderPick(box); const q2 = box.querySelector('#apQ'); q2.focus(); q2.setSelectionRange(q2.value.length, q2.value.length); });
    box.querySelectorAll('[data-cat]').forEach(b => b.addEventListener('click', () => { filterCat = b.getAttribute('data-cat'); renderPick(box); }));
    box.querySelectorAll('.apItem').forEach(b => b.addEventListener('click', () => {
      const p = cache.find(x => Number(x.id) === Number(b.getAttribute('data-id')));
      if (p) insertText(p.content || '');
    }));
  }

  function insertText(text) {
    const t = ta();
    if (!t || !text) return;
    t.focus();
    try {
      const s = t.selectionStart != null ? t.selectionStart : t.value.length;
      const e = t.selectionEnd != null ? t.selectionEnd : t.value.length;
      const before = t.value.slice(0, s), after = t.value.slice(e);
      const sep = before && !before.endsWith('\n') ? '\n' : '';
      t.value = before + sep + text + after;
      const pos = (before + sep + text).length;
      t.setSelectionRange(pos, pos);
    } catch (err) {
      t.value = (t.value ? t.value + '\n' : '') + text;
    }
    t.dispatchEvent(new Event('input', { bubbles: true }));   // 触发 autogrow + 草稿保存
    closePicker();
    toast('已写入输入框');
  }

  /* ---------- 管理 tab ---------- */
  function renderManage(box) {
    const cs = cats();
    const list = filtered();
    let h = `<div class="apCats"><button data-cat="" class="${filterCat === '' ? 'active' : ''}">全部</button>` +
      cs.map(([c, n]) => `<button data-cat="${esc(c)}" class="${filterCat === c ? 'active' : ''}">${esc(c)}(${n})</button>`).join('') +
      `</div><div class="apList">`;
    h += list.map((p, i) =>
      `<div class="apRow" data-id="${p.id}"><div class="apRowMain"><div class="apRowT">${esc(p.title || '(无标题)')}</div>` +
      `<div class="apRowC">${esc(catName(p.category))}</div></div>` +
      `<div class="apRowOps"><button data-act="up" title="上移" ${i === 0 ? 'disabled' : ''}>↑</button>` +
      `<button data-act="down" title="下移" ${i === list.length - 1 ? 'disabled' : ''}>↓</button>` +
      `<button data-act="edit" title="编辑">✎</button><button data-act="del" title="删除">×</button></div></div>`
    ).join('') || '<div class="muted" style="padding:10px 2px;">空空如也，点下面新建一条吧</div>';
    h += `</div><button class="btn small primary" id="apNew" style="margin-top:8px;">＋ 新建提示词</button>`;
    h += `<div id="apForm"></div>`;
    h += `<details class="apCatsMgr"><summary>分类管理（重命名 / 删除）</summary><div id="apCatsMgrBody"></div></details>`;
    box.innerHTML = h;
    box.querySelectorAll('[data-cat]').forEach(b => b.addEventListener('click', () => { filterCat = b.getAttribute('data-cat'); renderManage(box); }));
    box.querySelector('#apNew').addEventListener('click', () => { editingId = 0; renderForm(); });
    box.querySelectorAll('.apRow').forEach(row => {
      const id = Number(row.getAttribute('data-id'));
      row.querySelectorAll('[data-act]').forEach(b => b.addEventListener('click', ev => {
        ev.stopPropagation();
        rowAct(id, b.getAttribute('data-act'));
      }));
    });
    renderCatsMgr();
    if (editingId || box.querySelector('#apForm').dataset.open === '1') renderForm();
  }

  async function rowAct(id, act) {
    try {
      if (act === 'del') {
        const p = cache.find(x => Number(x.id) === id);
        if (!confirm('删除「' + ((p && p.title) || '') + '」？')) return;
        await api('/api/prompts/' + id, { method: 'DELETE' });
      } else if (act === 'edit') {
        editingId = id;
        document.querySelector('#apForm').dataset.open = '1';
      } else if (act === 'up' || act === 'down') {
        const ids = filtered().map(p => Number(p.id));
        const i = ids.indexOf(id);
        const j = act === 'up' ? i - 1 : i + 1;
        if (i < 0 || j < 0 || j >= ids.length) return;
        [ids[i], ids[j]] = [ids[j], ids[i]];
        // 只重排当前列表，其余保持原顺序缀在后面
        const rest = cache.map(p => Number(p.id)).filter(x => !ids.includes(x));
        await api('/api/prompts/order', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ids: ids.concat(rest) }) });
      }
      await load();
      renderBody();
    } catch (e) { toast(e.message); }
  }

  function renderForm() {
    const box = document.querySelector('#apForm');
    if (!box) return;
    box.dataset.open = '1';
    const p = editingId ? cache.find(x => Number(x.id) === editingId) : null;
    const cs = cats().map(([c]) => c);
    box.innerHTML = `<div class="apForm"><div class="apFTitle">${p ? '编辑' : '新建'}提示词</div>` +
      `<input id="apFT" placeholder="标题（列表里显示）" value="${esc((p && p.title) || '')}">` +
      `<input id="apFC" placeholder="分类（可新建，如：教程修改）" list="apCatList" value="${esc((p && p.category) || '')}">` +
      `<datalist id="apCatList">${cs.map(c => `<option value="${esc(c)}">`).join('')}</datalist>` +
      `<textarea id="apFX" rows="4" placeholder="提示词正文…"></textarea>` +
      `<div class="apFOps"><button class="btn small primary" id="apFSave">保存</button>` +
      `<button class="btn small" id="apFCancel">取消</button></div></div>`;
    box.querySelector('#apFX').value = (p && p.content) || '';
    box.querySelector('#apFCancel').addEventListener('click', () => { editingId = 0; box.dataset.open = ''; box.innerHTML = ''; });
    box.querySelector('#apFSave').addEventListener('click', async () => {
      const title = box.querySelector('#apFT').value.trim();
      const category = box.querySelector('#apFC').value.trim();
      const content = box.querySelector('#apFX').value.trim();
      if (!content) return toast('内容不能为空');
      try {
        if (p) await api('/api/prompts/' + p.id, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ title, category, content }) });
        else await api('/api/prompts', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ title, category, content }) });
        editingId = 0;
        box.dataset.open = '';
        await load();
        renderBody();
        toast('已保存');
      } catch (e) { toast(e.message); }
    });
    box.querySelector('#apFT').focus();
  }

  function renderCatsMgr() {
    const body = document.querySelector('#apCatsMgrBody');
    if (!body) return;
    const cs = cats();
    body.innerHTML = cs.length ? cs.map(([c, n]) =>
      `<div class="apCatRow"><span>${esc(c)}（${n}）</span><div class="spacer"></div>` +
      `<button class="btn tiny" data-cact="rename" data-c="${esc(c)}">改名</button>` +
      `<button class="btn tiny danger" data-cact="del" data-c="${esc(c)}">删除</button></div>`
    ).join('') : '<div class="muted">还没有分类（未分类的不显示在这里）</div>';
    body.querySelectorAll('[data-cact]').forEach(b => b.addEventListener('click', async () => {
      const c = b.getAttribute('data-c');
      try {
        if (b.getAttribute('data-cact') === 'rename') {
          const v = prompt('分类改名：', c);
          if (v == null) return;
          const name = String(v).trim().slice(0, 40);
          if (!name || name === c) return;
          await api('/api/prompt-categories/rename', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ old: c, new: name }) });
          if (filterCat === c) filterCat = name;
        } else {
          if (!confirm('删除分类「' + c + '」？名下提示词会移到“未分类”，内容不删除。')) return;
          await api('/api/prompt-categories/delete', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name: c }) });
          if (filterCat === c) filterCat = '';
        }
        await load();
        renderBody();
      } catch (e) { toast(e.message); }
    }));
  }

  timer = setInterval(ensure, 1000);
  ensure();

  SiErXing.registerPlugin({ id: 'aiprompts' });
})();
