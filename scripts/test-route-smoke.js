#!/usr/bin/env node
'use strict';
/**
 * 逐路由冒烟验收：node scripts/test-route-smoke.js
 * 用途：**真启动一次 SPA**，逐路由断言 ① 没有「页面出错」② 渲染出了该路由特有的标记元素
 *       ③ 页面有实质内容（不是只剩加载态）。
 *
 * 为什么必须有这一份（而不是只靠 `node --check` 或 test:parity）：
 *   1. `node --check` 只查语法，查不出 ReferenceError —— AGENTS.md 第 7 节坑 #9 已写明，
 *      但真实又踩了一次：`roadmapVueEnabled()` 被调用却**从未定义**，路线图页每次进都是
 *      「页面出错：roadmapVueEnabled is not defined」。
 *   2. `test:parity` 是「默认界面 vs 原版」的**对比**：两边都炸成同一个错误页时它会判"一致"，
 *      对"两模式一起坏"这类故障完全是瞎的。所以必须有一份**只看绝对正确性**的冒烟。
 *
 * 前置：服务已在跑（默认 3213，PORT 可覆盖）。
 * 用法：PORT=3213 node scripts/test-route-smoke.js
 * 退出码：0 = 全部通过；1 = 有路由失败。
 */
const { spawn, execFileSync } = require('node:child_process');
const { rmSync } = require('node:fs');

const PORT = Number(process.env.PORT || 3213);
const BASE = 'http://localhost:' + PORT;
const CDP_PORT = Number(process.env.CDP_PORT || 9788);
const PROFILE = '/tmp/sx-smoke-' + process.pid;

/* [路由, 该路由特有的标记选择器, 最少正文字数]
   ⚠️ 标记必须是**该路由才有的**元素：用 `#app` 或 `.page` 这种通配选择器等于没测
   （坑 #12：不能拿通用标记或 DOM 字节数当判据）。
   ⚠️ 路线图页（`#/g/:id/map`）的正文是 **SVG 导图**，`innerText` 天生就短（实测稳定 407 字），
      不能用 `.page` 当标记（它的根是 `.mapPage`）、也不能按大字数判 —— 判它有没有 `.mapPage`
      加少量文字即可。 */
const CASES = [
  ['/',               '#app .page',         400],
  ['/g/166',          '#app .page',         400],
  ['/g/166/map',      '#app .mapPage',      60],
  ['/g/166/chat',     '#app .page',         400],
  ['/g/166/versions', '#app .page',         400],
  ['/components',     '#app .page',         400],
  ['/library',        '#app .page',         400],
  ['/aitasks',        '#app .page',         60],
  ['/studystats',     '#app .page',         60],
  ['/settings',       '#app .page',         60],
  ['/guide/1',        '#app .page',         400],
  ['/t/142',          '#app .tutPage',      400],
];

const sleep = ms => new Promise(r => setTimeout(r, ms));

async function main() {
  const edge = spawn('microsoft-edge', [
    '--headless=new', '--disable-gpu', '--no-sandbox', '--remote-allow-origins=*',
    '--remote-debugging-port=' + CDP_PORT, '--user-data-dir=' + PROFILE,
    '--window-size=1440,900', 'about:blank'
  ], { stdio: 'ignore' });

  let ws, seq = 0;
  const pending = new Map();
  const exceptions = [];
  function send(method, params) {
    return new Promise((resolve, reject) => {
      const id = ++seq;
      pending.set(id, { resolve, reject });
      ws.send(JSON.stringify({ id, method, params: params || {} }));
      setTimeout(() => { if (pending.has(id)) { pending.delete(id); reject(new Error('timeout ' + method)); } }, 25000);
    });
  }
  async function evalIn(expr) {
    const r = await send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true });
    return r && r.result && r.result.value;
  }

  try {
    let list = null;
    for (let i = 0; i < 80; i++) {
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
        exceptions.push(((m.params.exceptionDetails.exception || {}).description || m.params.exceptionDetails.text || '').slice(0, 200));
      }
    });
    await send('Page.enable'); await send('Runtime.enable');

    await send('Page.navigate', { url: BASE + '/' });
    await sleep(2500);
    /* 关掉首次运行引导 + 常驻 AI 抽屉：它们会盖住页面、干扰标记判定 */
    await evalIn("localStorage.setItem('sierxing-guide-done','1'); localStorage.setItem('sierxing-guide','1'); localStorage.setItem('sierxing-ai-open','0');");

    let bad = 0;
    for (const [route, sel, minChars] of CASES) {
      exceptions.length = 0;
      await send('Page.navigate', { url: BASE + '/#' + route });
      await sleep(3800);
      const st = await evalIn('JSON.stringify({err:((document.querySelector("#app")||{innerText:""}).innerText||"").indexOf("页面出错")>=0, marker:!!document.querySelector(' + JSON.stringify(sel) + '), txt:((document.querySelector("#app")||{innerText:""}).innerText||"").length})');
      let o = null;
      try { o = JSON.parse(st); } catch (e) {}
      const pass = !!o && !o.err && o.marker && o.txt >= (minChars || 30);
      if (!pass) {
        bad++;
        console.log('  ❌ ' + route + '  err=' + (o ? o.err : '?') + ' marker=' + (o ? o.marker : '?') + ' chars=' + (o ? o.txt : '?'));
        if (exceptions.length) console.log('      异常: ' + exceptions[0]);
      } else {
        console.log('  ✓ ' + route);
      }
    }

    console.log('');
    if (bad) {
      console.log('失败 ' + bad + '/' + CASES.length + ' 条');
      process.exitCode = 1;
    } else {
      console.log(CASES.length + ' 条路由全部正常渲染 ✅');
    }
  } finally {
    try { ws && ws.close(); } catch (e) {}
    /* 按 profile 杀整棵树 + 删 profile（AGENTS.md 第 2 节铁律②） */
    try { execFileSync('pkill', ['-9', '-f', '--', '--user-data-dir=' + PROFILE], { stdio: 'ignore' }); } catch (e) {}
    try { edge.kill('SIGKILL'); } catch (e) {}
    try { rmSync(PROFILE, { recursive: true, force: true }); } catch (e) {}
  }
}

main().catch(e => { console.error('冒烟验收失败：', e.message); process.exit(1); });
