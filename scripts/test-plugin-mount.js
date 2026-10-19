#!/usr/bin/env node
'use strict';
/**
 * 插件接管冒烟测试（不需要 AI、不花钱、秒级）。
 *
 * 为什么必须有这个测试：
 *   路由里插件是「优先用插件、失败回退原版」。插件抛错时页面**照样能看**（原版兜底），
 *   于是像素一致性测试会全绿 —— 两边都是原版，当然一致。看起来"全都通过"，
 *   其实插件一次都没跑起来。这个测试专门验"插件真的接管了"：
 *     window.__sxPluginUsed[page] === true  +  #app 有内容  +  无未捕获异常
 *
 * 用法：node scripts/test-plugin-mount.js [route...]
 */
const { spawn, execFileSync } = require('node:child_process');
const { rmSync } = require('node:fs');

const PORT = Number(process.env.PORT || 3213);
const BASE = 'http://localhost:' + PORT;
const CDP_PORT = Number(process.env.CDP_PORT || 9788);
const PROFILE = '/tmp/sx-mount-' + process.pid;
const sleep = ms => new Promise(r => setTimeout(r, ms));

/** 路由 → 期望接管的插件 id（null = 由服务端组件/引导层负责，不检查） */
const CASES = [
  { route: '/', page: 'home' },
  { route: '/aitasks', page: 'aitasks' },
  { route: '/components', page: 'components' },
  { route: '/library', page: 'library' },
  { route: '/g/166', page: 'goal' },
  { route: '/g/166/map', page: 'roadmap' },
  { route: '/g/166/chat', page: 'goal' },
  { route: '/g/166/versions', page: 'versions' },
  { route: '/g/166/diff/285', page: 'diff' },
  { route: '/t/142', page: 'tutorial' },
  { route: '/settings', page: 'settings' },
  { route: '/settings/ai', page: 'settings' },
  { route: '/guide/1', page: 'guide' }
];

async function waitTargets() {
  for (let i = 0; i < 80; i++) {
    try {
      const r = await fetch('http://127.0.0.1:' + CDP_PORT + '/json/list');
      if (r.ok) return await r.json();
    } catch (e) {}
    await sleep(250);
  }
  throw new Error('CDP 未就绪');
}

(async () => {
  const edge = spawn('microsoft-edge', [
    '--headless=new', '--disable-gpu', '--no-sandbox', '--remote-allow-origins=*',
    '--remote-debugging-port=' + CDP_PORT, '--user-data-dir=' + PROFILE,
    '--window-size=1440,900', 'about:blank'
  ], { stdio: 'ignore' });

  let ws, seq = 0;
  const pending = new Map();
  const errors = [];
  const send = (method, params) => new Promise((resolve, reject) => {
    const id = ++seq;
    pending.set(id, { resolve, reject });
    ws.send(JSON.stringify({ id, method, params: params || {} }));
    setTimeout(() => { if (pending.has(id)) { pending.delete(id); reject(new Error('timeout ' + method)); } }, 20000);
  });
  const evalIn = async expr => {
    const r = await send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true });
    return r && r.result && r.result.value;
  };

  try {
    const list = await waitTargets();
    const page = list.find(t => t.type === 'page');
    ws = new WebSocket(page.webSocketDebuggerUrl);
    await new Promise((res, rej) => { ws.addEventListener('open', res); ws.addEventListener('error', rej); });
    ws.addEventListener('message', ev => {
      const m = JSON.parse(ev.data);
      if (m.id && pending.has(m.id)) {
        const p = pending.get(m.id); pending.delete(m.id);
        if (m.error) p.reject(new Error(m.error.message)); else p.resolve(m.result);
      } else if (m.method === 'Runtime.exceptionThrown') {
        const d = m.params.exceptionDetails;
        errors.push(((d.exception && d.exception.description) || d.text || '').slice(0, 240));
      }
    });
    await send('Page.enable');
    await send('Runtime.enable');

    /* 关掉首次引导 + AI 抽屉，避免干扰 */
    await send('Page.navigate', { url: BASE + '/' });
    await sleep(4500);
    await evalIn("localStorage.setItem('sierxing-guide-done','1'); localStorage.setItem('sierxing-ai-open','0');");
    await send('Page.navigate', { url: BASE + '/' });
    await sleep(3500);

    const targets = process.argv.slice(2);
    const cases = targets.length
      ? CASES.filter(c => targets.some(t => c.route.indexOf(t) >= 0 || t === c.page))
      : CASES;

    let pass = 0, fail = 0;
    for (const c of cases) {
      /* ⚠️ 必须整页导航：只改 hash 时上一页的 __sxPluginUsed 还在，会误判"已接管" */
      await send('Page.navigate', { url: BASE + '/#' + c.route });
      await sleep(3000);
      await evalIn("localStorage.setItem('sierxing-guide-done','1'); localStorage.setItem('sierxing-ai-open','0'); var m=document.getElementById('guideMask'); if(m) m.remove();");
      const info = await evalIn(`(function(){
        var used = window.__sxPluginUsed || {};
        var root = document.querySelector('#app');
        var txt = root ? String(root.textContent || '') : '';
        return {
          used: used[${JSON.stringify(c.page)}] === true,
          usedAll: Object.keys(used),
          textLen: txt.length,
          broken: txt.indexOf('页面出错') >= 0,
          head: txt.replace(/\\s+/g, ' ').slice(0, 60)
        };
      })()`);
      const ok = info && info.used && info.textLen > 40 && !info.broken;
      if (ok) { pass++; console.log('  ✅ 插件接管  ' + c.route + '  (' + c.page + ')'); }
      else {
        fail++;
        console.log('  ❌ 未接管    ' + c.route + '  期望 ' + c.page +
          '  实际 used=[' + ((info && info.usedAll) || []).join(',') + ']' +
          '  textLen=' + (info && info.textLen) + (info && info.broken ? '  页面出错' : ''));
        if (info) console.log('      内容: ' + info.head);
      }
    }

    console.log('');
    console.log('接管: ' + pass + '/' + cases.length);
    if (errors.length) {
      console.log('页面异常 ' + errors.length + ' 条:');
      errors.slice(0, 6).forEach(e => console.log('  - ' + e.split('\n')[0]));
    }
    if (fail) process.exitCode = 1;
  } catch (e) {
    console.error('测试异常: ' + e.message);
    process.exitCode = 1;
  } finally {
    try { ws && ws.close(); } catch (e) {}
    try { edge.kill('SIGKILL'); } catch (e) {}
    try { execFileSync('pkill', ['-9', '-f', '--', '--user-data-dir=' + PROFILE], { stdio: 'ignore' }); } catch (e) {}
    rmSync(PROFILE, { recursive: true, force: true });
  }
})();
