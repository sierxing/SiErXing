'use strict';
/**
 * 内置 UI 插件 · 版本管理页（#/g/:id/versions）
 * ---------------------------------------------------------------------------
 * 本文件由 scripts/build-page-plugin.js 生成，**不要直接改这里**：
 *   要改就改 public/app.js 里的原版实现，然后重新跑构建。
 *
 * 实现逐字来自原版 render* 及其依赖闭包（只把全局依赖改为 host 注入），
 * 因此 DOM 结构 / CSS 类名 / 交互与原版一致 —— 外观像素级相同。
 * 用户可在 DATA_DIR/ui-plugins/versions/ 放同名插件整页覆盖。
 */
(function () {
  var H = null;

/* 版本条目（面板与管理页共用） */
function versionItemHTML(v, goalId) {
  return `<div class="vpItem" data-vid="${v.id}">
    <div class="vpTop"><button class="vpStar ${Number(v.starred) ? 'on' : ''}" data-vp-star="${v.id}" title="${Number(v.starred) ? '已收藏（再点取消）' : '收藏这一版，方便找回'}">${Number(v.starred) ? '★' : '☆'}</button>${Number(v.manual) ? '<span class="chip ok">📌 手动保存</span>' : ''}<span class="chip gray">${H.esc(v.reason || '变更')}</span><span class="hint">${H.fmtDate(v.created_at)}</span></div>
    ${v.summary ? `<div class="vpSummary">${H.mdOneLine(v.summary)}</div>` : '<div class="vpSummary muted">（无汇报）</div>'}
    <div class="vpOps"><a class="btn small" href="#/g/${goalId}/diff/${v.id}">查看对比图</a><button class="btn small danger" data-vp-restore="${v.id}" title="先自动存档当前，再整体回到这一版（含任务进度状态）">恢复到此版</button></div>
  </div>`;
}

/* 版本条目按钮绑定（面板/管理页共用；after 为操作成功后的刷新回调） */
function bindVersionItems(root, goalId, after) {
  const rerun = after || (() => {});
  const sv = root.querySelector('#vpSave');
  if (sv) sv.addEventListener('click', async () => {
    const name = (prompt('给这版方案起个名（例如：偏实战版 / 保守版）：', '') || '').trim();
    if (!name) return;
    sv.disabled = true;
    try {
      await H.api('/api/goals/' + goalId + '/versions', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name }) });
      H.toast('已保存方案「' + name + '」，重新规划弄丢了也能找回来');
      rerun();
    } catch (e) { H.toast(e.message); sv.disabled = false; }
  });
  root.querySelectorAll('[data-vp-star]').forEach(b => b.addEventListener('click', async e => {
    e.stopPropagation();
    const vid = b.getAttribute('data-vp-star');
    const on = !b.classList.contains('on');
    try {
      await H.api('/api/versions/' + vid + '/star', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ starred: on }) });
      H.toast(on ? '已收藏' : '已取消收藏');
      rerun();
    } catch (err) { H.toast(err.message); }
  }));
  root.querySelectorAll('[data-vp-restore]').forEach(b => b.addEventListener('click', async () => {
    const vid = b.getAttribute('data-vp-restore');
    if (!confirm('恢复到这一版？\n\n当前方案会先自动存档（还可再 undo），然后节点（含任务进度状态）整体替换。\n教程按原节点关联，恢复后旧教程可能对不上新节点 id。')) return;
    b.disabled = true;
    try {
      const r = await H.api('/api/versions/' + vid + '/restore', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
      H.state.goal = r.goal;
      try { await H.loadGoal(goalId); } catch (e) {}
      const pnl = document.getElementById('versionsPanel');
      if (pnl) pnl.remove();
      H.rerenderCurrent();
      H.renderRail();
      H.toast('已恢复到该版本');
    } catch (e) { H.toast(e.message); b.disabled = false; }
  }));
}

async function renderVersionsPage(gid) {
  const g = H.state.goal;
  H.app.innerHTML = '<p class="muted">加载版本历史…</p>';
  const { versions } = await H.api('/api/goals/' + gid + '/versions');
  const f = H.state.verFilter || 'all';
  const counts = { all: versions.length, star: versions.filter(v => Number(v.starred)).length, manual: versions.filter(v => Number(v.manual)).length };
  const list = versions.filter(v => f === 'star' ? Number(v.starred) : f === 'manual' ? Number(v.manual) : true);
  H.app.innerHTML = `<div class="page"><div class="pageHead">
      <button class="back js-back" data-go="#/g/${gid}">← 返回目标</button>
      <h2 class="title" style="margin-left:10px;">📜 版本管理</h2>
      <span class="chip gray">${H.esc((g && g.title) || '')}</span>
      <div class="spacer"></div>
      <button class="btn small primary" id="vpSave">📌 保存当前方案</button>
    </div>
    <div class="sec"><div class="ppCats" id="verFilter">
      <button type="button" class="ppCat ${f === 'all' ? 'active' : ''}" data-vf="all">全部（${counts.all}）</button>
      <button type="button" class="ppCat ${f === 'star' ? 'active' : ''}" data-vf="star">⭐ 已收藏（${counts.star}）</button>
      <button type="button" class="ppCat ${f === 'manual' ? 'active' : ''}" data-vf="manual">📌 手动保存（${counts.manual}）</button>
    </div>
    <p class="hint">每次规划/调整/拆分自动存档；看中的版本点 ☆ 收藏；恢复前会自动存档当前，可再 undo。</p></div>
    <div class="sec"><div class="vpGrid">${list.length ? list.map(v => versionItemHTML(v, gid)).join('') : '<div class="muted">这里还没有版本。</div>'}</div></div>
  </div>`;
  H.app.querySelectorAll('#verFilter [data-vf]').forEach(b => b.addEventListener('click', () => { H.state.verFilter = b.getAttribute('data-vf'); renderVersionsPage(gid); }));
  bindVersionItems(app, gid, () => renderVersionsPage(gid));
}

  function mountVersions(host) {
    H = host || {};
    return {
      render: function () { return renderVersionsPage(H.__gid); },
      unmount: function () {}
    };
  }

  window.SXUIPlugin = window.SXUIPlugin || {};
  window.SXUIPlugin['versions'] = { id: 'versions', mount: mountVersions };
})();
