'use strict';
/**
 * 思而行 · 目标版本领域（从 server.js 抽出）
 * ------------------------------------------------------------------
 * 只负责：路线图快照、版本 diff、变更报告（模板/可选 AI）、版本收口。
 * 依赖注入：db、nowISO、safeParse、goalCompOn、aiText、currentModel。
 */

function createVersionDomain(opts) {
  const db = opts.db;
  const nowISO = opts.nowISO || function () { return new Date().toISOString(); };
  const safeParse = opts.safeParse || function (s) { try { return JSON.parse(s || '[]'); } catch (e) { return []; } };
  const goalCompOn = opts.goalCompOn || function () { return true; };
  const aiText = opts.aiText;
  const currentModel = opts.currentModel;

  function beginVersion(goalId, reason) {
    if (!goalCompOn(goalId, 'versions')) return 0;
    const nodes = db.prepare('SELECT * FROM nodes WHERE goal_id = ? ORDER BY level, sort_order, id').all(goalId);
    if (!nodes.length) return 0;
    const res = db.prepare('INSERT INTO goal_versions (goal_id, reason, snapshot, summary, created_at) VALUES (?,?,?,?,?)')
      .run(goalId, reason, JSON.stringify(nodes), '', nowISO());
    return Number(res.lastInsertRowid);
  }
  function nodeKeyMap(nodes) {
    const byId = {};
    for (const n of nodes) byId[n.id] = n;
    const memo = {};
    const build = function (n) {
      if (memo[n.id] != null) return memo[n.id];
      const parent = n.parent_id ? byId[n.parent_id] : null;
      const k = (parent ? build(parent) + ' / ' : '') + String(n.title || '');
      memo[n.id] = k;
      return k;
    };
    const map = {};
    for (const n of nodes) map[build(n)] = n;
    return map;
  }
  function diffVersions(oldNodes, newNodes) {
    const oldMap = nodeKeyMap(oldNodes);
    const newMap = nodeKeyMap(newNodes);
    const added = [], removed = [], changed = [];
    const fields = ['detail', 'artifact', 'acceptance', 'hours', 'sources', 'status'];
    for (const k in newMap) {
      if (!oldMap[k]) { added.push(newMap[k]); continue; }
      const a = oldMap[k], b = newMap[k];
      const diffFields = fields.filter(function (f) { return String(a[f] || '') !== String(b[f] || ''); });
      if (diffFields.length) changed.push({ key: k, old: a, new: b, fields: diffFields });
    }
    for (const k in oldMap) if (!newMap[k]) removed.push(oldMap[k]);
    return { added: added, removed: removed, changed: changed, total: { old: Object.keys(oldMap).length, new: Object.keys(newMap).length } };
  }
  function templateReport(reason, diff) {
    const parts = ['本次「' + reason + '」'];
    if (diff.added.length) parts.push('新增 ' + diff.added.length + ' 项（' + diff.added.slice(0, 3).map(function (n) { return n.title; }).join('、') + (diff.added.length > 3 ? ' 等' : '') + '）');
    if (diff.removed.length) parts.push('移除 ' + diff.removed.length + ' 项（' + diff.removed.slice(0, 3).map(function (n) { return n.title; }).join('、') + (diff.removed.length > 3 ? ' 等' : '') + '）');
    if (diff.changed.length) parts.push('调整 ' + diff.changed.length + ' 项');
    if (!diff.added.length && !diff.removed.length && !diff.changed.length) parts.push('结构无变化');
    parts.push('当前共 ' + diff.total.new + ' 个节点');
    return parts.join('；') + '。';
  }
  function buildReportPrompt(goal, reason, diff) {
    const lines = [];
    lines.push('你是职业规划助理。请用 3-5 句话简要汇报路线图的本次变更（中文，平实，不要列表，不要编造）。');
    lines.push('【职业目标】' + goal.title);
    lines.push('【本次操作】' + reason);
    lines.push('【新增】' + (diff.added.slice(0, 12).map(function (n) { return n.title; }).join('、') || '无'));
    lines.push('【移除】' + (diff.removed.slice(0, 12).map(function (n) { return n.title; }).join('、') || '无'));
    lines.push('【调整】' + (diff.changed.slice(0, 12).map(function (c) { return c.new.title; }).join('、') || '无'));
    lines.push('【当前规模】' + diff.total.new + ' 个节点');
    lines.push('要求：说明这次改了什么、为什么这么改、下一步建议；只依据上面事实，不要编造。');
    return lines.join('\n');
  }
  async function finishVersion(goal, vid, reason, useAI) {
    useAI = useAI !== false;
    if (!vid || !goalCompOn(goal && goal.id, 'versions')) return '';
    const v = db.prepare('SELECT * FROM goal_versions WHERE id = ?').get(vid);
    if (!v) return '';
    const oldNodes = safeParse(v.snapshot) || [];
    const newNodes = db.prepare('SELECT * FROM nodes WHERE goal_id = ? ORDER BY level, sort_order, id').all(goal.id);
    const diff = diffVersions(Array.isArray(oldNodes) ? oldNodes : [], newNodes);
    if (!diff.added.length && !diff.removed.length && !diff.changed.length) {
      db.prepare('DELETE FROM goal_versions WHERE id = ?').run(vid);
      return '';
    }
    db.prepare('UPDATE goal_versions SET snapshot_after = ? WHERE id = ?').run(JSON.stringify(newNodes), vid);
    let report = templateReport(reason, diff);
    if (useAI && typeof aiText === 'function') {
      try {
        const model = typeof currentModel === 'function' ? currentModel() : '';
        const txt = await aiText(buildReportPrompt(goal, reason, diff), model, 120000, null, null, '变更报告');
        if (txt && txt.trim()) report = txt.trim().slice(0, 800);
      } catch (e) {}
    }
    db.prepare('UPDATE goal_versions SET summary = ? WHERE id = ?').run(report, vid);
    return report;
  }
  return {
    beginVersion: beginVersion,
    diffVersions: diffVersions,
    templateReport: templateReport,
    buildReportPrompt: buildReportPrompt,
    finishVersion: finishVersion,
    nodeKeyMap: nodeKeyMap
  };
}

module.exports = { createVersionDomain: createVersionDomain };
