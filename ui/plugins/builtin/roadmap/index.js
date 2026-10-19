'use strict';
/**
 * 内置 UI 插件 · 路线图页（#/g/:id/map）
 * ---------------------------------------------------------------------------
 * 原版路线图的实现**搬进插件**：DOM 结构 / CSS 类名 / 交互与改造前完全一致，
 * 所以外观像素级相同；同时这一页现在可以整页替换（用户插件同 id 覆盖）。
 *
 * 宿主注入的依赖见 mountRoadmap()：全部是原版同名函数的别名，行为不变。
 */
(function () {
  var H = null;

function subtreeProgress(node) {
  let total = 0, done = 0, doing = 0;
  const walk = n => {
    if (!n.children || !n.children.length) { total++; if (n.status === 'done') done++; else if (n.status === 'doing') doing++; return; }
    n.children.forEach(walk);
  };
  walk(node);
  return { total, done, doing };
}

function nodeOpen(key, def) {
  return H.state.expanded[key] != null ? H.state.expanded[key] : def;
}

function subgoalNodeHTML(g) {
  const key = 'g' + g.id;
  const open = nodeOpen(key, false);
  const p = subtreeProgress(g);
  const srcN = (g.sourcesArr || []).length;
  const sst = H.ST_LABEL[g.status] ? g.status : 'todo';
  return `<div class="mtitem" data-id="${g.id}">
    <div class="mtnode mtsub ${sst} ${open ? 'open' : ''}" data-node-id="${g.id}" data-detail="${g.id}" title="点击查看详情 · 右键打开菜单">
      <span class="arrow" data-childtoggle="${key}" title="${open ? '收起' : '展开'}子节点">${open ? '▾' : '▸'}</span>
      <span class="mtTitle">${H.esc(g.title)}</span>
      <span class="mtProg">${p.done}/${p.total}</span>
      ${srcN ? `<span class="srcBadge" data-detail="${g.id}" title="查看信息源">📎${srcN}</span>` : ''}
      <span class="nodeOps">
        <button class="btn tiny" data-expand="${g.id}" title="AI 深度拆分（先搜集资料再细化出任务）">✨</button>
        <button class="btn tiny" data-edit="${g.id}" title="编辑">✎</button>
        <button class="btn tiny danger" data-del="${g.id}" title="删除">×</button>
      </span>
    </div>
    <div class="mtbranch" style="display:${open ? 'flex' : 'none'}; flex-direction:column; align-items:stretch;">
      ${g.children.map(taskNodeHTML).join('')}
      <button class="btn small addChild" data-parent="${g.id}" data-level="2">＋ 任务</button>
    </div>
  </div>`;
}

function stageNodeHTML(st, si, activeStageId) {
  const key = 's' + st.id;
  const open = nodeOpen(key, st.id === activeStageId);
  const p = subtreeProgress(st);
  const srcN = (st.sourcesArr || []).length;
  const sst = H.ST_LABEL[st.status] ? st.status : 'todo';
  return `<div class="mtitem" data-id="${st.id}">
    <div class="mtnode mtstage ${sst} ${open ? 'open' : ''}" data-node-id="${st.id}" data-detail="${st.id}" title="点击查看详情 · 右键打开菜单">
      <span class="arrow" data-childtoggle="${key}" title="${open ? '收起' : '展开'}子节点">${open ? '▾' : '▸'}</span>
      <span class="stageIdx">${String(si + 1).padStart(2, '0')}</span>
      <span class="mtTitle">${H.esc(st.title)}</span>
      <span class="mtProg">${p.done}/${p.total}</span>
      ${srcN ? `<span class="srcBadge" data-detail="${st.id}" title="查看信息源">📎${srcN}</span>` : ''}
      <span class="nodeOps">
        <button class="btn tiny" data-expand="${st.id}" title="AI 深度拆分（先搜集资料再细化出小目标）">✨</button>
        <button class="btn tiny" data-edit="${st.id}" title="编辑">✎</button>
        <button class="btn tiny danger" data-del="${st.id}" title="删除">×</button>
      </span>
    </div>
    <div class="mtbranch" style="display:${open ? 'flex' : 'none'}; flex-direction:column; align-items:stretch;">
      ${st.children.map(subgoalNodeHTML).join('')}
      <button class="btn small addChild" data-parent="${st.id}" data-level="1">＋ 小目标</button>
    </div>
  </div>`;
}

function drawMapLines() {
  const tree = document.querySelector('.mtree');
  if (!tree) return;
  const old = tree.querySelector('.mtlines');
  if (old) old.remove();
  const scale = H.state.mapScale || 1;
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('class', 'mtlines');
  svg.setAttribute('width', String(tree.scrollWidth));
  svg.setAttribute('height', String(tree.scrollHeight));
  const tr = tree.getBoundingClientRect();
  const addPath = (parentNode, childEl) => {
    if (!parentNode || !childEl) return;
    const pr = parentNode.getBoundingClientRect();
    const cr = childEl.getBoundingClientRect();
    const x1 = (pr.right - tr.left) / scale;
    const y1 = (pr.top + pr.height / 2 - tr.top) / scale;
    const x2 = (cr.left - tr.left) / scale;
    const y2 = (cr.top + cr.height / 2 - tr.top) / scale;
    if (x2 <= x1) return;
    const dx = Math.max(24, (x2 - x1) * 0.55);
    const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
    path.setAttribute('d', `M ${x1} ${y1} C ${x1 + dx} ${y1}, ${x2 - dx} ${y2}, ${x2} ${y2}`);
    svg.appendChild(path);
  };
  const root = tree.querySelector('.mtnode-root');
  const pageBranch = tree.querySelector(':scope > .mtbranch');
  if (root && pageBranch) pageBranch.querySelectorAll(':scope > .mtitem > .mtnode').forEach(n => addPath(root, n));
  tree.querySelectorAll('.mtitem').forEach(item => {
    const branch = item.querySelector(':scope > .mtbranch');
    if (!branch || branch.style.display === 'none') return;
    const node = item.querySelector(':scope > .mtnode');
    if (!node) return;
    branch.querySelectorAll(':scope > .mtitem > .mtnode').forEach(child => addPath(node, child));
  });
  tree.appendChild(svg);
}
/* ===== 全屏导图页交互（拖拽 / 缩放） ===== */

function applyCanvasTransform() {
  const canvas = document.getElementById('mapCanvas');
  if (!canvas) return;
  canvas.style.transform = `translate(${H.state.mapTx}px, ${H.state.mapTy}px) scale(${H.state.mapScale})`;
  const z = document.getElementById('zoomPct');
  if (z) z.textContent = Math.round(H.state.mapScale * 100) + '%';
}

function zoomBy(f) {
  const vp = document.getElementById('mapViewport');
  if (!vp) return;
  const cx = vp.clientWidth / 2, cy = vp.clientHeight / 2;
  const old = H.state.mapScale;
  const next = Math.max(0.25, Math.min(2.5, old * f));
  H.state.mapTx = cx - (cx - H.state.mapTx) * (next / old);
  H.state.mapTy = cy - (cy - H.state.mapTy) * (next / old);
  H.state.mapScale = next;
  applyCanvasTransform();
  drawMapLines();
}

function mapFit() {
  const vp = document.getElementById('mapViewport');
  const tree = document.querySelector('.mtree');
  if (!vp || !tree) return;
  const vw = vp.clientWidth, vh = vp.clientHeight;
  const tw = Math.max(tree.scrollWidth, 1), th = Math.max(tree.scrollHeight, 1);
  /* 画布已按视口铺满（.mtree width:100%）：tw≈vw 时若仍按 (vw - tw*s)/2 平移，
     画布会被右推、右侧露出底色（用户反馈的灰色框）。铺满时只缩放、不平移。 */
  const fillsW = tw >= vw - 2;
  const fillsH = th >= vh - 2;
  const s = Math.min(1.1, fillsW ? 1.1 : (vw - 90) / tw, fillsH ? 1.1 : (vh - 90) / th);
  H.state.mapScale = Math.max(0.25, Math.min(1.6, s));
  H.state.mapTx = fillsW ? 0 : (vw - tw * H.state.mapScale) / 2;
  H.state.mapTy = fillsH ? 0 : (vh - th * H.state.mapScale) / 2;
  applyCanvasTransform();
  drawMapLines();
}

function bindMapTools() {
  const vp = document.getElementById('mapViewport');
  if (!vp) return;
  vp.addEventListener('mousedown', e => {
    if (e.button !== 0) return;
    H.state._drag = { sx: e.clientX, sy: e.clientY, ox: H.state.mapTx, oy: H.state.mapTy, moved: false };
    vp.classList.add('dragging');
  });
  vp.addEventListener('click', e => {
    if (H.state._suppressClick) { e.stopPropagation(); e.preventDefault(); H.state._suppressClick = false; }
  }, true);
  vp.addEventListener('wheel', e => {
    e.preventDefault();
    const rect = vp.getBoundingClientRect();
    const px = e.clientX - rect.left, py = e.clientY - rect.top;
    const old = H.state.mapScale;
    const next = Math.max(0.25, Math.min(2.5, old * (e.deltaY < 0 ? 1.12 : 0.9)));
    H.state.mapTx = px - (px - H.state.mapTx) * (next / old);
    H.state.mapTy = py - (py - H.state.mapTy) * (next / old);
    H.state.mapScale = next;
    applyCanvasTransform();
    drawMapLines();
  }, { passive: false });
  const zo = document.getElementById('zoomOut');
  if (zo) zo.addEventListener('click', () => zoomBy(0.85));
  const zi = document.getElementById('zoomIn');
  if (zi) zi.addEventListener('click', () => zoomBy(1.18));
  const zf = document.getElementById('zoomFit');
  if (zf) zf.addEventListener('click', () => mapFit());
  const fa = document.getElementById('foldAll');
  if (fa) fa.addEventListener('click', () => {
    H.state.goal.nodes.forEach(n => {
      if (n.level === 0) H.state.expanded['s' + n.id] = false;
      if (n.level === 1) H.state.expanded['g' + n.id] = false;
    });
    renderMapPage();
  });
  const ea = document.getElementById('expandAll');
  if (ea) ea.addEventListener('click', () => {
    H.state.goal.nodes.forEach(n => {
      if (n.level === 0) H.state.expanded['s' + n.id] = true;
      if (n.level === 1) H.state.expanded['g' + n.id] = true;
    });
    renderMapPage();
  });
  const mv = document.getElementById('mapVerBtn');
  if (mv) mv.addEventListener('click', () => H.showVersionsPanel(H.state.goal.id));
  const mc = document.getElementById('mapChatBtn');
  if (mc) mc.addEventListener('click', () => H.aiToggle(true));
  const mp = document.getElementById('mapPlanBtn');
  if (mp) mp.addEventListener('click', () => {
    const g = H.state.goal;
    if ((g.nodes || []).length && !confirm('重新规划会清空现有路径（含任务进度）后从头生成。\n\n只想微调阶段/小目标？用下面的「调整规划骨架」，不用推倒重来。\n\n确定要全部推倒重来吗？')) return;
    H.startClarify(g.id);
  });
  H.bindPlanPanel();
  H.bindReportCard();
  H.bindTutorialCard();
}

function renderMapPage() {
  const g = H.state.goal;
  if (!g) { H.app.innerHTML = '<p class="muted">目标不存在</p>'; return; }
  const stages = H.buildTree(g.nodes);
  const pct = g.tasks_total ? Math.round(g.tasks_done / g.tasks_total * 100) : 0;
  if (!stages.length) {
    H.app.innerHTML = `<div class="mapPage"><div class="mapToolbar"><button class="back" data-back="#/g/${g.id}">← 返回</button><span class="mapTitle">${H.esc(g.title)}</span></div>
      <div class="mapViewport" id="mapViewport"><div class="emptyBox" style="margin:90px auto; max-width:440px;">
        <div class="ebIcon">🧭</div><div class="ebTitle">还没有路径</div><div class="ebText">回到执行页开始 AI 规划，生成路径后再来看图。</div>
        <a class="btn primary" href="#/g/${g.id}">返回执行页</a>
      </div></div></div>`;
    return;
  }
  const activeStageId = (() => {
    for (const s of stages) { const p = subtreeProgress(s); if (p.done < p.total) return s.id; }
    return stages[0] ? stages[0].id : null;
  })();
  H.app.innerHTML = `<div class="mapPage">
    <div class="mapToolbar">
      <button class="back" data-back="#/g/${g.id}">← 返回执行页</button>
      <span class="mapTitle">${H.esc(g.title)}</span>
      <span class="chip gray">${g.tasks_done}/${g.tasks_total} · ${pct}%</span>
      <div class="spacer"></div>
      <span class="hint mapHint">左键拖拽平移 · 滚轮缩放 · 点击节点展开/详情</span>
      <button class="btn small" id="zoomOut" title="缩小">－</button>
      <span class="zoomPct" id="zoomPct">100%</span>
      <button class="btn small" id="zoomIn" title="放大">＋</button>
      <button class="btn small" id="zoomFit" title="适应屏幕">适应</button>
      <button class="btn small" id="foldAll">全部折叠</button>
      <button class="btn small" id="expandAll">全部展开</button>
      ${H.goalCompOn(H.state.goal, 'chat') ? '<button class="btn small" id="mapChatBtn">💬 AI 助手</button>' : ''}
      ${H.goalCompOn(H.state.goal, 'versions') ? '<button class="btn small" id="mapVerBtn">📜 版本对比</button>' : ''}
      <button class="btn small" id="mapPlanBtn" title="重新规划（会清空现有路径，请三思；微调骨架用下面的调整面板）">🧭 重新规划</button>
    </div>
    ${H.reportCardHTML()}
    ${H.tutorialCardHTML()}
    ${H.expandPanelHTML()}
    ${H.tutProgressHTML()}
    <div class="mapViewport" id="mapViewport">
      <div class="mapCanvas" id="mapCanvas">
        <div class="mtree">
          <div class="mtnode mtnode-root">
            <div class="mtRootName">${H.esc(g.title)}</div>
            <div class="mtRootStat">${g.tasks_done}/${g.tasks_total} 任务 · ${pct}%</div>
          </div>
          <div class="mtbranch" style="display:flex; flex-direction:column; align-items:stretch;">
            ${stages.map((s, i) => stageNodeHTML(s, i, activeStageId)).join('')}
          </div>
        </div>
      </div>
    </div>
  </div>`;
  bindTreeEvents(renderMapPage);
  bindMapTools();
  requestAnimationFrame(() => mapFit());
}
/* 把节点里 AI 写的依据名匹配到资料库真实条目（与服务端同策略：去前缀、去类型、逐级放宽） */

function bindTreeEvents(rerender) {
  const onUpdate = goal => { H.state.goal = goal; rerender(); };
  H.app.querySelectorAll('[data-childtoggle]').forEach(el => el.addEventListener('click', e => {
    e.stopPropagation();
    const key = el.getAttribute('data-childtoggle');
    const item = el.closest('.mtitem');
    const branch = item ? item.querySelector(':scope > .mtbranch') : null;
    if (!branch) return;
    const open = branch.style.display === 'none';
    branch.style.display = open ? 'flex' : 'none';
    el.textContent = open ? '▾' : '▸';
    const nd = item ? item.querySelector(':scope > .mtnode') : null;
    if (nd) nd.classList.toggle('open', open);
    H.state.expanded[key] = open;
    drawMapLines();
    /* 展开/收起改变树尺寸（实测 1190→817），必须重新适应屏幕，
       否则树贴左边、右侧留大片灰底。延后一帧等布局稳定。 */
    requestAnimationFrame(function () { try { mapFit(); } catch (e) {} });
  }));
  H.app.querySelectorAll('[data-expand]').forEach(btn => btn.addEventListener('click', e => {
    e.stopPropagation();
    H.startExpand(Number(btn.getAttribute('data-expand')));
  }));
  H.app.querySelectorAll('[data-toggle]').forEach(el => el.addEventListener('click', e => {
    if (e.target.closest('.nodeOps') || e.target.closest('.srcBadge')) return;
    const key = el.getAttribute('data-toggle');
    const item = el.closest('.mtitem');
    const branch = item ? item.querySelector(':scope > .mtbranch') : null;
    if (!branch) return;
    const open = branch.style.display === 'none';
    branch.style.display = open ? 'flex' : 'none';
    el.classList.toggle('open', open);
    const arrow = el.querySelector('.arrow');
    if (arrow) arrow.textContent = open ? '▾' : '▸';
    H.state.expanded[key] = open;
    drawMapLines();
    requestAnimationFrame(function () { try { mapFit(); } catch (e) {} });
  }));
  H.app.querySelectorAll('[data-detail]').forEach(el => el.addEventListener('click', e => {
    if (e.target.closest('button') || e.target.closest('[data-cycle]') || e.target.closest('.nodeOps')) return;
    H.showNodePanel(Number(el.getAttribute('data-detail')), rerender);
  }));
  H.app.querySelectorAll('[data-cycle]').forEach(btn => btn.addEventListener('click', async e => {
    e.stopPropagation();
    const id = Number(btn.getAttribute('data-cycle'));
    const n = H.state.goal.nodes.find(x => x.id === id);
    if (!n) return;
    const next = ST_NEXT[n.status] || 'todo';
    try {
      const r = await H.api('/api/nodes/' + id, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ status: next }) });
      onUpdate(r.goal);
      H.toast(next === 'done' ? '已完成 ✓' : next === 'doing' ? '进行中' : '已回到未开始');
    } catch (e) { H.toast(e.message); }
  }));
  H.app.querySelectorAll('[data-edit]').forEach(btn => btn.addEventListener('click', async e => {
    e.stopPropagation();
    const id = Number(btn.getAttribute('data-edit'));
    const n = H.state.goal.nodes.find(x => x.id === id);
    if (!n) return;
    const title = (prompt('标题：', n.title) || '').trim();
    if (!title) return;
    const d = window.prompt('说明（可留空）：', n.detail);
    if (d === null) return;
    try {
      const r = await H.api('/api/nodes/' + id, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ title, detail: d }) });
      onUpdate(r.goal);
    } catch (err) { H.toast(err.message); }
  }));
  H.app.querySelectorAll('[data-del]').forEach(btn => btn.addEventListener('click', async e => {
    e.stopPropagation();
    const id = Number(btn.getAttribute('data-del'));
    const n = H.state.goal.nodes.find(x => x.id === id);
    if (!n) return;
    if (!confirm('删除「' + n.title + '」' + (n.level < 2 ? '（含其下全部内容）' : '') + '？')) return;
    try {
      const r = await H.api('/api/nodes/' + id, { method: 'DELETE' });
      onUpdate(r.goal);
      H.toast('已删除');
    } catch (err) { H.toast(err.message); }
  }));
  H.app.querySelectorAll('.addChild').forEach(btn => btn.addEventListener('click', async () => {
    const parent = Number(btn.getAttribute('data-parent'));
    const title = (prompt('添加' + (btn.getAttribute('data-level') === '2' ? '任务' : '小目标') + '：') || '').trim();
    if (!title) return;
    try {
      const r = await H.api('/api/goals/' + H.state.goal.id + '/nodes', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ parent_id: parent, title }) });
      H.state.expanded['g' + parent] = true;
      H.state.expanded['s' + parent] = true;
      onUpdate(r.goal);
    } catch (err) { H.toast(err.message); }
  }));
  drawMapLines();
  /* 首次进入必须"适应屏幕"：原版在 rAF 里调 mapFit（等布局完成再算缩放）。
     漏掉这步会导致初始 transform 没设、树节点位置整体偏移几个像素。 */
  /* 等两帧再 fit：字体与布局在插件注入后可能还没稳定，
     只等一帧会差出 0.5px（实测 translate y 113.168 vs 113.662），
     整棵树随之错位。等两次 rAF 与原版时序一致。 */
  requestAnimationFrame(function () {
    requestAnimationFrame(function () { try { mapFit(); } catch (e) {} });
  });
  // 顶栏收藏栏：与教程页同一套（钉选 / 收藏夹 / 横向拖拽 / ⋯ 收纳）
  H.applyBarOverflow('goal');
}

  /**
   * 渲染路线图页。
   * host 需要提供：state / esc / buildTree / goalCompOn / api / toast /
   *   reportCardHTML / tutorialCardHTML / expandPanelHTML / tutProgressHTML /
   *   bindPlanPanel / bindReportCard / bindTutorialCard / showVersionsPanel /
   *   startClarify / aiToggle / showNodePanel / startExpand / applyBarOverflow / ST_LABEL
   */
  function mountRoadmap(host) {
    H = host || {};
    if (H.state) {
      /* 原版渲染依赖 state.goal；宿主负责在此之前把目标数据装好。 */
    }
    return {
      /* 原版 renderMapPage() 是同步的，仍然把返回值交出去 —— 宿主统一 await，
         将来它变成 async 也不会踩"页面收尾跑在渲染完成之前"的坑。 */
      render: function () { return renderMapPage(); },
      /* 路由离开时由宿主调用；本页没有常驻监听需要清理 */
      unmount: function () {}
    };
  }

  window.SXUIPlugin = window.SXUIPlugin || {};
  window.SXUIPlugin.roadmap = { id: 'roadmap', mount: mountRoadmap };
})();
