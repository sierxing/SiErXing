'use strict';
/**
 * 语义洞察回归：node --no-warnings scripts/test-insights.js
 * 纯内存 SQLite，不碰真实数据。
 */
const assert = require('node:assert');
const { DatabaseSync } = require('node:sqlite');
const ins = require('../server/insights.js');

const NOW = '2026-10-17T00:00:00.000Z';
const NOW_MS = Date.parse(NOW);
function ago(days) { return new Date(NOW_MS - days * 86400000).toISOString(); }

const db = new DatabaseSync(':memory:');
db.exec([
  'CREATE TABLE goals (id INTEGER PRIMARY KEY AUTOINCREMENT, title TEXT NOT NULL, status TEXT NOT NULL DEFAULT \'draft\', weekly_hours TEXT NOT NULL DEFAULT \'\', deadline TEXT NOT NULL DEFAULT \'\', created_at TEXT NOT NULL, updated_at TEXT NOT NULL);',
  'CREATE TABLE nodes (id INTEGER PRIMARY KEY AUTOINCREMENT, goal_id INTEGER NOT NULL, parent_id INTEGER, level INTEGER NOT NULL DEFAULT 0, title TEXT NOT NULL, status TEXT NOT NULL DEFAULT \'todo\', hours TEXT NOT NULL DEFAULT \'\', sort_order INTEGER NOT NULL DEFAULT 0, updated_at TEXT NOT NULL);',
  'CREATE TABLE tutorials (id INTEGER PRIMARY KEY AUTOINCREMENT, goal_id INTEGER NOT NULL, title TEXT NOT NULL DEFAULT \'\', created_at TEXT NOT NULL, updated_at TEXT NOT NULL);',
  'CREATE TABLE friction_reports (id INTEGER PRIMARY KEY AUTOINCREMENT, goal_id INTEGER, page TEXT NOT NULL DEFAULT \'\', component TEXT NOT NULL DEFAULT \'\', action TEXT NOT NULL DEFAULT \'\', description TEXT NOT NULL DEFAULT \'\', expected TEXT NOT NULL DEFAULT \'\', actual TEXT NOT NULL DEFAULT \'\', severity TEXT NOT NULL DEFAULT \'medium\', status TEXT NOT NULL DEFAULT \'open\', note TEXT NOT NULL DEFAULT \'\', created_at TEXT NOT NULL, updated_at TEXT NOT NULL);',
  'CREATE TABLE goal_field_events (id INTEGER PRIMARY KEY AUTOINCREMENT, goal_id INTEGER NOT NULL, field TEXT NOT NULL, old_value TEXT NOT NULL DEFAULT \'\', new_value TEXT NOT NULL DEFAULT \'\', source TEXT NOT NULL DEFAULT \'\', created_at TEXT NOT NULL);'
].join('\n'));

function goal(id, title, status, days) {
  db.prepare('INSERT INTO goals (id,title,status,created_at,updated_at) VALUES (?,?,?,?,?)').run(id, title, status, ago(days), ago(days));
}
function node(id, gid, parent, level, title, status, days, sort) {
  db.prepare('INSERT INTO nodes (id,goal_id,parent_id,level,title,status,sort_order,updated_at) VALUES (?,?,?,?,?,?,?,?)').run(id, gid, parent, level, title, status, sort || 0, ago(days));
}
function tut(id, gid, title, days) {
  db.prepare('INSERT INTO tutorials (id,goal_id,title,created_at,updated_at) VALUES (?,?,?,?,?)').run(id, gid, title, ago(days), ago(days));
}

goal(1, '停滞目标', 'planned', 20);
node(11, 1, null, 0, '阶段 A', 'doing', 20, 0);
node(12, 1, 11, 1, '任务 A1', 'done', 25, 0);
node(13, 1, 11, 1, '任务 A2', 'todo', 20, 1);

goal(2, '有风险目标', 'planned', 9);
node(21, 2, null, 0, '阶段 B', 'doing', 9, 0);
node(22, 2, 21, 1, '任务 B1', 'todo', 9, 0);

goal(3, '在轨目标', 'planned', 0);
node(31, 3, null, 0, '阶段 C', 'doing', 0, 0);
node(32, 3, 31, 1, '任务 C1', 'todo', 0, 0);

goal(4, '已完成目标', 'planned', 1);
node(41, 4, null, 0, '阶段 D', 'doing', 1, 0);
node(42, 4, 41, 1, '任务 D1', 'done', 1, 0);
node(43, 4, 41, 1, '任务 D2', 'done', 1, 1);

goal(5, '空目标', 'draft', 0);
goal(6, '归档目标', 'archived', 30);

goal(7, '动量目标', 'planned', 0);
node(71, 7, null, 0, '阶段 E', 'doing', 2, 0);
node(72, 7, 71, 1, '任务 E1', 'todo', 10, 0);
tut(701, 7, '教程 E', 3);

db.prepare('INSERT INTO friction_reports (goal_id,page,component,action,description,expected,actual,severity,status,note,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)')
  .run(2, '#/g/2', 'pomodoro', '切走休息弹窗', '切走休息弹窗太吵', '安静提醒', '弹窗 + 提示音', 'high', 'open', '', NOW, NOW);

/* 第二批语义：目标字段变更（漂移）+ 计划工时 vs 可投入（冲突） */
db.prepare("UPDATE goals SET weekly_hours = '4', deadline = '2 周' WHERE id = 2").run();
db.prepare("UPDATE nodes SET hours = '40' WHERE id = 22").run();
db.prepare('INSERT INTO goal_field_events (goal_id, field, old_value, new_value, source, created_at) VALUES (?,?,?,?,?,?)')
  .run(2, 'deadline', '1 个月', '2 周', 'test', NOW);

const g1 = db.prepare('SELECT * FROM goals WHERE id = 1').get();
const r1 = ins.forGoal(db, g1, NOW);
assert.strictEqual(r1.health, 'stalled');
assert.strictEqual(r1.idleDays, 20);
assert.strictEqual(r1.progress.tasksTotal, 2);
assert.strictEqual(r1.progress.tasksDone, 1);
assert.strictEqual(r1.progress.nextTask, '任务 A2');
assert.ok(r1.insights.some(function (i) { return i.type === 'stall' && i.severity === 'warn'; }));
assert.ok(r1.nextAction && r1.nextAction.input && r1.nextAction.input.nodeId === 13);
console.log('  ✓ 停滞目标：health=stalled + stall 洞察 + 下一任务');

const g2 = db.prepare('SELECT * FROM goals WHERE id = 2').get();
const r2 = ins.forGoal(db, g2, NOW);
assert.strictEqual(r2.health, 'at_risk');
assert.ok(r2.insights.some(function (i) { return i.type === 'stall' && i.severity === 'info'; }));
assert.ok(r2.insights.some(function (i) { return i.type === 'goal_drift' && i.severity === 'warn'; }));
assert.ok(r2.insights.some(function (i) { return i.type === 'constraint_conflict' && i.severity === 'critical'; }));
console.log('  ✓ 有风险目标：health=at_risk + goal_drift + constraint_conflict');

const g3 = db.prepare('SELECT * FROM goals WHERE id = 3').get();
const r3 = ins.forGoal(db, g3, NOW);
assert.strictEqual(r3.health, 'on_track');
assert.ok(!r3.insights.some(function (i) { return i.type === 'stall'; }));
assert.ok(r3.momentum.last7 >= 1);
console.log('  ✓ 在轨目标：health=on_track + 动量');

const g4 = db.prepare('SELECT * FROM goals WHERE id = 4').get();
const r4 = ins.forGoal(db, g4, NOW);
assert.strictEqual(r4.health, 'achieved');
assert.ok(r4.insights.some(function (i) { return i.type === 'milestone'; }));
console.log('  ✓ 已完成目标：health=achieved + milestone');

const g5 = db.prepare('SELECT * FROM goals WHERE id = 5').get();
const r5 = ins.forGoal(db, g5, NOW);
assert.strictEqual(r5.health, 'empty');
assert.ok(r5.insights.some(function (i) { return i.type === 'empty_goal'; }));
console.log('  ✓ 空目标：health=empty + empty_goal');

const g6 = db.prepare('SELECT * FROM goals WHERE id = 6').get();
assert.strictEqual(ins.forGoal(db, g6, NOW).health, 'archived');
console.log('  ✓ 归档目标：health=archived');

const g7 = db.prepare('SELECT * FROM goals WHERE id = 7').get();
const r7 = ins.forGoal(db, g7, NOW);
assert.strictEqual(r7.momentum.last7, 2);
assert.strictEqual(r7.momentum.prev7, 1);
assert.strictEqual(r7.momentum.trend, 'up');
console.log('  ✓ 动量：last7=2 prev7=1 trend=up');

const leaves = ins.leafNodes(db.prepare('SELECT * FROM nodes WHERE goal_id = 1').all());
assert.deepStrictEqual(leaves.map(function (n) { return n.id; }).sort(function (a, b) { return a - b; }), [12, 13]);
console.log('  ✓ 叶子节点计算正确');

const u = ins.forUser(db, NOW);
assert.strictEqual(u.totalGoals, 7);
assert.ok(u.topInsights.length >= 1);
assert.ok(u.topInsights[0].goalId > 0);
assert.ok(u.goals.some(function (g) { return g.health === 'stalled'; }));
console.log('  ✓ 用户简报：目标健康度 + topInsights');

assert.ok(r2.insights.some(function (i) { return i.type === 'friction' && i.severity === 'warn'; }));
assert.ok(u.topInsights.some(function (i) { return i.type === 'friction'; }));
console.log('  ✓ 摩擦记录进入目标/用户洞察');

console.log('\n11 项全部通过');
