'use strict';
/**
 * 命令实现（写命令 + 审批/审计表）回归：node --no-warnings scripts/test-commands-write.js
 *
 * 用内存 SQLite，不碰真实数据。
 * 钉住：goal.create / node.create / node.update / node.complete / goal.update /
 *       brief.goal / audit.list / approvals 存储 / manifest。
 */
const assert = require('node:assert');
const { DatabaseSync } = require('node:sqlite');
const createCommands = require('../server/commands/index.js');

const db = new DatabaseSync(':memory:');
db.exec([
  'CREATE TABLE goals (id INTEGER PRIMARY KEY AUTOINCREMENT, title TEXT NOT NULL, profile TEXT NOT NULL DEFAULT \'\', materials TEXT NOT NULL DEFAULT \'\', weekly_hours TEXT NOT NULL DEFAULT \'\', deadline TEXT NOT NULL DEFAULT \'\', status TEXT NOT NULL DEFAULT \'draft\', summary TEXT NOT NULL DEFAULT \'\', created_at TEXT NOT NULL, updated_at TEXT NOT NULL);',
  'CREATE TABLE nodes (id INTEGER PRIMARY KEY AUTOINCREMENT, goal_id INTEGER NOT NULL, parent_id INTEGER, level INTEGER NOT NULL DEFAULT 0, title TEXT NOT NULL, detail TEXT NOT NULL DEFAULT \'\', artifact TEXT NOT NULL DEFAULT \'\', acceptance TEXT NOT NULL DEFAULT \'\', hours TEXT NOT NULL DEFAULT \'\', sources TEXT NOT NULL DEFAULT \'[]\', status TEXT NOT NULL DEFAULT \'todo\', sort_order INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL, updated_at TEXT NOT NULL);',
  'CREATE TABLE tutorials (id INTEGER PRIMARY KEY AUTOINCREMENT, goal_id INTEGER NOT NULL, node_id INTEGER NOT NULL, title TEXT NOT NULL DEFAULT \'\', format TEXT NOT NULL DEFAULT \'md\', content TEXT NOT NULL DEFAULT \'\', created_at TEXT NOT NULL, updated_at TEXT NOT NULL);',
  'CREATE TABLE sources (id INTEGER PRIMARY KEY AUTOINCREMENT, goal_id INTEGER NOT NULL, title TEXT NOT NULL DEFAULT \'\', url TEXT NOT NULL DEFAULT \'\', site TEXT NOT NULL DEFAULT \'\', kind TEXT NOT NULL DEFAULT \'\', snippet TEXT NOT NULL DEFAULT \'\', content TEXT NOT NULL DEFAULT \'\', published_at TEXT NOT NULL DEFAULT \'\', created_at TEXT NOT NULL, quality INTEGER NOT NULL DEFAULT 0);',
  'CREATE TABLE source_digests (id INTEGER PRIMARY KEY AUTOINCREMENT, goal_id INTEGER NOT NULL, topic TEXT NOT NULL DEFAULT \'\', title TEXT NOT NULL DEFAULT \'\', content TEXT NOT NULL DEFAULT \'\', sources_count INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL);'
].join('\n'));

const nowISO = function () { return new Date().toISOString(); };
function goalWithStats(g) {
  const nodes = db.prepare('SELECT * FROM nodes WHERE goal_id = ?').all(g.id);
  const done = nodes.filter(function (n) { return n.status === 'done'; }).length;
  const next = nodes.find(function (n) { return n.status !== 'done'; });
  return Object.assign({}, g, {
    tasks_total: nodes.length,
    tasks_done: done,
    next_task: next ? next.title : '',
    next_task_id: next ? next.id : null,
    next_path: ''
  });
}
function getGoal(id) {
  const g = db.prepare('SELECT * FROM goals WHERE id = ?').get(id);
  if (!g) return null;
  const nodes = db.prepare('SELECT * FROM nodes WHERE goal_id = ? ORDER BY level, sort_order, id').all(id);
  const tutorials = db.prepare('SELECT id, node_id, title, format, created_at FROM tutorials WHERE goal_id = ?').all(id);
  return Object.assign({}, goalWithStats(g), { nodes: nodes, tutorials: tutorials });
}

const settingMap = new Map();
const comps = [
  { id: 'plan', name: '规划', scope: 'core', kind: 'feature', defaultEnabled: true, enabled: true },
  { id: 'pomodoro', name: '番茄钟', scope: 'extra', kind: 'feature', defaultEnabled: true, enabled: true }
];
const deleted = { goal: 0, node: 0 };
const openedRoutes = [];
const installed = [];
const uninstalled = [];
const goalChanges = [];
let sourceChanges = 0;
let backupCount = 0;
const commands = createCommands({
  db: db, getGoal: getGoal, goalWithStats: goalWithStats, nowISO: nowISO, version: 'test',
  getSetting: function (k, d) { return settingMap.has(k) ? settingMap.get(k) : d; },
  setSetting: function (k, v) { settingMap.set(k, v); },
  backup: function () { backupCount++; },
  deleteGoal: function (id) {
    deleted.goal = id;
    db.prepare('DELETE FROM nodes WHERE goal_id = ?').run(id);
    db.prepare('DELETE FROM goals WHERE id = ?').run(id);
  },
  deleteNode: function (id) {
    deleted.node = id;
    const row = db.prepare('SELECT goal_id FROM nodes WHERE id = ?').get(id);
    db.prepare('DELETE FROM nodes WHERE id = ?').run(id);
    return row ? { node: { id: id }, goal: null } : null;
  },
  listComponents: function () { return comps; },
  describeComponent: function (id) { return comps.find(function (c) { return c.id === id; }) || null; },
  toggleComponent: function (id, enabled) {
    const c = comps.find(function (x) { return x.id === id; });
    if (!c) { const e = new Error('组件不存在'); e.code = 'not_found'; throw e; }
    if (c.scope === 'core') { const e = new Error('核心组件不可关闭'); e.code = 'forbidden'; throw e; }
    c.enabled = !!enabled;
    return c;
  },
  exportComponent: function (id) { return { format: 'sierxing-component', id: id, server: 'module.exports = { id: "' + id + '" };' }; },
  validateComponent: function (bundle) {
    if (!bundle || !bundle.id) { const e = new Error('缺少 id'); e.code = 'bad_input'; throw e; }
    return { id: bundle.id, name: bundle.name || bundle.id, sizes: { server: String(bundle.server || '').length }, hash: 'h' };
  },
  installComponent: function (bundle) {
    installed.push(bundle.id);
    return { id: bundle.id, loaded: 1, replaced: false, summary: { id: bundle.id } };
  },
  uninstallComponent: function (id) {
    uninstalled.push(id);
    return { id: id, removed: true };
  },
  recordGoalChange: function (id, before, after, source) {
    goalChanges.push({ id: id, source: source, before: before, after: after });
  },
  onSourceChanged: function () { sourceChanges++; },
  startTutorialGeneration: function (nodeId, opts) {
    return { taskId: 901, nodeId: nodeId, goalId: 1, format: (opts && opts.format) === 'html' ? 'html' : 'md', title: '生成教程' };
  },
  startTutorialEdit: async function (tutorialId, feedback, opts) {
    return { taskId: 902, tutorialId: tutorialId, sessionId: 0, feedback: feedback, allowRestructure: !!(opts && opts.allowRestructure) };
  },
  startSourceCollect: function (goalId) {
    return { taskId: 903, goalId: goalId, title: '搜集信息源' };
  },
  startSourceDigest: function (goalId) {
    return { taskId: 904, goalId: goalId, title: '资料提炼' };
  },
  startGoalPlan: function (goalId) {
    return { taskId: 905, goalId: goalId, title: '生成规划' };
  },
  openApp: function (route) {
    openedRoutes.push(route);
    return { ok: true, url: 'http://localhost:3213/' + route };
  }
});
let n = 0;
function T(name, fn) { return Promise.resolve().then(fn).then(function () { console.log('  ✓ ' + name); n++; }); }

(async function () {
  let goalId = 0;
  let node1 = 0;
  let node2 = 0;

  await T('goal.create 写入 goals', async function () {
    const r = await commands.run('goal.create', { title: '测试目标', weekly_hours: '5', deadline: '1 个月' });
    assert.ok(r.goalId > 0);
    goalId = r.goalId;
    const row = db.prepare('SELECT * FROM goals WHERE id = ?').get(goalId);
    assert.strictEqual(row.title, '测试目标');
    assert.strictEqual(row.status, 'draft');
  });

  await T('node.create 顶层节点 level=0', async function () {
    const r = await commands.run('node.create', { goalId: goalId, title: '第一步', acceptance: '能跑' });
    node1 = r.nodeId;
    const row = db.prepare('SELECT * FROM nodes WHERE id = ?').get(node1);
    assert.strictEqual(row.level, 0);
    assert.strictEqual(row.status, 'todo');
    assert.strictEqual(row.goal_id, goalId);
  });

  await T('node.create 子节点 level=父+1、sort_order 递增', async function () {
    const r = await commands.run('node.create', { goalId: goalId, parentId: node1, title: '子步骤' });
    node2 = r.nodeId;
    const row = db.prepare('SELECT * FROM nodes WHERE id = ?').get(node2);
    assert.strictEqual(row.level, 1);
    assert.strictEqual(row.parent_id, node1);
    assert.ok(row.sort_order >= 1);
  });

  await T('node.update 改状态', async function () {
    const r = await commands.run('node.update', { nodeId: node2, status: 'doing', detail: '进行中' });
    assert.strictEqual(r.node.status, 'doing');
    assert.strictEqual(db.prepare('SELECT status FROM nodes WHERE id = ?').get(node2).status, 'doing');
  });

  await T('node.complete 收口', async function () {
    await commands.run('node.complete', { nodeId: node1 });
    assert.strictEqual(db.prepare('SELECT status FROM nodes WHERE id = ?').get(node1).status, 'done');
  });

  await T('goal.update 改截止期', async function () {
    const r = await commands.run('goal.update', { goalId: goalId, deadline: '2 个月' });
    assert.strictEqual(r.goal.deadline, '2 个月');
    assert.ok(goalChanges.some(function (x) { return x.id === goalId && x.source === 'command' && x.after.deadline === '2 个月'; }));
  });

  await T('brief.goal 汇总进度与下一任务', async function () {
    const r = await commands.run('brief.goal', { goalId: goalId });
    assert.strictEqual(r.progress.tasks_total, 2);
    assert.strictEqual(r.progress.tasks_done, 1);
    assert.strictEqual(r.progress.next_task, '子步骤');
  });

  await T('audit.list 有写入记录', async function () {
    const r = await commands.run('audit.list', { limit: 20 });
    assert.ok(r.entries.length >= 5);
    assert.ok(r.entries.some(function (e) { return e.command === 'goal.create'; }));
  });

  await T('approvals 存储：create → approve → used', async function () {
    const ap = commands.approvals.create({ command: 'demo.admin', input: { a: 1 }, actor: 'test', risk: 'admin', reason: '单测' });
    assert.ok(ap.id);
    assert.strictEqual(commands.getApproval(ap.id).status, 'pending');
    const approved = commands.approve(ap.id, 'test');
    assert.strictEqual(approved.status, 'approved');
    commands.approvals.markUsed(ap.id);
    assert.strictEqual(commands.getApproval(ap.id).status, 'used');
  });

  await T('component.list/describe 可读', async function () {
    const l = await commands.run('component.list', {});
    assert.ok(l.components.length >= 2);
    const d = await commands.run('component.describe', { id: 'pomodoro' });
    assert.strictEqual(d.component.id, 'pomodoro');
  });

  await T('component.toggle 写 + 核心组件不可关', async function () {
    const r = await commands.run('component.toggle', { id: 'pomodoro', enabled: false });
    assert.strictEqual(r.component.enabled, false);
    let e = null;
    try { await commands.run('component.toggle', { id: 'plan', enabled: false }); } catch (err) { e = err; }
    assert.ok(e && e.code === 'forbidden');
  });

  await T('setting.list/get 只读白名单', async function () {
    const l = await commands.run('setting.list', {});
    assert.ok(l.settings.some(function (s) { return s.key === 'backup_keep'; }));
    const g = await commands.run('setting.get', { key: 'backup_keep' });
    assert.strictEqual(g.setting.key, 'backup_keep');
    let e = null;
    try { await commands.run('setting.get', { key: 'sync_token' }); } catch (err) { e = err; }
    assert.ok(e && e.code === 'forbidden');
  });

  await T('setting.set 需审批，批准后写入', async function () {
    let e = null;
    try { await commands.run('setting.set', { key: 'backup_keep', value: '7' }); } catch (err) { e = err; }
    assert.ok(e && e.code === 'approval_required' && e.details && e.details.approvalId);
    const aid = e.details.approvalId;
    commands.approve(aid, 'test');
    const r = await commands.run('setting.set', { key: 'backup_keep', value: '7' }, { approvalId: aid });
    assert.strictEqual(r.setting.value, '7');
    assert.strictEqual(settingMap.get('backup_keep'), '7');
    assert.ok(backupCount >= 1);
  });

  await T('goal.delete 需审批，批准后删除', async function () {
    const created = await commands.run('goal.create', { title: '待删除目标' });
    const gid = created.goalId;
    let e = null;
    try { await commands.run('goal.delete', { goalId: gid }); } catch (err) { e = err; }
    assert.ok(e && e.code === 'approval_required');
    const aid = e.details.approvalId;
    commands.approve(aid, 'test');
    const r = await commands.run('goal.delete', { goalId: gid }, { approvalId: aid });
    assert.ok(r.ok);
    assert.strictEqual(deleted.goal, gid);
    assert.ok(!db.prepare('SELECT id FROM goals WHERE id = ?').get(gid));
  });

  await T('node.delete 需审批，批准后删除', async function () {
    const g = await commands.run('goal.create', { title: '节点删除测试' });
    const nd = await commands.run('node.create', { goalId: g.goalId, title: '待删除节点' });
    let e = null;
    try { await commands.run('node.delete', { nodeId: nd.nodeId }); } catch (err) { e = err; }
    assert.ok(e && e.code === 'approval_required');
    const aid = e.details.approvalId;
    commands.approve(aid, 'test');
    const r = await commands.run('node.delete', { nodeId: nd.nodeId }, { approvalId: aid });
    assert.ok(r.ok);
    assert.strictEqual(deleted.node, nd.nodeId);
  });

  await T('component.export/validate 只读', async function () {
    const ex = await commands.run('component.export', { id: 'pomodoro' });
    assert.strictEqual(ex.bundle.id, 'pomodoro');
    const v = await commands.run('component.validate', { bundle: { format: 'sierxing-component', id: 'demo-plugin', server: 'module.exports = { id: "demo-plugin" };' } });
    assert.strictEqual(v.summary.id, 'demo-plugin');
  });

  await T('component.stage → install 需审批，批准后安装', async function () {
    const st = await commands.run('component.stage', { bundle: { format: 'sierxing-component', id: 'demo-plugin', name: '演示', server: 'module.exports = { id: "demo-plugin" };' } });
    assert.ok(st.changeId);
    assert.ok(st.previewUrl.indexOf('/api/component-staging/') >= 0);
    let e = null;
    try { await commands.run('component.install', { changeId: st.changeId }); } catch (err) { e = err; }
    assert.ok(e && e.code === 'approval_required');
    const aid = e.details.approvalId;
    commands.approve(aid, 'test');
    const r = await commands.run('component.install', { changeId: st.changeId }, { approvalId: aid });
    assert.ok(r.ok);
    assert.strictEqual(r.id, 'demo-plugin');
    assert.ok(installed.indexOf('demo-plugin') >= 0);
    assert.strictEqual(commands.getComponentStage(st.changeId).status, 'installed');
  });

  await T('component.uninstall 需审批，批准后卸载', async function () {
    let e = null;
    try { await commands.run('component.uninstall', { id: 'demo-plugin' }); } catch (err) { e = err; }
    assert.ok(e && e.code === 'approval_required');
    const aid = e.details.approvalId;
    commands.approve(aid, 'test');
    const r = await commands.run('component.uninstall', { id: 'demo-plugin' }, { approvalId: aid });
    assert.ok(r.ok);
    assert.ok(uninstalled.indexOf('demo-plugin') >= 0);
  });

  await T('source.add/list/update/delete 闭环', async function () {
    const add = await commands.run('source.add', { goalId: goalId, title: '资料 A', content: '测试正文' });
    assert.ok(add.id > 0);
    let list = await commands.run('source.list', { goalId: goalId });
    assert.ok(list.sources.some(function (s) { return s.id === add.id; }));
    const upd = await commands.run('source.update', { sourceId: add.id, title: '资料 A2' });
    assert.ok(upd.ok);
    let e = null;
    try { await commands.run('source.delete', { sourceId: add.id }); } catch (err) { e = err; }
    assert.ok(e && e.code === 'approval_required');
    const aid = e.details.approvalId;
    commands.approve(aid, 'test');
    const del = await commands.run('source.delete', { sourceId: add.id }, { approvalId: aid });
    assert.ok(del.ok);
    list = await commands.run('source.list', { goalId: goalId });
    assert.ok(!list.sources.some(function (s) { return s.id === add.id; }));
    assert.ok(sourceChanges >= 3);
  });

  await T('tutorial.generate 启动后台任务', async function () {
    const r = await commands.run('tutorial.generate', { nodeId: node1, format: 'html', note: '测试' });
    assert.ok(r.ok);
    assert.strictEqual(r.taskId, 901);
    assert.strictEqual(r.format, 'html');
    assert.strictEqual(r.status, 'started');
  });

  await T('tutorial.edit 启动后台任务', async function () {
    const r = await commands.run('tutorial.edit', { tutorialId: 7, feedback: '只改第二节', allowRestructure: false });
    assert.ok(r.ok);
    assert.strictEqual(r.taskId, 902);
    assert.strictEqual(r.tutorialId, 7);
    assert.strictEqual(r.status, 'started');
  });

  await T('source.collect 启动后台任务', async function () {
    const r = await commands.run('source.collect', { goalId: goalId });
    assert.ok(r.ok);
    assert.strictEqual(r.taskId, 903);
    assert.strictEqual(r.status, 'started');
  });

  await T('source.digest 启动后台任务', async function () {
    const r = await commands.run('source.digest', { goalId: goalId });
    assert.ok(r.ok);
    assert.strictEqual(r.taskId, 904);
    assert.strictEqual(r.status, 'started');
  });

  await T('plan.generate 启动后台任务', async function () {
    const r = await commands.run('plan.generate', { goalId: goalId, answers: { q1: 'a' } });
    assert.ok(r.ok);
    assert.strictEqual(r.taskId, 905);
    assert.strictEqual(r.status, 'started');
  });

  await T('tutorial.list/rename/delete 闭环', async function () {
    const t = db.prepare('INSERT INTO tutorials (goal_id,node_id,title,format,content,created_at,updated_at) VALUES (?,?,?,?,?,?,?)')
      .run(goalId, node1, '教程 A', 'md', '教程正文', nowISO(), nowISO());
    const tid = Number(t.lastInsertRowid);
    const list = await commands.run('tutorial.list', { goalId: goalId });
    assert.ok(list.tutorials.some(function (x) { return x.id === tid; }));
    const ren = await commands.run('tutorial.rename', { tutorialId: tid, title: '教程 A2' });
    assert.strictEqual(ren.title, '教程 A2');
    let e = null;
    try { await commands.run('tutorial.delete', { tutorialId: tid }); } catch (err) { e = err; }
    assert.ok(e && e.code === 'approval_required');
    const aid = e.details.approvalId;
    commands.approve(aid, 'test');
    const del = await commands.run('tutorial.delete', { tutorialId: tid }, { approvalId: aid });
    assert.ok(del.ok);
    const list2 = await commands.run('tutorial.list', { goalId: goalId });
    assert.ok(!list2.tutorials.some(function (x) { return x.id === tid; }));
  });

  await T('friction.report/list/update 闭环', async function () {
    const rep = await commands.run('friction.report', {
      goalId: 1, page: '#/g/1', component: 'pomodoro', action: '切走休息弹窗',
      description: '切走休息弹窗太吵', expected: '安静提醒', actual: '弹窗 + 提示音', severity: 'high'
    });
    assert.ok(rep.id > 0);
    assert.strictEqual(rep.status, 'open');
    const list = await commands.run('friction.list', { status: 'open' });
    assert.ok(list.reports.some(function (r) { return r.id === rep.id; }));
    const upd = await commands.run('friction.update', { id: rep.id, status: 'fixed', note: '已关弹窗' });
    assert.strictEqual(upd.status, 'fixed');
    const fixed = await commands.run('friction.list', { status: 'fixed' });
    assert.ok(fixed.reports.some(function (r) { return r.id === rep.id; }));
  });

  await T('app.open 打开首页/指定页面（交给宿主浏览器）', async function () {
    const r = await commands.run('app.open', { route: '#/g/1' });
    assert.strictEqual(r.ok, true);
    assert.ok(String(r.url).indexOf('#/g/1') >= 0, '返回地址应带路由');
    const home = await commands.run('app.open', {});
    assert.strictEqual(home.ok, true);
    assert.deepStrictEqual(openedRoutes, ['#/g/1', '']);
    let bad = null;
    try { await commands.run('app.open', { route: 'javascript:alert(1)' }); } catch (e) { bad = e; }
    assert.ok(bad && bad.code === 'bad_input', '非法路由要拒绝');
  });

  await T('manifest 含写命令、危险命令与 audit', async function () {
    const m = commands.fullManifest();
    const names = m.commands.map(function (c) { return c.name; });
    for (const x of ['goal.create', 'goal.update', 'goal.delete', 'node.create', 'node.update', 'node.delete', 'tutorial.list', 'tutorial.generate', 'tutorial.edit', 'tutorial.rename', 'tutorial.delete', 'source.add', 'source.update', 'source.delete', 'source.collect', 'source.digest', 'plan.generate', 'component.toggle', 'component.export', 'component.validate', 'component.stage', 'component.install', 'component.uninstall', 'setting.set', 'friction.report', 'friction.list', 'friction.update', 'audit.list', 'app.open']) {
      assert.ok(names.indexOf(x) >= 0, '缺少 ' + x);
    }
  });

  console.log('\n' + n + ' 项全部通过');
})().catch(function (e) { console.error('\n✗ ' + (e && e.stack || e)); process.exit(1); });
