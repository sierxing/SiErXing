'use strict';
/**
 * 目标读取领域回归：node --no-warnings scripts/test-goals-domain.js
 * 纯内存 SQLite，不碰真实数据。
 */
const assert = require('node:assert');
const { DatabaseSync } = require('node:sqlite');
const { createGoalDomain } = require('../server/domains/goals.js');

const db = new DatabaseSync(':memory:');
db.exec([
  "CREATE TABLE goals (id INTEGER PRIMARY KEY AUTOINCREMENT, title TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'draft', created_at TEXT NOT NULL, updated_at TEXT NOT NULL);",
  "CREATE TABLE nodes (id INTEGER PRIMARY KEY AUTOINCREMENT, goal_id INTEGER NOT NULL, parent_id INTEGER, level INTEGER NOT NULL DEFAULT 0, title TEXT NOT NULL, detail TEXT NOT NULL DEFAULT '', status TEXT NOT NULL DEFAULT 'todo', hours TEXT NOT NULL DEFAULT '', sort_order INTEGER NOT NULL DEFAULT 0);",
  "CREATE TABLE tutorials (id INTEGER PRIMARY KEY AUTOINCREMENT, goal_id INTEGER NOT NULL, node_id INTEGER NOT NULL, title TEXT NOT NULL DEFAULT '', format TEXT NOT NULL DEFAULT 'md', created_at TEXT NOT NULL);"
].join('\n'));
db.prepare('INSERT INTO goals (id,title,status,created_at,updated_at) VALUES (?,?,?,?,?)').run(1, '测试目标', 'planned', '2026-10-18', '2026-10-18');
db.prepare('INSERT INTO nodes (id,goal_id,parent_id,level,title,detail,status,hours,sort_order) VALUES (?,?,?,?,?,?,?,?,?)').run(11, 1, null, 0, '阶段 A', '', 'doing', '', 0);
db.prepare('INSERT INTO nodes (id,goal_id,parent_id,level,title,detail,status,hours,sort_order) VALUES (?,?,?,?,?,?,?,?,?)').run(12, 1, 11, 1, '任务 A1', '', 'done', '2h', 0);
db.prepare('INSERT INTO nodes (id,goal_id,parent_id,level,title,detail,status,hours,sort_order) VALUES (?,?,?,?,?,?,?,?,?)').run(13, 1, 11, 1, '任务 A2', '下一步说明', 'doing', '3h', 1);
db.prepare('INSERT INTO nodes (id,goal_id,parent_id,level,title,detail,status,hours,sort_order) VALUES (?,?,?,?,?,?,?,?,?)').run(14, 1, null, 0, '阶段 B', '', 'todo', '', 1);
db.prepare('INSERT INTO nodes (id,goal_id,parent_id,level,title,detail,status,hours,sort_order) VALUES (?,?,?,?,?,?,?,?,?)').run(15, 1, 14, 1, '任务 B1', '', 'todo', '1h', 0);
db.prepare('INSERT INTO tutorials (id,goal_id,node_id,title,format,created_at) VALUES (?,?,?,?,?,?)').run(101, 1, 11, '教程 A', 'md', '2026-10-18');

const d = createGoalDomain({ db: db });
let n = 0;
function ok(name, cond) { assert.ok(cond, name); console.log('  ✓ ' + name); n++; }

const leaves = d.orderedLeaves(1);
ok('orderedLeaves 只返回叶子并按兄弟顺序', leaves.length === 3 && leaves[0].id === 12 && leaves[1].id === 13 && leaves[2].id === 15);

const g = db.prepare('SELECT * FROM goals WHERE id = 1').get();
const stats = d.goalWithStats(g);
ok('goalWithStats 统计完成数与下一任务', stats.tasks_total === 3 && stats.tasks_done === 1 && stats.next_task === '任务 A2' && stats.next_task_id === 13);
ok('goalWithStats 给出下一任务路径', stats.next_path === '阶段 A');

const full = d.getGoal(1);
ok('getGoal 带节点与教程', full.id === 1 && full.nodes.length === 5 && full.tutorials.length === 1 && full.tasks_total === 3);
ok('getGoal 不存在返回 null', d.getGoal(999) === null);

const outline = d.roadmapOutline(1);
ok('roadmapOutline 带 id/层级/状态/工时', outline.indexOf('[12] 任务 A1（2h） ✓已完成') >= 0 && outline.indexOf('  [13] 任务 A2（3h） ▶进行中') >= 0);

db.close();
console.log('\n6 项全部通过');
