'use strict';
/**
 * 思而行 · 修「切过一次方案后教程/笔记/学习记录全不见了」
 * ------------------------------------------------------------------
 * 成因（2026-10-21 的真实翻车）：
 *   切方案 / 恢复历史版本 = 整棵 nodes 删掉再从快照重插，节点 id 全部换新；
 *   而 tutorials.node_id、node_notes.node_id、node_workspaces.node_id …
 *   还指着旧 id，于是全变成孤儿 —— 数据在库里、正文一个字没少，但页面上看不到。
 *   新版本（server/node-identity.js）已经修好；这个脚本用来救**旧版本里已经断掉**的数据。
 *
 * 做法：按「节点标题路径」（阶段 / 小目标 / 任务）把旧 id 搬回新 id，正文/文件不动。
 *   身份从 goal_versions 的历史快照里认（并集），所以批量改名过的节点也能认回来一部分；
 *   实在认不回的（那批节点更早就被删了）只报数，绝不删数据。
 *
 * 用法：
 *   node scripts/repair-plan-switch.js <dbPath> [--goal 166] [--switch-plan 350] [--apply] [--data-dir DIR]
 *     --switch-plan  先按正常逻辑切到该方案（你的教程是在那套树上生成的；等价界面点「切换」）
 *     --apply        真正写库（默认 dry-run：复制副本模拟，原库不动）
 *     --data-dir     数据目录（默认读 data-location.json；workspaces 就在它下面）
 *   ⚠️ 跑之前先退出思而行，避免它在你写库时又切一次方案。脚本会自己备份 db。
 */
const { DatabaseSync } = require('node:sqlite');
const fs = require('node:fs');
const path = require('node:path');
const { createPlanDomain } = require('../server/commands/plan-ops.js');
const { createNodeIdentity } = require('../server/node-identity.js');

const args = process.argv.slice(2);
const DB = args[0];
const APPLY = args.includes('--apply');
const getArg = (n, d) => { const i = args.indexOf(n); return i >= 0 ? args[i + 1] : d; };
const GID = Number(getArg('--goal', '166'));
const SWITCH_PLAN = Number(getArg('--switch-plan', '0')) || 0;
if (!DB || !fs.existsSync(DB)) {
  console.error('用法: node scripts/repair-plan-switch.js <dbPath> [--goal 166] [--switch-plan 350] [--apply] [--data-dir DIR]');
  process.exit(1);
}
/* 数据目录：优先 --data-dir，其次程序目录的 data-location.json（workspaces 跟着它走） */
const DATA_DIR = (function () {
  const explicit = getArg('--data-dir', '');
  if (explicit) return path.resolve(explicit);
  try {
    const j = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'data-location.json'), 'utf8'));
    if (j && j.dir && fs.existsSync(j.dir)) return j.dir;
  } catch (e) {}
  return path.dirname(path.resolve(DB));
})();
const WS_ROOT = path.join(DATA_DIR, 'workspaces');
console.log('数据目录：' + DATA_DIR);
if (!fs.existsSync(WS_ROOT)) console.log('⚠️ 这个目录下没有 workspaces，代码目录部分会被跳过');

/* ---------- 连接：dry-run 但需要切方案时写副本 ---------- */
let WORK_DB = DB;
if (APPLY) {
  const bak = DB.replace(/\.db$/, '') + '.bak-repair-' + new Date().toISOString().replace(/[-:T]/g, '').slice(0, 14) + '.db';
  fs.copyFileSync(DB, bak);
  console.log('已备份数据库 →', bak);
} else if (SWITCH_PLAN) {
  WORK_DB = DB.replace(/\.db$/, '') + '.dryrun-' + process.pid + '.db';
  fs.copyFileSync(DB, WORK_DB);
  console.log('（dry-run：在副本 ' + path.basename(WORK_DB) + ' 上模拟，原库不动）');
}
const WRITABLE = APPLY || !!SWITCH_PLAN;
const db = new DatabaseSync(WORK_DB, { readOnly: !WRITABLE });
const q = (s, ...a) => db.prepare(s).all(...a);
const one = (s, ...a) => db.prepare(s).get(...a);
const run = (s, ...a) => (WRITABLE ? db.prepare(s).run(...a) : { changes: 1 });
const nowISO = () => new Date().toISOString();
const safeParse = s => { try { return JSON.parse(s || '[]'); } catch (e) { return []; } };

/* ---------- 复用 server.js 的 insertNode 语义（含父子条件继承） ---------- */
function insertNode(goalId, parentId, level, title, detail, sources, sortOrder, extra) {
  const t = nowISO(), ex = extra || {};
  let cid = Number(ex.condition_id) || 0;
  if (!cid && parentId) { const p = one('SELECT condition_id FROM nodes WHERE id=?', Number(parentId)); cid = Number(p && p.condition_id) || 0; }
  db.prepare('INSERT INTO nodes (goal_id,parent_id,level,title,detail,artifact,acceptance,hours,sources,status,condition_id,sort_order,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)')
    .run(goalId, parentId || null, level, String(title || '').trim().slice(0, 200), String(detail || '').trim().slice(0, 2000),
      String(ex.artifact || '').trim().slice(0, 500), String(ex.acceptance || '').trim().slice(0, 500), String(ex.hours || '').trim().slice(0, 50),
      JSON.stringify(Array.isArray(sources) ? sources : safeParse(sources)), 'todo', cid, sortOrder || 0, t, t);
  return Number(one('SELECT last_insert_rowid() AS id').id);
}
function beginVersion(goalId, reason) {
  const nodes = q('SELECT * FROM nodes WHERE goal_id=? ORDER BY level,sort_order,id', goalId);
  if (!nodes.length) return 0;
  const g = one('SELECT active_plan_id FROM goals WHERE id=?', goalId);
  const r = db.prepare('INSERT INTO goal_versions (goal_id,reason,snapshot,summary,plan_id,created_at) VALUES (?,?,?,?,?,?)')
    .run(goalId, reason, JSON.stringify(nodes), '', Number((g && g.active_plan_id) || 0), nowISO());
  return Number(r.lastInsertRowid);
}
const identity = createNodeIdentity({ db, DATA_DIR, safeParse });
const domain = createPlanDomain({
  db, nowISO, safeParse, insertNode, beginVersion, backup() {},
  getGoal: id => one('SELECT * FROM goals WHERE id=?', id), repair: identity
});

/* ================= 0. 需要的话切回丢教程时用的那份方案 ================= */
if (SWITCH_PLAN) {
  const r = domain.switchTo(GID, SWITCH_PLAN);
  console.log('已切到方案「' + r.name + '」：' + r.nodes + ' 个节点（id 会全部换新，这正是教程挂掉的原因）');
}

/* ================= 1. 修：按标题路径把旧 id 搬回新 id ================= */
const before = identity.index(GID);
identity.begin(GID, before);
const allSlots = identity.slots(GID);
const stats = identity.rebind(GID, []);
const endInfo = identity.end();

const TABLES = ['tutorials', 'tutorial_progress', 'tutorial_bookmarks', 'node_notes', 'study_records', 'study_segments',
  'restate_rounds', 'quiz_sessions', 'explain_sessions', 'chat_sessions', 'task_runs', 'interview_sessions'];
console.log('\n== 按标题路径重绑 ==');
let totalMoved = 0, totalDangling = 0;
for (const t of TABLES) {
  let total = 0, attached = 0;
  try { total = one('SELECT count(*) c FROM ' + t + ' WHERE goal_id=?', GID).c; } catch (e) { continue; }
  try { attached = one('SELECT count(*) c FROM ' + t + ' x WHERE x.goal_id=? AND EXISTS(SELECT 1 FROM nodes n WHERE n.id=x.node_id)', GID).c; } catch (e) {}
  const moved = stats.moved[t] || 0;
  totalMoved += moved;
  totalDangling += (total - attached);
  console.log('  ' + t.padEnd(22), '共', String(total).padStart(4), '| 搬回', String(moved).padStart(4), '| 仍悬空', total - attached);
}
if (stats.unresolved) console.log('  另有', stats.unresolved, '条认不回（历史上被删过的节点），已原样保留');

/* ================= 2. 代码目录：把旧目录认回新节点 ================= */
let relinked = 0;
const countFiles = rel => { let c = 0; const walk = d => { let e = []; try { e = fs.readdirSync(d, { withFileTypes: true }); } catch (x) { return; } for (const x of e) if (x.isDirectory()) walk(d + '/' + x.name); else c++; }; walk(rel); return c; };
for (const n of before.rows) {
  const oldPath = allSlots.get(Number(n.id)) || '';
  if (!oldPath || !fs.existsSync(path.join(WS_ROOT, oldPath))) continue;
  const target = one('SELECT id FROM nodes WHERE goal_id=? AND title=? ORDER BY id LIMIT 1', GID, String(n.title));
  if (!target) continue;
  const nowPath = identity.wsPathOf(target.id);
  const t = nowISO();
  if (!nowPath) {
    run('INSERT OR REPLACE INTO node_workspaces (node_id,goal_id,path,created_at,updated_at) VALUES (?,?,?,?,?)', target.id, GID, oldPath, t, t);
    relinked++;
  } else if (nowPath !== oldPath && countFiles(path.join(WS_ROOT, nowPath)) === 0) {
    run('UPDATE node_workspaces SET path=? WHERE node_id=? AND goal_id=?', oldPath, target.id, GID);
    relinked++;
  }
}
/* 2b. 还有节点没有目录映射的（旧代码把档案行一起删过），按 workspace 插件同一套规则补建；
      能复用磁盘上同名旧目录就复用（不搬家），复不了才新建空目录。 */
let createdDirs = 0;
const wsSeg = title => String(title || '').replace(/[\\/:*?"<>|\r\n\t]/g, '').replace(/\s+/g, ' ').trim().slice(0, 40) || '未命名';
const liveRows = q('SELECT id,parent_id,title FROM nodes WHERE goal_id=? ORDER BY level,sort_order,id', GID);
const wsNow = () => new Map(q('SELECT node_id,path FROM node_workspaces WHERE goal_id=?', GID).map(r => [Number(r.node_id), r.path]));
/* 磁盘上所有已有目录（按「最后一段名字 + 父路径」索引），用于复用旧目录 */
const diskIndex = new Map();
(function walkDir(rel) {
  const abs = path.join(WS_ROOT, rel);
  let ents = []; try { ents = fs.readdirSync(abs, { withFileTypes: true }); } catch (e) { return; }
  for (const e of ents) {
    if (!e.isDirectory()) continue;
    const childRel = rel + '/' + e.name;
    const base = e.name.replace(/\(\d+\)$/, '').trim();
    (diskIndex.get(base) || diskIndex.set(base, []).get(base)).push(childRel);
    walkDir(childRel);
  }
})('goal-' + GID);
for (const n of liveRows) {
  const m = wsNow();
  if (m.has(Number(n.id))) continue;
  const parentPath = n.parent_id ? (m.get(Number(n.parent_id)) || null) : ('goal-' + GID);
  if (!parentPath) continue;                       // 父节点还没安排好，下一轮（按层序保证不会发生）
  const base = wsSeg(n.title);
  /* ① 复用磁盘上同名的旧目录（父目录一致才认，避免目录树错位） */
  const cand = (diskIndex.get(String(n.title).trim()) || []).find(rel => path.dirname(rel) === parentPath);
  let rel = cand || (parentPath + '/' + base);
  if (!cand) {
    let name = base, k = 2;
    while (fs.existsSync(path.join(WS_ROOT, rel))) rel = parentPath + '/' + base + '(' + (k++) + ')';
    try { fs.mkdirSync(path.join(WS_ROOT, rel), { recursive: true }); } catch (e) {}
  }
  const t = nowISO();
  run('INSERT OR REPLACE INTO node_workspaces (node_id,goal_id,path,created_at,updated_at) VALUES (?,?,?,?,?)', n.id, GID, rel, t, t);
  createdDirs++;
}
console.log('\n== 代码目录 ==');
console.log('  回挂有文件的旧目录', relinked, '条 | 复用/补建目录', createdDirs, '条 | 清理失效档案行', endInfo.prunedRows, '条');

/* ================= 2c. 可选：清掉「没有任何节点在用」的空目录 =================
   以前每切一次方案，workspace 插件会给新节点建一套新目录（名字相同就加 (2)(3)），
   旧目录留着。这些空壳没有文件、也没被任何节点映射引用，删掉只会让目录树变干净。
   有文件的目录、以及被任何节点映射引用的目录，一律不动。 */
if (args.includes('--clean-empty-dirs')) {
  const used = new Set(q('SELECT path FROM node_workspaces WHERE goal_id=?', GID).map(r => String(r.path)));
  let removed = 0;
  const all = [];
  (function walk(rel) {
    const abs = path.join(WS_ROOT, rel);
    let ents = []; try { ents = fs.readdirSync(abs, { withFileTypes: true }); } catch (e) { return; }
    for (const e of ents) if (e.isDirectory()) { const childRel = rel + '/' + e.name; all.push(childRel); walk(childRel); }
  })('goal-' + GID);
  for (const rel of all.sort((a, b) => b.length - a.length)) {
    if (used.has(rel)) continue;
    try { fs.rmdirSync(path.join(WS_ROOT, rel)); removed++; } catch (e) { /* 非空：留着 */ }
  }
  console.log('\n== 清空壳目录 ==\n  删掉', removed, '个没有任何节点在用、也没有文件的空目录');
}

/* ================= 3. 复查 ================= */
const tutTotal = one('SELECT count(*) c FROM tutorials WHERE goal_id=?', GID).c;
const tutOrphan = one('SELECT count(*) c FROM tutorials t WHERE t.goal_id=? AND NOT EXISTS(SELECT 1 FROM nodes n WHERE n.id=t.node_id)', GID).c;
const orphanIds = q('SELECT id FROM tutorials t WHERE t.goal_id=? AND NOT EXISTS(SELECT 1 FROM nodes n WHERE n.id=t.node_id)', GID).map(r => r.id);
const wsAll = q('SELECT node_id,path FROM node_workspaces WHERE goal_id=?', GID);
const wsMissing = wsAll.filter(r => !fs.existsSync(path.join(WS_ROOT, r.path))).length;
console.log('\n== 修复后 ==');
console.log('  教程', tutTotal, '篇 | 挂回节点', tutTotal - tutOrphan, '篇 | 仍悬空', tutOrphan, '篇' + (orphanIds.length ? '（教程 id：' + orphanIds.join(',') + '；那批节点早前已被删除，正文完整保留）' : ''));
console.log('  代码目录映射', wsAll.length, '条 | 磁盘上不存在的', wsMissing);
if (WORK_DB !== DB) { try { fs.unlinkSync(WORK_DB); } catch (e) {} console.log('\n（dry-run 结束，副本已删，原库未动；加 --apply 落库）'); }
else console.log(APPLY ? '\n✅ 已写入 ' + DB : '\n（dry-run，未写入；加 --apply 落库）');
