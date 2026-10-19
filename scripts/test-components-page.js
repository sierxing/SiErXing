#!/usr/bin/env node
'use strict';
/**
 * 组件管理页「分类折叠 + 搜索 + 改分类生效」回归
 * ---------------------------------------------------------------------------
 * 钉住用户报的两个问题：
 *   ① 「切换组件分类不生效」：移回「其它」曾写成 delete key，effectiveCategory 于是
 *      回落到插件声明分类、卡片下次刷新又跳回去；内置组件（plan/clarify/…）压根
 *      没走 effectiveCategory，改了永远不生效。
 *   ② 「组件全铺一屏、找不动」：分类必须可折叠（默认收起）+ 顶部可搜索。
 *
 * 跑法（无头浏览器 + 沙箱实例，不碰真实数据）：
 *   node scripts/test-components-page.js
 *   PORT=3430 node scripts/test-components-page.js     # 复用已在跑的沙箱
 *   KEEP=1 保留沙箱目录便于排查
 */
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const net = require('node:net');
const http = require('node:http');
const { spawn, execFileSync } = require('node:child_process');

const BASE = path.resolve(__dirname, '..');
const CDP_PORT = Number(process.env.CDP_PORT || 9811);
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

/* ---------------- 无头浏览器（CDP；收尾按 profile 杀整棵树） ---------------- */
async function launchBrowser() {
  const profile = path.join(os.tmpdir(), 'sx-cmp-test-' + process.pid);
  const home = path.join(os.tmpdir(), 'sx-cmp-home-' + process.pid);
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
      /* ⚠️ 每次都带一个唯一 query 强制**整页重新加载**：
         目标 URL 一直是 '/#/components'，Page.navigate 到"和当前完全相同的 URL"时
         Chrome 只做同文档 hash 导航、根本不 reload —— 上一次的 DOM 还在，
         "服务端刚改的分类在页面上搬没搬过去"就会拿到旧渲染（实测就是这么假通过的）。
         query 里的 t 不影响 SPA 路由（只认 # 之后）。 */
      const url = 'http://127.0.0.1:' + sandbox.port + '/?t=' + Date.now() + (hash || '');
      await send('Page.navigate', { url: url });
      await sleep(500);
      for (let i = 0; i < 140; i++) {
        await sleep(150);
        const ready = await api.evalIn("(function(){var a=document.querySelector('#app');if(!a||!a.children.length)return false;var t=a.innerText||'';return t.indexOf('加载组件')<0&&t.indexOf('加载中')<0;})()");
        if (ready) {
          const used = await api.evalIn("JSON.stringify(window.__sxPluginUsed||{})");
          const hasCats = await api.evalIn("!!document.querySelector('#cmpCatList [data-cmp-cat]')");
          if (used && used.indexOf('components') >= 0 && hasCats) { await sleep(300); return; }
        }
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

const GROUPS_EXPR = "JSON.stringify(Object.fromEntries(Array.from(document.querySelectorAll('#cmpCatList [data-cmp-cat]')).map(function(x){return [x.getAttribute('data-cmp-cat'), {folded: x.classList.contains('isFolded'), cards: x.querySelectorAll('.cmpCard').length}];})))";
const GOAL_GROUPS_EXPR = "JSON.stringify(Object.fromEntries(Array.from(document.querySelectorAll('#cmpGoalCatList [data-cmp-cat]')).map(function(x){return [x.getAttribute('data-cmp-cat'), {folded: x.classList.contains('isFolded')}];})))";
function q(sel) { return 'document.querySelector(' + JSON.stringify(sel) + ')'; }
function click(sel) { return q(sel) + '.click()'; }
function focusSearch(id) { return "(function(){var i=document.getElementById(" + JSON.stringify(id) + ");i.focus();return true;})()"; }
function typeSearch(id, val) { return "(function(){var i=document.getElementById(" + JSON.stringify(id) + ");i.value=" + JSON.stringify(val) + ";i.dispatchEvent(new Event('input'));})()"; }

(async function main() {
  const reuse = Number(process.env.PORT || 0);
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sx-cmp-page-test-'));
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
  } else {
    sandbox = { child: null, dataDir: '', port: reuse, log: function () { return ''; } };
  }
  try {
    page = await launchBrowser();
    await page.goto('#/components');

    console.log('');
    console.log('== 折叠 ==');
    await ok('默认全部收起（只留分类标题行）', async function () {
      const g = JSON.parse(await page.evalIn(GROUPS_EXPR));
      const cats = Object.keys(g);
      assert.ok(cats.length >= 3, '至少三个分类，实际：' + cats.join('/'));
      assert.ok(cats.every(function (k) { return g[k].folded === true; }), '默认应全部收起，实际：' + JSON.stringify(g));
    });
    await ok('点分类标题能展开 / 收起，状态写进本机偏好', async function () {
      const g0 = JSON.parse(await page.evalIn(GROUPS_EXPR));
      const cat = Object.keys(g0)[0];
      const sel = '#cmpCatList [data-cmp-cat="' + cat + '"] .cmpCatHead';
      await page.evalIn(click(sel));
      await sleep(350);
      let g = JSON.parse(await page.evalIn(GROUPS_EXPR));
      assert.strictEqual(g[cat].folded, false, '点一次应展开：' + cat);
      assert.ok(g[cat].cards > 0, '展开后该分类里应有卡片');
      const saved = JSON.parse(await page.evalIn("localStorage.getItem('sierxing-cmp-prefs') || '{}'"));
      assert.strictEqual(saved.collapsed[cat], false, '展开状态应写进本机偏好');
      await page.evalIn(click(sel));
      await sleep(350);
      g = JSON.parse(await page.evalIn(GROUPS_EXPR));
      assert.strictEqual(g[cat].folded, true, '再点一次应收起：' + cat);
    });
    await ok('「全部展开 / 全部收起」都生效', async function () {
      await page.evalIn("document.getElementById('cmpExpandAll').click()");
      await sleep(450);
      let g = JSON.parse(await page.evalIn(GROUPS_EXPR));
      assert.ok(Object.keys(g).every(function (k) { return g[k].folded === false; }), '全部展开后不该还有收起的');
      await page.evalIn("document.getElementById('cmpFoldAll').click()");
      await sleep(450);
      g = JSON.parse(await page.evalIn(GROUPS_EXPR));
      assert.ok(Object.keys(g).every(function (k) { return g[k].folded === true; }), '全部收起后不该还有展开的');
    });
    await ok('刷新后折叠状态保持', async function () {
      await page.evalIn(click('#cmpCatList [data-cmp-cat] .cmpCatHead'));
      await sleep(350);
      await page.goto('#/components');
      const g = JSON.parse(await page.evalIn(GROUPS_EXPR));
      const opened = Object.keys(g).filter(function (k) { return !g[k].folded; });
      assert.strictEqual(opened.length, 1, '刷新后应只有当时展开的那一个分类是开的，实际：' + JSON.stringify(g));
    });

    console.log('');
    console.log('== 搜索 ==');
    await ok('搜「主题」只留下相关分类，计数显示命中数', async function () {
      await page.evalIn("document.getElementById('cmpFoldAll').click()");
      await sleep(250);
      await page.evalIn(typeSearch('cmpSearch', '主题'));
      await sleep(450);
      const g = JSON.parse(await page.evalIn(GROUPS_EXPR));
      assert.ok(Object.keys(g).length >= 1, '搜索「主题」应至少命中一个分类');
      assert.ok(Object.keys(g).every(function (k) { return k.indexOf('主题') >= 0; }), '不该留下不相关的分类：' + Object.keys(g).join('/'));
      const count = await page.evalIn(q('#cmpSearch') + '.closest(".cmpSearch").querySelector(".cmpSearchCount").textContent');
      assert.ok(/命中/.test(count), '计数应显示命中数，实际：' + count);
    });
    await ok('搜不到时显示空态，清空后恢复', async function () {
      await page.evalIn(typeSearch('cmpSearch', 'zzzz-no-such'));
      await sleep(450);
      assert.strictEqual(await page.evalIn("!!document.querySelector('#cmpCatList .cmpEmpty')"), true, '搜不到时应显示空态');
      await page.evalIn(typeSearch('cmpSearch', ''));
      await sleep(450);
      const g = JSON.parse(await page.evalIn(GROUPS_EXPR));
      assert.ok(Object.keys(g).length >= 3, '清空搜索后分类应恢复');
    });
    await ok('搜索状态下点分类还能展开看到卡片', async function () {
      await page.evalIn(typeSearch('cmpSearch', '组件'));
      await sleep(450);
      const cat = await page.evalIn("(function(){var m=document.querySelector('#cmpCatList [data-cmp-cat]');return m?m.getAttribute('data-cmp-cat'):'';})()");
      assert.ok(cat, '搜索后应还有分类');
      await page.evalIn(click('#cmpCatList [data-cmp-cat="' + cat + '"] .cmpCatHead'));
      await sleep(350);
      assert.strictEqual(await page.evalIn("!!document.querySelector('#cmpCatList [data-cmp-cat=\"" + cat + "\"] .cmpCard')"), true, '搜索命中后点分类应能看到卡片');
      await page.evalIn(typeSearch('cmpSearch', ''));
      await sleep(350);
    });

    console.log('');
    console.log('== 改分类真的生效 ==');
    await ok('移到另一个分类：接口、组件列表、页面卡片三处都搬过去', async function () {
      const r = await req(sandbox.port, 'POST', '/api/components/conditions/category', { category: '学习与练习' });
      assert.strictEqual(r.status, 200, r.text);
      assert.strictEqual(r.json.category, '学习与练习', '接口返回的分类应是新的');
      const comps = await req(sandbox.port, 'GET', '/api/components');
      assert.strictEqual(comps.json.components.find(function (c) { return c.id === 'conditions'; }).category, '学习与练习');
      await page.goto('#/components');
      await page.evalIn("document.getElementById('cmpExpandAll').click()");
      await sleep(450);
      const cat = await page.evalIn("(function(){var s=document.querySelector('[data-comp-cat=\"conditions\"]');if(!s)return '';var m=s.closest('[data-cmp-cat]');return m?m.getAttribute('data-cmp-cat'):'';})()");
      assert.strictEqual(cat, '学习与练习', '卡片应出现在新分类里，实际：' + cat);
    });
    await ok('改回「其它」也生效（曾经的 bug：被插件声明分类抢回去）', async function () {
      const r = await req(sandbox.port, 'POST', '/api/components/conditions/category', { category: '其它' });
      assert.strictEqual(r.status, 200, r.text);
      assert.strictEqual(r.json.category, '其它', '改回「其它」必须真的生效，实际：' + r.json.category);
      const comps = await req(sandbox.port, 'GET', '/api/components');
      assert.strictEqual(comps.json.components.find(function (c) { return c.id === 'conditions'; }).category, '其它');
    });
    await ok('内置组件（clarify 等）也能改分类', async function () {
      const r = await req(sandbox.port, 'POST', '/api/components/clarify/category', { category: '学习与练习' });
      assert.strictEqual(r.status, 200, r.text);
      assert.strictEqual(r.json.category, '学习与练习', '内置组件改分类必须生效，实际：' + r.json.category);
      const comps = await req(sandbox.port, 'GET', '/api/components');
      assert.strictEqual(comps.json.components.find(function (c) { return c.id === 'clarify'; }).category, '学习与练习');
      await req(sandbox.port, 'POST', '/api/components/clarify/category', { category: '基础功能组件' });
    });
    await ok('页面上用分类下拉改分类：卡片当场搬过去、下拉不回弹', async function () {
      await page.goto('#/components');
      await page.evalIn("document.getElementById('cmpExpandAll').click()");
      await sleep(450);
      const expr = "(async function(){var s=document.querySelector('[data-comp-cat=\"conditions\"]');if(!s)return 'no-select';var b=s.nextElementSibling;if(!b||!b.classList.contains('sxiSelBtn'))return 'no-custom-btn';b.click();await new Promise(function(r){setTimeout(r,250);});var opts=Array.prototype.slice.call(document.querySelectorAll('.sxiPop .sxiOpt'));var w=opts.filter(function(o){return o.textContent.trim()==='基础功能组件';})[0];if(!w)return 'no-option';w.click();await new Promise(function(r){setTimeout(r,700);});var s2=document.querySelector('[data-comp-cat=\"conditions\"]');var m=s2&&s2.closest('[data-cmp-cat]');return JSON.stringify({value:s2&&s2.value,cat:m&&m.getAttribute('data-cmp-cat')});})()";
      const moved = JSON.parse(await page.evalIn(expr));
      assert.strictEqual(moved.value, '基础功能组件', '下拉值应停在新分类，实际：' + JSON.stringify(moved));
      assert.strictEqual(moved.cat, '基础功能组件', '卡片应搬到新分类，实际：' + JSON.stringify(moved));
    });

    console.log('');
    console.log('== 目标范围视图 ==');
    await ok('选中目标后同样按分类折叠 + 有搜索框 + 全局块收起', async function () {
      const goals = await req(sandbox.port, 'GET', '/api/goals');
      if (!(goals.json.goals || []).length) { console.log('    （这个沙箱没有目标，跳过目标视图断言）'); return; }
      await page.goto('#/components');
      const clicked = await page.evalIn("(function(){var b=document.querySelectorAll('#cmpScopeBar [data-scope]');if(b.length<2)return false;b[1].click();return true;})()");
      assert.strictEqual(clicked, true, '应有「某个目标」的管理范围按钮');
      await sleep(1400);
      assert.strictEqual(await page.evalIn("!!document.getElementById('cmpGoalSearch')"), true, '目标视图应有搜索框');
      const g = JSON.parse(await page.evalIn(GOAL_GROUPS_EXPR));
      assert.ok(Object.keys(g).length >= 2, '目标视图也应分类分组，实际：' + JSON.stringify(g));
      assert.ok(Object.keys(g).every(function (k) { return g[k].folded === true; }), '目标视图同样默认收起');
      assert.strictEqual(await page.evalIn("!!document.querySelector('#app .cmpGlobalFold')"), true, '选了目标时全局组件应折叠起来，避免误改');
    });
    await ok('目标范围的开关是 data-gcmp（不是全局 data-cmp）', async function () {
      const n = await page.evalIn("document.querySelectorAll('#cmpGoalCatList [data-gcmp]').length + '/' + document.querySelectorAll('#cmpGoalCatList [data-cmp]').length");
      assert.ok(String(n).endsWith('/0'), '目标范围里不该出现全局开关 data-cmp，实际：' + n);
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
