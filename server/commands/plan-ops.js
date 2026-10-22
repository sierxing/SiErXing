'use strict';
/**
 * 思而行 · 方案领域（同一目标多份规划）—— 从 server.js 抽出
 * ------------------------------------------------------------------
 * 模型：goal_versions 里 manual=1 的行就是一份「方案」（快照 = 节点数组）。
 * 「当前路径」永远是 nodes 表里的那套节点；goals.active_plan_id 记着它来自哪份方案。
 *
 * 版本历史按方案隔离（2026-10-21）：goal_versions.plan_id 记这份自动快照属于哪份方案
 * （0 = 主方案）。切到某方案后只看得到该方案自己的历史；「从历史版本建方案」= 把某个快照
 * 复制成一份新方案（类似 git 从 commit 建分支）。
 *
 * 依赖注入：db / nowISO / safeParse / insertNode / beginVersion / backup / getGoal
 */

function createPlanDomain(opts) {
  const db = opts.db;
  const nowISO = opts.nowISO || function () { return new Date().toISOString(); };
  const safeParse = opts.safeParse || function (s) { try { return JSON.parse(s || '[]'); } catch (e) { return []; } };
  const insertNode = opts.insertNode;
  const beginVersion = opts.beginVersion || function () { return 0; };
  const backup = opts.backup || function () {};
  const getGoal = opts.getGoal || function () { return null; };

  function err(code, message) { const e = new Error(message); e.code = code; return e; }
  function goalRow(gid) { return db.prepare('SELECT id, title, active_plan_id FROM goals WHERE id = ?').get(gid); }
  function manualRows(gid) {
    return db.prepare('SELECT id, goal_id, reason, snapshot, summary, starred, created_at FROM goal_versions WHERE goal_id = ? AND manual = 1 ORDER BY starred DESC, id DESC').all(gid);
  }
  function currentNodeRows(gid) {
    return db.prepare('SELECT * FROM nodes WHERE goal_id = ? ORDER BY level, sort_order, id').all(gid);
  }
  function planNameOf(row) { return String((row && row.reason) || '').trim() || ('方案 ' + (row ? row.id : '')); }
  function snapshotCount(raw) { const a = safeParse(raw); return Array.isArray(a) ? a.length : 0; }
  function activePlanId(gid) { const g = goalRow(gid); return Number((g && g.active_plan_id) || 0); }

  function planInfo(gid) {
    const pid = activePlanId(gid);
    if (!pid) return { id: 0, name: '主方案' };
    const row = db.prepare('SELECT id, reason FROM goal_versions WHERE id = ? AND manual = 1').get(pid);
    return row ? { id: pid, name: planNameOf(row) } : { id: 0, name: '主方案' };
  }

  function list(gid) {
    const g = goalRow(gid);
    if (!g) throw err('not_found', '目标不存在：' + gid);
    const activeId = Number(g.active_plan_id || 0);
    const rows = manualRows(gid);
    const plans = rows.map(function (r) {
      return {
        planId: Number(r.id), name: planNameOf(r), nodes: snapshotCount(r.snapshot),
        created_at: r.created_at, starred: !!r.starred, active: Number(r.id) === activeId
      };
    });
    const info = planInfo(gid);
    return {
      goalId: gid,
      current: { planId: info.id, name: info.name, nodes: currentNodeRows(gid).length },
      plans: plans
    };
  }

  function insertPlan(gid, name, nodes, allowEmpty) {
    const list_ = Array.isArray(nodes) ? nodes : [];
    if (!list_.length && !allowEmpty) throw err('bad_input', '方案里至少要有一个节点');
    if (list_.length > 400) throw err('bad_input', '单个方案最多 400 个节点（当前 ' + list_.length + '）');
    const nm = String(name || '').trim().slice(0, 60) || ('方案 ' + (manualRows(gid).length + 1));
    const summary = list_.length ? (list_.length + ' 个节点') : '空白方案（0 个节点）';
    const r = db.prepare('INSERT INTO goal_versions (goal_id, reason, snapshot, summary, manual, plan_id, created_at) VALUES (?,?,?,?,?,?,?)')
      .run(gid, nm, JSON.stringify(list_), summary, 1, 0, nowISO());
    return { planId: Number(r.lastInsertRowid), name: nm, nodes: list_.length };
  }

  function saveCurrent(gid, name) {
    const g = goalRow(gid);
    if (!g) throw err('not_found', '目标不存在：' + gid);
    const nodes = currentNodeRows(gid);
    if (!nodes.length) throw err('bad_input', '当前目标还没有路径节点，无法存为方案');
    return insertPlan(gid, name, nodes, false);
  }

  function saveFromNodes(gid, name, nodes) {
    const g = goalRow(gid);
    if (!g) throw err('not_found', '目标不存在：' + gid);
    return insertPlan(gid, name, nodes, false);
  }

  function createBlank(gid, name) {
    const g = goalRow(gid);
    if (!g) throw err('not_found', '目标不存在：' + gid);
    return insertPlan(gid, name, [], true);
  }

  function applyStages(gid, name, stages) {
    const g = goalRow(gid);
    if (!g) throw err('not_found', '目标不存在：' + gid);
    const arr = Array.isArray(stages) ? stages : [];
    if (!arr.length) throw err('bad_input', 'stages 不能为空');
    let nid = -1;
    const rows = [];
    function add(parentId, level, title, detail, extra, sortOrder) {
      const id = nid--;
      rows.push({
        id: id, goal_id: gid, parent_id: parentId, level: level,
        title: String(title || '').slice(0, 200), detail: String(detail || '').slice(0, 5000),
        artifact: String((extra && extra.artifact) || '').slice(0, 2000),
        acceptance: String((extra && extra.acceptance) || '').slice(0, 2000),
        hours: String((extra && extra.hours) || '').slice(0, 50),
        sources: '[]', status: 'todo', condition_id: 0, sort_order: sortOrder
      });
      return id;
    }
    arr.slice(0, 12).forEach(function (stage, si) {
      const sid = add(null, 0, stage.title || ('阶段 ' + (si + 1)), stage.detail, stage, si);
      const goals = Array.isArray(stage.goals) ? stage.goals : (Array.isArray(stage.children) ? stage.children : []);
      goals.slice(0, 20).forEach(function (goal, gi) {
        const gid2 = add(sid, 1, goal.title || ('小目标 ' + (gi + 1)), goal.detail, goal, gi);
        const tasks = Array.isArray(goal.tasks) ? goal.tasks : [];
        tasks.slice(0, 20).forEach(function (task, ti) {
          add(gid2, 2, task.title || ('任务 ' + (ti + 1)), task.detail, task, ti);
        });
      });
    });
    if (!rows.length) throw err('bad_input', '转换后没有节点');
    return insertPlan(gid, name, rows, false);
  }

  function restoreSnapshot(gid, snap, reason, opts2) {
    const arr = Array.isArray(snap) ? snap : [];
    const allowEmpty = !!(opts2 && opts2.allowEmpty);
    if (!arr.length && !allowEmpty) throw err('bad_input', '这个方案是空快照，无法切换');
    beginVersion(gid, reason || '切换方案前自动存档');
    db.prepare('DELETE FROM nodes WHERE goal_id = ?').run(gid);
    try { db.prepare('DELETE FROM node_workspaces WHERE goal_id = ?').run(gid); } catch (e) {}
    const sorted = arr.slice().sort(function (a, b) {
      return ((a.level || 0) - (b.level || 0)) || ((a.sort_order || 0) - (b.sort_order || 0)) || ((a.id || 0) - (b.id || 0));
    });
    const validConds = new Set(db.prepare('SELECT id FROM goal_conditions WHERE goal_id = ?').all(gid).map(function (c) { return Number(c.id); }));
    const idMap = new Map();
    for (const n of sorted) {
      const newParent = n.parent_id ? (idMap.get(n.parent_id) || null) : null;
      const condId = validConds.has(Number(n.condition_id)) ? Number(n.condition_id) : 0;
      insertNode(gid, newParent, n.level || 0, n.title, n.detail, safeParse(n.sources) || [], n.sort_order || 0,
        { artifact: n.artifact, acceptance: n.acceptance, hours: n.hours, condition_id: condId });
      const newId = db.prepare('SELECT last_insert_rowid() AS id').get().id;
      idMap.set(n.id, newId);
      if (n.status && n.status !== 'todo') db.prepare('UPDATE nodes SET status = ? WHERE id = ?').run(n.status, newId);
    }
    const cnt = db.prepare('SELECT COUNT(*) AS c FROM nodes WHERE goal_id = ?').get(gid).c;
    db.prepare('UPDATE goals SET status = ?, error = ?, updated_at = ? WHERE id = ?').run(cnt ? 'planned' : 'draft', '', nowISO(), gid);
    return cnt;
  }

  function saveIntoActive(gid, g) {
    const activeId = Number(g.active_plan_id || 0);
    const cur = currentNodeRows(gid);
    if (!cur.length) return activeId;
    if (activeId) {
      db.prepare('UPDATE goal_versions SET snapshot = ?, summary = ? WHERE id = ? AND goal_id = ?')
        .run(JSON.stringify(cur), cur.length + ' 个节点', activeId, gid);
      return activeId;
    }
    const r = insertPlan(gid, '主方案', cur, false);
    db.prepare('UPDATE goals SET active_plan_id = ?, updated_at = ? WHERE id = ?').run(r.planId, nowISO(), gid);
    return r.planId;
  }

  function switchTo(gid, planId) {
    const pid = Number(planId || 0);
    const row = db.prepare('SELECT * FROM goal_versions WHERE id = ? AND goal_id = ? AND manual = 1').get(pid, gid);
    if (!row) throw err('not_found', '方案不存在：' + pid);
    const g = goalRow(gid);
    if (!g) throw err('not_found', '目标不存在：' + gid);
    const activeId = Number(g.active_plan_id || 0);
    if (activeId === pid) {
      return { goalId: gid, planId: pid, name: planNameOf(row), nodes: currentNodeRows(gid).length, goal: getGoal(gid), unchanged: true };
    }
    saveIntoActive(gid, g);
    const snap = safeParse(row.snapshot) || [];
    const cnt = restoreSnapshot(gid, snap, '切换方案前自动存档', { allowEmpty: true });
    db.prepare('UPDATE goals SET active_plan_id = ?, updated_at = ? WHERE id = ?').run(pid, nowISO(), gid);
    backup();
    return { goalId: gid, planId: pid, name: planNameOf(row), nodes: cnt, goal: getGoal(gid) };
  }

  function activateById(planId) {
    const pid = Number(planId || 0);
    const row = db.prepare('SELECT goal_id FROM goal_versions WHERE id = ? AND manual = 1').get(pid);
    if (!row) throw err('not_found', '方案不存在：' + pid);
    return switchTo(Number(row.goal_id), pid);
  }

  function rename(planId, name) {
    const pid = Number(planId || 0);
    const row = db.prepare('SELECT * FROM goal_versions WHERE id = ? AND manual = 1').get(pid);
    if (!row) throw err('not_found', '方案不存在：' + pid);
    const nm = String(name || '').trim().slice(0, 60);
    if (!nm) throw err('bad_input', '方案名不能为空');
    db.prepare('UPDATE goal_versions SET reason = ? WHERE id = ?').run(nm, pid);
    backup();
    return { planId: pid, name: nm };
  }

  function remove(planId) {
    const pid = Number(planId || 0);
    const row = db.prepare('SELECT * FROM goal_versions WHERE id = ? AND manual = 1').get(pid);
    if (!row) throw err('not_found', '方案不存在：' + pid);
    const g = db.prepare('SELECT id, active_plan_id FROM goals WHERE id = ?').get(row.goal_id);
    if (g && Number(g.active_plan_id || 0) === pid) throw err('conflict', '不能删除当前正在使用的方案，请先切换到别的方案');
    db.prepare('DELETE FROM goal_versions WHERE goal_id = ? AND plan_id = ? AND manual = 0').run(row.goal_id, pid);
    db.prepare('DELETE FROM goal_versions WHERE id = ?').run(pid);
    backup();
    return { planId: pid, deleted: true };
  }

  function versions(gid, planIdArg) {
    const g = goalRow(gid);
    if (!g) throw err('not_found', '目标不存在：' + gid);
    const activeId = Number(g.active_plan_id || 0);
    const pid = planIdArg == null || planIdArg === '' ? activeId : Number(planIdArg);
    const rows = db.prepare('SELECT id, goal_id, reason, summary, manual, starred, created_at, plan_id FROM goal_versions WHERE goal_id = ? AND plan_id = ? AND manual = 0 ORDER BY starred DESC, id DESC LIMIT 60').all(gid, pid);
    let planName = '主方案';
    if (pid) {
      const pr = db.prepare('SELECT id, reason FROM goal_versions WHERE id = ? AND goal_id = ? AND manual = 1').get(pid, gid);
      planName = pr ? planNameOf(pr) : ('方案 ' + pid);
    }
    const plans = manualRows(gid).map(function (r) {
      return { planId: Number(r.id), name: planNameOf(r), nodes: snapshotCount(r.snapshot), active: Number(r.id) === activeId };
    });
    return {
      versions: rows,
      plan: { id: pid, name: planName },
      plans: plans,
      activePlanId: activeId
    };
  }

  function toPlan(versionId, name) {
    const vid = Number(versionId || 0);
    const v = db.prepare('SELECT * FROM goal_versions WHERE id = ?').get(vid);
    if (!v) throw err('not_found', '版本不存在：' + vid);
    const snap = safeParse(v.snapshot) || [];
    if (!Array.isArray(snap) || !snap.length) throw err('bad_input', '这个版本是空快照，不能存成方案');
    const nm = String(name || '').trim().slice(0, 60) || ('来自版本 ' + vid);
    const r = insertPlan(Number(v.goal_id), nm, snap, false);
    return { planId: r.planId, name: r.name, nodes: r.nodes };
  }

  function restoreVersion(versionId) {
    const vid = Number(versionId || 0);
    const v = db.prepare('SELECT * FROM goal_versions WHERE id = ?').get(vid);
    if (!v) throw err('not_found', '版本不存在：' + vid);
    if (Number(v.manual) === 1) return switchTo(Number(v.goal_id), v.id);
    const snap = safeParse(v.snapshot) || [];
    if (!snap.length) throw err('bad_input', '这个版本是空快照，无法恢复');
    const gid = Number(v.goal_id);
    const g = goalRow(gid);
    if (!g) throw err('not_found', '目标不存在：' + gid);
    saveIntoActive(gid, g);
    const targetPid = Number(v.plan_id || 0);
    db.prepare('UPDATE goals SET active_plan_id = ?, updated_at = ? WHERE id = ?').run(targetPid, nowISO(), gid);
    const cnt = restoreSnapshot(gid, snap, '恢复版本前自动存档');
    backup();
    return { goalId: gid, planId: targetPid, nodes: cnt, goal: getGoal(gid) };
  }

  function switchByName(gid, name) {
    const nm = String(name || '').trim();
    const hit = list(gid).plans.find(function (p) { return p.name === nm; });
    if (!hit) throw err('not_found', '方案不存在：' + (nm || '（没给名字）'));
    return switchTo(gid, hit.planId);
  }

  /* 给对话提示词用的方案清单：文本 + 上下文标签都放这里（commands/ 目录豁免中文硬编码扫描）。 */
  function chatBlock(gid) {
    let data;
    try { data = list(gid); } catch (e) { return null; }
    const cur = data.current || {};
    const others = (data.plans || []).filter(function (p) { return !p.active; });
    const lines = [];
    lines.push('【这个目标的规划方案（一个目标可以有多份规划；方括号里是方案 id）】');
    lines.push('当前路线图来自：' + (cur.name || '主方案') + '（' + (cur.nodes || 0) + ' 个节点）' + (cur.planId ? ' [方案 ' + cur.planId + ']' : ''));
    if (others.length) lines.push('其它方案：' + others.map(function (p) { return '[' + p.planId + '] ' + p.name + '（' + p.nodes + ' 个节点）'; }).join(' | '));
    lines.push('要新建一份完整规划 → 用 plan_create（写 stages 树，不会动当前路线图）；要切换 → plan_switch；要把当前路径另存一版 → plan_save。');
    return { text: lines.join(String.fromCharCode(10)), label: '这个目标的规划方案', detail: (data.plans.length + 1) + ' 份' };
  }

  return {
    list: list,
    planInfo: planInfo,
    activePlanId: activePlanId,
    saveCurrent: saveCurrent,
    saveFromNodes: saveFromNodes,
    createBlank: createBlank,
    applyStages: applyStages,
    restoreSnapshot: restoreSnapshot,
    switchTo: switchTo,
    switchByName: switchByName,
    activateById: activateById,
    rename: rename,
    remove: remove,
    versions: versions,
    toPlan: toPlan,
    restoreVersion: restoreVersion,
    chatBlock: chatBlock
  };
}

module.exports = { createPlanDomain: createPlanDomain };
