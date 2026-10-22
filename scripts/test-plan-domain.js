'use strict';
/**
 * 方案领域回归：node --no-warnings scripts/test-plan-domain.js
 * 纯内存 SQLite，不碰真实数据。
 * 覆盖：列表 / 存当前 / Agent 写树 / 切换（含进度保留）/ 改名 / 删除保护。
 */
const assert = require('node:assert');
const { DatabaseSync } = require('node:sqlite');
const { createPlanDomain } = require('../server/commands/plan-ops.js');

const db = new DatabaseSync(':memory:');
db.exec([
  "CREATE TABLE goals (id INTEGER PRIMARY KEY AUTOINCREMENT, title TEXT NOT NULL DEFAULT '', status TEXT NOT NULL DEFAULT 'draft', error TEXT NOT NULL DEFAULT '', active_plan_id INTEGER NOT NULL DEFAULT 0, updated_at TEXT NOT NULL DEFAULT '');",
  "CREATE TABLE nodes (id INTEGER PRIMARY KEY AUTOINCREMENT, goal_id INTEGER NOT NULL, parent_id INTEGER, level INTEGER NOT NULL DEFAULT 0, title TEXT NOT NULL, detail TEXT NOT NULL DEFAULT '', artifact TEXT NOT NULL DEFAULT '', acceptance TEXT NOT NULL DEFAULT '', hours TEXT NOT NULL DEFAULT '', sources TEXT NOT NULL DEFAULT '', status TEXT NOT NULL DEFAULT 'todo', condition_id INTEGER NOT NULL DEFAULT 0, sort_order INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL DEFAULT '', updated_at TEXT NOT NULL DEFAULT '');",
  "CREATE TABLE goal_versions (id INTEGER PRIMARY KEY AUTOINCREMENT, goal_id INTEGER NOT NULL, reason TEXT NOT NULL DEFAULT '', snapshot TEXT NOT NULL DEFAULT '[]', summary TEXT NOT NULL DEFAULT '', created_at TEXT NOT NULL, manual INTEGER NOT NULL DEFAULT 0, starred INTEGER NOT NULL DEFAULT 0, snapshot_after TEXT NOT NULL DEFAULT '', plan_id INTEGER NOT NULL DEFAULT 0);",
  "CREATE TABLE goal_conditions (id INTEGER PRIMARY KEY AUTOINCREMENT, goal_id INTEGER NOT NULL, title TEXT NOT NULL DEFAULT '');",
  "CREATE TABLE node_workspaces (id INTEGER PRIMARY KEY AUTOINCREMENT, goal_id INTEGER NOT NULL, node_id INTEGER NOT NULL, path TEXT NOT NULL DEFAULT '');"
].join(String.fromCharCode(10)));
db.prepare("INSERT INTO goals (id, title, status) VALUES (1, '测试目标', 'planned')").run();

let versionCalls = 0, backupCalls = 0;
const nowISO = function () { return '2026-10-21T00:00:00.000Z'; };
function insertNode(goalId, parentId, level, title, detail, sources, sortOrder, extra) {
  const ex = extra || {};
  const info = db.prepare('INSERT INTO nodes (goal_id,parent_id,level,title,detail,artifact,acceptance,hours,sources,status,condition_id,sort_order,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)')
    .run(goalId, parentId || null, level, String(title || ''), String(detail || ''), String(ex.artifact || ''), String(ex.acceptance || ''), String(ex.hours || ''), '[]', 'todo', Number(ex.condition_id) || 0, sortOrder || 0, nowISO(), nowISO());
  return Number(info.lastInsertRowid);
}
const domain = createPlanDomain({
  db: db, nowISO: nowISO,
  safeParse: function (s) { try { return JSON.parse(s || '[]'); } catch (e) { return []; } },
  insertNode: insertNode,
  beginVersion: function () { versionCalls++; return 1; },
  backup: function () { backupCalls++; },
  getGoal: function (id) { return db.prepare('SELECT * FROM goals WHERE id = ?').get(id); }
});
let n = 0;
function ok(name, cond) { assert.ok(cond, name); console.log('  ✓ ' + name); n++; }

/* 初始：两个节点 */
db.prepare("INSERT INTO nodes (id,goal_id,parent_id,level,title,status,sort_order) VALUES (11,1,NULL,0,'阶段 A','todo',0)").run();
db.prepare("INSERT INTO nodes (id,goal_id,parent_id,level,title,status,sort_order) VALUES (12,1,11,1,'任务 A1','done',0)").run();

const empty = domain.list(1);
ok('初始列表：当前=主方案、无其他方案', empty.current.name === '主方案' && empty.current.nodes === 2 && empty.plans.length === 0);

const saved = domain.saveCurrent(1, '方案甲');
ok('saveCurrent 把当前路径存成方案', saved.planId > 0 && saved.nodes === 2);
let list = domain.list(1);
ok('列表出现方案甲且不是当前', list.plans.length === 1 && list.plans[0].name === '方案甲' && list.plans[0].active === false);

const applied = domain.applyStages(1, '方案乙', [
  { title: '阶段 1', goals: [{ title: '小目标 1', tasks: [{ title: '任务 1', hours: '1h' }, { title: '任务 2' }] }] },
  { title: '阶段 2' }
]);
ok('applyStages 建树并存成方案（1+1+2+1=5 个节点）', applied.nodes === 5);
ok('applyStages 不改当前路径', db.prepare('SELECT COUNT(*) AS c FROM nodes WHERE goal_id = 1').get().c === 2);

const switched = domain.switchTo(1, applied.planId);
ok('switchTo 载入方案乙节点数', switched.nodes === 5 && db.prepare('SELECT COUNT(*) AS c FROM nodes WHERE goal_id = 1').get().c === 5);
ok('switchTo 记住当前方案', db.prepare('SELECT active_plan_id FROM goals WHERE id = 1').get().active_plan_id === applied.planId);
ok('switchTo 切换前自动存版本 + 备份', versionCalls > 0 && backupCalls > 0);
ok('第一次切走时把原路径固化成「主方案」', domain.list(1).plans.some(function (p) { return p.name === '主方案' && p.nodes === 2; }));

/* 在方案乙里把最后一个节点标成 done，再切走切回，验证进度保留 */
const leaf = db.prepare('SELECT id FROM nodes WHERE goal_id = 1 AND level = 2 ORDER BY id DESC LIMIT 1').get().id;
db.prepare("UPDATE nodes SET status = 'done' WHERE id = ?").run(leaf);
const planA = domain.list(1).plans.find(function (p) { return p.name === '方案甲'; });
const back = domain.switchTo(1, planA.planId);
ok('切回方案甲恢复 2 个节点', back.nodes === 2);
const doneBefore = db.prepare("SELECT COUNT(*) AS c FROM nodes WHERE goal_id = 1 AND status = 'done'").get().c;
ok('方案甲的 done 状态保留', doneBefore === 1);
const planB = domain.list(1).plans.find(function (p) { return p.name === '方案乙'; });
const again = domain.switchTo(1, planB.planId);
const doneB = db.prepare("SELECT COUNT(*) AS c FROM nodes WHERE goal_id = 1 AND status = 'done'").get().c;
ok('方案乙切回后 done 状态也保留', doneB === 1 && again.nodes === 5);

ok('rename 改方案名', domain.rename(planA.planId, '方案甲·改名').name === '方案甲·改名');
let threw = false;
try { domain.remove(planB.planId); } catch (e) { threw = e.code === 'conflict'; }
ok('不能删除当前正在使用的方案', threw);
ok('删除非当前方案成功', domain.remove(planA.planId).deleted === true && !domain.list(1).plans.some(function (p) { return p.name === '方案甲·改名'; }));

threw = false;
try { domain.switchTo(1, 999999); } catch (e) { threw = e.code === 'not_found'; }
ok('切换不存在的方案报 not_found', threw);

/* ---------- 空白方案 ---------- */
const blank = domain.createBlank(1, '空白方案 X');
ok('createBlank 建 0 节点方案', blank.nodes === 0 && domain.list(1).plans.some(function (p) { return p.planId === blank.planId && p.nodes === 0; }));
const toBlank = domain.switchTo(1, blank.planId);
ok('切到空白方案后节点清零', toBlank.nodes === 0 && db.prepare('SELECT COUNT(*) AS c FROM nodes WHERE goal_id = 1').get().c === 0);
const toB2 = domain.switchTo(1, planB.planId);
ok('从空白方案切回恢复 5 个节点', toB2.nodes === 5);

/* ---------- 版本历史按方案隔离 ---------- */
const snapOld = JSON.stringify([{ id: 1, goal_id: 1, parent_id: null, level: 0, title: '旧版阶段', detail: '', artifact: '', acceptance: '', hours: '', sources: '[]', status: 'todo', condition_id: 0, sort_order: 0 }]);
const vrB = db.prepare("INSERT INTO goal_versions (goal_id,reason,snapshot,summary,manual,plan_id,created_at) VALUES (1,'自动存档',?, '',0,?,?)").run(snapOld, planB.planId, nowISO());
const vrMain = db.prepare("INSERT INTO goal_versions (goal_id,reason,snapshot,summary,manual,plan_id,created_at) VALUES (1,'自动存档2',?, '',0,?,?)").run(snapOld, 0, nowISO());
const vB = domain.versions(1, planB.planId);
ok('版本历史按方案过滤：方案乙只看到自己的 1 条', vB.versions.length === 1 && vB.plan.id === planB.planId);
ok('请求哪份方案就显示哪份方案的名字', vB.plan.name === '方案乙');
ok('主方案历史单独可见', domain.versions(1, 0).versions.length === 1 && domain.versions(1, 0).plan.name === '主方案');

/* ---------- 从历史版本建方案 ---------- */
const fromV = domain.toPlan(Number(vrB.lastInsertRowid), '从版本建的方案');
ok('toPlan 把版本快照复制成新方案（1 个节点）', fromV.nodes === 1 && domain.list(1).plans.some(function (p) { return p.planId === fromV.planId; }));
ok('toPlan 不改当前路径', db.prepare('SELECT COUNT(*) AS c FROM nodes WHERE goal_id = 1').get().c === 5);

/* ---------- 恢复版本（切回它所属的方案） ---------- */
const rest = domain.restoreVersion(Number(vrMain.lastInsertRowid));
ok('restoreVersion 恢复快照', db.prepare('SELECT COUNT(*) AS c FROM nodes WHERE goal_id = 1').get().c === 1 && db.prepare('SELECT active_plan_id FROM goals WHERE id = 1').get().active_plan_id === 0);
ok('restoreVersion 返回 goal', !!rest.goal);
const cb = domain.chatBlock(1);
ok('chatBlock 给 AI 助手带方案清单', !!cb && cb.text.indexOf('规划方案') >= 0 && cb.text.indexOf('主方案') >= 0);

console.log(String.fromCharCode(10) + '通过 ' + n + ' 项');
