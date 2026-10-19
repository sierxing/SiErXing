'use strict';
/**
 * 「AI 助手全页面常驻」UI 回归：node --no-warnings scripts/test-chat-global-ui.js
 * 验证：① 无目标页面（首页/设置页）也显示悬浮入口；② 点开是就地抽屉（不跳对话页）；
 *       ③ 在首页发消息走"全局助手"（goal_id=0），能正常收到回复；④ 0 JS 异常。
 */
const { spawn, execFileSync } = require('node:child_process');
const http = require('node:http');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const APP_PORT = Number(process.env.APP_PORT || 3327);
const AI_PORT = Number(process.env.AI_PORT || 3326);
const CDP_PORT = Number(process.env.CDP_PORT || 9801);
const DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'sx-chat-global-ui-'));
const HOME_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'sx-chat-global-home-'));
const PROFILE = path.join(os.tmpdir(), 'sx-chat-global-prof-' + process.pid);
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
  nodes: [{ id: 11, goal_id: 1, parent_id: null, level: 0, title: '阶段一', condition_id: 0, sort_order: 1 }]
};

const aiSrv = http.createServer((req, res) => {
  let body = '';
  req.on('data', c => { body += c; });
  req.on('end', () => {
    let imgN = 0, reqModel = '', isStream = true, prompt = '';
    try {
      const j = JSON.parse(body);
      reqModel = String(j.model || '');
      isStream = j.stream !== false;
      for (const m of (j.messages || [])) {
        if (Array.isArray(m.content)) for (const p of m.content) if (p && (p.type === 'image_url' || p.image_url)) imgN++;
      }
      prompt = (j.messages || []).map(function (m) {
        if (typeof m.content === 'string') return m.content;
        if (Array.isArray(m.content)) return m.content.filter(function (p) { return p && typeof p.text === 'string'; }).map(function (p) { return p.text; }).join('');
        return '';
      }).join(NL);
    } catch (e) {}
    /* 识图模型：返回一段识别结果（非流式请求回 JSON，流式回 SSE） */
    if (reqModel === 'vision-1' && imgN > 0) {
      const vt = '识别结果：HELLO-UI。';
      if (!isStream) {
        res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({ choices: [{ message: { role: 'assistant', content: vt }, finish_reason: 'stop' }] }));
        return;
      }
      res.writeHead(200, { 'Content-Type': 'text/event-stream; charset=utf-8' });
      res.write('data: ' + JSON.stringify({ choices: [{ delta: { content: vt }, finish_reason: 'stop' }] }) + NL + NL);
      res.write('data: [DONE]' + NL + NL);
      res.end();
      return;
    }
    /* 其它模型带图：模拟「不支持识图」的上游 400（服务端应据此标记/回退） */
    if (imgN > 0) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: { message: 'This model does not support image input' } }));
      return;
    }
    const text = prompt.indexOf('【图片识别结果') >= 0 ? '已按识图结果回答：HELLO-UI。' : '全局助手收到：我现在能看到你的所有目标。';
    res.writeHead(200, { 'Content-Type': 'text/event-stream; charset=utf-8' });
    for (const chunk of [text.slice(0, 12), text.slice(12)]) {
      res.write('data: ' + JSON.stringify({ choices: [{ delta: { content: chunk } }] }) + NL + NL);
    }
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

async function main() {
  await new Promise(res => aiSrv.listen(AI_PORT, '127.0.0.1', res));
  const app = spawn(process.execPath, ['--no-warnings', '--experimental-sqlite', 'server/server.js'], {
    cwd: ROOT,
    env: Object.assign({}, process.env, {
      PORT: String(APP_PORT), NO_OPEN: '1', SIERXING_DATA_DIR: DATA_DIR,
      SIERXING_API_BASE: 'http://127.0.0.1:' + AI_PORT + '/v1', SIERXING_API_KEY: 'test-key', SIERXING_MODEL: 'fake-model'
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
      } else if (m.method === 'Runtime.consoleAPICalled') {
        try {
          const txt = (m.params.args || []).map(a => a.value != null ? String(a.value) : (a.description || '')).join(' ');
          if (txt.indexOf('[aiSync') >= 0) console.log('      [console]', txt);
        } catch (e) {}
      }
    });
    await send('Page.enable'); await send('Runtime.enable');
    await send('Page.navigate', { url: BASE + '/' }); await sleep(2000);
    await evalIn("localStorage.setItem('sierxing-guide-done','1'); localStorage.setItem('sierxing-guide','1'); localStorage.setItem('sierxing-ai-open','0');");
    await evalIn("document.querySelectorAll('#guideMask,#pomoBadge,#pomoPanel').forEach(x=>x.remove())");
    await sleep(800);

    exceptions.length = 0;
    /* ① 首页：AI 助手悬浮入口必须在 */
    const home = JSON.parse(await evalIn("JSON.stringify({fab:!!document.querySelector('#aiFab'),hidden:!!(document.querySelector('#aiFab')||{}).classList&&document.querySelector('#aiFab').classList.contains('hidden'),hash:location.hash})"));
    ok('首页也显示 AI 助手入口', home.fab === true && home.hidden === false, JSON.stringify(home));

    /* ② 点开：就地抽屉（不跳对话页） */
    await evalIn("document.querySelector('#aiFab').click()"); await sleep(1800);
    const opened = JSON.parse(await evalIn("JSON.stringify({hash:location.hash,open:!!document.querySelector('#aiDrawer.open'),goalId:window.__sxAiDebugGoalId})"));
    ok('点开是就地抽屉（没有跳走）', opened.open === true && opened.hash === '#/' || opened.hash === '', JSON.stringify(opened));

    /* ③ 发消息：走全局助手（goal_id=0）并收到回复 */
    await evalIn("(function(){var t=document.querySelector('#adText'); t.value='我现在有哪些目标？'; t.dispatchEvent(new Event('input',{bubbles:true})); document.querySelector('#adSend').click(); return 1;})()");
    let reply = '';
    for (let i = 0; i < 60; i++) {
      await sleep(400);
      reply = await evalIn("((document.querySelector('#adMsgs')||{}).innerText||'')");
      if (reply.indexOf('全局助手收到') >= 0) break;
    }
    ok('首页发消息能收到 AI 回复', reply.indexOf('全局助手收到') >= 0, reply.slice(0, 100));
    const gs = await jget(BASE + '/api/goals/0/chat-sessions');
    ok('服务端创建了 goal_id=0 的全局对话', (gs.sessions || []).length >= 1, JSON.stringify((gs.sessions || []).length));

    /* ④ 设置页也常驻 */
    await send('Page.navigate', { url: BASE + '/#/settings' }); await sleep(4500);
    await evalIn("document.querySelectorAll('#guideMask,#pomoBadge,#pomoPanel').forEach(x=>x.remove())");
    let st = {};
    for (let i = 0; i < 20; i++) {
      st = JSON.parse(await evalIn("JSON.stringify({fab:!!document.getElementById('aiFab'),hidden:document.getElementById('aiFab').classList.contains('hidden'),drawer:!!document.querySelector('#aiDrawer.open'),hash:location.hash})"));
      if (st.drawer || (st.fab && st.hidden === false)) break;
      await sleep(400);
    }
    /* 抽屉跨页保持：如果上次开着，它会自动恢复打开（此时悬浮球按设计隐藏）；两种都算"助手可用" */
    ok('设置页也有 AI 助手（抽屉恢复或悬浮入口可见）', st.drawer === true || (st.fab === true && st.hidden === false), JSON.stringify(st));

    /* ⑦ 设置页的正文能被采集到（截图里 AI 说"看不到当前页面"的回归） */
    const pctx = JSON.parse(await evalIn("JSON.stringify((function(){try{var p=collectPageContext();if(!p)return null;var t=String(p.text||'');return {label:p.label,title:p.title,len:t.length,hasSettings:t.indexOf('AI 接入方式')>=0||t.indexOf('设置')>=0};}catch(e){return null}})())"));
    ok('设置页能采集到页面正文', !!pctx && pctx.len > 0, JSON.stringify(pctx));
    ok('采集到的正文是设置页的内容', !!pctx && (pctx.hasSettings || pctx.label.indexOf('设置') >= 0), JSON.stringify(pctx && { label: pctx.label, title: pctx.title, len: pctx.len }));
    /* ⑧ 粘贴图片：输入框要能接住，模型不支持识图时明确回一句 */
    await evalIn("document.querySelectorAll('#guideMask,#pomoBadge,#pomoPanel').forEach(x=>x.remove())");
    const pasteRes = JSON.parse(await evalIn("(function(){"
      + "var b64='iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';"
      + "var bin=atob(b64);var u8=new Uint8Array(bin.length);for(var i=0;i<bin.length;i++)u8[i]=bin.charCodeAt(i);"
      + "var f=new File([u8],'paste-test.png',{type:'image/png'});var dt=new DataTransfer();dt.items.add(f);"
      + "var ta=document.querySelector('#adText');ta.focus();"
      + "var ev=new ClipboardEvent('paste',{clipboardData:dt,bubbles:true,cancelable:true});"
      + "var ok=ta.dispatchEvent(ev);return JSON.stringify({dispatched:true,prevented:ok===false});"
      + "})()"));
    let imgSt = {};
    for (let i = 0; i < 25; i++) {
      await sleep(300);
      imgSt = JSON.parse(await evalIn("JSON.stringify({len:(state.aiImgs||[]).length,chips:document.querySelectorAll('#adImgs .adImgChip').length,hidden:!!document.getElementById('adImgs').hidden,warn:(document.getElementById('adImgWarn')||{}).textContent||''})"));
      if (imgSt.len >= 1 && imgSt.chips >= 1) break;
    }
    ok('粘贴图片后输入区出现缩略图', imgSt.len === 1 && imgSt.chips === 1 && imgSt.hidden === false, JSON.stringify(imgSt));
    /* 默认当作能识图：第一次粘图不应提前报「不支持」，直接发过去试 */
    await sleep(800);
    let warnBefore = await evalIn("((document.getElementById('adImgWarn')||{}).textContent||'')");
    ok('默认当作能识图：粘图时不提前报错', String(warnBefore || '').indexOf('不支持') < 0, String(warnBefore || '').slice(0, 80));
    await evalIn("document.querySelector('#adSend').click()");
    let imgReply = '';
    for (let i = 0; i < 50; i++) {
      await sleep(300);
      imgReply = await evalIn("((document.querySelector('#adMsgs')||{}).innerText||'')");
      if (imgReply.indexOf('不支持识别图片') >= 0) break;
    }
    ok('模型回应不能识图时明确回复', imgReply.indexOf('不支持识别图片') >= 0, imgReply.slice(-200));
    ok('回复里说明已把模型标记为不支持识图', imgReply.indexOf('已把它标记') >= 0, imgReply.slice(-220));
    const imgBubble = JSON.parse(await evalIn("JSON.stringify({bubbleImgs:document.querySelectorAll('#adMsgs .chImgs img').length,pending:(state.aiImgs||[]).length})"));
    ok('发出的图片显示在消息气泡里', imgBubble.bubbleImgs >= 1, JSON.stringify(imgBubble));
    ok('发送后输入区缩略图被清空', imgBubble.pending === 0, JSON.stringify(imgBubble));

    /* 已标记之后：再粘图会提前提示「已被标记为不支持识图」 */
    await evalIn("(function(){var b64='iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';var bin=atob(b64);var u8=new Uint8Array(bin.length);for(var i=0;i<bin.length;i++)u8[i]=bin.charCodeAt(i);var f=new File([u8],'paste2.png',{type:'image/png'});var dt=new DataTransfer();dt.items.add(f);var ta=document.querySelector('#adText');ta.focus();ta.dispatchEvent(new ClipboardEvent('paste',{clipboardData:dt,bubbles:true,cancelable:true}));return 1})()");
    let warnAfter = '';
    for (let i = 0; i < 25; i++) {
      await sleep(300);
      warnAfter = await evalIn("((document.getElementById('adImgWarn')||{}).textContent||'')");
      if (warnAfter.indexOf('不支持') >= 0) break;
    }
    ok('已标记的模型再粘图会提前提示不支持识图', warnAfter.indexOf('不支持') >= 0, String(warnAfter || '').slice(0, 120));
    await evalIn("document.querySelector('#adImgs .adImgDel').click()");
    const cleared = JSON.parse(await evalIn("JSON.stringify({len:(state.aiImgs||[]).length,chips:document.querySelectorAll('#adImgs .adImgChip').length})"));
    ok('可以手动移除待发送的图片', cleared.len === 0 && cleared.chips === 0, JSON.stringify(cleared));

    /* ⑨ 设置里配了识图模型后：当前模型发图会先由识图模型识别，再交给它回答 */
    await jpost(BASE + '/api/settings', { vis_base_url: 'http://127.0.0.1:' + AI_PORT + '/v1', vision_model: 'vision-1', vis_api_key: 'test-key' });
    await evalIn("(function(){var b64='iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';var bin=atob(b64);var u8=new Uint8Array(bin.length);for(var i=0;i<bin.length;i++)u8[i]=bin.charCodeAt(i);var f=new File([u8],'paste3.png',{type:'image/png'});var dt=new DataTransfer();dt.items.add(f);var ta=document.querySelector('#adText');ta.focus();ta.dispatchEvent(new ClipboardEvent('paste',{clipboardData:dt,bubbles:true,cancelable:true}));return 1})()");
    let fbWarn = '';
    for (let i = 0; i < 25; i++) {
      await sleep(300);
      fbWarn = await evalIn("((document.getElementById('adImgWarn')||{}).textContent||'')");
      if (fbWarn.indexOf('识图模型') >= 0) break;
    }
    ok('配了识图模型后提示「会自动用识图模型识别」', fbWarn.indexOf('识图模型') >= 0, String(fbWarn || '').slice(0, 140));
    await evalIn("document.querySelector('#adSend').click()");
    let fbReply = '';
    for (let i = 0; i < 60; i++) {
      await sleep(300);
      fbReply = await evalIn("((document.querySelector('#adMsgs')||{}).innerText||'')");
      if (fbReply.indexOf('已按识图结果回答') >= 0) break;
    }
    ok('自动回退识图并回答（不再报不能识别）', fbReply.indexOf('已按识图结果回答') >= 0 && fbReply.indexOf('HELLO-UI') >= 0, fbReply.slice(-220));
    const fbPending = JSON.parse(await evalIn("JSON.stringify({pending:(state.aiImgs||[]).length,chips:document.querySelectorAll('#adImgs .adImgChip').length})"));
    ok('回退识图后输入区已清空', fbPending.pending === 0 && fbPending.chips === 0, JSON.stringify(fbPending));

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
    try { aiSrv.close(); } catch (e) {}
    try { fs.rmSync(DATA_DIR, { recursive: true, force: true }); } catch (e) {}
    try { fs.rmSync(HOME_DIR, { recursive: true, force: true }); } catch (e) {}
  }
}
main().then(() => process.exit(process.exitCode || 0)).catch(e => { console.error('UI 回归失败：', e && e.message); process.exit(1); });
