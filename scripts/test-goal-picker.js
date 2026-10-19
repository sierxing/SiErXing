#!/usr/bin/env node
'use strict';
/**
 * 组件管理页 + 三处「选目标」回归
 * ---------------------------------------------------------------------------
 * 钉住用户 2026-10-19 的几条要求：
 *   ① 组件管理：切换组件分类必须真生效（含改回「其它」、含内置组件）；
 *   ② 组件管理：分类必须可折叠（默认收起）+ 顶部搜索；
 *   ③ 组件管理：「管理范围」不再铺一排目标，而是一个按钮 + 可搜索弹层；
 *   ④ 产出库 / 资源库 / AI 任务里「选目标」也都能按名字搜索。
 *
 * 跑法（无头浏览器 + 沙箱实例，不碰真实数据）：
 *   node scripts/test-goal-picker.js
 *   PORT=3430 node scripts/test-goal-picker.js      # 复用已在跑的沙箱
 */
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const net = require('node:net');
const http = require('node:http');
const { spawn, execFileSync } = require('node:child_process');

const BASE = path.resolve(__dirname, '..');
const CDP_PORT = Number(process.env.CDP_PORT || 9813);
const sleep = ms => new Promise(r => setTimeout(r, ms));
let passed = 0;
let sandbox = null;
let page = null;
const consoleErrs = [];

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

async function launchBrowser() {
  const profile = path.join(os.tmpdir(), 'sx-gp-test-' + process.pid);
  const home = path.join(os.tmpdir(), 'sx-gp-home-' + process.pid);
  fs.mkdirSync(profile, { recursive: true });
  fs.mkdirSync(home, { recursive: true });
  const edge = spawn('microsoft-edge', [
    '--headless=new', '--disable-gpu', '--no-sandbox', '--disable-dev-shm-usage',
    '--remote-allow-origins=*', '--disable-crash-reporter',
    '--remote-debugging-port=' + CDP_PORT, '--user-data-dir=' + profile,
    '--window-size=1440,1000', 'about:blank'
  ], { stdio: 'ignore', env: Object.assign({}, process.env, { HOME: home }) });
  let list = null;
  for (let i = 0; i < 100; i++) {
    try { const r = await fetch('http://127.0.0.1:' + CDP_PORT + '/json/list'); if (r.ok) { list = await r.json(); break; } } catch (e) {}
    await sleep(200);
  }
  if (!list) throw new Error('CDP 未就绪（浏览器没起来？）');
  const ws = new WebSocket(list.find(function (t) { return t.type === 'page'; }).webSocketDebuggerUrl);
  await new Promise(function (res, rej) { ws.addEventListener('open', res); ws.addEventListener('error', rej); });
  let seq = 0;
  const pending = new Map();
  ws.addEventListener('message', function (ev) {
    const m = JSON.parse(ev.data);
    if (m.id && pending.has(m.id)) { const p = pending.get(m.id); pending.delete(m.id); if (m.error) p.reject(new Error(m.error.message)); else p.resolve(m.result || m); return; }
    if (m.method === 'Runtime.exceptionThrown') consoleErrs.push('EXCEPTION: ' + JSON.stringify(m.params.exceptionDetails).slice(0, 300));
    if (m.method === 'Runtime.consoleAPICalled' && m.params.type === 'error') consoleErrs.push('console.error: ' + m.params.args.map(function (a) { return a.value || a.description || ''; }).join(' ').slice(0, 300));
  });
  function send(method, params) {
    return new Promise(function (resolve, reject) {
      const id = ++seq;
      pending.set(id, { resolve: resolve, reject: reject });
      ws.send(JSON.stringify({ id: id, method: method, params: params || {} }));
      setTimeout(function () { if (pending.has(id)) { pending.delete(id); reject(new Error('timeout ' + method)); } }, 30000);
    });
  }
  await send('Page.enable');
  await send('Runtime.enable');
  const api = {
    async evalIn(expr) {
      const r = await send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true });
      if (r && r.exceptionDetails) throw new Error('eval 失败: ' + JSON.stringify(r.exceptionDetails).slice(0, 300));
      return r && r.result && r.result.value;
    },
    async goto(hash) {
      const url = 'http://127.0.0.1:' + sandbox.port + '/?t=' + Date.now() + (hash || '');
      await send('Page.navigate', { url: url });
      for (let i = 0; i < 160; i++) {
        await sleep(150);
        const ready = await api.evalIn("(function(){var a=document.querySelector('#app');if(!a||!a.children.length)return false;var t=a.innerText||'';return t.indexOf('加载组件')<0&&t.indexOf('加载中')<0&&t.indexOf('正在读取')<0;})()");
        if (ready) { await sleep(600); return; }
      }
      throw new Error('页面没渲染出来: ' + hash);
    },
    async close() {
      try { await send('Browser.close'); } catch (e) {}
      try { execFileSync('pkill', ['-9', '-f', '--', '--user-data-dir=' + profile], { stdio: 'ignore' }); } catch (e) {}
      try { edge.kill('SIGKILL'); } catch (e) {}
      try { fs.rmSync(profile, { recursive: true, force: true }); } catch (e) {}
      try { fs.rmSync(home, { recursive: true, force: true }); } catch (e) {}
    }
  };
  return api;
}

(async function main() {
  const reuse = Number(process.env.PORT || 0);
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sx-gp-page-test-'));
  if (!reuse) {
    const port = await freePort();
    const child = spawn(process.execPath, ['--no-warnings', '--experimental-sqlite', path.join(BASE, 'server', 'server.js')], {
      cwd: BASE,
      env: Object.assign({}, process.env, { NO_OPEN: '1', PORT: String(port), SIERXING_DATA_DIR: dataDir }),
      stdio: ['ignore', 'pipe', 'pipe']
    });
    let log = '';
    child.stdout.on('data', function (d) { log += d; });
    child.stderr.on('data', function (d) { log += d; });
    sandbox = { child: child, dataDir: dataDir, port: port, log: function () { return log; } };
    await waitHealth(port);
    // 沙箱里造几个目标，才能验「选目标」
    for (const title of ['找到 AI 产品经理实习', '零基础速通 SQL', '进入大厂高性能计算相关岗位']) {
      await req(port, 'POST', '/api/goals', { title: title });
    }
  } else {
    sandbox = { child: null, dataDir: '', port: reuse, log: function () { return ''; } };
  }
  try {
    page = await launchBrowser();

    console.log('');
    console.log('== 组件管理 · 管理范围收成一个可搜索按钮 ==');
    await ok('不再是「一排目标按钮」，而是一个按钮', async function () {
      await page.goto('#/components');
      assert.strictEqual(await page.evalIn("document.querySelectorAll('#cmpScopeBar').length"), 0, '旧的整排按钮应该没有了');
      assert.strictEqual(await page.evalIn("!!document.querySelector('#cmpScopePick [data-sgp-open]')"), true, '应有一个管理范围按钮');
    });
    await ok('「全局默认」只出现一个地球（图标里有一个、文案里不再重复）', async function () {
      await page.goto('#/components');
      const btn = JSON.parse(await page.evalIn("JSON.stringify({icon: (document.querySelector('#cmpScopePick .sgpIcon')||{}).textContent, text: (document.querySelector('#cmpScopePick .sgpText')||{}).textContent})"));
      assert.strictEqual((btn.text.match(/🌍/g) || []).length, 0, '按钮文案里不该再有地球（会和图标重复），实际：' + JSON.stringify(btn.text));
      assert.strictEqual((btn.icon.match(/🌍/g) || []).length, 1, '按钮图标里应只有一个地球，实际：' + JSON.stringify(btn.icon));
      await page.evalIn("document.querySelector('#cmpScopePick [data-sgp-open]').click()");
      await sleep(400);
      const first = JSON.parse(await page.evalIn("(function(){var o=document.querySelector('.sxiGoalPop .sgpOpt');return JSON.stringify({icon:(o.querySelector('.sgpOptIcon')||{}).textContent, text:(o.querySelector('.sgpOptText')||{}).textContent});})()"));
      assert.strictEqual((first.text.match(/🌍/g) || []).length, 0, '弹层「全局默认」文案里不该再有地球，实际：' + JSON.stringify(first.text));
      assert.strictEqual((first.icon.match(/🌍/g) || []).length, 1, '弹层「全局默认」图标里应只有一个地球，实际：' + JSON.stringify(first.icon));
      await page.evalIn("document.body.click()");
      await sleep(200);
    });
    await ok('点按钮弹出目标列表，可搜索', async function () {
      await page.evalIn("document.querySelector('#cmpScopePick [data-sgp-open]').click()");
      await sleep(400);
      assert.strictEqual(await page.evalIn("!!document.querySelector('.sxiGoalPop')"), true, '应弹出选择器');
      const n = await page.evalIn("document.querySelectorAll('.sxiGoalPop .sgpOpt').length");
      assert.ok(n >= 4, '应含「全部目标 + 各目标」，实际 ' + n);
      await page.evalIn("(function(){var i=document.querySelector('.sgpSearch');i.value='SQL';i.dispatchEvent(new Event('input'));})()");
      await sleep(300);
      const hit = JSON.parse(await page.evalIn("JSON.stringify([...document.querySelectorAll('.sxiGoalPop .sgpOpt')].map(function(x){return x.textContent.trim();}))"));
      assert.strictEqual(hit.length, 1, '搜 SQL 应只剩 1 项，实际：' + JSON.stringify(hit));
      assert.ok(hit[0].indexOf('SQL') >= 0, '命中的应是 SQL 目标');
    });
    await ok('选一个目标 → 切到该目标的管理视图', async function () {
      await page.evalIn("(function(){var o=[...document.querySelectorAll('.sxiGoalPop .sgpOpt')].find(function(x){return x.getAttribute('data-sgp-pick')!=='0';});if(o)o.click();})()");
      await sleep(1600);
      assert.strictEqual(await page.evalIn("!!document.getElementById('cmpGoalSearch')"), true, '应切到「某个目标」的视图');
      const label = await page.evalIn("(document.querySelector('#cmpScopePick .sgpText')||{}).textContent || ''");
      assert.ok(/SQL|AI|大厂/.test(label), '按钮上应显示选中的目标，实际：' + label);
    });

    console.log('');
    console.log('== 组件管理 · 分类折叠 + 搜索（原需求仍在） ==');
    await ok('分类可折叠，默认收起', async function () {
      await page.goto('#/components');
      const g = JSON.parse(await page.evalIn("JSON.stringify(Object.fromEntries([...document.querySelectorAll('#cmpCatList [data-cmp-cat]')].map(function(x){return [x.getAttribute('data-cmp-cat'), x.classList.contains('isFolded')];})))"));
      assert.ok(Object.keys(g).length >= 3, '至少三个分类');
      assert.ok(Object.keys(g).every(function (k) { return g[k] === true; }), '默认应全部收起');
    });
    await ok('顶部搜索能过滤组件', async function () {
      await page.evalIn("(function(){var i=document.getElementById('cmpSearch');i.value='主题';i.dispatchEvent(new Event('input'));})()");
      await sleep(400);
      const cats = JSON.parse(await page.evalIn("JSON.stringify([...document.querySelectorAll('#cmpCatList [data-cmp-cat]')].map(function(x){return x.getAttribute('data-cmp-cat');}))"));
      assert.ok(cats.length >= 1 && cats.every(function (k) { return k.indexOf('主题') >= 0; }), '搜索应只留相关分类，实际：' + JSON.stringify(cats));
      await page.evalIn("(function(){var i=document.getElementById('cmpSearch');i.value='';i.dispatchEvent(new Event('input'));})()");
      await sleep(300);
    });

    console.log('');
    console.log('== 资源库 · 选目标可搜索 ==');
    await ok('资源库页头是「可搜索的目标选择」，不是原生下拉', async function () {
      await page.goto('#/library');
      assert.strictEqual(await page.evalIn("!!document.querySelector('#libGoal [data-sgp-open]')"), true, '资源库应有新的目标选择器');
    });
    await ok('点开能搜、能选中', async function () {
      await page.evalIn("document.querySelector('#libGoal [data-sgp-open]').click()");
      await sleep(400);
      assert.strictEqual(await page.evalIn("!!document.querySelector('.sxiGoalPop')"), true, '应弹出选择器');
      await page.evalIn("(function(){var i=document.querySelector('.sgpSearch');i.value='SQL';i.dispatchEvent(new Event('input'));})()");
      await sleep(300);
      const hit = JSON.parse(await page.evalIn("JSON.stringify([...document.querySelectorAll('.sxiGoalPop .sgpOpt')].map(function(x){return x.textContent.trim();}))"));
      assert.strictEqual(hit.length, 1, '搜 SQL 应只剩 1 项，实际：' + JSON.stringify(hit));
    });

    console.log('');
    console.log('== 产出库 · 选目标可搜索 ==');
    await ok('产出库页头是「可搜索的目标选择」', async function () {
      await page.goto('#/outlib');
      assert.strictEqual(await page.evalIn("!!document.querySelector('#olGoalSel [data-sgp-open]')"), true, '产出库应有新的目标选择器');
      await page.evalIn("document.querySelector('#olGoalSel [data-sgp-open]').click()");
      await sleep(400);
      assert.strictEqual(await page.evalIn("!!document.querySelector('.sxiGoalPop')"), true, '应弹出选择器');
      await page.evalIn("(function(){var i=document.querySelector('.sgpSearch');i.value='大厂';i.dispatchEvent(new Event('input'));})()");
      await sleep(300);
      const hit = JSON.parse(await page.evalIn("JSON.stringify([...document.querySelectorAll('.sxiGoalPop .sgpOpt')].map(function(x){return x.textContent.trim();}))"));
      assert.strictEqual(hit.length, 1, '搜「大厂」应只剩 1 项，实际：' + JSON.stringify(hit));
    });

    console.log('');
    console.log('== AI 任务中心 · 目标筛选可搜索 ==');
    await ok('目标筛选弹层里带搜索框，输入即过滤', async function () {
      await page.goto('#/aitasks');
      const hasBtn = await page.evalIn("!!document.querySelector('[data-ait-open=\"goal\"]')");
      assert.strictEqual(hasBtn, true, 'AI 任务页应有目标筛选按钮');
      await page.evalIn("document.querySelector('[data-ait-open=\"goal\"]').click()");
      await sleep(500);
      assert.strictEqual(await page.evalIn("!!document.querySelector('.sxiPopSearchInput')"), true, '弹层里应有搜索框');
      const all = await page.evalIn("document.querySelectorAll('.sxiPop [data-ait-pick]').length");
      assert.ok(all >= 2, '默认应列出全部目标 + 全部目标项，实际 ' + all);
      await page.evalIn("(function(){var i=document.querySelector('.sxiPopSearchInput');i.value='SQL';i.dispatchEvent(new Event('input'));})()");
      await sleep(300);
      const hit = JSON.parse(await page.evalIn("JSON.stringify([...document.querySelectorAll('.sxiPop [data-ait-pick]')].map(function(x){return x.textContent.trim();}))"));
      assert.strictEqual(hit.length, 2, '搜 SQL 应只剩「全部目标 + 1 项」，实际：' + JSON.stringify(hit));
    });

    console.log('');
    console.log('== 改分类真的生效（原 bug 不回归） ==');
    await ok('移到「其它」、以及内置组件改分类，都真生效', async function () {
      const r1 = await req(sandbox.port, 'POST', '/api/components/conditions/category', { category: '其它' });
      assert.strictEqual(r1.status, 200, r1.text);
      assert.strictEqual(r1.json.category, '其它', '改回「其它」必须生效');
      const r2 = await req(sandbox.port, 'POST', '/api/components/clarify/category', { category: '学习与练习' });
      assert.strictEqual(r2.status, 200, r2.text);
      assert.strictEqual(r2.json.category, '学习与练习', '内置组件改分类必须生效');
    });

    console.log('');
    console.log('== 无 JS 异常 ==');
    await ok('整轮操作没有未捕获异常 / console.error', function () {
      assert.deepStrictEqual(consoleErrs, []);
    });
  } finally {
    try { if (page) await page.close(); } catch (e) {}
    try { if (sandbox && sandbox.child) sandbox.child.kill('SIGKILL'); } catch (e) {}
    if (!process.env.KEEP) { try { fs.rmSync(dataDir, { recursive: true, force: true }); } catch (e) {} }
    if (sandbox && sandbox.child && process.exitCode && typeof sandbox.log === 'function') {
      console.error('');
      console.error('--- 服务日志 ---');
      console.error(String(sandbox.log()).slice(-3000));
    }
  }
  console.log('');
  console.log('全部通过：' + passed + ' 项');
})().catch(function (e) {
  console.error('');
  console.error('失败：' + ((e && e.stack) || e));
  process.exit(1);
});
