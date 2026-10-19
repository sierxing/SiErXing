'use strict';
/**
 * 「在达成条件页和 AI 助手聊着改」端到端 UI 回归：node --no-warnings scripts/test-conditions-chat-ui.js
 *
 * 验证的是用户真正看到的那条闭环（假 AI，不花钱）：
 *   ① 页面上有「💬 让 AI 调整条件」，点它**就地**打开宿主 AI 抽屉（不跳走、不是另写一套对话）；
 *   ② 在抽屉里发一句话 → 假 AI 回带 condition_* ops 的回复；
 *   ③ 条件真的被改了，而且**这一页自动重画**（不是"AI 说改了、页面还是旧的"）；
 *   ④ 全程无 JS 异常。
 *
 * 沙箱：SIERXING_DATA_DIR=临时目录 + 独立端口（app 3323 / 假 AI 3322 / CDP 9797），不碰真实数据。
 */
const { spawn, execFileSync } = require('node:child_process');
const http = require('node:http');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const APP_PORT = Number(process.env.APP_PORT || 3323);
const AI_PORT = Number(process.env.AI_PORT || 3322);
const CDP_PORT = Number(process.env.CDP_PORT || 9797);
const DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'sx-cond-chat-ui-'));
const HOME_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'sx-cond-chat-home-'));
const PROFILE = path.join(os.tmpdir(), 'sx-cond-chat-prof-' + process.pid);
const BASE = 'http://127.0.0.1:' + APP_PORT;
const FENCE3 = String.fromCharCode(96, 96, 96);
const sleep = ms => new Promise(r => setTimeout(r, ms));

let passed = 0, failed = 0;
function ok(name, cond, detail) {
  if (cond) { passed++; console.log('  ✓', name); }
  else { failed++; console.log('  ✗', name, detail == null ? '' : '→ ' + detail); }
}

const SEED = {
  goals: [{ id: 1, title: '转行 AI 产品经理实习回归目标', status: 'active' }],
  conditions: [
    { id: 1, goal_id: 1, title: '能独立产出合格的 PRD', detail: '岗位硬要求', acceptance: '不看模板写出 1 份 PRD', priority: 'must', source: 'plan', sort_order: 1 },
    { id: 2, goal_id: 1, title: '完成 AIPM 基础认知扫盲', detail: '补齐基本功', acceptance: '能讲清概念', jd_ref: '公共 AIPM JD：产品基本功（需求/优先级/指标）', priority: 'should', source: 'plan', sort_order: 2 }
  ],
  nodes: [
    { id: 11, goal_id: 1, parent_id: null, level: 0, title: '第1阶段：基础扫盲', condition_id: 2, sort_order: 1 },
    { id: 12, goal_id: 1, parent_id: 11, level: 1, title: '读入门书', condition_id: 2, status: 'done', sort_order: 1 },
    { id: 14, goal_id: 1, parent_id: null, level: 0, title: '第2阶段：作品集', condition_id: 1, sort_order: 2 },
    { id: 15, goal_id: 1, parent_id: 14, level: 2, title: '写出第一份 PRD', condition_id: 1, sort_order: 1 }
  ]
};
const NEW_ACCEPT = '对话改过的达成标准XYZ：能讲清需求 / 优先级 / 指标';
const NEW_JD = 'JD 原文：本科及以上、2027 届、北京、每周到岗 ≥3 天';

/* ---------- 假 AI ---------- */
const seenPrompts = [];
const aiSrv = http.createServer((req, res) => {
  let body = '';
  req.on('data', c => { body += c; });
  req.on('end', () => {
    try {
      const j = JSON.parse(body);
      seenPrompts.push((j.messages || []).map(m => (typeof m.content === 'string' ? m.content : JSON.stringify(m.content))).join('\n'));
    } catch (e) {}
    /* 故意混一条越界的节点修改：用户在条件页让 AI 改条件，模型想顺手改路线图 ——
       服务端必须按 edit_scope=conditions 把它挡掉（用户真实踩过的坑）。 */
    const ops = [
      { op: 'condition_update', id: 2, acceptance: NEW_ACCEPT, jd: NEW_JD },
      { op: 'condition_add', title: '面试表达过关', detail: '面试要能讲清取舍', acceptance: '完成 3 次模拟面试', jd: '公共 AIPM JD：场景+任务+动作+指标', priority: 'should' },
      { op: 'update', id: 11, title: '不该被改的节点标题' }
    ];
    const text = '好的，我按你说的改了第 2 条的达成标准，并新增了「面试表达过关」。\n\n' + FENCE3 + 'ops\n' + JSON.stringify(ops) + '\n' + FENCE3 + '\n';
    res.writeHead(200, { 'Content-Type': 'text/event-stream; charset=utf-8' });
    for (const chunk of [text.slice(0, 24), text.slice(24, 96), text.slice(96)]) {
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
    const imp = await jpost(BASE + '/api/import/json', SEED);
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
    await sleep(2000);
    await evalIn("localStorage.setItem('sierxing-guide-done','1'); localStorage.setItem('sierxing-guide','1'); localStorage.setItem('sierxing-ai-open','0');");
    await evalIn("document.querySelectorAll('#guideMask,#pomoBadge,#pomoPanel').forEach(x=>x.remove())");

    exceptions.length = 0;
    await send('Page.navigate', { url: BASE + '/#/g/1/conditions' });
    await sleep(3200);
    await evalIn("document.querySelectorAll('#guideMask,#pomoBadge,#pomoPanel').forEach(x=>x.remove())");
    const before = JSON.parse(await evalIn("JSON.stringify({cards:document.querySelectorAll('.condCard').length,ai:document.querySelectorAll('[data-aichat]').length,hash:location.hash})"));
    ok('先渲染出 2 条条件', before.cards === 2, '实际 ' + before.cards);
    ok('有「让 AI 调整条件」按钮', before.ai >= 1, '实际 ' + before.ai);
    const jdSeed = await evalIn("Array.from(document.querySelectorAll('.condJd')).map(x=>x.textContent).join(' | ')");
    ok('条件卡里能看到「对应 JD」并带种子条款', jdSeed.indexOf('对应 JD') >= 0 && jdSeed.indexOf('公共 AIPM JD') >= 0, jdSeed.slice(0, 100));

    await evalIn("document.querySelector('[data-aichat]').click()");
    await sleep(1600);
    const opened = JSON.parse(await evalIn("JSON.stringify({hash:location.hash,open:!!document.querySelector('#aiDrawer.open'),body:document.body.classList.contains('aiOpen')})"));
    ok('抽屉就地打开（没有跳到对话页）', opened.open === true && opened.hash === '#/g/1/conditions', JSON.stringify(opened));
    ok('页面仍是达成条件页（列表还在）', (await evalIn("document.querySelectorAll('.condCard').length")) === 2);

    /* 「🎯 只改」：从条件页的入口打开时，范围应自动钉到「达成条件」 */
    const scopeUI = JSON.parse(await evalIn("JSON.stringify({hasBtn:!!document.querySelector('#adScopeBtn'),label:(document.querySelector('#adScopeLabel')||{}).textContent||'',on:!!document.querySelector('#adScopeBtn.scopeOn'),scope:state.aiScope,items:document.querySelectorAll('#adScopePop [data-ais]').length})"));
    ok('对话栏上方有「🎯 只改」功能键', scopeUI.hasBtn === true);
    ok('条件页打开时范围自动=达成条件', scopeUI.scope === 'conditions' && scopeUI.label === '只改：达成条件' && scopeUI.on === true, JSON.stringify(scopeUI));
    ok('范围菜单列出全部 6 个范围', scopeUI.items === 6, '实际 ' + scopeUI.items);

    await evalIn("(function(){var t=document.querySelector('#adText'); t.value='把第 2 条的达成标准写具体点，再新增一条面试表达'; t.dispatchEvent(new Event('input',{bubbles:true})); document.querySelector('#adSend').click(); return 1;})()");
    let cards = 0, reply = '';
    for (let i = 0; i < 60; i++) {
      await sleep(400);
      const st = JSON.parse(await evalIn("JSON.stringify({cards:document.querySelectorAll('.condCard').length,msgs:((document.querySelector('#adMsgs')||{}).innerText||'')})"));
      cards = st.cards; reply = st.msgs;
      if (cards === 3) break;
    }
    const dbAfter = await jget(BASE + '/api/goals/1/conditions');
    const dbN = Number(((dbAfter || {}).conditions || []).length);
    ok('服务端条件已改成 3 条', dbN === 3, '实际 ' + dbN + '：' + JSON.stringify(((dbAfter || {}).conditions || []).map(c => c.title)));
    ok('对话后条件被改了（2 → 3 条）', cards === 3, '实际 ' + cards);
    ok('抽屉里有 AI 的回复', reply.indexOf('面试表达过关') >= 0, reply.slice(0, 80));
    const after = JSON.parse(await evalIn("JSON.stringify({titles:Array.from(document.querySelectorAll('.condCardTitle')).map(x=>x.textContent),err:document.querySelector('#app').innerText.indexOf('页面出错')>=0})"));
    ok('页面自动重画：新条件出现在列表里', after.titles.some(t => t.indexOf('面试表达过关') >= 0), JSON.stringify(after.titles));
    ok('页面没有「页面出错」', after.err === false);

    /* 范围硬拦：服务端只执行条件类 op，越界的节点修改被挡掉并在回复里说明 */
    const promptSeen = seenPrompts.join('\n');
    ok('请求真的带上了「只改达成条件」的硬约束', promptSeen.indexOf('【本轮改动范围 · 用户已在界面上锁定：只改「达成条件」】') >= 0, promptSeen.slice(-600));
    const nodeAfter = await jget(BASE + '/api/goals/1');
    const flatNode = [];
    (function walk(list) { for (const x of (list || [])) { flatNode.push(x); walk(x.children); } })((nodeAfter.goal || {}).nodes || []);
    const n11 = flatNode.find(x => Number(x.id) === 11);
    ok('越界的节点修改没有落库（节点 11 标题没变）', !!n11 && n11.title === '第1阶段：基础扫盲', n11 && n11.title);
    ok('回复里说明了越界改动被挡掉', reply.indexOf('超出范围') >= 0 || reply.indexOf('已被挡掉') >= 0, reply.slice(-160));

    /* 手动切换范围：切到「路线图节点」→ 切回「自动」（只验 UI 与状态，不发消息） */
    await evalIn("document.querySelector('#adScopeBtn').click()");
    await sleep(300);
    const popOpen = await evalIn("!document.querySelector('#adScopePop').hidden");
    ok('点「只改」会弹出范围菜单', popOpen === true);
    await evalIn("(function(){var b=Array.from(document.querySelectorAll('#adScopePop [data-ais]')).find(x=>x.getAttribute('data-ais')==='nodes'); b.click(); return 1;})()");
    await sleep(300);
    const switched = JSON.parse(await evalIn("JSON.stringify({scope:state.aiScope,label:(document.querySelector('#adScopeLabel')||{}).textContent||''})"));
    ok('选「路线图节点」后按钮与状态都变了', switched.scope === 'nodes' && switched.label === '只改：路线图节点', JSON.stringify(switched));
    const ph = await evalIn("(document.querySelector('#adText')||{}).placeholder||''");
    ok('输入框提示语跟着范围走（只改路线图节点）', ph.indexOf('只改「路线图节点」') >= 0, ph);
    await evalIn("document.querySelector('#adScopeBtn').click()");
    await sleep(250);
    await evalIn("(function(){var b=Array.from(document.querySelectorAll('#adScopePop [data-ais]')).find(x=>x.getAttribute('data-ais')==='auto'); b.click(); return 1;})()");
    await sleep(250);
    const backAuto = JSON.parse(await evalIn("JSON.stringify({scope:state.aiScope,label:(document.querySelector('#adScopeLabel')||{}).textContent||'',on:!!document.querySelector('#adScopeBtn.scopeOn')})"));
    ok('切回「自动」后按钮恢复常态', backAuto.scope === 'auto' && backAuto.label === '只改：自动' && backAuto.on === false, JSON.stringify(backAuto));

    await evalIn("(function(){var c=Array.from(document.querySelectorAll('.condCard')).find(x=>x.textContent.indexOf('AIPM')>=0); if(c) c.querySelector('[data-ctoggle]').click(); return 1;})()");
    await sleep(500);
    const acc = await evalIn("((document.querySelector('.condCard.open .condAccept')||{}).textContent||'')");
    ok('刷新后看到的是对话改过的新达成标准', acc.indexOf('对话改过的达成标准XYZ') >= 0, acc.slice(0, 80));
    const jdNow = await evalIn("((document.querySelector('.condCard.open .condJd')||{}).textContent||'')");
    ok('刷新后看到的是对话改过的新 JD 条款', jdNow.indexOf('每周到岗') >= 0, jdNow.slice(0, 100));
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
