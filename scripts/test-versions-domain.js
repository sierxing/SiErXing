'use strict';
/**
 * 目标版本领域回归：node --no-warnings scripts/test-versions-domain.js
 * 纯内存 SQLite，不碰真实数据。
 */
const assert = require('node:assert');
const { DatabaseSync } = require('node:sqlite');
const { createVersionDomain } = require('../server/domains/versions.js');

const db = new DatabaseSync(':memory:');
db.exec([
  "CREATE TABLE nodes (id INTEGER PRIMARY KEY AUTOINCREMENT, goal_id INTEGER NOT NULL, parent_id INTEGER, level INTEGER NOT NULL DEFAULT 0, title TEXT NOT NULL, detail TEXT NOT NULL DEFAULT '', artifact TEXT NOT NULL DEFAULT '', acceptance TEXT NOT NULL DEFAULT '', hours TEXT NOT NULL DEFAULT '', sources TEXT NOT NULL DEFAULT '', status TEXT NOT NULL DEFAULT 'todo', sort_order INTEGER NOT NULL DEFAULT 0);",
  "CREATE TABLE goal_versions (id INTEGER PRIMARY KEY AUTOINCREMENT, goal_id INTEGER NOT NULL, reason TEXT NOT NULL DEFAULT '', snapshot TEXT NOT NULL DEFAULT '[]', summary TEXT NOT NULL DEFAULT '', created_at TEXT NOT NULL, snapshot_after TEXT NOT NULL DEFAULT '', manual INTEGER NOT NULL DEFAULT 0, starred INTEGER NOT NULL DEFAULT 0, plan_id INTEGER NOT NULL DEFAULT 0);",
  "CREATE TABLE goals (id INTEGER PRIMARY KEY AUTOINCREMENT, active_plan_id INTEGER NOT NULL DEFAULT 0);"
].join('\n'));
function addNode(id, title, status) {
  db.prepare('INSERT INTO nodes (id,goal_id,parent_id,level,title,status,sort_order) VALUES (?,?,?,?,?,?,?)').run(id, 1, null, 0, title, status || 'todo', id);
}
let compOn = true;
let aiCalls = 0;
const domain = createVersionDomain({
  db: db,
  nowISO: function () { return '2026-10-18T00:00:00.000Z'; },
  safeParse: function (s) { try { return JSON.parse(s || '[]'); } catch (e) { return []; } },
  goalCompOn: function () { return compOn; },
  aiText: async function () { aiCalls++; return 'AI 报告'; },
  currentModel: function () { return 'test-model'; }
});
let n = 0;
function ok(name, cond) { assert.ok(cond, name); console.log('  ✓ ' + name); n++; }

addNode(11, '阶段 A');
addNode(12, '任务 A1');
const vid = domain.beginVersion(1, '测试快照');
ok('beginVersion 写入快照', vid > 0 && JSON.parse(db.prepare('SELECT snapshot FROM goal_versions WHERE id = ?').get(vid).snapshot).length === 2);

compOn = false;
ok('组件关闭时不写版本', domain.beginVersion(1, '关掉') === 0);
compOn = true;

db.prepare("UPDATE nodes SET status = 'done' WHERE id = 12").run();
const diff = domain.diffVersions(JSON.parse(db.prepare('SELECT snapshot FROM goal_versions WHERE id = ?').get(vid).snapshot), db.prepare('SELECT * FROM nodes WHERE goal_id = 1').all());
ok('diffVersions 识别状态变化', diff.changed.length === 1 && diff.changed[0].fields.indexOf('status') >= 0 && diff.total.new === 2);

const report = domain.templateReport('测试快照', diff);
ok('templateReport 含操作与节点数', report.indexOf('测试快照') >= 0 && report.indexOf('2 个节点') >= 0);

const prompt = domain.buildReportPrompt({ title: '测试目标' }, '测试快照', diff);
ok('buildReportPrompt 含目标/操作/当前规模', prompt.indexOf('测试目标') >= 0 && prompt.indexOf('测试快照') >= 0 && prompt.indexOf('2 个节点') >= 0);

(async function () {
  const summary = await domain.finishVersion({ id: 1 }, vid, '测试快照', false);
  const row = db.prepare('SELECT * FROM goal_versions WHERE id = ?').get(vid);
  ok('finishVersion 写 snapshot_after 与 summary', !!summary && row.summary === summary && JSON.parse(row.snapshot_after).length === 2 && aiCalls === 0);

  const vid2 = domain.beginVersion(1, '无变化');
  const r2 = await domain.finishVersion({ id: 1 }, vid2, '无变化', false);
  ok('没有变化时删除空版本', r2 === '' && !db.prepare('SELECT id FROM goal_versions WHERE id = ?').get(vid2));

  db.prepare('DELETE FROM nodes WHERE goal_id = 1').run();
  ok('没有节点时不写版本', domain.beginVersion(1, '空目标') === 0);

  console.log('\n8 项全部通过');
})().catch(function (e) { console.error(e); process.exit(1); });
