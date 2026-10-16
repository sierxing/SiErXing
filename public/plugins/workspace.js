'use strict';
/**
 * 思而行 · 前端扩展组件：代码目录
 * ------------------------------------------------------------------
 * 一个节点对应一个文件夹（子目录嵌在父目录下），建节点时自动建好；
 * 教程页一键用 VSCode 打开当前节点目录，边看教程边写代码；
 * 目标页 / 教程页一键打包整个目标的代码目录（zip 下载）。
 * 由 app.js 在教程页 / 目标页按需调用（仅当组件启用时）。
 */
(function () {
  const { api, esc, toast } = SiErXing;

  function fmtBytes(n) {
    n = Number(n) || 0;
    if (n < 1024) return n + ' B';
    if (n < 1024 * 1024) return (n / 1024).toFixed(1) + ' KB';
    return (n / 1024 / 1024).toFixed(1) + ' MB';
  }

  async function openNode(nodeId, btn) {
    if (!nodeId) { toast('先选定一个节点'); return; }
    const old = btn ? btn.textContent : '';
    if (btn) { btn.disabled = true; btn.textContent = '⏳ 打开中…'; }
    try {
      const r = await api('/api/nodes/' + nodeId + '/workspace/open', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
      toast(r.warn || ('已在 VSCode 打开：' + (r.path || '')));
      refreshHint(nodeId);
    } catch (e) {
      toast(e.message);
    } finally {
      if (btn) { btn.disabled = false; btn.textContent = old || '💻 写代码'; }
    }
  }

  function exportGoal(goalId) {
    if (!goalId) { toast('目标不存在'); return; }
    const a = document.createElement('a');
    a.href = '/api/goals/' + goalId + '/workspace/export';
    document.body.appendChild(a);
    a.click();
    setTimeout(() => a.remove(), 3000);
    toast('正在打包整个目标的代码目录…');
  }

  async function refreshHint(nodeId) {
    const el = document.getElementById('wsHint');
    if (!el || !nodeId) return;
    try {
      const r = await api('/api/nodes/' + nodeId + '/workspace');
      el.textContent = r.exists
        ? ('📁 ' + r.path + (r.files ? (' · ' + r.files + ' 个文件 · ' + fmtBytes(r.bytes)) : ' · 空目录'))
        : '📁 目录将在首次打开时自动创建';
      el.title = r.path || '';
    } catch (e) {
      el.textContent = '';
    }
  }

  window.Workspace = {
    openNode,
    exportGoal,
    refreshHint,
    /* 教程页头部绑定（app.js 调用）：两个按钮 + 目录提示 */
    bindTutorial(tid, node, goal) {
      const openBtn = document.getElementById('tutCodeBtn');
      if (openBtn && node) openBtn.addEventListener('click', () => openNode(node.id, openBtn));
      const packBtn = document.getElementById('tutPackBtn');
      if (packBtn && goal) packBtn.addEventListener('click', () => exportGoal(goal.id || (node && node.goal_id)));
      if (node) refreshHint(node.id);
    },
    /* 目标页头部绑定（app.js 调用）：打包按钮 */
    bindGoal(goal) {
      const b = document.getElementById('wsPackBtn');
      if (b && goal) b.addEventListener('click', () => exportGoal(goal.id));
    }
  };

  SiErXing.registerPlugin({ id: 'workspace' });
})();
