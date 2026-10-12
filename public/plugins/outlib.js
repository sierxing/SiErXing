'use strict';
/**
 * 思而行 · 前端扩展组件：产出库
 * ------------------------------------------------------------------
 * 侧边栏「📦 产出库」进这个页面。每个目标一个独立产出库，用文件夹目录树
 * 管理手动添加的产出文件：建文件夹、加文件、拖拽移动、排序、改名、删除、
 * 打包下载、图片/文本内嵌预览 —— 能对真实目录做的事这里都能做。
 */
(function () {
  const H = () => (window.SiErXing ? SiErXing : {});
  const app = () => H().app;
  const api = (p, o) => H().api(p, o);
  const esc = s => (H().esc ? H().esc(s) : String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])));
  const toast = m => { try { H().toast(m); } catch (e) { console.log(m); } };
  const go = h => { try { H().go(h); } catch (e) { location.hash = h; } };

  /* 非主题组件的 css 宿主不会自动挂（只有主题走 link[data-theme-style]），这里自己挂一次 */
  (function injectCss() {
    if (document.getElementById('ol-style')) return;
    const l = document.createElement('link');
    l.id = 'ol-style';
    l.rel = 'stylesheet';
    l.href = (typeof assetUrl === 'function' ? assetUrl('/plugins/outlib.css') : '/plugins/outlib.css');
    document.head.appendChild(l);
  })();

  /* 状态 */
  let gid = 0;           // 当前目标 id
  let curDir = 0;        // 当前目录 id（0 = 根）
  let tree = [];         // 当前目标的扁平节点
  let goals = [];
  let picked = 0;        // 选中的节点 id
  let editing = 0;       // 正在改名的节点 id
  let dragId = 0;
  let preview = null;    // {id,name,kind,mime}

  const byId = id => tree.find(n => n.id === id) || null;
  const kids = id => tree.filter(n => n.parent_id === id).sort((a, b) => (a.sort_order - b.sort_order) || (a.id - b.id));
  const isDir = n => n && n.kind === 'dir';

  function fmtSize(b) {
    b = Number(b || 0);
    if (b < 1024) return b + ' B';
    if (b < 1024 * 1024) return (b / 1024).toFixed(1) + ' KB';
    if (b < 1024 * 1024 * 1024) return (b / 1024 / 1024).toFixed(1) + ' MB';
    return (b / 1024 / 1024 / 1024).toFixed(2) + ' GB';
  }
  function dirStat(id) {
    let files = 0, bytes = 0;
    const walk = pid => kids(pid).forEach(c => {
      if (isDir(c)) walk(c.id); else { files++; bytes += Number(c.size || 0); }
    });
    walk(id);
    return { files, bytes };
  }
  function pathOf(id) {
    const chain = [];
    let n = byId(id);
    while (n) { chain.unshift(n); n = n.parent_id ? byId(n.parent_id) : null; }
    return chain;
  }

  /* ---------- 渲染 ---------- */
  function headHTML() {
    const opts = goals.map(g => `<option value="${g.id}"${g.id === gid ? ' selected' : ''}>${esc(g.title || ('目标 ' + g.id))}</option>`).join('');
    return `<div class="pageHead">
      <button class="back" data-go="#/">← 返回</button>
      <span class="mapTitle">📦 产出库</span>
      <span class="chip gray">目录化管理 · 每个目标独立</span>
      <div class="spacer"></div>
      ${goals.length ? `<select class="sxi-sel sxi-sel-sm" id="olGoalSel">${opts}</select>` : ''}
      <button class="btn small" id="olMkdir">＋ 新建文件夹</button>
      <button class="btn small primary" id="olAddFiles">＋ 添加产出</button>
    </div>`;
  }
  function crumbHTML() {
    const chain = pathOf(curDir);
    let h = `<span class="olCrumb"><span>产出库</span>`;
    chain.forEach((n, i) => {
      h += `<span class="olSep">›</span>`;
      h += i === chain.length - 1
        ? `<span class="olCur">${esc(n.name)}</span>`
        : `<a data-cd="${n.id}">${esc(n.name)}</a>`;
    });
    h += `</span>`;
    return h;
  }
  function sideHTML() {
    let h = `<div class="olSideTitle">目录</div><div class="olTree" id="olTree">`;
    h += `<div class="olNode${curDir === 0 ? ' sel' : ''}" data-cd="0" draggable="true" data-drag="0"><span class="olIc">🏠</span><span class="olNm">全部产出</span></div>`;
    const walk = pid => kids(pid).forEach(n => {
      if (!isDir(n)) return;
      const st = dirStat(n.id);
      h += `<div class="olNode${curDir === n.id ? ' sel' : ''}" data-cd="${n.id}" draggable="true" data-drag="${n.id}" data-folder="1" style="margin-left:${(pathOf(n.id).length - 1) * 12}px">
        <span class="olIc">📁</span><span class="olNm">${esc(n.name)}</span><span class="olCt">${st.files || ''}</span></div>`;
      walk(n.id);
    });
    walk(0);
    return h + `</div>`;
  }
  function rowHTML(n) {
    const dir = isDir(n);
    const st = dir ? dirStat(n.id) : null;
    /* 本机没有文件本体（多端同步没带过来 / 超大文件 / 别的设备上删过）：
       标出来并禁用下载，别让人点下去吃一个 404 才知道。 */
    const lost = !dir && n.has_file === false;
    const sizeTxt = lost ? '文件本体缺失' : (dir ? (st.files + ' 个文件 · ' + fmtSize(st.bytes)) : fmtSize(n.size));
    const canPrev = !lost && n.mime && /^image\/|^video\/|^audio\/|^text\/|application\/pdf/.test(n.mime);
    return `<div class="olRow${picked === n.id ? ' picked' : ''}${lost ? ' lost' : ''}" data-row="${n.id}" draggable="1" data-drag="${n.id}"${lost ? ' title="这条只有目录记录，文件本体没同步到本机（多端同步只传 20MB 以内的文件）"' : ' title="拖动可排序，拖到文件夹上可移进去"'}>
      <span class="olIc">${dir ? '📁' : (lost ? '⚠️' : '📄')}</span>
      ${editing === n.id
        ? `<input class="olIn" data-edit="${n.id}" value="${esc(n.name)}">`
        : `<span class="olNm" data-open="${n.id}">${esc(n.name)}</span>`}
      <span class="olMeta"><span>${sizeTxt}</span><span>${esc((n.updated_at || '').slice(0, 10))}</span></span>
      <span class="olOps">
        ${dir ? '' : (lost ? '' : `<button title="下载" data-dl="${n.id}">⬇</button>`)}
        ${!dir && canPrev ? `<button title="预览" data-pv="${n.id}">👁</button>` : ''}
        ${dir ? `<button title="打包下载" data-zip="${n.id}">🧩</button>` : ''}
        <button title="改名" data-rn="${n.id}">✏️</button>
        <button title="删除" class="danger" data-rm="${n.id}">🗑</button>
      </span>
    </div>`;
  }
  function listHTML() {
    const list = kids(curDir);
    if (!list.length) return `<div class="olEmpty"><div class="ebIcon">🗂</div><div>这里还没有产出。点右上角<b>「添加产出」</b>，把文件或文件夹拖进去（或点一下从电脑里选）。</div></div>`;
    return list.map(rowHTML).join('');
  }
  function previewHTML() {
    if (!preview) return '';
    const n = byId(preview.id);
    if (!n || isDir(n)) return '';
    const url = '/api/outlib/dl/' + n.id + '?inline=1';
    let body = '';
    if (/^image\//.test(n.mime)) body = `<img src="${url}" alt="">`;
    else if (/^video\//.test(n.mime)) body = `<video src="${url}" controls style="max-width:100%"></video>`;
    else if (/^audio\//.test(n.mime)) body = `<audio src="${url}" controls></audio>`;
    else if (/^text\/|json/.test(n.mime)) body = `<div class="muted">文本文件请点「⬇ 下载」查看，或用系统默认程序打开。</div>`;
    else body = `<div class="muted">此类型暂不支持内嵌预览，点「⬇ 下载」用本地程序打开。</div>`;
    return `<div class="olPreview"><div class="olPvHead">👁 ${esc(n.name)}<div class="spacer"></div><button class="btn tiny" id="olPvClose">关闭</button></div><div class="olPvBody">${body}</div></div>`;
  }
  function pageHTML() {
    return `<div class="page">${headHTML()}${crumbHTML()}
      <div class="olWrap">
        <div class="olSide">${sideHTML()}</div>
        <div class="olMain">
          <div class="olList" id="olList">${listHTML()}</div>
        </div>
      </div>
      ${previewHTML()}</div>`;
  }

  /* ---------- 数据 ---------- */
  async function loadGoals() {
    try {
      const r = await api('/api/goals');
      goals = (r && r.goals) || [];
    } catch (e) { goals = []; }
  }
  async function loadTree() {
    if (!gid) { tree = []; return; }
    try {
      const r = await api('/api/outlib/nodes/' + gid);
      tree = (r && r.nodes) || [];
    } catch (e) { tree = []; }
  }
  /* 每次重画后把 select.sxi-sel 换成自画下拉（插件自己替换 innerHTML，得自己再叫一次） */
  function polish() { try { if (window.sxiSelify) window.sxiSelify(document); } catch (e) {} }
  async function render(match) {
    const box = app();
    if (!box) return;
    if (match && match[1]) gid = Number(match[1]);
    if (!gid) {
      if (state && state.goal && state.goal.id) gid = state.goal.id;
      else { await loadGoals(); gid = goals.length ? goals[0].id : 0; }
    }
    if (!goals.length || !goals.some(g => g.id === gid)) await loadGoals();
    curDir = 0; picked = 0; editing = 0; preview = null; dragId = 0;
    await loadTree();
    box.innerHTML = pageHTML();
    polish();
    bind();
  }

  /* ---------- 动作 ---------- */
  async function post(p, body) { return api(p, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }); }
  async function refresh(keepDir) {
    const d = keepDir === false ? 0 : curDir;
    await loadTree();
    curDir = d && byId(d) ? d : 0;
    app().innerHTML = pageHTML();
    polish();
    bind();
  }
  async function mkdir() {
    const name = prompt('新建文件夹名字：', '新文件夹');
    if (name == null) return;
    try { await post('/api/outlib/dir', { goal_id: gid, parent_id: curDir, name }); await refresh(); }
    catch (e) { toast('新建失败：' + e.message); }
  }
  /* 上传进度遮罩：拖一整个文件夹进去可能要等，别让用户以为卡死 */
  function progress(title, cur, total, name) {
    let box = document.getElementById('olUp');
    if (!box) {
      box = document.createElement('div');
      box.id = 'olUp'; box.className = 'olUpload';
      box.innerHTML = '<div class="olUpCard"><h4 id="olUpT"></h4><div class="olBar2"><i id="olUpB"></i></div><div class="olUpTxt" id="olUpX"></div></div>';
      document.body.appendChild(box);
    }
    box.hidden = false;
    document.getElementById('olUpT').textContent = title;
    document.getElementById('olUpB').style.width = (total ? Math.round(cur / total * 100) : 0) + '%';
    document.getElementById('olUpX').textContent = name || '';
  }
  function progressDone() {
    const b = document.getElementById('olUp');
    if (b) b.remove();
  }

  /* 递归遍历一个拖入项（文件或文件夹），收集成 {file, rel} 列表。
     rel 是相对当前目录的子路径（如 "作品/a.png"），服务端据此还原目录结构。
     webkitGetAsEntry 是目前唯一能拿到文件夹层级的通用方式。 */
  async function readEntry(entry, prefix, out) {
    if (!entry) return;
    if (entry.isFile) {
      await new Promise(res => {
        entry.file(f => { if (f instanceof Blob) out.push({ file: f, rel: prefix }); res(); }, () => res());
      });
      return;
    }
    if (!entry.isDirectory) return;
    const reader = entry.createReader();
    const base = prefix + entry.name + '/';
    /* readEntries 一次最多返回 100 条，必须读到空数组才算读完 */
    for (;;) {
      const batch = await new Promise(res => {
        try { reader.readEntries(list => res(list || []), () => res([])); }
        catch (e) { res([]); }
      });
      if (!batch.length) break;
      for (const e of batch) await readEntry(e, base, out);
    }
  }

  /* 从 drop 事件收集文件与文件夹 */
  async function collectDrop(dt) {
    const out = [];
    const items = Array.from((dt && dt.items) || []);
    /* 必须先把所有 entry 同步取完：一旦 await 让出，浏览器就回收了
       DataTransfer，剩下的项 webkitGetAsEntry() 会全部返回 null。 */
    const entries = [];
    for (const it of items) {
      if (it.kind && it.kind !== 'file') continue;
      entries.push(it.webkitGetAsEntry ? it.webkitGetAsEntry() : null);
    }
    for (const en of entries) {
      if (en) await readEntry(en, '', out);
    }
    if (!out.length) {
      /* 一个都没拿到 entry（老浏览器 / 非文件源）：退回普通文件列表，退化成平铺 */
      for (const f of Array.from((dt && dt.files) || [])) {
        if (f instanceof Blob) out.push({ file: f, rel: '' });
      }
    }
    return out;
  }

  /* 两处入参形态不同：按钮选文件给的是裸 File，拖入给的是 {file, rel}。
     统一成 {file, rel} 再用，避免把包装对象当 Blob 传给 FileReader。 */
  async function addFiles(files) {
    const list = (files || []).map(x => (x && x.file instanceof Blob) ? x : { file: x, rel: '' })
      .filter(x => x.file instanceof Blob);
    if (!list.length) { toast('没有可添加的文件'); return; }
    /* 整批一次提交（共用一个 batch）：
       同一批里的文件会落进同一棵目录树，文件夹不会被拆散。
       超大文件夹自动分批上传，避免单个请求超过服务端体积上限。 */
    const BATCH_MAX = 12;
    let ok = 0, fail = 0, lastErr = '';
    const batch = 'b' + Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
    for (let s0 = 0; s0 < list.length; s0 += BATCH_MAX) {
      const chunk = list.slice(s0, s0 + BATCH_MAX);
      const payload = [];
      for (let k = 0; k < chunk.length; k++) {
        const it = chunk[k], f = it.file;
        progress('正在添加…', s0 + k, list.length, f.name + '（' + (s0 + k + 1) + '/' + list.length + '）');
        try {
          payload.push({ name: f.name, mime: f.type || '', data: await fileToBase64(f), rel: it.rel || '' });
        } catch (e) { fail++; lastErr = e.message; }
      }
      if (!payload.length) continue;
      try {
        const r = await post('/api/outlib/files', { goal_id: gid, parent_id: curDir, batch, files: payload });
        ok += (r && r.added && r.added.length) || payload.length;
      } catch (e) {
        /* 整批失败时逐个重试，好文件别被一个坏文件连累 */
        for (const p1 of payload) {
          try { await post('/api/outlib/files', { goal_id: gid, parent_id: curDir, batch, files: [p1] }); ok++; }
          catch (e2) { fail++; lastErr = e2.message; }
        }
      }
    }
    progressDone();
    if (ok) toast('已添加 ' + ok + ' 个文件' + (fail ? '，' + fail + ' 个失败' : ''));
    if (fail) toast('最后一个错误：' + lastErr);
    await refresh();
  }

  /* 拖入只在「添加产出」弹窗的拖放区里生效。
     之前挂在整页上会和列表里 draggable 条目的拖拽排序打架 ——
     列表一旦有条目，拖外部文件进来就没反应了。 */
  function isFileDrag(e) {
    return !!(e && e.dataTransfer && Array.from(e.dataTransfer.types || []).indexOf('Files') >= 0);
  }
  let dzDepth = 0;
  function bindDropZone(z) {
    if (!z) return;
    z.addEventListener('dragenter', e => {
      if (!isFileDrag(e)) return;
      e.preventDefault(); e.stopPropagation();
      dzDepth++; z.classList.add('over');
    });
    z.addEventListener('dragover', e => {
      if (!isFileDrag(e)) return;
      e.preventDefault(); e.stopPropagation();
      e.dataTransfer.dropEffect = 'copy';
    });
    z.addEventListener('dragleave', e => {
      e.stopPropagation();
      dzDepth = Math.max(0, dzDepth - 1);
      if (!dzDepth) z.classList.remove('over');
    });
    z.addEventListener('drop', async e => {
      if (!isFileDrag(e)) return;
      e.preventDefault(); e.stopPropagation();
      dzDepth = 0; z.classList.remove('over');
      const items = await collectDrop(e.dataTransfer);
      if (!items.length) { toast('没读到文件（可能是空文件夹，或浏览器不支持文件夹拖入）'); return; }
      closeAddModal();
      await addFiles(items);
    });
  }

  /* 「添加产出」弹窗：拖进来，或点一下从电脑里选文件 / 选整个文件夹 */
  function openAddModal() {
    closeAddModal();
    const m = document.createElement('div');
    m.id = 'olAddModal'; m.className = 'olModal';
    m.innerHTML = `<div class="olModalCard">
      <h4>添加产出</h4>
      <div class="olModalTip">加到：<b id="olAddWhere"></b></div>
      <div class="olDropZone" id="olDz">
        <div class="olDzIcon">📥</div>
        <div class="olDzMain">把文件或文件夹拖到这里</div>
        <div class="olDzSub">也可以点击这里，从电脑里选择</div>
      </div>
      <div class="olModalOps">
        <button class="btn small" id="olPickFile">📄 选择文件</button>
        <button class="btn small" id="olPickDir">📁 选择文件夹</button>
        <div class="spacer"></div>
        <button class="btn small" id="olAddCancel">取消</button>
      </div>
      <input type="file" id="olMFile" multiple hidden>
      <input type="file" id="olMDir" webkitdirectory hidden>
    </div>`;
    document.body.appendChild(m);
    const where = document.getElementById('olAddWhere');
    const cur = curDir ? byId(curDir) : null;
    if (where) where.textContent = (cur ? cur.name : '产出库根目录');

    const z = document.getElementById('olDz');
    bindDropZone(z);
    /* 点拖放区 = 选文件；下方另有「选择文件夹」按钮 */
    if (z) z.addEventListener('click', () => { const i = document.getElementById('olMFile'); if (i) i.click(); });
    const cancel = document.getElementById('olAddCancel');
    if (cancel) cancel.addEventListener('click', closeAddModal);
    m.addEventListener('click', e => { if (e.target === m) closeAddModal(); });   // 点遮罩关闭

    const mf = document.getElementById('olMFile');
    if (mf) mf.addEventListener('change', () => {
      const list = Array.from(mf.files || []);
      closeAddModal();
      addFiles(list);
    });
    /* 选整个文件夹：webkitdirectory 给的每个文件都带 webkitRelativePath，
       去掉第一段（根文件夹名）当 rel 传上去，目录结构就能原样还原 */
    const md = document.getElementById('olMDir');
    if (md) md.addEventListener('change', () => {
      const list = Array.from(md.files || []).map(f => {
        const rel = String(f.webkitRelativePath || '');
        const parts = rel.split('/').filter(Boolean);
        return { file: f, rel: parts.slice(1).join('/') };
      });
      closeAddModal();
      addFiles(list);
    });
    const pf = document.getElementById('olPickFile');
    if (pf) pf.addEventListener('click', () => { const i = document.getElementById('olMFile'); if (i) i.click(); });
    const pd = document.getElementById('olPickDir');
    if (pd) pd.addEventListener('click', () => { const i = document.getElementById('olMDir'); if (i) i.click(); });
  }
  function closeAddModal() {
    const m = document.getElementById('olAddModal');
    if (m) m.remove();
  }
  function fileToBase64(file) {
    return new Promise((resolve, reject) => {
      const fr = new FileReader();
      fr.onload = () => resolve(String(fr.result || '').split(',')[1] || '');
      fr.onerror = () => reject(new Error('读取文件失败'));
      fr.readAsDataURL(file);
    });
  }
  function openNode(id) {
    const n = byId(id);
    if (!n) return;
    if (isDir(n)) { curDir = id; picked = 0; preview = null; refresh(); }
    else showPreview(id);
  }
  async function showPreview(id) {
    const n = byId(id);
    if (!n) return;
    preview = { id, name: n.name };
    app().innerHTML = pageHTML();
    polish();
    bind();
    const close = document.getElementById('olPvClose');
    if (close) close.addEventListener('click', () => { preview = null; app().innerHTML = pageHTML(); polish(); bind(); });
  }
  function dl(id) { location.href = '/api/outlib/dl/' + id; }
  function zip(id) { location.href = '/api/outlib/zip/' + id; }
  async function rename(id) {
    const n = byId(id);
    if (!n) return;
    const name = prompt('改名为：', n.name);
    if (name == null || !name.trim() || name === n.name) return;
    try { await post('/api/outlib/rename', { id, name: name.trim() }); await refresh(); }
    catch (e) { toast('改名失败：' + e.message); }
  }
  async function remove(id) {
    const n = byId(id);
    if (!n) return;
    const extra = isDir(n) ? '（里面的文件也会一起删掉）' : '';
    if (!confirm('删除「' + n.name + '」？' + extra)) return;
    try { await post('/api/outlib/delete', { id }); if (preview && preview.id === id) preview = null; await refresh(); }
    catch (e) { toast('删除失败：' + e.message); }
  }
  async function moveTo(id, parentId) {
    if (!id) return;
    try { await post('/api/outlib/move', { id, parent_id: parentId }); await refresh(); }
    catch (e) { toast('移动失败：' + e.message); }
  }
  /* 拖拽排序的落点：把 moving 插到 tid 之前/之后（或末尾）后提交新顺序 */
  let dropTargetId = 0, dropPos = '';
  function clearDropHint(list) {
    (list || app()).querySelectorAll('.dropBefore,.dropAfter,.dropInto')
      .forEach(r => r.classList.remove('dropBefore', 'dropAfter', 'dropInto'));
  }
  async function finishReorder(movingId, beforeOrAfterId, pos) {
    const sibs = kids(curDir).filter(n => n.id !== movingId).map(n => n.id);
    let idx = sibs.length;                       // 默认放末尾
    if (beforeOrAfterId && pos !== 'end') {
      const at = sibs.indexOf(beforeOrAfterId);
      if (at >= 0) idx = pos === 'before' ? at : at + 1;
    }
    sibs.splice(idx, 0, movingId);
    await reorderInDir(curDir, sibs);
    // 本地树立刻按新顺序排，界面马上跟上（服务端已持久化）
    const order = new Map(sibs.map((id, i) => [id, i * 1000]));
    tree.forEach(n => { if (order.has(n.id)) n.sort_order = order.get(n.id); });
    refresh();
  }
  async function reorderInDir(parentId, orderedIds) {
    try { await post('/api/outlib/order', { parent_id: parentId, ids: orderedIds }); }
    catch (e) { toast('排序失败：' + e.message); }
  }
  /* ---------- 右键菜单 ---------- */
  function closeMenu() {
    document.querySelectorAll('.olMenu').forEach(m => m.remove());
  }
  function showMenu(x, y, items) {
    closeMenu();
    const m = document.createElement('div');
    m.className = 'olMenu';
    m.innerHTML = items.map(it => {
      if (it === '-') return '<div class="olMsep"></div>';
      return `<button data-act="${esc(it.act)}" class="${it.danger ? 'danger' : ''}"${it.disabled ? ' disabled' : ''}>${it.icon || ''}<span>${esc(it.label)}</span></button>`;
    }).join('');
    document.body.appendChild(m);
    const r = m.getBoundingClientRect();
    m.style.left = Math.max(6, Math.min(x, window.innerWidth - r.width - 6)) + 'px';
    m.style.top = Math.max(6, Math.min(y, window.innerHeight - r.height - 6)) + 'px';
    m.addEventListener('click', e => {
      const b = e.target.closest('[data-act]');
      if (!b || b.disabled) return;
      closeMenu();
      const it = items.find(v => v !== '-' && v.act === b.getAttribute('data-act'));
      if (it && it.run) it.run();
    });
  }
  function wireMenuDismiss() {
    if (wireMenuDismiss._done) return;
    wireMenuDismiss._done = 1;
    setTimeout(() => {
      document.addEventListener('click', closeMenu);
      document.addEventListener('contextmenu', e => { if (!e.target.closest('.olMenu')) closeMenu(); });
      document.addEventListener('scroll', closeMenu, true);
      window.addEventListener('resize', closeMenu);
    }, 0);
  }
  function rowMenu(e, id) {
    const n = byId(id);
    if (!n) return;
    e.preventDefault();
    const dir = isDir(n);
    picked = id;
    const b0 = app();
    if (b0) b0.querySelectorAll('.olRow').forEach(r => r.classList.toggle('picked', r.getAttribute('data-row') === String(id)));
    showMenu(e.clientX, e.clientY, [
      { act: 'open', icon: dir ? '📂' : '👁', label: dir ? '打开' : '预览', run: () => openNode(id) },
      ...(dir ? [] : [{ act: 'dl', icon: '⬇', label: '下载', run: () => dl(id) }]),
      ...(dir ? [{ act: 'zip', icon: '🧩', label: '打包下载', run: () => zip(id) }] : []),
      '-',
      { act: 'rn', icon: '✏️', label: '重命名', run: () => rename(id) },
      { act: 'mv', icon: '↔️', label: '移动到…', run: () => movePicker(id) },
      '-',
      { act: 'rm', icon: '🗑', label: dir ? '删除文件夹' : '删除', danger: true, run: () => remove(id) }
    ]);
    wireMenuDismiss();
  }
  function dirMenu(e) {
    e.preventDefault();
    showMenu(e.clientX, e.clientY, [
      { act: 'af', icon: '📥', label: '添加产出…', run: openAddModal },
      { act: 'md', icon: '＋', label: '新建文件夹', run: mkdir },
      '-',
      { act: 'zg', icon: '🧩', label: '打包下载本目标', run: zipGoal }
    ]);
    wireMenuDismiss();
  }

  /* ---------- 移动到…：挑目标文件夹 ---------- */
  function movePicker(id) {
    const n = byId(id);
    if (!n) return;
    const bad = new Set([id]);
    if (isDir(n)) (function mark(pid) {
      kids(pid).forEach(c => { bad.add(c.id); if (isDir(c)) mark(c.id); });
    })(id);
    const opt = (nid, label, depth) => {
      if (bad.has(nid)) return '';
      return `<option value="${nid}"${nid === n.parent_id ? ' selected' : ''}>${'\u3000'.repeat(depth)}${esc(label)}</option>`;
    };
    let opts = `<option value="0"${n.parent_id === 0 ? ' selected' : ''}>📦 产出库根目录</option>`;
    (function walk(pid, depth) {
      kids(pid).forEach(c => { if (isDir(c)) { opts += opt(c.id, '📁 ' + c.name, depth + 1); walk(c.id, depth + 1); } });
    })(0, 0);
    const m = document.createElement('div');
    m.id = 'olMoveModal'; m.className = 'olModal';
    m.innerHTML = `<div class="olModalCard" style="width:min(420px,94vw)">
      <h4>移动「${esc(n.name)}」</h4>
      <div class="olModalTip">选一个目标文件夹</div>
      <select id="olMoveSel" style="width:100%;padding:8px;border:1px solid var(--border);border-radius:var(--r-sm);background:var(--bg);color:var(--text);font-size:13px;margin-bottom:4px;">${opts}</select>
      <div class="olModalOps"><div class="spacer"></div>
        <button class="btn small" id="olMoveCancel">取消</button>
        <button class="btn small primary" id="olMoveOk">移动到这里</button>
      </div>
    </div>`;
    document.body.appendChild(m);
    const close = () => { const x = document.getElementById('olMoveModal'); if (x) x.remove(); };
    document.getElementById('olMoveCancel').addEventListener('click', close);
    m.addEventListener('click', e => { if (e.target === m) close(); });
    document.getElementById('olMoveOk').addEventListener('click', async () => {
      const to = Number(document.getElementById('olMoveSel').value) || 0;
      close();
      if (to === n.parent_id) { toast('已经在那个文件夹里了'); return; }
      await moveTo(id, to);
    });
  }
  function zipGoal() {
    location.href = '/api/outlib/zip/goal/' + gid;
  }

  /* ---------- 事件 ---------- */
  function bind() {
    const box = app();
    if (!box) return;

    box.querySelectorAll('[data-cd]').forEach(el => el.addEventListener('click', () => {
      curDir = Number(el.getAttribute('data-cd')) || 0; picked = 0; preview = null; refresh();
    }));
    const sel = document.getElementById('olGoalSel');
    if (sel) sel.addEventListener('change', () => { gid = Number(sel.value) || 0; go('#/outlib/' + gid); });
    const mk = document.getElementById('olMkdir');
    if (mk) mk.addEventListener('click', mkdir);
    const add = document.getElementById('olAddFiles');
    if (add) add.addEventListener('click', openAddModal);

    box.querySelectorAll('[data-open]').forEach(el => el.addEventListener('click', () => openNode(Number(el.getAttribute('data-open')))));
    box.querySelectorAll('[data-dl]').forEach(el => el.addEventListener('click', () => dl(Number(el.getAttribute('data-dl')))));
    box.querySelectorAll('[data-zip]').forEach(el => el.addEventListener('click', () => zip(Number(el.getAttribute('data-zip')))));
    box.querySelectorAll('[data-pv]').forEach(el => el.addEventListener('click', () => showPreview(Number(el.getAttribute('data-pv')))));
    box.querySelectorAll('[data-rn]').forEach(el => el.addEventListener('click', () => rename(Number(el.getAttribute('data-rn')))));
    box.querySelectorAll('[data-rm]').forEach(el => el.addEventListener('click', () => remove(Number(el.getAttribute('data-rm')))));

    const list = document.getElementById('olList');
    if (list) {
      list.addEventListener('click', e => {
        const row = e.target.closest('[data-row]');
        if (row) { picked = Number(row.getAttribute('data-row')) || 0; box.querySelectorAll('.olRow').forEach(r => r.classList.toggle('picked', r === row)); }
      });
      /* 右键：文件/文件夹 → 该条目的操作菜单；空白处 → 本目录能做的事 */
      list.addEventListener('contextmenu', e => {
        const row = e.target.closest('[data-row]');
        if (row) rowMenu(e, Number(row.getAttribute('data-row')) || 0);
        else dirMenu(e);
      });
      /* 双击空白 = 添加产出 */
      list.addEventListener('dblclick', e => { if (!e.target.closest('[data-row]')) openAddModal(); });
      /* 拖已有条目：同目录内排序（上/下插入），或拖进某个文件夹。
         文件拖入是另一套（在弹窗里），这里用 isFileDrag 区分开。 */
      list.addEventListener('dragstart', e => {
        if (isFileDrag(e)) return;
        const row = e.target.closest('[data-row]');
        if (!row) return;
        dragId = Number(row.getAttribute('data-row')) || 0;
        row.classList.add('dragging');
        try { e.dataTransfer.setData('text/plain', String(dragId)); } catch (err) {}
        e.dataTransfer.effectAllowed = 'move';
      });
      list.addEventListener('dragend', () => {
        clearDropHint(list);
        const d = list.querySelector('.dragging'); if (d) d.classList.remove('dragging');
        dragId = 0;
      });
      list.addEventListener('dragover', e => {
        if (isFileDrag(e)) return;
        const row = e.target.closest('[data-row]');
        clearDropHint(list);
        if (!dragId) return;
        e.preventDefault();
        e.dataTransfer.dropEffect = 'move';
        if (!row) return;                    // 空白处：放到本目录末尾
        const rid = Number(row.getAttribute('data-row')) || 0;
        if (rid === dragId) return;
        const n = byId(rid);
        const r = row.getBoundingClientRect();
        const ratio = (e.clientY - r.top) / (r.height || 1);
        /* 文件夹中间 → 移进去；其余按上半/下半 → 插到它前面/后面 */
        if (n && isDir(n) && ratio > 0.25 && ratio < 0.75) row.classList.add('dropInto');
        else row.classList.add(ratio < 0.5 ? 'dropBefore' : 'dropAfter');
        dropTargetId = rid;
        dropPos = (n && isDir(n) && ratio > 0.25 && ratio < 0.75) ? 'into' : (ratio < 0.5 ? 'before' : 'after');
      });
      list.addEventListener('drop', e => {
        if (isFileDrag(e)) return;          // 拖文件进列表无效，交由弹窗处理
        e.preventDefault();
        const row = e.target.closest('[data-row]');
        const pos = dropPos, tid = dropTargetId;
        clearDropHint(list);
        if (!dragId) return;
        const d = list.querySelector('.dragging'); if (d) d.classList.remove('dragging');
        const moving = dragId;
        dragId = 0; dropTargetId = 0; dropPos = '';
        if (!row) { finishReorder(moving, 0, 'end'); return; }   // 空白 → 末尾
        if (pos === 'into') { moveTo(moving, tid); return; }
        if (!tid || tid === moving) return;
        finishReorder(moving, tid, pos);
      });
    }
    /* 侧边目录树：拖到目录上移动；右键目录 → 该文件夹的操作菜单 */
    box.querySelectorAll('[data-drag]').forEach(el => {
      el.addEventListener('dragover', e => { if (isFileDrag(e)) return; if (el.hasAttribute('data-folder')) { e.preventDefault(); el.classList.add('drop'); } });
      el.addEventListener('dragleave', () => el.classList.remove('drop'));
      el.addEventListener('drop', e => { el.classList.remove('drop'); if (isFileDrag(e)) return; if (el.hasAttribute('data-folder') && dragId) { e.preventDefault(); moveTo(dragId, Number(el.getAttribute('data-cd')) || 0); } });
      el.addEventListener('contextmenu', e => {
        const fid = Number(el.getAttribute('data-cd')) || 0;
        if (!fid) return;                       // 「全部产出」是虚拟根，不给条目菜单
        e.preventDefault(); e.stopPropagation();
        rowMenu(e, fid);
      });
    });
  }

  /* ---------- 注册：侧边栏 #/outlib 与 #/outlib/<目标> ---------- */
  const H_ = SiErXing;
  if (H_ && H_.registerPlugin) {
    H_.registerPlugin({
      id: 'outlib',
      routes: [
        { match: h => h.match(/^#\/outlib\/(\d+)$/), render: (m) => render(m) },
        { match: h => /^#\/outlib$/.test(h), render: () => render(null) }
      ]
    });
  }
})();