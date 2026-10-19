'use strict';
/**
 * 思而行 · 语义洞察（确定性规则版）
 * ------------------------------------------------------------------
 * 输入：goal / nodes / tutorials / 时间；输出：健康度、卡点、动量、下一步。
 * 原则：每条判断带证据；不调 AI、不写库；先确定性，后续再加 AI 解读。
 */

const DAY = 86400000;

function ms(v) {
  const t = Date.parse(String(v || ''));
  return Number.isFinite(t) ? t : 0;
}
function daysSince(nowMs, v) {
  const t = ms(v);
  if (!t) return null;
  return Math.max(0, Math.floor((nowMs - t) / DAY));
}
function leafNodes(nodes) {
  const hasChild = new Set();
  for (const n of nodes) {
    const p = Number(n.parent_id || 0);
    if (p > 0) hasChild.add(p);
  }
  return nodes.filter(function (n) { return !hasChild.has(Number(n.id)); })
    .sort(function (a, b) { return (Number(a.level) - Number(b.level)) || (Number(a.sort_order || 0) - Number(b.sort_order || 0)) || (Number(a.id) - Number(b.id)); });
}

function forGoal(db, goal, nowISO) {
  const nowMs = Date.parse(nowISO || new Date().toISOString());
  const nodes = db.prepare('SELECT id, parent_id, level, title, status, hours, sort_order, updated_at FROM nodes WHERE goal_id = ?').all(goal.id);
  const tutorials = db.prepare('SELECT id, title, created_at, updated_at FROM tutorials WHERE goal_id = ?').all(goal.id);
  const leaves = leafNodes(nodes);
  const total = leaves.length;
  const done = leaves.filter(function (n) { return n.status === 'done'; }).length;
  const next = leaves.find(function (n) { return n.status === 'doing'; }) || leaves.find(function (n) { return n.status !== 'done'; }) || null;

  const goalAt = ms(goal.updated_at) || ms(goal.created_at);
  const nodeAt = nodes.reduce(function (m, n) { return Math.max(m, ms(n.updated_at)); }, 0);
  const tutAt = tutorials.reduce(function (m, t) { return Math.max(m, ms(t.updated_at), ms(t.created_at)); }, 0);
  const lastAt = Math.max(goalAt, nodeAt, tutAt);
  const idleDays = lastAt ? Math.max(0, Math.floor((nowMs - lastAt) / DAY)) : null;
  const status = String(goal.status || '');

  let health = 'on_track';
  if (status === 'archived') health = 'archived';
  else if (status === 'done' || (total > 0 && done === total)) health = 'achieved';
  else if (total === 0) health = 'empty';
  else if (idleDays == null || idleDays >= 14) health = 'stalled';
  else if (idleDays >= 7) health = 'at_risk';

  const insights = [];
  if (health === 'empty') {
    insights.push({
      id: 'ins_goal_' + goal.id + '_empty',
      type: 'empty_goal',
      severity: 'info',
      confidence: 0.9,
      evidence: [{ kind: 'goal', ref: goal.id, summary: '目标下还没有任何节点' }],
      interpretation: '目标还没有拆成可执行的一步；先拆出第一个最小任务，比继续想更重要。',
      suggestedActions: [{ command: 'node.create', input: { goalId: goal.id, title: '先拆出第一个最小任务' }, why: '把目标变成今天就能开始的一步' }]
    });
  }
  if (health === 'achieved') {
    insights.push({
      id: 'ins_goal_' + goal.id + '_achieved',
      type: 'milestone',
      severity: 'info',
      confidence: 0.9,
      evidence: [{ kind: 'node', summary: done + '/' + total + ' 个任务已完成' }],
      interpretation: '目标下的任务已全部完成，适合复盘一次，决定归档还是进入下一阶段。',
      suggestedActions: [{ command: 'goal.update', input: { goalId: goal.id, status: 'review' }, why: '进入复盘状态，而不是继续加任务' }]
    });
  }
  if (health === 'stalled' || health === 'at_risk') {
    const sev = health === 'stalled' ? 'warn' : 'info';
    const conf = health === 'stalled' ? 0.88 : 0.72;
    const ev = [];
    if (next) ev.push({ kind: 'node', ref: next.id, summary: '下一任务「' + next.title + '」' });
    ev.push({ kind: 'time', summary: '最近活动在 ' + (idleDays == null ? '未知' : idleDays + ' 天前') });
    if (!tutorials.length) ev.push({ kind: 'tutorial', summary: '这个目标还没有教程' });
    insights.push({
      id: 'ins_goal_' + goal.id + '_stall',
      type: 'stall',
      severity: sev,
      confidence: conf,
      evidence: ev,
      interpretation: idleDays == null
        ? '这个目标没有可判断的活动记录，先和用户确认现在卡在哪。'
        : '已经 ' + idleDays + ' 天没有推进' + (next ? '，下一任务还停在「' + next.title + '」' : '') + '；先问是太难、没时间、不想做，还是目标变了。',
      suggestedActions: next
        ? [{ command: 'node.update', input: { nodeId: next.id, status: 'doing' }, why: '先把下一任务明确成 doing，做 15 分钟再评估' }]
        : [{ command: 'node.create', input: { goalId: goal.id, title: '先拆出第一个最小任务' }, why: '目标还没有可执行的下一步' }]
    });
  }

  const last7 = nowMs - 7 * DAY, prev14 = nowMs - 14 * DAY;
  function countRecent(arr, field) {
    return arr.filter(function (x) { const t = Math.max(ms(x[field]), ms(x.created_at)); return t >= last7; }).length;
  }
  function countPrev(arr, field) {
    return arr.filter(function (x) { const t = Math.max(ms(x[field]), ms(x.created_at)); return t >= prev14 && t < last7; }).length;
  }
  const act7 = countRecent(nodes, 'updated_at') + countRecent(tutorials, 'updated_at');
  const actPrev = countPrev(nodes, 'updated_at') + countPrev(tutorials, 'updated_at');
  let trend = 'none';
  if (act7 > actPrev) trend = 'up';
  else if (act7 < actPrev) trend = 'down';
  else if (act7 > 0) trend = 'flat';

  for (const f of frictionInsights(db, goal)) insights.push(f);
  for (const d of goalDriftInsights(db, goal, nowMs)) insights.push(d);
  if (health !== 'achieved' && health !== 'empty' && health !== 'archived') {
    const cc = constraintConflictInsight(goal, leaves, nowMs);
    if (cc) insights.push(cc);
  }

  const nextAction = next
    ? { command: 'node.update', input: { nodeId: next.id, status: 'doing' }, why: '下一任务：' + next.title }
    : (health === 'empty'
      ? { command: 'node.create', input: { goalId: goal.id, title: '先拆出第一个最小任务' }, why: '目标还没有可执行的下一步' }
      : null);

  return {
    goalId: goal.id,
    title: goal.title,
    status: status,
    health: health,
    idleDays: idleDays,
    progress: { tasksTotal: total, tasksDone: done, nextTask: next ? next.title : '', nextTaskId: next ? next.id : null },
    momentum: { last7: act7, prev7: actPrev, trend: trend },
    insights: insights,
    nextAction: nextAction,
    generatedAt: new Date(nowMs).toISOString()
  };
}

function severityRank(sev) {
  if (sev === 'critical') return 3;
  if (sev === 'warn') return 2;
  return 1;
}

/* ===== 第二批语义：目标漂移 / 计划与可投入冲突 ===== */
const FIELD_LABELS = { title: '标题', profile: '现状', weekly_hours: '每周可投入', deadline: '期限', materials: '参考资料' };
function shortText(v, n) {
  const s = String(v == null ? '' : v).replace(/\s+/g, ' ').trim();
  return s.length > n ? s.slice(0, n) + '…' : s;
}
function goalDriftInsights(db, goal, nowMs) {
  let rows = [];
  try {
    rows = db.prepare("SELECT * FROM goal_field_events WHERE goal_id = ? AND created_at >= ? ORDER BY id DESC LIMIT 12")
      .all(goal.id, new Date(nowMs - 14 * DAY).toISOString());
  } catch (e) { return []; }
  if (!rows.length) return [];
  const changed = [];
  for (const r of rows) if (changed.indexOf(r.field) < 0) changed.push(r.field);
  const sev = changed.some(function (f) { return f !== 'materials'; }) ? 'warn' : 'info';
  const evidence = rows.slice(0, 4).map(function (r) {
    return {
      kind: 'goal_change', ref: r.id,
      summary: (FIELD_LABELS[r.field] || r.field) + '：' + (shortText(r.old_value, 40) || '（空）') + ' → ' + (shortText(r.new_value, 40) || '（空）')
        + '（' + String(r.source || '未知') + ' · ' + String(r.created_at || '').slice(0, 10) + '）'
    };
  });
  return [{
    id: 'ins_goal_' + goal.id + '_drift',
    type: 'goal_drift',
    severity: sev,
    confidence: 0.72,
    evidence: evidence,
    interpretation: '目标在最近 14 天内改过 ' + changed.map(function (f) { return FIELD_LABELS[f] || f; }).join('、')
      + '；旧计划可能已经对不上新目标。先核对一下，再按旧计划催进度。',
    suggestedActions: [
      { command: 'node.list', input: { goalId: goal.id }, why: '看当前计划是否还匹配新目标' },
      { command: 'brief.goal', input: { goalId: goal.id }, why: '重新读一次目标、进度与下一任务' }
    ]
  }];
}
function pickNum(text) {
  const m = String(text == null ? '' : text).match(/(\d+(?:\.\d+)?)(?:\s*[-~到至]\s*(\d+(?:\.\d+)?))?/);
  if (!m) return null;
  const a = Number(m[1]);
  const b = m[2] != null ? Number(m[2]) : a;
  if (!Number.isFinite(a) || !Number.isFinite(b)) return null;
  return (a + b) / 2;
}
function parseWeeklyHours(text) {
  const s = String(text == null ? '' : text);
  const n = pickNum(s);
  if (n == null || n <= 0) return null;
  let v = n;
  if (/每天|每日|一天/.test(s)) v = n * 7;
  else if (/每月|一个月/.test(s)) v = n / 4.3;
  if (!(v > 0) || v > 168) return null;
  return Math.round(v * 10) / 10;
}
function parseNodeHours(text) {
  const s = String(text == null ? '' : text);
  const n = pickNum(s);
  if (n == null || n <= 0) return 0;
  if (/分钟|min/i.test(s)) return Math.round((n / 60) * 10) / 10;
  if (/半天/.test(s)) return 4;
  if (/一天|1\s*天/.test(s)) return 8;
  return Math.round(n * 10) / 10;
}
function parseDeadlineDays(text, nowMs) {
  const s = String(text == null ? '' : text).trim();
  if (!s) return null;
  const pad = function (x) { return String(x).padStart(2, '0'); };
  let m = s.match(/(\d{4})[-/.](d{1,2})[-/.](d{1,2})/);
  if (m) {
    const t = Date.parse(m[1] + '-' + pad(m[2]) + '-' + pad(m[3]) + 'T23:59:59');
    if (Number.isFinite(t)) return Math.max(0, Math.ceil((t - nowMs) / DAY));
  }
  m = s.match(/(\d{1,2})月(\d{1,2})日/);
  if (m) {
    const y = new Date(nowMs).getFullYear();
    let t = Date.parse(y + '-' + pad(m[1]) + '-' + pad(m[2]) + 'T23:59:59');
    if (!Number.isFinite(t) || t < nowMs) t = Date.parse((y + 1) + '-' + pad(m[1]) + '-' + pad(m[2]) + 'T23:59:59');
    if (Number.isFinite(t)) return Math.max(0, Math.ceil((t - nowMs) / DAY));
  }
  const n = pickNum(s);
  if (n == null) return null;
  if (/天|日/.test(s)) return Math.max(0, Math.round(n));
  if (/周|星期/.test(s)) return Math.max(0, Math.round(n * 7));
  if (/月/.test(s)) return Math.max(0, Math.round(n * 30));
  if (/年/.test(s)) return Math.max(0, Math.round(n * 365));
  return null;
}
function constraintConflictInsight(goal, leaves, nowMs) {
  const weekHours = parseWeeklyHours(goal.weekly_hours);
  if (!weekHours) return null;
  const remaining = leaves.filter(function (n) { return n.status !== 'done'; });
  if (!remaining.length) return null;
  let total = 0;
  const sized = [];
  for (const n of remaining) {
    const h = parseNodeHours(n.hours);
    if (h > 0) { total += h; sized.push({ id: n.id, title: n.title, hours: h }); }
  }
  if (!(total > 0)) return null;
  const deadlineDays = parseDeadlineDays(goal.deadline, nowMs);
  const horizon = deadlineDays != null && deadlineDays > 0 ? deadlineDays : 28;
  const capacity = weekHours * horizon / 7;
  if (!(capacity > 0)) return null;
  const ratio = total / capacity;
  if (ratio < 1.15) return null;
  const sev = ratio >= 1.6 ? 'critical' : 'warn';
  const evidence = [
    { kind: 'goal', summary: '每周可投入：' + shortText(goal.weekly_hours, 30) + '（按 ' + weekHours + ' 小时/周算）' },
    { kind: 'plan', summary: '剩余任务约 ' + (Math.round(total * 10) / 10) + ' 小时（' + remaining.length + ' 个未完成任务）' },
    { kind: 'capacity', summary: (deadlineDays != null && deadlineDays > 0 ? '期限：' + shortText(goal.deadline, 30) + '（约 ' + deadlineDays + ' 天）' : '期限没能解析成日期，按未来 4 周估算') + '；最多约 ' + Math.round(capacity) + ' 小时' }
  ];
  const biggest = sized.sort(function (a, b) { return b.hours - a.hours; })[0];
  const actions = [
    { command: 'node.list', input: { goalId: goal.id }, why: '先看剩余任务和工时估算' },
    { command: 'brief.goal', input: { goalId: goal.id }, why: '重新核对进度与下一任务' }
  ];
  if (biggest) actions.push({ command: 'node.update', input: { nodeId: biggest.id, hours: String(Math.max(1, Math.round(biggest.hours / 2))) }, why: '把最大任务「' + shortText(biggest.title, 20) + '」削减一半，先让计划排得下' });
  return {
    id: 'ins_goal_' + goal.id + '_constraint',
    type: 'constraint_conflict',
    severity: sev,
    confidence: 0.78,
    evidence: evidence,
    interpretation: '剩余任务约 ' + (Math.round(total * 10) / 10) + ' 小时，按每周 ' + weekHours + ' 小时的可投入，' + horizon + ' 天最多做约 ' + Math.round(capacity) + ' 小时；计划很可能排不下，先删减、降目标或拆阶段。',
    suggestedActions: actions
  };
}

/* 用户之前记录过的摩擦：存在 friction_reports 里，open 状态才会进入洞察。
   表由 commands/index.js 幂等创建；旧库/单测没有表时静默跳过。 */
function frictionInsight(r, goalId, goalTitle) {
  const where = [r.page, r.component, r.action].filter(Boolean).join(' · ');
  const evidence = [{ kind: 'friction', ref: r.id, summary: (where ? where + '：' : '') + String(r.description || '') }];
  if (r.expected) evidence.push({ kind: 'expectation', summary: '期望：' + r.expected });
  if (r.actual) evidence.push({ kind: 'actual', summary: '实际：' + r.actual });
  return {
    id: 'ins_friction_' + r.id,
    type: 'friction',
    severity: r.severity === 'high' ? 'warn' : 'info',
    confidence: 0.9,
    evidence: evidence,
    interpretation: '用户之前反馈过这里不舒服：' + String(r.description || '').slice(0, 120) + '。先找最小改动（配置/提示词/组件开关），改之前再跟用户确认。',
    suggestedActions: [
      { command: 'component.list', input: {}, why: '先看有没有现成开关' },
      { command: 'setting.list', input: {}, why: '再看有没有现成设置' },
      { command: 'prompt.list', input: {}, why: '文案/语气问题可能改提示词就能解决' }
    ],
    goalId: goalId || null,
    goalTitle: goalTitle || ''
  };
}
function frictionInsights(db, goal) {
  let rows = [];
  try {
    rows = db.prepare("SELECT * FROM friction_reports WHERE status = 'open' AND goal_id = ? ORDER BY CASE severity WHEN 'high' THEN 0 WHEN 'medium' THEN 1 ELSE 2 END, id DESC LIMIT 5").all(goal.id);
  } catch (e) { return []; }
  return rows.map(function (r) { return frictionInsight(r, goal.id, goal.title); });
}

function forUser(db, nowISO) {
  const goals = db.prepare('SELECT * FROM goals ORDER BY updated_at DESC LIMIT 20').all();
  const items = goals.map(function (g) { return forGoal(db, g, nowISO); });
  const top = [];
  for (const it of items) {
    for (const ins of it.insights) {
      top.push(Object.assign({}, ins, { goalId: it.goalId, goalTitle: it.title }));
    }
  }
  /* 全局/跨目标摩擦：forGoal 已带本目标的，这里按 id 去重后再补一次 */
  let frictionRows = [];
  try {
    frictionRows = db.prepare("SELECT * FROM friction_reports WHERE status = 'open' ORDER BY CASE severity WHEN 'high' THEN 0 WHEN 'medium' THEN 1 ELSE 2 END, id DESC LIMIT 10").all();
  } catch (e) { frictionRows = []; }
  const seen = new Set(top.map(function (x) { return x.id; }));
  const goalTitles = {};
  for (const it of items) goalTitles[it.goalId] = it.title;
  for (const row of frictionRows) {
    const ins = frictionInsight(row, row.goal_id, goalTitles[row.goal_id] || '');
    if (!seen.has(ins.id)) { top.push(ins); seen.add(ins.id); }
  }
  top.sort(function (a, b) {
    return (severityRank(b.severity) - severityRank(a.severity)) || String(b.id).localeCompare(String(a.id));
  });
  return {
    generatedAt: new Date(Date.parse(nowISO || new Date().toISOString())).toISOString(),
    totalGoals: goals.length,
    goals: items.map(function (x) {
      return { goalId: x.goalId, title: x.title, status: x.status, health: x.health, idleDays: x.idleDays, nextTask: x.progress.nextTask, momentum: x.momentum };
    }),
    topInsights: top.slice(0, 10)
  };
}

module.exports = { forGoal: forGoal, forUser: forUser, leafNodes: leafNodes };
