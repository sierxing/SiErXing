'use strict';
/**
 * 节点身份延续回归：node --no-warnings scripts/test-plan-identity.js
 * 纯内存 SQLite + 临时目录，不碰真实数据。
 *
 * 钉住「切方案 / 恢复版本后，教程、节点笔记、学习记录、代码目录全都还在」——
 * 2026-10-21 的真实翻车：整棵 nodes 重建（id 全换）后，按 node_id 挂的数据全成孤儿，
 * 用户看到的是「我原来目标下的教程全没了」。
 */
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');
const { createPlanDomain } = require('../server/commands/plan-ops.js');
const { createNodeIdentity } = require('../server/node-identity.js');

const DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'sx-identity-'));
process.on('exit', () => { try { fs.rmSync(DATA_DIR, { recursive: true, force: true }); } catch (e) {} });

const db = new DatabaseSync(':memory:');
db.exec([
  "CREATE TABLE goals (id INTEGER PRIMARY KEY AUTOINCREMENT, title TEXT NOT NULL DEFAULT '', status TEXT NOT NULL DEFAULT 'draft', error TEXT NOT NULL DEFAULT '', active_plan_id INTEGER NOT NULL DEFAULT 0, updated_at TEXT NOT NULL DEFAULT '');",
  "CREATE TABLE nodes (id INTEGER PRIMARY KEY AUTOINCREMENT, goal_id INTEGER NOT NULL, parent_id INTEGER, level INTEGER NOT NULL DEFAULT 0, title TEXT NOT NULL, detail TEXT NOT NULL DEFAULT '', artifact TEXT NOT NULL DEFAULT '', acceptance TEXT NOT NULL DEFAULT '', hours TEXT NOT NULL DEFAULT '', sources TEXT NOT NULL DEFAULT '[]', status TEXT NOT NULL DEFAULT 'todo', condition_id INTEGER NOT NULL DEFAULT 0, sort_order INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL DEFAULT '', updated_at TEXT NOT NULL DEFAULT '');",
  "CREATE TABLE goal_versions (id INTEGER PRIMARY KEY AUTOINCREMENT, goal_id INTEGER NOT NULL, reason TEXT NOT NULL DEFAULT '', snapshot TEXT NOT NULL DEFAULT '[]', summary TEXT NOT NULL DEFAULT '', created_at TEXT NOT NULL, manual INTEGER NOT NULL DEFAULT 0, starred INTEGER NOT NULL DEFAULT 0, snapshot_after TEXT NOT NULL DEFAULT '', plan_id INTEGER NOT NULL DEFAULT 0);",
  "CREATE TABLE goal_conditions (id INTEGER PRIMARY KEY AUTOINCREMENT, goal_id INTEGER NOT NULL, title TEXT NOT NULL DEFAULT '');",
  "CREATE TABLE node_workspaces (node_id INTEGER PRIMARY KEY, goal_id INTEGER NOT NULL DEFAULT 0, path TEXT NOT NULL DEFAULT '', created_at TEXT NOT NULL, updated_at TEXT NOT NULL);",
  "CREATE TABLE tutorials (id INTEGER PRIMARY KEY AUTOINCREMENT, goal_id INTEGER NOT NULL, node_id INTEGER NOT NULL, title TEXT NOT NULL DEFAULT '', format TEXT NOT NULL DEFAULT 'md', content TEXT NOT NULL DEFAULT '', created_at TEXT NOT NULL DEFAULT '', updated_at TEXT NOT NULL DEFAULT '');",
  "CREATE TABLE node_notes (id INTEGER PRIMARY KEY AUTOINCREMENT, node_id INTEGER NOT NULL, goal_id INTEGER NOT NULL DEFAULT 0, content TEXT NOT NULL DEFAULT '', created_at TEXT NOT NULL DEFAULT '', updated_at TEXT NOT NULL DEFAULT '');",
  "CREATE TABLE study_records (id INTEGER PRIMARY KEY AUTOINCREMENT, goal_id INTEGER NOT NULL DEFAULT 0, node_id INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL DEFAULT '');",
  "CREATE TABLE tutorial_progress (id INTEGER PRIMARY KEY AUTOINCREMENT, tutorial_id INTEGER NOT NULL, goal_id INTEGER NOT NULL DEFAULT 0, node_id INTEGER NOT NULL DEFAULT 0, section_idx INTEGER NOT NULL DEFAULT 0, sections_total INTEGER NOT NULL DEFAULT 0, updated_at TEXT NOT NULL DEFAULT '');"
].join('\n'));
db.prepare("INSERT INTO goals (id, title, status) VALUES (1, '测试目标', 'planned')").run();

const nowISO = () => '2026-10-22T00:00:00.000Z';
const safeParse = s => { try { return JSON.parse(s || '[]'); } catch (e) { return []; } };
function insertNode(goalId, parentId, level, title, detail, sources, sortOrder, extra) {
  const ex = extra || {};
  const t = nowISO();
  const info = db.prepare('INSERT INTO nodes (goal_id,parent_id,level,title,detail,artifact,acceptance,hours,sources,status,condition_id,sort_order,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)')
    .run(goalId, parentId || null, level, String(title || ''), String(detail || ''), String(ex.artifact || ''), String(ex.acceptance || ''), String(ex.hours || ''), JSON.stringify(Array.isArray(sources) ? sources : safeParse(sources)), 'todo', Number(ex.condition_id) || 0, sortOrder || 0, t, t);
  return Number(info.lastInsertRowid);
}
function beginVersion(goalId, reason) {
  const nodes = db.prepare('SELECT * FROM nodes WHERE goal_id = ? ORDER BY level, sort_order, id').all(goalId);
  if (!nodes.length) return 0;
  const g = db.prepare('SELECT active_plan_id FROM goals WHERE id = ?').get(goalId);
  const r = db.prepare('INSERT INTO goal_versions (goal_id,reason,snapshot,summary,plan_id,created_at) VALUES (?,?,?,?,?,?)')
    .run(goalId, reason, JSON.stringify(nodes), '', Number((g && g.active_plan_id) || 0), nowISO());
  return Number(r.lastInsertRowid);
}
/* 模拟 workspace 插件：建节点即建目录（带同名 (2) 后缀规则） */
const WS_ROOT = path.join(DATA_DIR, 'workspaces');
let wsInsertNode;   /* 下面定义：建完节点顺手建目录（与 server.js 的 insertNode 一样） */
function wsEnsure(goalId, nodeId) {
  const hit = db.prepare('SELECT path FROM node_workspaces WHERE node_id = ?').get(nodeId);
  if (hit && hit.path) { fs.mkdirSync(path.join(WS_ROOT, hit.path), { recursive: true }); return hit.path; }
  const chain = []; let cur = db.prepare('SELECT id,goal_id,parent_id,title FROM nodes WHERE id = ?').get(nodeId);
  while (cur) { chain.unshift(cur); cur = cur.parent_id ? db.prepare('SELECT * FROM nodes WHERE id = ?').get(cur.parent_id) : null; }
  let rel = 'goal-' + goalId;
  for (const n of chain) {
    const m = db.prepare('SELECT path FROM node_workspaces WHERE node_id = ?').get(Number(n.id));
    if (m) { rel = m.path; continue; }
    const seg = String(n.title || '').replace(/[\\/:*?"<>|]/g, '').slice(0, 40) || '未命名';
    let name = seg, k = 2;
    while (fs.existsSync(path.join(WS_ROOT, rel || '', name))) name = seg + '(' + (k++) + ')';
    rel = rel ? rel + '/' + name : name;
    fs.mkdirSync(path.join(WS_ROOT, rel), { recursive: true });
    db.prepare('INSERT OR REPLACE INTO node_workspaces (node_id,goal_id,path,created_at,updated_at) VALUES (?,?,?,?,?)').run(Number(n.id), goalId, rel, nowISO(), nowISO());
  }
  return rel;
}

/* 与 server.js 一致：insertNode 建完节点就回调 workspace 建目录 */
wsInsertNode = function (goalId, parentId, level, title, detail, sources, sortOrder, extra) {
  const id = rawInsert(goalId, parentId, level, title, detail, sources, sortOrder, extra);
  wsEnsure(goalId, id);
  return id;
};

const identity = createNodeIdentity({ db, DATA_DIR, safeParse });
const domain = createPlanDomain({
  db, nowISO, safeParse, insertNode: wsInsertNode, beginVersion,
  backup() {}, getGoal: id => db.prepare('SELECT * FROM goals WHERE id = ?').get(id),
  repair: identity
});
/* insertNode 挂钩：模拟宿主 server.js 建节点即建目录 */
const rawInsert = insertNode;
let n = 0;
function ok(name, cond, extra) { assert.ok(cond, name + (extra ? '（' + extra + '）' : '')); console.log('  ✓ ' + name); n++; }

/* ---------- 方案甲：3 个节点，教程/笔记/学习记录/代码目录都挂上 ---------- */
const a = rawInsert(1, null, 0, '阶段一', '', [], 0); wsEnsure(1, a);
const a1 = rawInsert(1, a, 1, '任务 A1', '', [], 0); wsEnsure(1, a1);
const a2 = rawInsert(1, a, 1, '任务 A2', '', [], 1); wsEnsure(1, a2);
db.prepare("INSERT INTO tutorials (goal_id,node_id,title,content) VALUES (1,?,?,?)").run(a1, '任务A1教程', '正文A1');
db.prepare("INSERT INTO tutorials (goal_id,node_id,title,content) VALUES (1,?,?,?)").run(a2, '任务A2教程', '正文A2');
db.prepare('INSERT INTO node_notes (node_id,goal_id,content) VALUES (?,1,?)').run(a1, '笔记A1');
db.prepare("INSERT INTO study_records (goal_id,node_id) VALUES (1,?)").run(a1);
db.prepare("INSERT INTO tutorial_progress (tutorial_id,goal_id,node_id,section_idx,sections_total) VALUES (1,1,?,3,10)").run(a1);
/* 用户默认方案里给 A1 的目录写了一个文件 */
const a1Dir = db.prepare('SELECT path FROM node_workspaces WHERE node_id=?').get(a1).path;
fs.writeFileSync(path.join(WS_ROOT, a1Dir, 'note.md'), 'A1 的代码/笔记');

const saved = domain.saveCurrent(1, '方案甲');
ok('把当前路径存成方案甲', saved.planId > 0 && db.prepare('SELECT COUNT(*) c FROM nodes WHERE goal_id=1').get().c === 3);

/* ---------- 方案乙：另一棵树（只有 1 个阶段 + 1 个任务），切过去 ---------- */
const other = domain.applyStages(1, '方案乙', [
  { title: '阶段X', goals: [{ title: '任务X1' }] },
  { title: '阶段Y' }
]);
const switched = domain.switchTo(1, other.planId);
ok('切到方案乙：节点数变成方案乙的 3 个', switched.nodes === 3, '实际 ' + switched.nodes);
ok('现在树上真的是方案乙的标题', (function () {
  const titles = db.prepare('SELECT title FROM nodes WHERE goal_id=1 ORDER BY id').all().map(r => r.title);
  return titles.indexOf('阶段X') >= 0 && titles.indexOf('阶段一') < 0;
})(), JSON.stringify(db.prepare('SELECT title FROM nodes WHERE goal_id=1 ORDER BY id').all().map(r => r.title)));

/* ---------- 切回方案甲：教程/笔记/记录/目录必须都回来 ---------- */
const back = domain.switchTo(1, saved.planId);
ok('切回方案甲：节点数恢复 3 个', back.nodes === 3);
ok('切回后真的是方案甲的标题', (function () {
  const titles = db.prepare('SELECT title FROM nodes WHERE goal_id=1 ORDER BY id').all().map(r => r.title);
  return titles.indexOf('阶段一') >= 0 && titles.indexOf('阶段X') < 0;
})(), JSON.stringify(db.prepare('SELECT title FROM nodes WHERE goal_id=1 ORDER BY id').all().map(r => r.title)));
const newIds = db.prepare('SELECT id FROM nodes WHERE goal_id=1 ORDER BY id').all().map(r => Number(r.id));
ok('切回后节点 id 已全部换新（正是断链的根因）', newIds.every(id => id > a2), JSON.stringify(newIds));

const tuts = db.prepare('SELECT t.id, t.title, t.node_id, n.title AS node_title FROM tutorials t LEFT JOIN nodes n ON n.id = t.node_id WHERE t.goal_id=1 ORDER BY t.id').all();
ok('2 篇教程都还挂在新节点上（不是孤儿）', tuts.length === 2 && tuts.every(t => t.node_title), JSON.stringify(tuts.map(t => t.id + '→' + t.node_title)));
ok('教程挂到标题相同的那个节点（任务A1 → 新的任务 A1）', tuts[0].node_title === '任务 A1' && tuts[1].node_title === '任务 A2');
ok('教程正文没有被改动', db.prepare('SELECT content FROM tutorials WHERE id=1').get().content === '正文A1');
ok('节点笔记跟着回到「任务 A1」', db.prepare("SELECT n.title t FROM node_notes x JOIN nodes n ON n.id=x.node_id WHERE x.goal_id=1").get().t === '任务 A1');
ok('学习记录跟着回到新节点', (function () {
  const r = db.prepare('SELECT n.title t FROM study_records x JOIN nodes n ON n.id=x.node_id WHERE x.goal_id=1').get();
  return !!r && r.t === '任务 A1';
})());
ok('教程阅读进度跟着回到新节点', (function () {
  const r = db.prepare('SELECT n.title t, x.section_idx i FROM tutorial_progress x JOIN nodes n ON n.id=x.node_id WHERE x.goal_id=1').get();
  return !!r && r.t === '任务 A1' && r.i === 3;
})());

/* ---------- 代码目录：沿用旧目录（里面的文件还在同一个节点下） ---------- */
const a1After = db.prepare('SELECT id FROM nodes WHERE goal_id=1 AND title=?').get('任务 A1').id;
const a1Path = db.prepare('SELECT path FROM node_workspaces WHERE node_id=?').get(a1After);
ok('「任务 A1」的代码目录沿用原来那个（下班还在）', !!a1Path && a1Path.path === a1Dir,
  '期望 ' + a1Dir + ' 实际 ' + (a1Path && a1Path.path) + ' | 全部映射 ' + JSON.stringify(db.prepare('SELECT node_id,path FROM node_workspaces WHERE goal_id=1').all()));
ok('目录里的文件还在（切方案不会搬走/清空用户文件）', fs.existsSync(path.join(WS_ROOT, a1Dir, 'note.md')));
ok('每个存活节点都还有目录映射（不会出现空映射）', (function () {
  const rows = db.prepare('SELECT node_id FROM node_workspaces WHERE goal_id=1').all().map(r => Number(r.node_id));
  const live = db.prepare('SELECT id FROM nodes WHERE goal_id=1').all().map(r => Number(r.id));
  return live.every(id => rows.indexOf(id) >= 0);
})(), JSON.stringify(db.prepare('SELECT node_id,path FROM node_workspaces WHERE goal_id=1').all()));
ok('回滚后「阶段一」没有留下 (2)/(3) 空壳目录', (function () {
  const top = fs.readdirSync(path.join(WS_ROOT, 'goal-1'));
  return top.filter(d => /^阶段一\(\d+\)$/.test(d)).length === 0;
})(), JSON.stringify(fs.readdirSync(path.join(WS_ROOT, 'goal-1'))));

/* ---------- 恢复历史版本（另一条换树路径）也要保住教程 ---------- */
const vidBefore = beginVersion(1, '手动存档');
db.prepare('UPDATE nodes SET title=? WHERE id=?').run('任务 A1（改名）', a1After);
const restored = domain.restoreVersion(vidBefore);
ok('恢复历史版本成功', restored.nodes === 3);
const tuts2 = db.prepare('SELECT t.id, n.title t2 FROM tutorials t LEFT JOIN nodes n ON n.id=t.node_id WHERE t.goal_id=1').all();
ok('恢复版本后教程还挂得上（标题改过的那个认不回来是预期：只搬得回没改名的）', tuts2.length === 2 && tuts2.some(t => t.t2), JSON.stringify(tuts2));

/* ---------- 节点被彻底删掉的，数据保留成孤儿但不丢 ---------- */
db.prepare('DELETE FROM nodes WHERE goal_id=1 AND title=?').run('任务 A2');
const orphan = db.prepare('SELECT COUNT(*) c FROM tutorials t WHERE t.goal_id=1 AND NOT EXISTS(SELECT 1 FROM nodes n WHERE n.id=t.node_id)').get().c;
ok('节点被删后，教程变成孤儿但正文仍完整（不删用户内容）', orphan >= 0 && db.prepare('SELECT COUNT(*) c FROM tutorials WHERE goal_id=1').get().c === 2);

console.log('\n通过 ' + n + ' 项');
