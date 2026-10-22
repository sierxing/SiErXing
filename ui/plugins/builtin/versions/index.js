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
    <div class="vpTop"><button class="vpStar ${Number(v.starred) ? 'on' : ''}" data-vp-star="${v.id}" title="${Number(v.starred) ? tr('已收藏（再点取消）') : tr('收藏这一版，方便找回')}">${Number(v.starred) ? '★' : '☆'}</button>${Number(v.manual) ? '<span class="chip ok">📌 ' + H.esc(tr('手动保存')) + '</span>' : ''}<span class="chip gray">${H.esc(v.reason || tr('变更'))}</span><span class="hint">${H.fmtDate(v.created_at)}</span></div>
    ${v.summary ? `<div class="vpSummary">${H.mdOneLine(v.summary)}</div>` : `<div class="vpSummary muted">${H.esc(tr('（无汇报）'))}</div>`}
    <div class="vpOps"><a class="btn small" href="#/g/${goalId}/diff/${v.id}">${H.esc(tr('查看对比图'))}</a><button class="btn small" data-vp-toplan="${v.id}" title="${H.esc(tr('把这个版本单独存成一份方案，不动当前路径'))}">＋ ${H.esc(tr('存成方案'))}</button><button class="btn small danger" data-vp-restore="${v.id}" title="${H.esc(tr('先自动存档当前，再整体回到这一版（含任务进度状态）'))}">${H.esc(tr('恢复到此版'))}</button></div>
  </div>`;
}

/* 版本条目按钮绑定（面板/管理页共用；after 为操作成功后的刷新回调） */
function bindVersionItems(root, goalId, after) {
  const rerun = after || (() => {});
  const sv = root.querySelector('#vpSave');
  if (sv) sv.addEventListener('click', async () => {
    const name = (prompt(tr('给这个方案起个名（例如：偏实战版 / 保守版）：'), '') || '').trim();
    if (!name) return;
    sv.disabled = true;
    try {
      await H.api('/api/goals/' + goalId + '/versions', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name }) });
      H.toast(tr('已存为新方案「{0}」，可在「🗂 方案」里切换', name));
      rerun();
    } catch (e) { H.toast(e.message); sv.disabled = false; }
  });
  root.querySelectorAll('[data-vp-star]').forEach(b => b.addEventListener('click', async e => {
    e.stopPropagation();
    const vid = b.getAttribute('data-vp-star');
    const on = !b.classList.contains('on');
    try {
      await H.api('/api/versions/' + vid + '/star', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ starred: on }) });
      H.toast(on ? tr('已收藏') : tr('已取消收藏'));
      rerun();
    } catch (err) { H.toast(err.message); }
  }));
  root.querySelectorAll('[data-vp-toplan]').forEach(b => b.addEventListener('click', async e => {
    e.stopPropagation();
    const vid = b.getAttribute('data-vp-toplan');
    const name = (prompt(tr('给这份新方案起个名（会把这一版复制成一份独立方案）'), tr('方案 · 版本 {0}', vid)) || '').trim();
    if (!name) return;
    try {
      const r = await H.api('/api/versions/' + vid + '/to-plan', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name }) });
      H.toast(tr('已存成新方案「{0}」（{1} 个节点），可在「🗂 方案」里切换', r.name, r.nodes));
      rerun();
    } catch (err) { H.toast(err.message || tr('保存失败')); }
  }));
  root.querySelectorAll('[data-vp-restore]').forEach(b => b.addEventListener('click', async () => {
    const vid = b.getAttribute('data-vp-restore');
    if (!confirm(tr('恢复到这一版？\n\n当前方案会先自动存档（还可再 undo），然后节点（含任务进度状态）整体替换。\n教程按原节点关联，恢复后旧教程可能对不上新节点 id。'))) return;
    b.disabled = true;
    try {
      const r = await H.api('/api/versions/' + vid + '/restore', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
      H.state.goal = r.goal;
      try { await H.loadGoal(goalId); } catch (e) {}
      const pnl = document.getElementById('versionsPanel');
      if (pnl) pnl.remove();
      H.rerenderCurrent();
      H.renderRail();
      H.toast(tr('已恢复到该版本'));
    } catch (e) { H.toast(e.message); b.disabled = false; }
  }));
}

async function renderVersionsPage(gid) {
  if (H.versionsVueEnabled() && await H.renderVersionsVue(gid)) return;
  const g = H.state.goal;
  H.app.innerHTML = '<p class="muted">' + H.esc(tr('加载版本历史…')) + '</p>';
  const data = await H.api('/api/goals/' + gid + '/versions');
  const versions = data.versions || [];
  const curPlan = data.plan || { id: 0, name: tr('主方案') };
  const plans = data.plans || [];
  const otherPlans = plans.filter(p => !p.active);
  const f = H.state.verFilter === 'star' ? 'star' : 'all';
  const counts = { all: versions.length, star: versions.filter(v => Number(v.starred)).length };
  const list = f === 'star' ? versions.filter(v => Number(v.starred)) : versions;
  H.app.innerHTML = `<div class="page"><div class="pageHead">
      <button class="back js-back" data-go="#/g/${gid}">← ${H.esc(tr('返回目标'))}</button>
      <h2 class="title" style="margin-left:10px;">📜 ${H.esc(tr('版本管理'))}</h2>
      <span class="chip gray">${H.esc((g && g.title) || '')}</span>
      <div class="spacer"></div>
      <button class="btn small" id="vpBlank">＋ ${H.esc(tr('新建空白方案'))}</button>
      <button class="btn small primary" id="vpSave">📌 ${H.esc(tr('存为新方案'))}</button>
    </div>
    <div class="sec"><div class="planVerBar"><span class="hint">${H.esc(tr('当前方案：'))}</span><b>${H.esc(curPlan.name)}</b>
      ${otherPlans.map(p => `<button class="btn small" data-plan-switch="${p.planId}" data-plan-name="${H.esc(p.name)}">${H.esc(tr('切换到「{0}」（{1} 个节点）', p.name, p.nodes))}</button>`).join('')}
      ${otherPlans.length ? '' : `<span class="hint">${H.esc(tr('还没有其他方案；点「＋ 新建空白方案」，或把下面任一历史版本「存成方案」。'))}</span>`}
    </div></div>
    <div class="sec"><div class="ppCats" id="verFilter">
      <button type="button" class="ppCat ${f === 'all' ? 'active' : ''}" data-vf="all">${H.esc(tr('全部（{0}）', counts.all))}</button>
      <button type="button" class="ppCat ${f === 'star' ? 'active' : ''}" data-vf="star">⭐ ${H.esc(tr('已收藏（{0}）', counts.star))}</button>
    </div>
    <p class="hint">${H.esc(tr('版本历史按方案分开管理：这里只显示「{0}」的历史。每次规划/调整自动存档；看中的版本可以「＋ 存成方案」变成一份独立方案，或恢复到此版（恢复前会自动存档当前）。', curPlan.name))}</p></div>
    <div class="sec"><div class="vpGrid">${list.length ? list.map(v => versionItemHTML(v, gid)).join('') : `<div class="muted">${H.esc(tr('这个方案还没有版本记录。'))}</div>`}</div></div>
  </div>`;
  H.app.querySelectorAll('#verFilter [data-vf]').forEach(b => b.addEventListener('click', () => { H.state.verFilter = b.getAttribute('data-vf'); renderVersionsPage(gid); }));
  bindVersionItems(document.getElementById('app'), gid, () => renderVersionsPage(gid));
  const vb = document.getElementById('vpBlank');
  if (vb) vb.addEventListener('click', async () => {
    const name = (prompt(tr('给空白方案起个名字'), tr('空白方案')) || '').trim();
    if (!name) return;
    try {
      const r = await H.api('/api/goals/' + gid + '/plans', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name, blank: true }) });
      if (confirm(tr('已新建空白方案「{0}」。现在切换过去吗？（当前路径会先自动存回当前方案）', r.name))) {
        const ar = await H.api('/api/plans/' + r.planId + '/activate', { method: 'POST' });
        H.state.goal = ar.goal;
        await H.loadGoal(gid);
        H.toast(tr('已切换到空白方案，开始搭节点吧'));
        location.hash = '#/g/' + gid + '/map';
        return;
      }
      H.toast(tr('已创建空白方案「{0}」', r.name));
      renderVersionsPage(gid);
    } catch (e) { H.toast(e.message || tr('新建失败')); }
  });
  H.app.querySelectorAll('[data-plan-switch]').forEach(b => b.addEventListener('click', async () => {
    const pid = Number(b.getAttribute('data-plan-switch'));
    const nm = b.getAttribute('data-plan-name') || '';
    if (!confirm(tr('切换到方案「{0}」？当前路径会先自动存回当前方案。', nm))) return;
    try {
      const r = await H.api('/api/plans/' + pid + '/activate', { method: 'POST' });
      H.state.goal = r.goal;
      await H.loadGoal(gid);
      H.toast(tr('已切换'));
      renderVersionsPage(gid);
    } catch (e) { H.toast(e.message || tr('切换失败')); }
  }));
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
