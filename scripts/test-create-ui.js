#!/usr/bin/env node
'use strict';
/**
 * 创造模式 · 前端闭环回归（假 AI，不花钱）
 * node --no-warnings scripts/test-create-ui.js
 *
 * 验证用户真正走的那条路：
 *   ① AI 助手里能切到「🎨 创造」模式（按钮状态 / 输入框提示 / 「只改」自动收起）；
 *   ② 发一句话 → 服务端真的带上了「创造模式扩展点说明书」（页面表 / 插件契约 / 输出协议）；
 *   ③ AI 回 create 块 → 对话里出现「已生成」卡片（不是直接装）；
 *   ④ 点「查看代码」能看到文件内容；点「安装并查看」→ 装进数据目录；
 *   ⑤ 点「撤销安装」→ 删掉，页面回到原样；全程无 JS 异常。
 *
 * 沙箱：SIERXING_DATA_DIR=临时目录 + 独立端口（app 3333 / 假 AI 3332 / CDP 9798），不碰真实数据。
 */
const { spawn, execFileSync } = require('node:child_process');
const http = require('node:http');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const APP_PORT = Number(process.env.APP_PORT || 3333);
const AI_PORT = Number(process.env.AI_PORT || 3332);
const CDP_PORT = Number(process.env.CDP_PORT || 9798);
const DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'sx-create-ui-'));
const HOME_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'sx-create-home-'));
const PROFILE = path.join(os.tmpdir(), 'sx-create-prof-' + process.pid);
const BASE = 'http://127.0.0.1:' + APP_PORT;
const FENCE3 = String.fromCharCode(96, 96, 96);
const sleep = ms => new Promise(r => setTimeout(r, ms));

let passed = 0, failed = 0;
function ok(name, cond, detail) {
  if (cond) { passed++; console.log('  ✓', name); }
  else { failed++; console.log('  ✗', name, detail == null ? '' : '→ ' + detail); }
}

const PAGE_ID = 'fake-home-' + Date.now().toString(36);
const ARTIFACT = {
  kind: 'ui-page', page: 'home', id: PAGE_ID, name: '暖色首页', summary: '把首页换成暖色卡片风',
  files: {
    'index.js': "export default {\n  setup() {\n    const { h } = window.SiErXingUI.vue;\n    const css = '.page{background:#fff7ed}';\n    return () => h('div', { class: 'page' }, [h('h1', null, '暖色首页'), h('p', null, 'fake-create-page')]);\n  }\n};\n"
  }
};

/* ---------- 假 AI：只回 create 块 ---------- */
const seenPrompts = [];
const aiSrv = http.createServer((req, res) => {
  let body = '';
  req.on('data', c => { body += c; });
  req.on('end', () => {
    try {
      const j = JSON.parse(body);
      seenPrompts.push((j.messages || []).map(m => (typeof m.content === 'string' ? m.content : JSON.stringify(m.content))).join('\n'));
    } catch (e) {}
    const text = '好的，我先给你一版「暖色首页」，确认后点「安装并查看」。\n\n'
      + FENCE3 + 'create\n' + JSON.stringify(ARTIFACT) + '\n' + FENCE3 + '\n';
    res.writeHead(200, { 'Content-Type': 'text/event-stream; charset=utf-8' });
    for (const chunk of [text.slice(0, 30), text.slice(30, 140), text.slice(140)]) {
      res.write('data: ' + JSON.stringify({ choices: [{ delta: { content: chunk } }] }) + '\n\n');
    }
    res.write('data: ' + JSON.stringify({ choices: [{ delta: {}, finish_reason: 'stop' }] }) + '\n\n');
    res.write('data: [DONE]\n\n');
    res.end();
  });
});

async function jget(url) { const r = await fetch(url); const t = await r.text(); try { return JSON.parse(t); } catch (e) { return t; } }
async function jpost(url, body) {
  const r = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body || {}) });
  const t = await r.text(); try { return JSON.parse(t); } catch (e) { return t; }
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
    stdio: 'ignore'
  });
  let edge = null, ws = null;
  try {
    let up = false;
    for (let i = 0; i < 60; i++) {
      await sleep(250);
      try { const h = await jget(BASE + '/api/health'); if (h && h.ok) { up = true; break; } } catch (e) {}
    }
    if (!up) throw new Error('测试实例没起来（端口 ' + APP_PORT + '）');
    const imp = await jpost(BASE + '/api/import/json', { goals: [{ id: 1, title: '创造模式回归目标', status: 'active' }] });
    if (!imp || !imp.ok) throw new Error('导入种子失败：' + JSON.stringify(imp).slice(0, 200));

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
      if (r && r.exceptionDetails) throw new Error('eval 失败: ' + JSON.stringify(r.exceptionDetails).slice(0, 300));
      return r && r.result && r.result.value;
    };
    let list = null;
    for (let i = 0; i < 120; i++) {
      try { const r = await fetch('http://127.0.0.1:' + CDP_PORT + '/json/list'); if (r.ok) { list = await r.json(); break; } } catch (e) {}
      await sleep(250);
    }
    if (!list) throw new Error('CDP 未就绪（浏览器没起来？）');
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
    await send('Page.navigate', { url: BASE + '/' });
    await sleep(2200);
    await evalIn("localStorage.setItem('sierxing-guide-done','1'); localStorage.setItem('sierxing-guide','1'); localStorage.setItem('sierxing-ai-open','1'); localStorage.setItem('sierxing-ai-mode','agent');");
    exceptions.length = 0;
    await send('Page.navigate', { url: BASE + '/#/g/1' });
    await sleep(3200);
    await evalIn("document.querySelectorAll('#guideMask,#pomoBadge,#pomoPanel').forEach(x=>x.remove())");
    await evalIn("if(!document.querySelector('#aiDrawer.open')) { try { aiToggleLegacy(true); } catch(e) {} }");
    await sleep(1200);
    ok('AI 抽屉已打开', (await evalIn("!!document.querySelector('#aiDrawer.open')")) === true);

    /* 切到「🎨 创造」 */
    await evalIn("document.querySelector('#adModeBtn').click()");
    await sleep(350);
    const modeItems = await evalIn("document.querySelectorAll('#adModePop [data-aimode]').length");
    ok('模式菜单里有 3 个模式（ASK / Agent / 创造）', Number(modeItems) === 3, '实际 ' + modeItems);
    await evalIn("(function(){var b=Array.from(document.querySelectorAll('#adModePop [data-aimode]')).find(x=>x.getAttribute('data-aimode')==='create'); b.click(); return 1;})()");
    await sleep(500);
    const modeUI = JSON.parse(await evalIn("JSON.stringify({mode:state.aiMode,label:(document.querySelector('#adModeLabel')||{}).textContent||'',ph:(document.querySelector('#adText')||{}).placeholder||'',scopeHidden:(document.querySelector('#adScopeBtn')||{}).hidden,ls:localStorage.getItem('sierxing-ai-mode')})"));
    ok('已切到创造模式（状态 + 按钮文案 + 本机记忆）', modeUI.mode === 'create' && modeUI.label === '创造' && modeUI.ls === 'create', JSON.stringify(modeUI));
    ok('输入框提示语说明创造模式能做什么', modeUI.ph.indexOf('创造模式') >= 0 && modeUI.ph.indexOf('组件') >= 0, modeUI.ph);
    ok('创造模式下「🎯 只改」自动收起（它不适用）', modeUI.scopeHidden === true);

    /* 发消息 → 假 AI 回 create 块 */
    await evalIn("(function(){var t=document.querySelector('#adText'); t.value='把首页改成暖色卡片风'; t.dispatchEvent(new Event('input',{bubbles:true})); document.querySelector('#adSend').click(); return 1;})()");
    let card = null;
    for (let i = 0; i < 80; i++) {
      await sleep(400);
      const st = await evalIn("(function(){var c=document.querySelector('#adMsgs .chCreate'); return c?JSON.stringify({head:c.innerText,btns:Array.from(c.querySelectorAll('[data-create-act]')).map(b=>b.getAttribute('data-create-act'))}):'';})()");
      if (st) { card = JSON.parse(st); break; }
    }
    ok('对话里出现「已生成」卡片（安装要用户点确认）', !!card && card.head.indexOf('已生成页面插件') >= 0, card && card.head.slice(0, 120));
    ok('卡片有 安装 / 查看代码 / 放弃 三个动作', !!card && ['install', 'code', 'discard'].every(a => card.btns.indexOf(a) >= 0), card && JSON.stringify(card.btns));
    ok('生成后**没有**自动安装（数据目录里还没有）', !fs.existsSync(path.join(DATA_DIR, 'ui-plugins', PAGE_ID)));

    /* 服务端提示词：真的带上了扩展点说明书 */
    const promptSeen = seenPrompts.join('\n');
    ok('请求带上了「创造模式」提示词', promptSeen.indexOf('创造模式') >= 0, promptSeen.slice(-300));
    ok('提示词里有可覆盖页面表 / 输出协议 / 安全红线', promptSeen.indexOf('可覆盖的页面') >= 0 && promptSeen.indexOf('create 代码块') >= 0 && (promptSeen.indexOf('不许联网') >= 0 || promptSeen.indexOf('不允许联网') >= 0));

    /* 查看代码 */
    await evalIn("(function(){var c=document.querySelector('#adMsgs .chCreate'); c.querySelector('[data-create-act=\"code\"]').click(); return 1;})()");
    let codeTxt = '';
    for (let i = 0; i < 30; i++) {
      await sleep(250);
      codeTxt = await evalIn("((document.querySelector('#adMsgs .chCreate .chCreCode')||{}).innerText||'')");
      if (codeTxt) break;
    }
    ok('「查看代码」能看到生成的文件内容', codeTxt.indexOf('export default') >= 0 && codeTxt.indexOf('SiErXingUI') >= 0, codeTxt.slice(0, 80));

    /* 安装 */
    await evalIn("(function(){var c=document.querySelector('#adMsgs .chCreate'); c.querySelector('[data-create-act=\"install\"]').click(); return 1;})()");
    let installed = '';
    for (let i = 0; i < 40; i++) {
      await sleep(300);
      installed = await evalIn("((document.querySelector('#adMsgs .chCreate')||{}).innerText||'')");
      if (installed.indexOf('已安装') >= 0) break;
    }
    ok('安装后卡片变成「已安装」并给刷新/撤销', installed.indexOf('已安装') >= 0 && installed.indexOf('撤销安装') >= 0, installed.slice(0, 160));
    ok('安装后文件真的落到数据目录', fs.existsSync(path.join(DATA_DIR, 'ui-plugins', PAGE_ID, 'index.js')));
    const uiList = await jget(BASE + '/api/ui/plugins');
    ok('注册表里能看到这个用户页面插件', !!((uiList || {}).plugins || []).find(p => p.id === PAGE_ID && p.enabled !== false));

    /* 刷新后卡片还在（create 信息随 trace 落库，不是只在流式这一轮显示） */
    exceptions.length = 0;
    await send('Page.navigate', { url: BASE + '/?r=' + Date.now() + '#/g/1' });   // 同 hash 的 navigate 可能不真重载，加查询串强制
    await sleep(3500);
    await evalIn("document.querySelectorAll('#guideMask,#pomoBadge,#pomoPanel').forEach(x=>x.remove())");
    await evalIn("if(!document.querySelector('#aiDrawer.open')) { try { aiToggleLegacy(true); } catch(e) {} }");
    await sleep(1200);
    const afterReload = await evalIn("((document.querySelector('#adMsgs .chCreate')||{}).innerText||'')");
    ok('刷新/重开对话后「已生成」卡片还在（不会丢）', afterReload.indexOf('暖色首页') >= 0 && afterReload.indexOf('已生成') >= 0, afterReload.slice(0, 160));

    /* 刷新后卡片是「已生成」，再点一次安装：服务端说已安装过，前端应切成「已安装」而不是弹失败 */
    await evalIn("(function(){var c=document.querySelector('#adMsgs .chCreate'); c.querySelector('[data-create-act=\"install\"]').click(); return 1;})()");
    let reinstalled = '';
    for (let i = 0; i < 30; i++) {
      await sleep(300);
      reinstalled = await evalIn("((document.querySelector('#adMsgs .chCreate')||{}).innerText||'')");
      if (reinstalled.indexOf('已安装') >= 0) break;
    }
    ok('刷新后再点「安装」不会报错，直接显示已安装', reinstalled.indexOf('已安装') >= 0 && reinstalled.indexOf('撤销安装') >= 0, reinstalled.slice(0, 140));

    /* 撤销（用刷新后卡片上的按钮，验证按钮链路在恢复后同样可用） */
    await evalIn("(function(){var c=document.querySelector('#adMsgs .chCreate'); c.querySelector('[data-create-act=\"rollback\"]').click(); return 1;})()");
    let undone = '';
    for (let i = 0; i < 40; i++) {
      await sleep(300);
      undone = await evalIn("((document.querySelector('#adMsgs .chCreate')||{}).innerText||'')");
      if (undone.indexOf('已撤销') >= 0) break;
    }
    ok('点「撤销安装」后卡片显示已撤销', undone.indexOf('已撤销') >= 0, undone.slice(0, 120));
    ok('撤销后数据目录里的文件已删除', !fs.existsSync(path.join(DATA_DIR, 'ui-plugins', PAGE_ID)));
    const uiList2 = await jget(BASE + '/api/ui/plugins');
    ok('撤销后注册表里也移除了', !((uiList2 || {}).plugins || []).some(p => p.id === PAGE_ID));
    ok('刷新后仍无 JS 异常', exceptions.length === 0, exceptions.join(' | '));
    console.log('');
    console.log(passed + ' 通过 / ' + failed + ' 失败');
    if (failed) process.exitCode = 1;
  } finally {
    try { ws && ws.close(); } catch (e) {}
    try { execFileSync('pkill', ['-9', '-f', '--', '--user-data-dir=' + PROFILE], { stdio: 'ignore' }); } catch (e) {}
    try { edge && edge.kill('SIGKILL'); } catch (e) {}
    try { fs.rmSync(PROFILE, { recursive: true, force: true }); } catch (e) {}
    try { app.kill('SIGKILL'); } catch (e) {}
    try { aiSrv.close(); } catch (e) {}
    try { fs.rmSync(DATA_DIR, { recursive: true, force: true }); } catch (e) {}
    try { fs.rmSync(HOME_DIR, { recursive: true, force: true }); } catch (e) {}
  }
}
main().catch(e => { console.error('失败：' + ((e && e.stack) || e)); process.exit(1); });
