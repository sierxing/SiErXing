#!/usr/bin/env node
'use strict';
/**
 * 信息源「重新收集」弹窗回归：node --no-warnings scripts/test-collect-ui.js
 *
 * 为什么留（2026-10-20 用户反馈）：点「重新收集」只看到一句「AI 正在按目标制定搜集方案…」
 * 然后什么都不发生，搜集彻底跑不起来。真因有两个，都在前端，node --check 查不出来：
 *   ① showCollectSetupDialog 里用了 csGate，但 csGate 是 ensureCollectSetup 的局部变量
 *      → 弹窗渲染直接 ReferenceError，Promise reject，startCollect 静默中断；
 *   ② 旧流程是「两个 AI 推荐请求（10~30 秒）都回来才弹窗」，中间只有一个 3 秒就消失的
 *      toast，用户看到的就是"点了没反应"。
 * 现在：弹窗立刻出来，方案/书单在后台补进去；csGate 通过 opts 传进去。
 *
 * 这个测试用假 AI（不花钱）+ 无头浏览器真点，验：
 *   · 点「重新收集」→ 弹窗 3 秒内出现（插件版 + ?ui=legacy 两套都验）
 *   · 没有 csGate / 其它未捕获异常
 *   · 方案与书单在后台补进弹窗（各 ≥1 条）
 *   · 把关控件渲染出来（csGate 真的传进去了）
 *   · 点「跳过，直接搜集」→ /api/goals/:id/collect 200 + 页面出现进度条（这才是"触发搜集"）
 *   · 长任务按目标隔离（2026-10-21 用户反馈：A 目标搜集中打开 B 目标，B 也显示 A 的
 *     「抓取正文 48/200」进度条、B 的「重新规划」还被禁用）：用假 fetch 挂住 /collect，
 *     验 B 不串进度/不禁用按钮、B 能并行搜集、回 A 进度还在、停止只影响自己的目标
 *
 * 端口：假 AI 3336 / 测试实例 3337 / CDP 9352（都可在下面改）。
 */
const assert = require('node:assert');
const http = require('node:http');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn, execFileSync } = require('node:child_process');

const ROOT = path.join(__dirname, '..');
const APP_PORT = Number(process.env.APP_PORT || 3337);
const AI_PORT = Number(process.env.AI_PORT || 3336);
const CDP_PORT = Number(process.env.CDP_PORT || 9352);
const DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'sx-collect-ui-'));
const PROFILE = path.join(os.tmpdir(), 'sx-collect-ui-prof-' + process.pid);
const NL = String.fromCharCode(10);
const FENCE = String.fromCharCode(96, 96, 96);
const PLAN = [{ kind: '招聘', q: 'AI Agent 开发实习 招聘要求' }, { kind: '面经', q: 'Agent 开发实习 面经 大厂' }];
const BOOKS = [{ title: '测试入门书', author: '测试作者', pitch: '假 AI 给的推荐理由', public_domain: false, where: '微信读书', en: '' }];
let APP_LOG = '';
const AI_LOG = [];
let n = 0;
function ok(name, cond, extra) { assert.ok(cond, name + (extra ? '：' + extra : '')); console.log('  ✓ ' + name); n++; }
const sleep = ms => new Promise(r => setTimeout(r, ms));

/* ---------- 假 AI：搜集方案 → 2 条；书单 → 1 本；其它请求也给一段文本 ---------- */
const aiSrv = http.createServer((req, res) => {
  let body = '';
  req.on('data', c => { body += c; });
  req.on('end', () => {
    let j = {}; try { j = JSON.parse(body); } catch (e) {}
    const prompt = (j.messages || []).map(m => (typeof m.content === 'string' ? m.content : JSON.stringify(m.content))).join(NL);
    AI_LOG.push(prompt.slice(0, 120));
    let out = '好的';
    if (prompt.includes('「搜集方案」')) out = '方案如下：' + NL + FENCE + 'json' + NL + JSON.stringify(PLAN) + NL + FENCE;
    else if (prompt.includes('入门书单')) out = FENCE + 'json' + NL + JSON.stringify(BOOKS) + NL + FENCE;
    /* 推荐类调用没有 onEvent → ai.js 走非流式（stream:false），必须回 JSON 而不是 SSE；
       只有对话/规划这种带进度的才走 SSE。两种都支持，才能同时测到。 */
    if (j.stream === false) {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ choices: [{ message: { content: out }, finish_reason: 'stop' }] }));
      return;
    }
    res.writeHead(200, { 'Content-Type': 'text/event-stream; charset=utf-8' });
    res.write('data: ' + JSON.stringify({ choices: [{ delta: { content: out } }] }) + NL + NL);
    res.write('data: ' + JSON.stringify({ choices: [{ delta: {}, finish_reason: 'stop' }] }) + NL + NL);
    res.write('data: [DONE]' + NL + NL);
    res.end();
  });
});

async function jget(url) { const r = await fetch(url); const t = await r.text(); try { return JSON.parse(t); } catch (e) { return t; } }
async function jpost(url, body) {
  const r = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body || {}) });
  const t = await r.text(); try { return JSON.parse(t); } catch (e) { return t; }
}

/* ---------- 一个极简 CDP 客户端：只做「打开页面 / 执行 JS / 截图」 ---------- */
function connectCDP() {
  return (async () => {
    let page = null;
    for (let i = 0; i < 120; i++) {
      await sleep(250);
      try {
        const j = await (await fetch('http://127.0.0.1:' + CDP_PORT + '/json/list')).json();
        page = (j || []).find(t => t.type === 'page');
        if (page && page.webSocketDebuggerUrl) break;
      } catch (e) {}
    }
    if (!page) throw new Error('无头浏览器 CDP 没起来');
    const ws = new WebSocket(page.webSocketDebuggerUrl);
    await new Promise((res, rej) => { ws.onopen = res; ws.onerror = () => rej(new Error('CDP WebSocket 失败')); });
    let id = 0; const pend = new Map();
    const exceptions = []; const requests = [];
    ws.onmessage = ev => {
      let m; try { m = JSON.parse(ev.data); } catch (e) { return; }
      if (m.id && pend.has(m.id)) { pend.get(m.id)(m); pend.delete(m.id); return; }
      if (m.method === 'Runtime.exceptionThrown') {
        const d = m.params.exceptionDetails || {};
        exceptions.push(String(d.text || '') + ' ' + String((d.exception && (d.exception.description || d.exception.value)) || ''));
      }
      if (m.method === 'Network.responseReceived') {
        const u = String(m.params.response.url || '');
        if (/\/collect$|recommend$/.test(u)) requests.push({ url: u, status: m.params.response.status });
      }
    };
    const send = (method, params) => new Promise(res => { const i = ++id; pend.set(i, res); ws.send(JSON.stringify({ id: i, method, params: params || {} })); });
    const evalJS = async expr => {
      const r = await send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: false });
      return r && r.result && r.result.result ? r.result.result.value : null;
    };
    await send('Page.enable'); await send('Runtime.enable'); await send('Network.enable');
    return { send, evalJS, exceptions, requests, close: () => { try { ws.close(); } catch (e) {} } };
  })();
}

async function runMode(cdp, label, url) {
  await cdp.evalJS('1');
  await cdp.send('Page.navigate', { url });
  let ready = false;
  for (let i = 0; i < 160; i++) { await sleep(250); ready = await cdp.evalJS('!!document.getElementById("collectBtn")'); if (ready) break; }
  ok(label + '：目标页渲染出「重新收集」按钮', ready);

  const t0 = Date.now();
  await cdp.evalJS('document.getElementById("collectBtn").click()');
  let dlg = false;
  for (let i = 0; i < 40; i++) { await sleep(150); dlg = await cdp.evalJS('!!document.getElementById("collectSetupDlg")'); if (dlg) break; }
  const ms = Date.now() - t0;
  ok(label + '：点完「重新收集」弹窗立刻出现（' + ms + 'ms，旧实现要么不弹、要么干等 30 秒）', dlg && ms < 3000, '实测 ' + ms + 'ms');
  if (!dlg) return { fatal: '弹窗没出现' };

  let q = 0, books = 0;
  for (let i = 0; i < 60; i++) {
    await sleep(300);
    const st = await cdp.evalJS('JSON.stringify({q:Array.from(document.querySelectorAll("#collectSetupDlg [data-cpqtext]")).filter(function(x){return (x.value||"").trim();}).length,b:document.querySelectorAll("#collectSetupDlg [data-ebbook]").length,txt:(document.getElementById("csQList")||{}).innerText||""})');
    let o = {}; try { o = JSON.parse(st); } catch (e) {}
    q = o.q || 0; books = o.b || 0;
    if (q > 0 && books > 0) break;
  }
  ok(label + '：AI 推荐的搜集方案补进弹窗（' + q + ' 条可搜 query）', q >= 2);
  if (!books) console.log('DEBUG requests=' + JSON.stringify(cdp.requests) + NL + 'DEBUG aiLog=' + JSON.stringify(AI_LOG) + NL + 'DEBUG appLog=' + APP_LOG.slice(-600));
  ok(label + '：AI 推荐的书单补进弹窗（' + books + ' 本）', books >= 1);
  const gate = await cdp.evalJS('JSON.stringify({score:!!document.getElementById("csMinScore"),cap:!!document.getElementById("csCandCap"),perSite:!!document.getElementById("csPerSite"),val:(document.getElementById("csMinScore")||{}).value})');
  let g = {}; try { g = JSON.parse(gate); } catch (e) {}
  ok(label + '：把关控件渲染出来（csGate 真的传进弹窗了）', g.score && g.cap && g.perSite && g.val === '3', gate);

  await cdp.evalJS('var s=document.getElementById("csSkip"); if(s)s.click();');
  let started = false;
  for (let i = 0; i < 60; i++) {
    await sleep(250);
    started = await cdp.evalJS('!!document.querySelector(".spProgress") && !!document.getElementById("collectStop")');
    if (started) break;
  }
  let collReq = [];
  for (let i = 0; i < 40; i++) {                 /* 进度条比 fetch 的响应头早几毫秒出现，等一小会儿再断言 */
    await sleep(250);
    collReq = cdp.requests.filter(r => /\/collect$/.test(r.url));
    if (collReq.length) break;
  }
  ok(label + '：点「跳过，直接搜集」后真的发起搜集请求（' + (collReq[0] ? collReq[0].status : '无') + '）', collReq.length > 0 && collReq[0].status === 200);
  ok(label + '：页面出现搜集进度条（能点停止）', started);
  await cdp.evalJS('var x=document.getElementById("collectStop"); if(x)x.click();');
  await sleep(800);
  return { q, books };
}

/* ---------- 按目标隔离（2026-10-21 用户反馈）----------
   在 A 目标点「收集信息源」后，打开 B 目标也会显示「抓取正文 …」进度条，
   B 的「重新规划 / 重新收集」按钮还被禁掉 —— 根因是搜集状态是全局单例（state.collecting）。
   现在状态按目标存放（state.collectJobs[goalId]），这个用例用假 fetch 把 /collect 挂住，
   让"搜集中"成为确定状态（不依赖真实搜索耗时），验：
     · B 目标页不显示 A 的进度、按钮不被禁
     · B 目标可以自己开始搜集（两个目标互不影响）
     · 回 A 进度还在；停止只影响自己的目标 */
function fakeCollectFetch() {
  return [
    '(function(){',
    '  if (window.__sxOrigFetch) return "already";',
    '  window.__sxOrigFetch = window.fetch;',
    '  window.fetch = function(url, opts){',
    '    var u = String(url);',
    '    if (u.slice(-8) === "/collect") {',
    '      opts = opts || {};',
    '      return new Promise(function(resolve){',
    '        var enc = new TextEncoder();',
    '        var stream = new ReadableStream({ start: function(c){',
    '          c.enqueue(enc.encode(": keepalive"));',
    '          if (opts.signal) opts.signal.addEventListener("abort", function(){',
    '            try { c.error(new DOMException("Aborted", "AbortError")); } catch(e) {}',
    '          });',
    '        }});',
    '        resolve(new Response(stream, { status: 200, headers: { "Content-Type": "text/event-stream" } }));',
    '      });',
    '    }',
    '    return window.__sxOrigFetch.apply(window, arguments);',
    '  };',
    '  return "ok";',
    '})()'
  ].join(NL);
}
async function waitFor(cdp, expr, tries, gap) {
  for (let i = 0; i < (tries || 80); i++) { await sleep(gap || 200); if (await cdp.evalJS(expr)) return true; }
  return false;
}
async function navigateHash(cdp, hash) { await cdp.evalJS('location.hash=' + JSON.stringify(hash) + '; true'); }
async function goalPageState(cdp) {
  const s = await cdp.evalJS('JSON.stringify({progress:!!document.querySelector(".spProgress"),stop:!!document.getElementById("collectStop"),planBtn:((document.getElementById("planBtn")||{}).disabled===true),collectBtn:((document.getElementById("collectBtn")||{}).disabled===true),status:((document.getElementById("spStatus")||{}).textContent||"")})');
  let o = {}; try { o = JSON.parse(s); } catch (e) {}
  return o;
}
async function startCollectOnPage(cdp) {
  await cdp.evalJS('var b=document.getElementById("collectBtn"); if(b)b.click();');
  const dlg = await waitFor(cdp, '!!document.getElementById("collectSetupDlg")', 40, 150);
  if (dlg) await cdp.evalJS('var s=document.getElementById("csSkip"); if(s)s.click();');
  const started = await waitFor(cdp, '!!document.querySelector(".spProgress") && !!document.getElementById("collectStop")', 60, 200);
  return { dlg, started };
}
async function runIsolation(cdp, label, baseUrl, gidA, gidB) {
  await cdp.send('Page.navigate', { url: baseUrl + '#/g/' + gidA });
  ok(label + '：A 目标页打开', await waitFor(cdp, '!!document.getElementById("collectBtn")', 160, 250));
  const inst = await cdp.evalJS(fakeCollectFetch());
  ok(label + '：装好假搜集流（把「搜集中」挂成确定状态）', inst === 'ok', String(inst));

  ok(label + '：A 目标开始搜集（进度条出现）', (await startCollectOnPage(cdp)).started);
  const a1 = await goalPageState(cdp);
  ok(label + '：A 搜集中自己的「重新规划」按预期禁用', a1.planBtn === true, JSON.stringify(a1));

  await navigateHash(cdp, '#/g/' + gidB);
  ok(label + '：切到 B 目标页', await waitFor(cdp, '!!document.getElementById("collectBtn")', 160, 250));
  const b1 = await goalPageState(cdp);
  ok(label + '：B 目标页不显示 A 的搜集进度条', b1.progress === false && b1.stop === false, JSON.stringify(b1));
  ok(label + '：B 目标「重新规划」没被 A 的搜集禁用', b1.planBtn === false, JSON.stringify(b1));
  ok(label + '：B 目标「重新收集」也没被禁用', b1.collectBtn === false, JSON.stringify(b1));

  ok(label + '：B 目标自己也能开始搜集（两个目标互不影响）', (await startCollectOnPage(cdp)).started);

  await navigateHash(cdp, '#/g/' + gidA);
  ok(label + '：回到 A 目标页', await waitFor(cdp, '!!document.getElementById("collectBtn")', 160, 250));
  const a2 = await goalPageState(cdp);
  ok(label + '：回到 A 后 A 的进度还在（状态按目标保留）', a2.progress === true && a2.stop === true, JSON.stringify(a2));
  await cdp.evalJS('var x=document.getElementById("collectStop"); if(x)x.click();');
  ok(label + '：停止 A 后进度条消失', await waitFor(cdp, '!document.querySelector(".spProgress") && !document.getElementById("collectStop")', 40, 250));

  await navigateHash(cdp, '#/g/' + gidB);
  ok(label + '：再切到 B 目标页', await waitFor(cdp, '!!document.getElementById("collectBtn")', 160, 250));
  const b2 = await goalPageState(cdp);
  ok(label + '：B 的搜集不受 A 停止影响（进度还在）', b2.progress === true && b2.stop === true, JSON.stringify(b2));
  await cdp.evalJS('var x=document.getElementById("collectStop"); if(x)x.click();');
  ok(label + '：停止 B 后进度条消失', await waitFor(cdp, '!document.querySelector(".spProgress") && !document.getElementById("collectStop")', 40, 250));
  ok(label + '：停止 B 后「重新规划」恢复可用', (await goalPageState(cdp)).planBtn === false);
}

async function main() {
  await new Promise(res => aiSrv.listen(AI_PORT, '127.0.0.1', res));
  const app = spawn(process.execPath, ['--no-warnings', '--experimental-sqlite', 'server/server.js'], {
    cwd: ROOT,
    env: Object.assign({}, process.env, {
      PORT: String(APP_PORT), NO_OPEN: '1', SIERXING_DATA_DIR: DATA_DIR,
      SIERXING_API_BASE: 'http://127.0.0.1:' + AI_PORT + '/v1',
      SIERXING_API_KEY: 'test-key', SIERXING_MODEL: 'fake-model'
    }),
    stdio: ['ignore', 'pipe', 'pipe']
  });
  app.stdout.on('data', d => { APP_LOG += d; });
  app.stderr.on('data', d => { APP_LOG += d; });
  let edge = null, cdp = null;
  try {
    let up = false;
    for (let i = 0; i < 60; i++) {
      await sleep(250);
      try { const h = await jget('http://127.0.0.1:' + APP_PORT + '/api/health'); if (h && h.ok) { up = true; break; } } catch (e) {}
    }
    ok('测试实例起来了（端口 ' + APP_PORT + '）', up);
    const imp = await jpost('http://127.0.0.1:' + APP_PORT + '/api/import/json', {
      goals: [
        { id: 1, title: '找到 Agent 开发相关的大厂实习', status: 'planned' },
        { id: 2, title: 'legacy 界面用的同款目标', status: 'planned' },
        { id: 3, title: '隔离用例：A 目标（插件版）', status: 'planned' },
        { id: 4, title: '隔离用例：B 目标（插件版）', status: 'planned' },
        { id: 5, title: '隔离用例：A 目标（legacy 版）', status: 'planned' },
        { id: 6, title: '隔离用例：B 目标（legacy 版）', status: 'planned' }
      ], nodes: []
    });
    ok('导入测试目标成功', imp && imp.ok, JSON.stringify(imp).slice(0, 160));


    try { fs.rmSync(PROFILE, { recursive: true, force: true }); } catch (e) {}
    edge = spawn('microsoft-edge', ['--headless=new', '--disable-gpu', '--no-sandbox', '--no-first-run',
      '--disable-dev-shm-usage', '--window-size=1600,1000',
      '--remote-debugging-port=' + CDP_PORT, '--user-data-dir=' + PROFILE, 'about:blank'],
      { stdio: 'ignore', env: Object.assign({}, process.env, { HOME: '/tmp/sxhome', XDG_CONFIG_HOME: '/tmp/sxhome/.config' }) });
    cdp = await connectCDP();

    /* 两个模式各用一个新目标：第一个模式会把搜集方案存到目标上，同一个目标第二次进来
       会正确地"直接开跑、不弹窗"，那样就测不到弹窗了。 */
    await runMode(cdp, '插件版', 'http://127.0.0.1:' + APP_PORT + '/#/g/1');
    await runMode(cdp, 'legacy 版', 'http://127.0.0.1:' + APP_PORT + '/?ui=legacy#/g/2');

    /* 搜集状态按目标隔离（A 搜集中打开 B 不串进度、不禁用 B 的按钮） */
    await runIsolation(cdp, '插件版', 'http://127.0.0.1:' + APP_PORT + '/', 3, 4);
    await runIsolation(cdp, 'legacy 版', 'http://127.0.0.1:' + APP_PORT + '/?ui=legacy', 5, 6);

    const bad = cdp.exceptions.filter(x => x.trim());
    ok('整个流程没有未捕获异常（csGate 崩弹窗的 bug 不再出现）', bad.length === 0, bad.slice(0, 2).join(' | '));
    console.log(NL + n + ' 项全部通过');
  } finally {
    try { cdp && cdp.close(); } catch (e) {}
    try { execFileSync('pkill', ['-9', '-f', '--', '--user-data-dir=' + PROFILE], { stdio: 'ignore' }); } catch (e) {}
    try { edge && edge.kill('SIGKILL'); } catch (e) {}
    try { app.kill('SIGKILL'); } catch (e) {}
    try { aiSrv.close(); } catch (e) {}
    try { fs.rmSync(DATA_DIR, { recursive: true, force: true }); } catch (e) {}
    try { fs.rmSync(PROFILE, { recursive: true, force: true }); } catch (e) {}
  }
}
main().catch(e => { console.error(e && e.stack || e); try { aiSrv.close(); } catch (x) {} process.exit(1); });
