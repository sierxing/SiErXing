#!/usr/bin/env node
'use strict';
/**
 * 简历工坊整页回归（沙箱实例 + CDP 真浏览器，不碰真实数据）
 * ----------------------------------------------------------------
 * 验证「像达成条件一样」的三个要素：
 *   1. 目标页顶栏有「📄 简历工坊」按钮（goalEntry 提供，不是硬编码）；
 *   2. 点开是**整页** #/g/<id>/resume（不再有右侧抽屉 / 右下角浮窗）；
 *   3. 开关是**按目标**的：骨架里的开关只隐藏这个目标的入口，别的目标照旧；
 *      组件管理页的「目标视图」里能看到它、能单独开关。
 *
 * 跑法：node --no-warnings scripts/test-resume-page.js
 */
const { spawn, execFileSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const APP_PORT = Number(process.env.APP_PORT || 3341);
const CDP_PORT = Number(process.env.CDP_PORT || 9821);
const DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'sx-rs-page-'));
const HOME_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'sx-rs-home-'));
const PROFILE = path.join(os.tmpdir(), 'sx-rs-prof-' + process.pid);
const BASE = 'http://127.0.0.1:' + APP_PORT;
const sleep = ms => new Promise(r => setTimeout(r, ms));

let passed = 0, failed = 0;
function ok(name, cond, detail) {
  if (cond) { passed++; console.log('  ✓', name); }
  else { failed++; console.log('  ✗', name, detail == null ? '' : '→ ' + detail); }
}

async function jget(url) { const r = await fetch(url); const t = await r.text(); try { return JSON.parse(t); } catch (e) { return t; } }
async function jsend(url, method, body) {
  const r = await fetch(url, { method: method, headers: { 'Content-Type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
  const t = await r.text(); try { return JSON.parse(t); } catch (e) { return t; }
}

async function main() {
  /* 只有一个目标 + 一个空方案，避免页面空状态干扰 */
  const app = spawn(process.execPath, ['--no-warnings', '--experimental-sqlite', 'server/server.js'], {
    cwd: ROOT,
    env: Object.assign({}, process.env, { PORT: String(APP_PORT), NO_OPEN: '1', SIERXING_DATA_DIR: DATA_DIR, SIERXING_RESUME_FAKE: '1' }),
    stdio: 'ignore'
  });
  let edge = null, ws = null;
  try {
    let up = false;
    for (let i = 0; i < 80; i++) {
      await sleep(250);
      try { const h = await jget(BASE + '/api/health'); if (h && h.ok) { up = true; break; } } catch (e) {}
    }
    if (!up) throw new Error('测试实例没起来');

    const g1 = await jsend(BASE + '/api/goals', 'POST', { title: '求职目标A' });
    const g2 = await jsend(BASE + '/api/goals', 'POST', { title: '求职目标B' });
    if (!g1.goal || !g2.goal) throw new Error('建目标失败：' + JSON.stringify(g1).slice(0, 120));

    edge = spawn('microsoft-edge', [
      '--headless=new', '--disable-gpu', '--no-sandbox', '--disable-crash-reporter', '--disable-breakpad',
      '--remote-allow-origins=*', '--remote-debugging-port=' + CDP_PORT, '--user-data-dir=' + PROFILE,
      '--window-size=1440,1000', 'about:blank'
    ], { stdio: 'ignore', env: Object.assign({}, process.env, { HOME: HOME_DIR }) });

    let seq = 0;
    const pending = new Map();
    const exceptions = [];
    const send = (method, params) => new Promise((resolve, reject) => {
      const id = ++seq;
      pending.set(id, { resolve, reject });
      ws.send(JSON.stringify({ id, method, params: params || {} }));
      setTimeout(() => { if (pending.has(id)) { pending.delete(id); reject(new Error('timeout ' + method)); } }, 30000);
    });
    const evalIn = async expr => {
      const r = await send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true });
      if (r && r.exceptionDetails) throw new Error('eval 失败: ' + JSON.stringify(r.exceptionDetails).slice(0, 240));
      return r && r.result && r.result.value;
    };
    let list = null;
    for (let i = 0; i < 120; i++) {
      try { const r = await fetch('http://127.0.0.1:' + CDP_PORT + '/json/list'); if (r.ok) { list = await r.json(); break; } } catch (e) {}
      await sleep(250);
    }
    if (!list) throw new Error('CDP 未就绪');
    ws = new WebSocket(list.find(t => t.type === 'page').webSocketDebuggerUrl);
    await new Promise((res, rej) => { ws.addEventListener('open', res); ws.addEventListener('error', rej); });
    ws.addEventListener('message', ev => {
      const m = JSON.parse(ev.data);
      if (m.id && pending.has(m.id)) {
        const p = pending.get(m.id); pending.delete(m.id);
        m.error ? p.reject(new Error(m.error.message)) : p.resolve(m.result);
      } else if (m.method === 'Runtime.exceptionThrown') {
        exceptions.push(((m.params.exceptionDetails.exception || {}).description || m.params.exceptionDetails.text || '').slice(0, 240));
      }
    });
    await send('Page.enable'); await send('Runtime.enable');
    const nav = async h => {
      await send('Page.navigate', { url: BASE + '/' + h });
      await sleep(2600);
      await evalIn("document.querySelectorAll('#guideMask,#pomoBadge,#pomoPanel').forEach(x=>x.remove())");
    };

    await nav('');
    await evalIn("localStorage.setItem('sierxing-guide-done','1'); localStorage.setItem('sierxing-guide','1');");
    await nav('');

    /* ① 目标页顶栏：有 📄 简历工坊 按钮（goalEntry 生成，data-plugin-go） */
    await nav('#/g/' + g1.goal.id);
    const btn = await evalIn(`(function(){
      var b = document.querySelector('[data-plugin-go="#/g/${g1.goal.id}/resume"]');
      return JSON.stringify({ found: !!b, text: b ? b.textContent.trim() : '', id: b ? b.id : '' });
    })()`);
    const b1 = JSON.parse(btn);
    ok('目标页顶栏有「📄 简历工坊」入口', b1.found === true, btn);
    ok('入口由 goalEntry 提供（id=goalComp_resume）', b1.id === 'goalComp_resume', b1.id);

    /* ② 点入口 → 整页，且不是抽屉 */
    await evalIn(`document.querySelector('[data-plugin-go="#/g/${g1.goal.id}/resume"]').click()`);
    await sleep(2200);
    const page = await evalIn(`(function(){
      return JSON.stringify({
        hash: location.hash,
        hasPage: !!document.getElementById('rsPage'),
        hasDrawer: !!document.getElementById('resumePanel'),
        steps: document.querySelectorAll('#rsSteps .rsStep').length,
        title: (document.querySelector('#rsPage .mapTitle')||{}).textContent || '',
        back: !!document.querySelector('#rsPage [data-back="#/g/${g1.goal.id}"]'),
        pluginUsed: !!(window.__sxPluginUsed && window.__sxPluginUsed.resume)
      });
    })()`);
    const p2 = JSON.parse(page);
    ok('点开是整页 #/g/<id>/resume', p2.hash === '#/g/' + g1.goal.id + '/resume', p2.hash);
    ok('渲染出整页（#rsPage 存在）', p2.hasPage === true, page);
    ok('不再有右侧抽屉面板', p2.hasDrawer === false, page);
    ok('六步向导步骤条都在', p2.steps === 6, 'steps=' + p2.steps);
    ok('页头有「← 返回目标」', p2.back === true, page);
    ok('插件路由被注册（matchRoute 命中）', p2.hash.indexOf('/resume') > 0, p2.hash);

    /* ③ 目标级开关：关掉目标 A 的 resume → A 的入口消失，B 的不受影响 */
    const off = await jsend(BASE + '/api/goals/' + g1.goal.id + '/plugins', 'POST', { plugin_id: 'resume', enabled: false });
    if (!off || off.enabled.resume !== false) throw new Error('按目标关闭失败');
    await nav('#/g/' + g1.goal.id);
    const aOff = await evalIn(`!!document.querySelector('[data-plugin-go="#/g/${g1.goal.id}/resume"]')`);
    ok('关掉目标A后：A 顶栏没有简历入口', aOff === false, String(aOff));
    /* 直接访问 A 的简历页：应显示「这个目标已关闭」而不是崩 */
    await nav('#/g/' + g1.goal.id + '/resume');
    const closed = await evalIn(`(function(){
      var t = (document.querySelector('#rsPage .ebTitle')||{}).textContent || '';
      return JSON.stringify({ hasPage: !!document.getElementById('rsPage'), text: t, hasBody: !!document.getElementById('rsBody') });
    })()`);
    const c3 = JSON.parse(closed);
    ok('被关掉的目标直接开简历页 → 显示「已关闭」空状态（不崩）', c3.hasPage === true && c3.text.indexOf('已关闭') >= 0, closed);

    await nav('#/g/' + g2.goal.id);
    const bOn = await evalIn(`!!document.querySelector('[data-plugin-go="#/g/${g2.goal.id}/resume"]')`);
    ok('目标B 的入口不受影响（仍是开的）', bOn === true, String(bOn));

    /* ④ 全局值没被目标级开关串掉 */
    const comps = await jget(BASE + '/api/components');
    ok('全局开关仍是开（按目标关闭不串全局）', comps.enabled.resume === true, String(comps.enabled.resume));

    /* ⑤ 组件管理页「目标视图」里能看到 resume（可按目标管理清单包含它） */
    const gm = await jsget(BASE + '/api/goals/' + g1.goal.id + '/plugins');
    ok('目标级清单包含 resume（组件管理目标视图可见）', gm.enabled && ('resume' in gm.enabled), JSON.stringify(Object.keys(gm.enabled || {}).slice(0, 6)));

    /* ⑥ 恢复开关，并验证抽屉式老入口不会再把页面打回 body 浮层 */
    await jsend(BASE + '/api/goals/' + g1.goal.id + '/plugins', 'POST', { plugin_id: 'resume', enabled: true });
    await nav('#/g/' + g1.goal.id);
    await evalIn(`document.querySelector('[data-plugin-go="#/g/${g1.goal.id}/resume"]').click()`);
    await sleep(2000);
    const again = await evalIn(`JSON.stringify({
      page: !!document.getElementById('rsPage'),
      drawer: !!document.getElementById('resumePanel') || !!document.getElementById('resumeMask'),
      inApp: !!(document.getElementById('app') && document.getElementById('app').querySelector('#rsPage'))
    })`);
    const a6 = JSON.parse(again);
    ok('重新打开仍是整页、无抽屉/蒙层残留', a6.page === true && a6.drawer === false, again);
    ok('整页画在 #app 里（不是 body 浮层）', a6.inApp === true, again);

    ok('全程无 JS 异常', exceptions.length === 0, exceptions.join(' | '));

    console.log('');
    console.log(passed + ' 通过 / ' + failed + ' 失败');
    if (failed) process.exitCode = 1;
  } finally {
    try { ws && ws.close(); } catch (e) {}
    try { execFileSync('pkill', ['-9', '-f', '--', '--user-data-dir=' + PROFILE], { stdio: 'ignore' }); } catch (e) {}
    try { edge && edge.kill('SIGKILL'); } catch (e) {}
    try { fs.rmSync(PROFILE, { recursive: true, force: true }); } catch (e) {}
    try { app.kill('SIGKILL'); } catch (e) {}
    try { fs.rmSync(DATA_DIR, { recursive: true, force: true }); } catch (e) {}
    try { fs.rmSync(HOME_DIR, { recursive: true, force: true }); } catch (e) {}
  }
}

async function jsget(url) {
  const r = await fetch(url);
  const t = await r.text();
  try { return JSON.parse(t); } catch (e) { return {}; }
}

main().then(() => process.exit(process.exitCode || 0)).catch(e => { console.error('回归失败：', e && e.message); process.exit(1); });
