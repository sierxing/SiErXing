#!/usr/bin/env node
'use strict';
/**
 * UI 一致性验收：逐路由对比「默认界面」与「原版界面（?ui=legacy）」是否像素一致。
 * 用途：逐步把原版 UI 抽成插件时，每一步都要跑一遍，保证外观功能零退化。
 *
 * 用法：
 *   node scripts/test-ui-parity.js              # 全部路由
 *   node scripts/test-ui-parity.js /g/166 /settings   # 只测指定路由
 *   PORT=3214 node scripts/test-ui-parity.js
 *
 * 退出码：0 = 全部一致；1 = 有差异（列出差异路由）。
 */
const { spawn, execFileSync } = require('node:child_process');
const { createHash } = require('node:crypto');
const { rmSync, mkdirSync } = require('node:fs');
const path = require('node:path');

const PORT = Number(process.env.PORT || 3213);
const BASE = 'http://localhost:' + PORT;
const CDP_PORT = Number(process.env.CDP_PORT || 9777);
const PROFILE = '/tmp/sx-parity-' + process.pid;
const SHOTS = path.join(process.cwd(), '.sx-backup', 'parity-shots');

function targetHash(route) { return '#' + route; }
const ROUTES = process.argv.slice(2).length ? process.argv.slice(2) : [
  '/', '/studystats', '/aitasks', '/components', '/library',
  '/g/166', '/g/166/map', '/g/166/chat', '/g/166/versions', '/g/166/diff/285',
  '/t/142', '/settings', '/settings/ai', '/settings/data', '/settings/sync',
  '/settings/rag', '/settings/service', '/settings/update', '/settings/system',
  '/settings/theme', '/guide/1'
];

const sleep = ms => new Promise(r => setTimeout(r, ms));

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

async function main() {
  try { mkdirSync(SHOTS, { recursive: true }); } catch (e) {}
  const edge = spawn('microsoft-edge', [
    '--headless=new', '--disable-gpu', '--no-sandbox', '--remote-allow-origins=*',
    '--remote-debugging-port=' + CDP_PORT, '--user-data-dir=' + PROFILE,
    '--window-size=1440,900', 'about:blank'
  ], { stdio: 'ignore' });

  let ws, seq = 0;
  const pending = new Map();
  const errors = [];
  function send(method, params) {
    return new Promise((resolve, reject) => {
      const id = ++seq;
      pending.set(id, { resolve, reject });
      ws.send(JSON.stringify({ id, method, params: params || {} }));
      setTimeout(() => { if (pending.has(id)) { pending.delete(id); reject(new Error('timeout ' + method)); } }, 20000);
    });
  }
  async function evalIn(expr) {
    const r = await send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true });
    return r && r.result && r.result.value;
  }
  /* 截图保存并返回路径（不直接比 MD5：抗锯齿会产生少量噪声像素） */
  async function shotFile(name) {
    const r = await send('Page.captureScreenshot', { format: 'png' });
    const buf = Buffer.from(r.data, 'base64');
    const p = path.join(SHOTS, name + '.png');
    try { require('node:fs').writeFileSync(p, buf); } catch (e) {}
    return p;
  }
  /* 像素差异：用 ImageMagick 的 compare -metric AE（不同像素个数）。
     ⚠️ 必须带 `-fuzz`：AE 把"任何一位不同的像素"都算差异，于是同一页面两次渲染之间
     的**抗锯齿噪声**（实测番茄钟浮窗的分数坐标 y=249.828125 在不同渲染轮次会落成
     相邻像素）会被记成几千像素差异，同一路由反复跑还会拿到 97 / 1052 / 1149 / 2347
     等完全不可复现的数字 —— 那不是退化，是噪声。
     实测 /guide/1 两模式之间的**最大单通道差只有 4/255（1.6%）**，而真正不同的两个
     页面（换路由）在 2% fuzz 下仍有 40 万+ 像素、照样能抓出来。
     返回 null 表示 compare 不可用（此时退回 MD5 判定）。 */
  const FUZZ_PCT = Number(process.env.PARITY_FUZZ || 2);   /* 允许的单通道差异（%）*/
  function pixelDiffRatio(a, b) {
    try {
      const out = execFileSync('compare', ['-metric', 'AE', '-fuzz', FUZZ_PCT + '%', a, b, '/dev/null'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
      /* ⚠️ 差异为 0 时 compare 退出码 0、但 stdout **是空串**（不是 "0"）——
         直接 parseInt 会拿到 NaN，于是这里返回 null、退回"逐字节比 MD5"那条路，
         同一张图两次编码的二进制差异又会被判成"不一致"。差异为 0 就是 0。 */
      const n = parseInt(String(out).trim(), 10);
      return { diffPixels: Number.isFinite(n) ? n : 0 };
    } catch (e) {
      /* compare 对"有差异"会返回非 0，差异数在 stderr 里 */
      const msg = String((e.stderr || '') + (e.stdout || '')).trim();
      const m = msg.match(/^(\d+)/);
      if (m) return { diffPixels: parseInt(m[1], 10) };
      return null;
    }
  }
  /* 同一路由两种模式的取图方式**必须对等**：都用整页导航（Page.navigate）+ 等渲染稳定。
     ⚠️ 曾经「默认」那侧只用 `location.hash = …` 切 hash（不重载）：
     而上一轮的导航停在 `?ui=legacy`，于是这侧其实还是原版渲染；同时上一步残留的
     AI 抽屉 / 引导蒙层也留在页面上 —— 拿它跟整页重载的原版比，会得到几万像素的假差异，
     而且每次失败的路线都不一样（完全不可复现）。 */
  async function nav(url, wait) {
    await send('Page.navigate', { url });
    const target = url.slice(url.indexOf('#')) || '';
    /* 等两件事：① hash 到位且 #app 有内容；② 文本不再是「加载中…」且两次采样文本一致
       （设置页/教程页是"先渲染加载中 → 异步拉数据 → 整体重绘"，抢在中间截图会得到假差异）。 */
    let prev = null, stable = 0;
    for (let i = 0; i < 120; i++) {
      await sleep(150);
      const st = await evalIn("JSON.stringify({h: location.hash, n: document.querySelector('#app') ? document.querySelector('#app').children.length : 0, t: (document.querySelector('#app')||{innerText:''}).innerText.length, loading: ((document.querySelector('#app')||{innerText:''}).innerText.indexOf('加载中') >= 0)})");
      let o = null;
      try { o = JSON.parse(st); } catch (e) {}
      if (!o || o.h !== target || o.n < 1 || o.loading) { prev = null; stable = 0; continue; }
      if (prev && prev.t === o.t) { stable++; if (stable >= 2) break; } else { stable = 0; }
      prev = o;
    }
    await sleep(wait);
  }

  try {
    const list = await waitTargets();
    const page = list.find(t => t.type === 'page');
    ws = new WebSocket(page.webSocketDebuggerUrl);
    await new Promise((res, rej) => { ws.addEventListener('open', res); ws.addEventListener('error', rej); });
    ws.addEventListener('message', ev => {
      const m = JSON.parse(ev.data);
      if (m.id && pending.has(m.id)) {
        const p = pending.get(m.id); pending.delete(m.id);
        m.error ? p.reject(new Error(m.error.message)) : p.resolve(m.result);
      } else if (m.method === 'Runtime.exceptionThrown') {
        errors.push(((m.params.exceptionDetails.exception || {}).description || '').slice(0, 120));
      }
    });
    await send('Page.enable'); await send('Runtime.enable');

    /* 关掉首次运行引导：不清掉它会在默认页弹出「欢迎使用 1/6」蒙层，
       被当成"默认界面与原版不一致"（实测 /g/166 假差异 31540 像素）。
       同时清掉可能残留的引导蒙层 DOM。 */
    await nav(BASE + '/', 3000);
    await evalIn("localStorage.setItem('sierxing-guide-done','1'); localStorage.setItem('sierxing-guide','1');");
    await evalIn("document.querySelectorAll('#guideMask,.guideMask').forEach(function(n){n.remove();}); document.body.classList.remove('guideOpen');");
    /* 每轮路由切换后也兜底清一次蒙层（引导可能在任意页面弹出） */
    /* 每页切换前复位：连续跑时上一步的 AI 抽屉 / 引导蒙层 / 番茄钟浮窗会残留，
       导致后续页面截图多出面板（实测 /g/166/chat、/versions、/t/142 假差异 2.6~4.3 万像素）。
       这里统一把"跨页残留状态"清掉，并滚回顶部，保证每页都从干净状态截图。 */
    /* 每页切换前只做最小化复位：清引导蒙层、关 AI 抽屉。
       ⚠️ AI 助手现在是**常驻**的（抽屉跨页保持、localStorage `sierxing-ai-open` 记着上次是否打开）：
       一旦某一页把它拉开（例如上次进来点过 💬），后面每一页都会带着这个抽屉截图，
       而对照的原版那侧是干净重载 —— 会变成整条右侧栏的假差异。所以每次取图前明确关掉它，
       并且**两种模式用同一套复位**。
       另外：别在这里做 scrollTo / pause 番茄钟 / 反复 DOM 操作 —— 实测会干扰页面自身渲染，
       导致大量假差异（/library 4.2 万、/chat 16.5 万像素）。 */
    const resetPage = async () => {
      try {
        await evalIn("localStorage.setItem('sierxing-guide-done','1'); localStorage.setItem('sierxing-guide','1'); localStorage.setItem('sierxing-ai-open','0'); document.querySelectorAll('#guideMask,.guideMask').forEach(function(n){n.remove();}); document.body.classList.remove('guideOpen'); var d=document.getElementById('aiDrawer'); if(d) d.classList.remove('open'); document.body.classList.remove('aiOpen'); var f=document.getElementById('aiFab'); if(f) f.classList.remove('hidden');");
      } catch (e) {}
    };

    let match = 0;
    const diffs = [];
    for (const route of ROUTES) {
      const tag = route.replace(/[^a-z0-9]/gi, '_') || 'home';
      await resetPage();
      await nav(BASE + '/#' + route, 1200);
      await resetPage();
      const p1 = await shotFile('default' + tag);
      await send('Page.navigate', { url: BASE + '/?ui=legacy' + targetHash(route) });
      await sleep(4500);
      await resetPage();
      const p2 = await shotFile('legacy' + tag);
      /* 判定：像素差异 < 0.05%（约 600 像素）视为一致 —— 抗锯齿噪声不算退化。
         （比较本身已带 PARITY_FUZZ% 容差，见 pixelDiffRatio） */
      const d = pixelDiffRatio(p1, p2);
      if (!d) {
        const same = require('node:fs').readFileSync(p1).equals(require('node:fs').readFileSync(p2));
        if (same) { match++; console.log('  ✅ 一致   ' + route); } else { diffs.push(route); console.log('  ❌ 不一致 ' + route); }
      } else if (d.diffPixels <= 600) {
        match++; console.log('  ✅ 一致   ' + route + (d.diffPixels ? '（像素差 ' + d.diffPixels + '，抗锯齿噪声）' : ''));
      } else {
        diffs.push(route); console.log('  ❌ 不一致 ' + route + '（像素差 ' + d.diffPixels + '）');
      }
    }

    console.log('');
    console.log('一致性: ' + match + '/' + ROUTES.length);
    if (errors.length) console.log('页面异常: ' + JSON.stringify(errors.slice(0, 3)));
    console.log('截图目录: ' + SHOTS);
    if (diffs.length) {
      console.log('不一致路由: ' + JSON.stringify(diffs));
      process.exitCode = 1;
    } else {
      console.log('全部路由与原版像素一致 ✅');
    }
  } finally {
    try { ws && ws.close(); } catch (e) {}
    try { edge.kill('SIGKILL'); } catch (e) {}
    try { execFileSync('pkill', ['-9', '-f', '--', '--user-data-dir=' + PROFILE], { stdio: 'ignore' }); } catch (e) {}
    try { rmSync(PROFILE, { recursive: true, force: true }); } catch (e) {}
  }
}

main().catch(e => { console.error('验收失败：', e.message); process.exit(1); });