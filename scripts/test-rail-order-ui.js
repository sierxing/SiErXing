'use strict';
/**
 * 左栏功能按钮「拖动排序」回归：node --no-warnings scripts/test-rail-order-ui.js
 * 需求（用户原话）：左侧的功能按键的上下顺序可以用户手动拖动调整。
 * 钉住：
 *   ① 按住按钮上下拖 → 顺序立刻变化，未拖到 5px 时仍当点击；
 *   ② 顺序存本机 localStorage（sierxing-rail-order-v1，显示偏好，不做多端同步），刷新后保持；
 *   ③ 拖完不会误触发跳转（松手后的 click 必须被拦掉）；
 *   ④ 往上拖 / 拖到末尾都能正确落位。
 */
const { spawn, execFileSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const APP_PORT = Number(process.env.APP_PORT || 3331);
const CDP_PORT = Number(process.env.CDP_PORT || 9805);
const DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'sx-rail-order-'));
const HOME_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'sx-rail-order-home-'));
const PROFILE = path.join(os.tmpdir(), 'sx-rail-order-prof-' + process.pid);
const BASE = 'http://127.0.0.1:' + APP_PORT;
const KEY = 'sierxing-rail-order-v1';
const sleep = ms => new Promise(r => setTimeout(r, ms));

let passed = 0, failed = 0;
function ok(name, cond, detail) {
  if (cond) { passed++; console.log('  ✓', name); }
  else { failed++; console.log('  ✗', name, detail == null ? '' : '→ ' + detail); }
}

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
    const imp = await jpost(BASE + '/api/import/json', { goals: [{ id: 1, title: '拖排序测试目标', status: 'active' }] });
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
      await send('Page.navigate', { url: BASE + '/?r=' + Date.now() + hash });
      await sleep(3000);
      await evalIn("document.querySelectorAll('#guideMask,#pomoBadge,#pomoPanel').forEach(x=>x.remove())");
    };
    const order = async () => JSON.parse(await evalIn("(function(){return JSON.stringify([].slice.call(document.querySelectorAll('#rail .railNav .railItem[data-rail-item]')).map(function(x){return x.getAttribute('data-rail-item')}))})()"));
    const railInfo = async () => JSON.parse(await evalIn("(function(){var o={};[].slice.call(document.querySelectorAll('#rail .railNav .railItem[data-rail-item]')).forEach(function(x){var r=x.getBoundingClientRect();o[x.getAttribute('data-rail-item')]={x:r.left+r.width/2,y:r.top+r.height/2,top:r.top,bottom:r.bottom,title:x.getAttribute('title')||''}});return JSON.stringify(o)})()"));

    const drag = async (fromKey, toKey, placeAfter) => {
      const info = await railInfo();
      const a = info[fromKey], b = info[toKey];
      if (!a || !b) throw new Error('找不到左栏按钮 ' + fromKey + '/' + toKey);
      const sx = a.x, sy = a.y;
      const ty = placeAfter ? (b.bottom - 3) : (b.top + 3);
      await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: sx, y: sy });
      await send('Input.dispatchMouseEvent', { type: 'mousePressed', x: sx, y: sy, button: 'left', buttons: 1, clickCount: 1 });
      for (let i = 1; i <= 10; i++) {
        const y = sy + (ty - sy) * i / 10;
        await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: sx, y: y, button: 'left', buttons: 1 });
        await sleep(20);
      }
      await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: sx, y: ty, button: 'left', buttons: 0, clickCount: 1 });
      await sleep(500);
    };

    await nav('#/');
    await evalIn("localStorage.setItem('sierxing-guide-done','1'); localStorage.setItem('sierxing-guide','1');");
    await nav('#/');

    const info0 = await railInfo();
    ok('八个功能按钮都在左栏', Object.keys(info0).length === 8, Object.keys(info0).join(','));
    ok('每项 title 带「可拖动排序」提示', Object.keys(info0).every(k => /可拖动排序/.test(info0[k].title)), JSON.stringify(info0.home));
    const def = await order();
    ok('默认顺序：目标 / 路线图在最上面', def[0] === 'home' && def[1] === 'roadmap', def.join(','));
    ok('底部「主题」不在可拖动列表里', (await evalIn("document.querySelectorAll('#rail .railBottom .railItem[data-rail-item]').length")) === 0);

    /* ① 把「设置」拖到最上面（放在「目标」之前） */
    await drag('settings', 'home', false);
    const o1 = await order();
    ok('拖到最上面：设置排第一、目标第二', o1[0] === 'settings' && o1[1] === 'home', o1.join(','));
    ok('松手后没有被误点跳去设置页', (await evalIn('location.hash')) === '#/', String(await evalIn('location.hash')));
    const saved1 = JSON.parse(await evalIn("localStorage.getItem('" + KEY + "')||'[]'"));
    ok('顺序写进本机 localStorage（8 项且设置第一）', Array.isArray(saved1) && saved1.length === 8 && saved1[0] === 'settings', JSON.stringify(saved1));

    /* ② 刷新后顺序保持 */
    await nav('#/');
    const o2 = await order();
    ok('刷新后顺序保持', JSON.stringify(o2) === JSON.stringify(o1), o2.join(','));
    ok('刷新后设置的 title 提示还在', /可拖动排序/.test((await railInfo()).settings.title));

    /* ③ 把「设置」拖回最末尾（放在最后一项之后） */
    const lastKey = o2[o2.length - 1];
    await drag('settings', lastKey, true);
    const o3 = await order();
    ok('拖到末尾：设置落到最后一位', o3[o3.length - 1] === 'settings' && o3.length === 8, o3.join(','));

    /* ④ 把「目标」也拖到末尾，确认任意按钮都能排 */
    await drag('home', 'settings', true);
    const o4 = await order();
    ok('任意按钮都能拖：目标落到最后', o4[o4.length - 1] === 'home', o4.join(','));

    /* ⑤ 清理存储后恢复默认（不影响真机，这里只是沙箱） */
    await evalIn("localStorage.removeItem('" + KEY + "')");
    await nav('#/');
    const o5 = await order();
    ok('清掉本机顺序后回到默认', o5[0] === 'home' && o5[1] === 'roadmap', o5.join(','));

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

main().then(() => process.exit(process.exitCode || 0)).catch(e => { console.error('回归失败：', e && e.stack || e); process.exit(1); });
