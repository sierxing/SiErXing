'use strict';
/**
 * 左栏「路线图」按钮回归：node --no-warnings scripts/test-rail-roadmap-ui.js
 * 需求（用户原话）：按钮要**常驻**；
 *   · 在某个目标上下文里 → 点了跳该目标的规划页（#/g/<id>）；
 *   · 不在任何目标页面 → 按钮保留但禁用（灰掉、点不动）。
 * 以前是按 state.goal + 视图白名单决定显示，插件页/版本页/教程页时有时无。
 */
const { spawn, execFileSync } = require('node:child_process');
const http = require('node:http');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const APP_PORT = Number(process.env.APP_PORT || 3329);
const CDP_PORT = Number(process.env.CDP_PORT || 9804);
const DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'sx-rail-ui-'));
const HOME_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'sx-rail-home-'));
const PROFILE = path.join(os.tmpdir(), 'sx-rail-prof-' + process.pid);
const BASE = 'http://127.0.0.1:' + APP_PORT;
const NL = String.fromCharCode(10);
const sleep = ms => new Promise(r => setTimeout(r, ms));

let passed = 0, failed = 0;
function ok(name, cond, detail) {
  if (cond) { passed++; console.log('  ✓', name); }
  else { failed++; console.log('  ✗', name, detail == null ? '' : '→ ' + detail); }
}

const SEED = {
  goals: [{ id: 1, title: '转行 AI 产品经理', status: 'active' }],
  nodes: [{ id: 11, goal_id: 1, parent_id: null, level: 0, title: '阶段一', condition_id: 0, sort_order: 1 }],
  tutorials: [{ id: 1, goal_id: 1, node_id: 11, title: '入门教程', format: 'md', content: '# 入门' + NL + NL + '正文' }]
};

async function jget(url) { const r = await fetch(url); const t = await r.text(); try { return JSON.parse(t); } catch (e) { return t; } }
async function jpost(url, body) {
  const r = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body || {}) });
  const t = await r.text(); try { return JSON.parse(t); } catch (e) { return t; }
}

async function main() {
  const app = spawn(process.execPath, ['--no-warnings', '--experimental-sqlite', 'server/server.js'], {
    cwd: ROOT,
    env: Object.assign({}, process.env, { PORT: String(APP_PORT), NO_OPEN: '1', SIERXING_DATA_DIR: DATA_DIR }),
    stdio: 'ignore'
  });
  let edge = null, ws = null;
  try {
    let up = false;
    for (let i = 0; i < 60; i++) {
      await sleep(250);
      try { const h = await jget(BASE + '/api/health'); if (h && h.ok) { up = true; break; } } catch (e) {}
    }
    if (!up) throw new Error('测试实例没起来');
    const imp = await jpost(BASE + '/api/import/json', SEED);
    if (!imp || !imp.ok) throw new Error('导入种子失败：' + JSON.stringify(imp).slice(0, 160));

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
    const nav = async (hash) => {
      await send('Page.navigate', { url: BASE + '/' + hash });
      await sleep(2600);
      await evalIn("document.querySelectorAll('#guideMask,#pomoBadge,#pomoPanel').forEach(x=>x.remove())");
    };
    const rail = () => evalIn("(function(){var el=[].slice.call(document.querySelectorAll('#rail .railItem')).find(function(x){return (x.textContent||'').indexOf('路线图')>=0});if(!el)return JSON.stringify({found:false});return JSON.stringify({found:true,disabled:el.classList.contains('disabled'),tag:el.tagName,href:el.getAttribute('href')||'',active:el.classList.contains('active'),title:el.getAttribute('title')||''})})()");

    await nav('');  // 首次加载先过引导
    await evalIn("localStorage.setItem('sierxing-guide-done','1'); localStorage.setItem('sierxing-guide','1');");
    await nav('');

    /* ① 首页（无目标上下文）：常驻但禁用 */
    const home = JSON.parse(await rail());
    ok('首页：路线图按钮存在', home.found === true, JSON.stringify(home));
    ok('首页：按钮是禁用态（点不动）', home.disabled === true && home.tag === 'SPAN' && !home.href, JSON.stringify(home));

    /* ② 目标页：可用，指向该目标 */
    await nav('#/g/1');
    const goal = JSON.parse(await rail());
    ok('目标页：按钮可用且指向 #/g/1', goal.found && !goal.disabled && goal.href === '#/g/1', JSON.stringify(goal));
    ok('目标页：按钮高亮 active', goal.active === true, JSON.stringify(goal));

    /* ③ 版本页（以前这里经常没有按钮）：仍然常驻可用 */
    await nav('#/g/1/versions');
    const ver = JSON.parse(await rail());
    ok('版本页：按钮常驻且指向 #/g/1', ver.found && !ver.disabled && ver.href === '#/g/1', JSON.stringify(ver));

    /* ④ 教程页（靠教程所属目标）：常驻可用 */
    await nav('#/t/1');
    const tut = JSON.parse(await rail());
    ok('教程页：按钮常驻且指向教程所属目标 #/g/1', tut.found && !tut.disabled && tut.href === '#/g/1', JSON.stringify(tut));

    /* ④b 教程内插件页（#/t/1/quiz，以前这里也没有按钮）：常驻可用 */
    await nav('#/t/1/quiz');
    const tq = JSON.parse(await rail());
    ok('教程内插件页：按钮常驻且指向教程所属目标', tq.found && !tq.disabled && tq.href === '#/g/1', JSON.stringify(tq));

    /* ⑤ 设置页：禁用 */
    await nav('#/settings');
    const st = JSON.parse(await rail());
    ok('设置页：按钮常驻但禁用', st.found && st.disabled === true, JSON.stringify(st));

    /* ⑥ 从版本页点按钮 → 真的跳到该目标规划页 */
    await nav('#/g/1/versions');
    await evalIn("(function(){var el=[].slice.call(document.querySelectorAll('#rail .railItem')).find(function(x){return (x.textContent||'').indexOf('路线图')>=0});el.click();return 1})()");
    await sleep(1500);
    const hashAfter = await evalIn("location.hash");
    ok('点按钮跳到该目标的规划页', hashAfter === '#/g/1', String(hashAfter));

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
main().then(() => process.exit(process.exitCode || 0)).catch(e => { console.error('回归失败：', e && e.message); process.exit(1); });
