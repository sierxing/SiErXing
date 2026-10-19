#!/usr/bin/env node
'use strict';
/**
 * 「清理 AI 任务历史」回归
 * ---------------------------------------------------------------------------
 * 用户反馈：目标删掉之后，任务中心一直挂着几行「（目标已删除）」，
 * 点不进去也没法去掉。这里给三个删除入口，钉住三条契约：
 *   ① 只会删 task_runs 行 —— 目标/教程/产出等真实数据一个字都不动；
 *   ② 目标还在的**不允许**按目标批量清（防止误删在用的历史）；
 *   ③ 清完分组从接口里消失；「清理已删除目标」按钮在最后一个孤儿清掉后自己消失。
 *
 * 另外把「（未关联目标）」和「（目标已删除）」分开 —— goal_id=0 是没关联目标，
 * 不是目标被删，混在一起会让用户以为记录坏了。
 *
 * 跑法：node scripts/test-ai-tasks-cleanup.js（自带沙箱实例，不碰真实数据）
 */
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const net = require('node:net');
const http = require('node:http');
const { spawn } = require('node:child_process');

const BASE = path.resolve(__dirname, '..');
const sleep = ms => new Promise(r => setTimeout(r, ms));
let passed = 0;
let sandbox = null;

function ok(name, fn) {
  return Promise.resolve().then(fn).then(
    function () { passed++; console.log('  ok ' + name); },
    function (e) { console.error('  FAIL ' + name); throw e; }
  );
}
function freePort() {
  return new Promise(function (resolve, reject) {
    const s = net.createServer();
    s.unref();
    s.on('error', reject);
    s.listen(0, '127.0.0.1', function () { const p = s.address().port; s.close(function () { resolve(p); }); });
  });
}
function req(port, method, p, body) {
  return new Promise(function (resolve, reject) {
    const data = body == null ? null : JSON.stringify(body);
    const r = http.request({ host: '127.0.0.1', port: port, method: method, path: p, headers: data ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) } : {} }, function (res) {
      let s = '';
      res.on('data', function (c) { s += c; });
      res.on('end', function () {
        let json = null;
        try { json = JSON.parse(s); } catch (e) {}
        resolve({ status: res.statusCode, text: s, json: json });
      });
    });
    r.on('error', reject);
    if (data) r.write(data);
    r.end();
  });
}
function waitHealth(port) {
  return new Promise(function (resolve, reject) {
    let n = 0;
    (function tick() {
      req(port, 'GET', '/api/health').then(function (r) {
        if (r.status === 200 && r.json && r.json.ok) return resolve();
        if (++n > 80) return reject(new Error('服务 20 秒内没起来'));
        setTimeout(tick, 250);
      }).catch(function () {
        if (++n > 80) return reject(new Error('服务 20 秒内没起来'));
        setTimeout(tick, 250);
      });
    })();
  });
}

(async function main() {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sx-ait-clean-'));
  const port = await freePort();
  const child = spawn(process.execPath, ['--no-warnings', '--experimental-sqlite', path.join(BASE, 'server', 'server.js')], {
    cwd: BASE,
    env: Object.assign({}, process.env, { NO_OPEN: '1', PORT: String(port), SIERXING_DATA_DIR: dataDir }),
    stdio: ['ignore', 'pipe', 'pipe']
  });
  let log = '';
  child.stdout.on('data', function (d) { log += d; });
  child.stderr.on('data', function (d) { log += d; });
  sandbox = { child: child, port: port, dataDir: dataDir };
  const DatabaseSync = require('node:sqlite').DatabaseSync;
  let db = null;
  const writeRun = function (goalId, title, status, error) {
    const now = new Date().toISOString();
    db.prepare('INSERT INTO task_runs (goal_id,node_id,type,title,status,error,cost_ms,created_at) VALUES (?,?,?,?,?,?,?,?)')
      .run(goalId, 0, 'tutorial', title, status || 'done', error || '', 5000, now);
  };
  try {
    await waitHealth(port);
    db = new DatabaseSync(path.join(dataDir, 'sierxing.db'));

    console.log('');
    console.log('== 清理已删除目标的残余历史 ==');
    await ok('目标还在时，禁止按目标批量清理（防误删）', async function () {
      // 201 + { goal: {...} }（不是 200 + id 直给）
      const g = await req(port, 'POST', '/api/goals', { title: '还在的目标' });
      assert.strictEqual(g.status, 201, g.text);
      const gid = g.json.goal.id;
      writeRun(gid, '给还在的目标跑的任务', 'done');
      const r = await req(port, 'DELETE', '/api/ai-tasks/history?goal=' + gid);
      assert.strictEqual(r.status, 400, '目标还在时必须拒绝，实际：' + r.text);
      assert.ok(/还在/.test(r.text), '错误信息要说清原因，实际：' + r.text);
      // 记录必须还在
      const n = db.prepare('SELECT COUNT(*) n FROM task_runs WHERE goal_id = ?').get(gid).n;
      assert.strictEqual(n, 1, '拒绝时不能删任何行');
    });

    await ok('目标删掉后，可以按目标清理它的历史（只删 task_runs）', async function () {
      const g = await req(port, 'POST', '/api/goals', { title: '待删除的目标' });
      const gid = g.json.goal.id;
      writeRun(gid, '任务 A', 'done');
      writeRun(gid, '任务 B', 'failed', '超时');
      // 造一份真实数据，验证清理历史不会碰它
      await req(port, 'POST', '/api/goals/' + gid + '/sources', { title: '一条资料', content: '内容', kind: 'note' });
      const beforeSrc = db.prepare('SELECT COUNT(*) n FROM sources WHERE goal_id = ?').get(gid).n;
      assert.ok(beforeSrc >= 1, '前置：目标下应有资料');
      // 删目标（走真实接口，会更 task_runs 之外的数据）
      const del = await req(port, 'DELETE', '/api/goals/' + gid);
      assert.ok(del.status === 200 || del.status === 204, '删目标接口应成功，实际：' + del.text);
      // 注意：删目标本身不应该动 task_runs（历史要留到用户主动清理）
      const left = db.prepare('SELECT COUNT(*) n FROM task_runs WHERE goal_id = ?').get(gid).n;
      assert.strictEqual(left, 2, '删目标后它的任务历史应该还在（等用户清理），实际：' + left);
      const r = await req(port, 'DELETE', '/api/ai-tasks/history?goal=' + gid);
      assert.strictEqual(r.status, 200, r.text);
      assert.strictEqual(r.json.deleted, 2, '应删掉 2 条，实际：' + r.text);
      assert.strictEqual(db.prepare('SELECT COUNT(*) n FROM task_runs WHERE goal_id = ?').get(gid).n, 0, '删完后该目标不应再有历史');
    });

    await ok('「一键清理已删除目标」只清孤儿，不碰还在的目标', async function () {
      const keep = await req(port, 'POST', '/api/goals', { title: '留着的目标' });
      writeRun(keep.json.goal.id, '留着的任务', 'done');
      writeRun(9991, '孤儿任务 1', 'done');
      writeRun(9992, '孤儿任务 2', 'failed', 'x');
      const r = await req(port, 'DELETE', '/api/ai-tasks/history/orphans');
      assert.strictEqual(r.status, 200, r.text);
      assert.ok(r.json.deleted >= 2, '至少清掉 2 条孤儿，实际：' + r.text);
      const orphanLeft = db.prepare('SELECT COUNT(*) n FROM task_runs WHERE goal_id > 0 AND goal_id NOT IN (SELECT id FROM goals)').get().n;
      assert.strictEqual(orphanLeft, 0, '不应再有孤儿行');
      const keepLeft = db.prepare('SELECT COUNT(*) n FROM task_runs WHERE goal_id = ?').get(keep.json.goal.id).n;
      assert.strictEqual(keepLeft, 1, '还在的目标的历史不能被动');
    });

    await ok('一键清理后，接口里再也没有 goalMissing 分组', async function () {
      const r = await req(port, 'GET', '/api/ai-tasks');
      assert.strictEqual(r.status, 200);
      const missing = (r.json.groups || []).filter(function (g) { return g.goalMissing; });
      assert.deepStrictEqual(missing, [], '不应再有「目标已删除」分组，实际：' + JSON.stringify(missing));
    });

    console.log('');
    console.log('== 单条删除 ==');
    await ok('删单条：只删指定那一行，连带 404 处理', async function () {
      const g = await req(port, 'POST', '/api/goals', { title: '单条删除测试' });
      writeRun(g.json.goal.id, '要保留的任务', 'done');
      writeRun(g.json.goal.id, '要删掉的任务', 'done');
      const rows = db.prepare('SELECT id,title FROM task_runs WHERE goal_id = ? ORDER BY id').all(g.json.goal.id);
      const target = rows.find(function (x) { return x.title === '要删掉的任务'; });
      const r = await req(port, 'DELETE', '/api/ai-tasks/history/' + target.id);
      assert.strictEqual(r.status, 200, r.text);
      const left = db.prepare('SELECT title FROM task_runs WHERE goal_id = ?').all(g.json.goal.id).map(function (x) { return x.title; });
      assert.deepStrictEqual(left, ['要保留的任务'], '只该删掉指定那一条，实际：' + JSON.stringify(left));
      const nf = await req(port, 'DELETE', '/api/ai-tasks/history/99999999');
      assert.strictEqual(nf.status, 404, '不存在的记录应 404，实际：' + nf.status);
    });

    console.log('');
    console.log('== 文案区分 ==');
    await ok('goal_id=0 显示「（未关联目标）」，不是「（目标已删除）」', async function () {
      writeRun(0, '没挂目标的任务', 'done');
      const r = await req(port, 'GET', '/api/ai-tasks');
      const g0 = (r.json.groups || []).find(function (g) { return Number(g.goalId) === 0; });
      assert.ok(g0, '应有 goal_id=0 的分组，实际：' + JSON.stringify(r.json.groups));
      assert.strictEqual(g0.goalTitle, '（未关联目标）', '文案要区分开，实际：' + g0.goalTitle);
      assert.strictEqual(g0.goalMissing, false, 'goal_id=0 不算「目标已删除」，不该给清理按钮');
    });

    await ok('「目标已删除」的分组带 goalMissing=true（前端据此显示清理入口）', async function () {
      writeRun(8888, '孤儿任务', 'done');
      const r = await req(port, 'GET', '/api/ai-tasks');
      const g = (r.json.groups || []).find(function (x) { return Number(x.goalId) === 8888; });
      assert.ok(g, '应有 goal_id=8888 的分组');
      assert.strictEqual(g.goalMissing, true, '已删除目标应为 true，实际：' + g.goalMissing);
      assert.strictEqual(g.goalTitle, '（目标已删除）');
    });
  } finally {
    try { db && db.close(); } catch (e) {}
    try { child.kill('SIGKILL'); } catch (e) {}
    await sleep(300);
    if (!process.env.KEEP) { try { fs.rmSync(dataDir, { recursive: true, force: true }); } catch (e) {} }
    if (process.exitCode) console.error('\n--- 服务日志 ---\n' + log.slice(-3000));
  }
  console.log('');
  console.log('全部通过：' + passed + ' 项');
})().catch(function (e) {
  console.error('');
  console.error('失败：' + ((e && e.stack) || e));
  process.exit(1);
});
