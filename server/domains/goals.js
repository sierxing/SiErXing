'use strict';
/**
 * 思而行 · 目标读取领域（从 server.js 抽出）
 * ------------------------------------------------------------------
 * 只负责：叶子任务排序、目标进度统计、单个目标读取、路线图大纲。
 * 依赖注入：db。不 require server.js，不涉及 HTTP/AI。
 */
function createGoalDomain(opts) {
  const db = opts.db;

  function orderedLeaves(goalId) {
    const nodes = db.prepare('SELECT id, parent_id, title, status, sort_order FROM nodes WHERE goal_id = ?').all(goalId);
    const childrenOf = {};
    for (const n of nodes) {
      const k = n.parent_id == null ? 'root' : n.parent_id;
      (childrenOf[k] = childrenOf[k] || []).push(n);
    }
    const sortFn = function (a, b) { return (a.sort_order - b.sort_order) || (a.id - b.id); };
    const out = [];
    const walk = function (key) {
      for (const k of (childrenOf[key] || []).sort(sortFn)) {
        const kids = childrenOf[k.id] || [];
        if (!kids.length) out.push(k);
        else walk(k.id);
      }
    };
    walk('root');
    return out;
  }

  function goalWithStats(g) {
    const leaves = orderedLeaves(g.id);
    const t = leaves.length;
    const d = leaves.filter(function (n) { return n.status === 'done'; }).length;
    const next = leaves.find(function (n) { return n.status === 'doing'; }) || leaves.find(function (n) { return n.status !== 'done'; });
    let nextPath = '';
    if (next && next.parent_id) {
      const sub = db.prepare('SELECT title, parent_id FROM nodes WHERE id = ?').get(next.parent_id);
      const stage = sub && sub.parent_id ? db.prepare('SELECT title FROM nodes WHERE id = ?').get(sub.parent_id) : null;
      nextPath = [stage && stage.title, sub && sub.title].filter(Boolean).join(' / ');
    }
    return Object.assign({}, g, { tasks_total: t, tasks_done: d, next_task: next ? next.title : '', next_task_id: next ? next.id : null, next_task_status: next ? next.status : '', next_path: nextPath });
  }

  function getGoal(id) {
    const g = db.prepare('SELECT * FROM goals WHERE id = ?').get(id);
    if (!g) return null;
    const nodes = db.prepare('SELECT * FROM nodes WHERE goal_id = ? ORDER BY level ASC, sort_order ASC, id ASC').all(id);
    const tutorials = db.prepare('SELECT id, node_id, title, format, created_at FROM tutorials WHERE goal_id = ? ORDER BY id DESC').all(id);
    return Object.assign({}, goalWithStats(g), { nodes: nodes, tutorials: tutorials });
  }

  function roadmapOutline(goalId) {
    const nodes = db.prepare('SELECT id, parent_id, level, title, detail, hours, status FROM nodes WHERE goal_id = ? ORDER BY level, sort_order, id').all(goalId);
    const byParent = {};
    for (const n of nodes) { const k = n.parent_id || 0; (byParent[k] = byParent[k] || []).push(n); }
    const lines = [];
    const walk = function (pid, depth) {
      if (lines.length > 600) return;
      for (const n of (byParent[pid] || [])) {
        const st = n.status === 'done' ? ' ✓已完成' : n.status === 'doing' ? ' ▶进行中' : '';
        const det = n.level >= 2 && n.detail ? '　' + String(n.detail).replace(/\s+/g, ' ').slice(0, 70) : '';
        lines.push('  '.repeat(depth) + '[' + n.id + '] ' + n.title + (n.hours ? '（' + n.hours + '）' : '') + st + det);
        walk(n.id, depth + 1);
      }
    };
    walk(0, 0);
    if (lines.length > 600) lines.push('…（节点过多，仅显示前 600 个）');
    return lines.join('\n');
  }

  return { orderedLeaves: orderedLeaves, goalWithStats: goalWithStats, getGoal: getGoal, roadmapOutline: roadmapOutline };
}
module.exports = { createGoalDomain: createGoalDomain };
