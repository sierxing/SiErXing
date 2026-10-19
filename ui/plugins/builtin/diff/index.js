'use strict';
/**
 * 内置 UI 插件 · 版本对比页（#/g/:id/diff/:vid）
 * ---------------------------------------------------------------------------
 * 本文件由 scripts/build-page-plugin.js 生成，**不要直接改这里**：
 *   要改就改 public/app.js 里的原版实现，然后重新跑构建。
 *
 * 实现逐字来自原版 render* 及其依赖闭包（只把全局依赖改为 host 注入），
 * 因此 DOM 结构 / CSS 类名 / 交互与原版一致 —— 外观像素级相同。
 * 用户可在 DATA_DIR/ui-plugins/diff/ 放同名插件整页覆盖。
 */
(function () {
  var H = null;

function keyOfNode(nodes, n) {
  const byId = {};
  for (const x of nodes) byId[x.id] = x;
  let k = String(n.title || '');
  let p = n.parent_id ? byId[n.parent_id] : null;
  while (p) { k = String(p.title || '') + ' / ' + k; p = p.parent_id ? byId[p.parent_id] : null; }
  return k;
}

function diffColumnHTML(nodes, side, otherKeyMap) {
  const tree = H.buildTree(nodes);
  let count = 0;
  const rows = [];
  const walk = (n, depth) => {
    count++;
    const key = keyOfNode(nodes, n);
    const other = otherKeyMap[key];
    let cls = '';
    if (side === 'old') {
      if (!other) cls = 'removed';
      else if (nodeChanged(n, other)) cls = 'changed';
    } else {
      if (!other) cls = 'added';
      else if (nodeChanged(other, n)) cls = 'changed';
    }
    rows.push(`<div class="diffRow ${cls}" style="padding-left:${8 + depth * 14}px" title="${H.esc(key)}">
      <span class="diffDot"></span><span class="diffTitle">${H.esc(n.title)}</span>
      ${n.hours ? `<span class="mtHours">${H.esc(n.hours)}</span>` : ''}
    </div>`);
    for (const c of (n.children || [])) walk(c, depth + 1);
  };
  for (const r of tree) walk(r, 0);
  const label = side === 'old' ? '修改前' : '当前';
  return `<div class="diffCol">
    <div class="diffColHead">${label}（${count} 节点）</div>
    <div class="diffBody">${rows.join('') || '<div class="empty">（无内容）</div>'}</div>
  </div>`;
}

function nodeChanged(a, b) {
  return ['detail', 'artifact', 'acceptance', 'hours', 'sources', 'status'].some(f => String(a[f] || '') !== String(b[f] || ''));
}

async function renderDiffPage(vid) {
  H.app.innerHTML = '<p class="muted">加载中…</p>';
  const data = await H.api('/api/versions/' + vid);
  const oldNodes = data.old_nodes || [];
  const newNodes = data.new_nodes || [];
  const oldK = {};
  for (const n of oldNodes) oldK[keyOfNode(oldNodes, n)] = n;
  const newK = {};
  for (const n of newNodes) newK[keyOfNode(newNodes, n)] = n;
  let html = `<div class="diffPage">
    <div class="diffHead">
      <button class="back" data-back="#/g/${data.version.goal_id}">← 返回</button>
      <span class="mapTitle">${H.esc((data.goal && data.goal.title) || '')} · 路线变更对比</span>
      <span class="chip">${H.esc(data.version.reason || '变更')}</span>
      <span class="hint">${H.fmtDate(data.version.created_at)} 的版本 ↔ 当前</span>
      <div class="spacer"></div>
      <span class="diffLegend"><span class="lgdot added"></span>新增 <span class="lgdot removed"></span>移除 <span class="lgdot changed"></span>修改 <span class="lgdot"></span>未变</span>
    </div>`;
  if (data.version.summary) {
    html += `<div class="reportCard" style="margin-bottom:14px;"><div class="rcHead"><span>📋</span><span>AI 变更汇报</span></div><div class="rcText mdBody">${H.mdToHTML(data.version.summary)}</div></div>`;
  }
  html += `<div class="diffCols">
      ${diffColumnHTML(oldNodes, 'old', newK)}
      ${diffColumnHTML(newNodes, 'new', oldK)}
    </div>
  </div>`;
  H.app.innerHTML = html;
}

  function mountDiff(host) {
    H = host || {};
    return {
      render: function () { return renderDiffPage(H.__vid); },
      unmount: function () {}
    };
  }

  window.SXUIPlugin = window.SXUIPlugin || {};
  window.SXUIPlugin['diff'] = { id: 'diff', mount: mountDiff };
})();
