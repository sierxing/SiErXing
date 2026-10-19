#!/usr/bin/env node
'use strict';
/**
 * 达成条件组件 UI 冒烟（无头浏览器 + CDP，写沙箱实例，不碰真实数据）
 *
 * 跑之前先起沙箱实例（必须 NO_OPEN=1 + 独立端口 + 独立数据目录）：
 *   NO_OPEN=1 PORT=3413 SIERXING_DATA_DIR=/tmp/sx-cond node --no-warnings --experimental-sqlite server/server.js
 * 然后：
 *   PORT=3413 node scripts/test-conditions-ui.js
 *
 * 断言的是「用户真能看到 / 真能点」的东西：
 *   ① 条件卡片、进度条、汇总、节点列表都渲染出来；
 *   ② 点节点能展开详情，里面能跳去路线图；
 *   ③ 新建条件弹层能打开、填完能保存并立刻出现在列表里；
 *   ④ 调整归属弹层能打开、列出全部节点；
 *   ⑤ 没有 JS 异常；组件 css 确实被注入。
 */
const { spawn, execFileSync } = require('node:child_process');
const { rmSync } = require('node:fs');

const PORT = Number(process.env.PORT || 3413);
const BASE = 'http://localhost:' + PORT;
const GID = Number(process.env.GID || 1);
const CDP_PORT = Number(process.env.CDP_PORT || 9791);
const PROFILE = '/tmp/sx-cond-ui-' + process.pid;
const sleep = ms => new Promise(r => setTimeout(r, ms));

let passed = 0, failed = 0;
function ok(name, cond, detail) {
  if (cond) { passed++; console.log('  ✓', name); }
  else { failed++; console.log('  ✗', name, detail == null ? '' : '→ ' + detail); }
}

async function resetTestCondition() {
  /* 让脚本可重复跑：先清掉上一次可能留下的「UI 冒烟条件」 */
  try {
    const data = await (await fetch(BASE + '/api/goals/' + GID + '/conditions')).json();
    for (const c of (data.conditions || [])) {
      if (c.title === 'UI 冒烟条件') await fetch(BASE + '/api/conditions/' + c.id, { method: 'DELETE' });
    }
    return (data.conditions || []).filter(c => c.title !== 'UI 冒烟条件').length;
  } catch (e) { return -1; }
}

async function main() {
  const baseCards = await resetTestCondition();
  const expectCards = baseCards >= 0 ? baseCards : 2;
  const edge = spawn('microsoft-edge', [
    '--headless=new', '--disable-gpu', '--no-sandbox', '--remote-allow-origins=*',
    '--remote-debugging-port=' + CDP_PORT, '--user-data-dir=' + PROFILE,
    '--window-size=1440,1000', 'about:blank'
  ], { stdio: 'ignore' });

  let ws, seq = 0;
  const pending = new Map();
  const exceptions = [];
  function send(method, params) {
    return new Promise((resolve, reject) => {
      const id = ++seq;
      pending.set(id, { resolve, reject });
      ws.send(JSON.stringify({ id, method, params: params || {} }));
      setTimeout(() => { if (pending.has(id)) { pending.delete(id); reject(new Error('timeout ' + method)); } }, 30000);
    });
  }
  async function evalIn(expr) {
    const r = await send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true });
    if (r && r.exceptionDetails) throw new Error('eval 失败: ' + JSON.stringify(r.exceptionDetails).slice(0, 300));
    return r && r.result && r.result.value;
  }

  try {
    let list = null;
    for (let i = 0; i < 100; i++) {
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
    await evalIn("localStorage.setItem('sierxing-guide-done','1'); localStorage.setItem('sierxing-guide','1'); localStorage.setItem('sierxing-ai-open','0');");

    /* ---------- 目标 1：有条件、有节点 ---------- */
    exceptions.length = 0;
    await send('Page.navigate', { url: BASE + '/#/g/' + GID + '/conditions' });
    await sleep(3800);
    const page = JSON.parse(await evalIn("JSON.stringify({err:((document.querySelector('#app')||{innerText:''}).innerText||'').indexOf('页面出错')>=0,page:!!document.querySelector('#condPage'),cards:document.querySelectorAll('.condCard').length,sum:!!document.querySelector('.condSum'),nodes:document.querySelectorAll('.condNode').length,css:!!document.querySelector('link[href*=\"conditions.css\"]'),title:((document.querySelector('.condCardTitle')||{}).textContent||'').trim(),pct:((document.querySelector('.condBigPct')||{}).textContent||'').trim(),un:!!document.querySelector('.condWarn'),toggles:document.querySelectorAll('[data-ctoggle]').length,ai:document.querySelectorAll('[data-aichat]').length,open:document.querySelectorAll('.condCard.open').length,bodies:Array.from(document.querySelectorAll('.condBody')).filter(x=>getComputedStyle(x).display!=='none').length,bw:parseFloat(getComputedStyle(document.querySelector('.condCard')).borderLeftWidth),bc:getComputedStyle(document.querySelector('.condCard')).borderLeftColor,shadow:getComputedStyle(document.querySelector('.condCard')).boxShadow})"));
    ok('页面无「页面出错」', !page.err);
    ok('渲染出 .condPage', page.page === true);
    ok('条件卡片数 = ' + expectCards, page.cards === expectCards, '实际 ' + page.cards);
    ok('汇总卡在', page.sum === true);
    ok('节点行渲染（>=3，收起时也在 DOM 里）', page.nodes >= 3, '实际 ' + page.nodes);
    ok('组件 css 已注入', page.css === true);
    ok('百分比有值', /%$/.test(page.pct), page.pct);
    ok('条件标题正确', page.title.indexOf('PRD') >= 0, page.title);
    ok('每张卡都有「详情」开关', page.toggles === expectCards, '实际 ' + page.toggles);
    ok('有「让 AI 调整条件」入口（复用宿主 AI 助手，不自建对话）', page.ai >= 1, '实际 ' + page.ai);
    ok('默认全部收起（一屏看完所有条件）', page.open === 0 && page.bodies === 0, 'open=' + page.open + ' bodies=' + page.bodies);
    ok('卡片有明确左边框（优先级色条 4px）', page.bw === 4, '实际 ' + page.bw + 'px');
    ok('卡片边框不是白色/透明', page.bc !== 'rgba(0, 0, 0, 0)' && page.bc !== 'transparent' && page.bc !== 'rgb(255, 255, 255)', page.bc);
    ok('卡片有阴影分层', page.shadow !== 'none' && page.shadow !== '', page.shadow);

    /* 展开第一条条件 → 说明/达成标准/节点都出来 */
    await evalIn("document.querySelector('[data-ctoggle]').click()");
    await sleep(350);
    const opened = JSON.parse(await evalIn("JSON.stringify({open:document.querySelectorAll('.condCard.open').length,body:Array.from(document.querySelectorAll('.condBody')).filter(x=>getComputedStyle(x).display!=='none').length,accept:!!document.querySelector('.condCard.open .condAccept'),nodes:document.querySelectorAll('.condCard.open .condNode').length,aria:document.querySelector('[data-ctoggle]').getAttribute('aria-expanded')})"));
    ok('点「详情」能展开这一条', opened.open === 1 && opened.body === 1, 'open=' + opened.open + ' body=' + opened.body);
    ok('展开后能看到达成标准', opened.accept === true);
    ok('展开后能看到对应节点', opened.nodes >= 1, '实际 ' + opened.nodes);
    ok('展开态 aria-expanded=true', opened.aria === 'true');

    /* 点第一个节点 → 展开节点详情 */
    await evalIn("document.querySelector('.condCard.open .condNode').click()");
    await sleep(350);
    const detail = JSON.parse(await evalIn("JSON.stringify({has:!!document.querySelector('.condNodeDetail'),link:!!document.querySelector('.condNodeDetail a[href*=\"/map?node=\"]'),txt:((document.querySelector('.condNodeDetail')||{}).innerText||'')})"));
    ok('点节点展开详情', detail.has === true);
    ok('详情里有「在路线图中查看」链接', detail.link === true);
    ok('详情有内容', (detail.txt || '').length > 5, detail.txt.slice(0, 40));

    /* 全部展开 / 全部收起 */
    await evalIn("document.querySelector('[data-ctoggleall]').click()");
    await sleep(250);
    const allOpen = JSON.parse(await evalIn("JSON.stringify({open:document.querySelectorAll('.condCard.open').length,cards:document.querySelectorAll('.condCard').length,label:document.querySelector('[data-ctoggleall]').textContent.trim()})"));
    ok('「全部展开」展开所有条件', allOpen.open === allOpen.cards && allOpen.cards > 0, 'open=' + allOpen.open + '/' + allOpen.cards);
    ok('按钮变成「全部收起」', allOpen.label === '全部收起', allOpen.label);
    await evalIn("document.querySelector('[data-ctoggleall]').click()");
    await sleep(250);
    const allClosed = JSON.parse(await evalIn("JSON.stringify({open:document.querySelectorAll('.condCard.open').length,label:document.querySelector('[data-ctoggleall]').textContent.trim()})"));
    ok('「全部收起」收起所有条件', allClosed.open === 0, 'open=' + allClosed.open);
    ok('按钮变回「全部展开」', allClosed.label === '全部展开', allClosed.label);

    /* 打开新建条件弹层 → 填写保存 */
    await evalIn("document.querySelector('[data-new]').click()");
    await sleep(300);
    const dlg = JSON.parse(await evalIn("JSON.stringify({mask:!!document.querySelector('#condMask'),input:!!document.querySelector('#cfTitle'),prio:document.querySelectorAll('#cfPrio option').length})"));
    ok('新建条件弹层能打开', dlg.mask === true && dlg.input === true);
    ok('优先级有 3 个选项', dlg.prio === 3, '实际 ' + dlg.prio);
    await evalIn("document.querySelector('#cfTitle').value='UI 冒烟条件';document.querySelector('#cfDetail').value='由冒烟脚本创建';document.querySelector('#cfAcc').value='能看到它就算达成';document.querySelector('#cfSave').click()");
    await sleep(900);
    const afterCreate = JSON.parse(await evalIn("JSON.stringify({mask:!!document.querySelector('#condMask'),cards:document.querySelectorAll('.condCard').length,has:Array.from(document.querySelectorAll('.condCardTitle')).some(x=>x.textContent.indexOf('UI 冒烟条件')>=0),toast:((document.querySelector('#toast')||{}).innerText||'')})"));
    ok('保存后弹层关闭', afterCreate.mask === false);
    ok('保存后列表多一条', afterCreate.cards === expectCards + 1 && afterCreate.has === true, 'cards=' + afterCreate.cards);
    ok('有保存成功提示', (afterCreate.toast || '').indexOf('条件已创建') >= 0, afterCreate.toast);

    /* 打开调整归属弹层 */
    await evalIn("document.querySelector('[data-assign]').click()");
    await sleep(300);
    const asg = JSON.parse(await evalIn("JSON.stringify({mask:!!document.querySelector('#condMask'),rows:document.querySelectorAll('.condAssignRow').length,save:!!document.querySelector('#condAsSave'),bulk:!!document.querySelector('#condBulkGo'),sel:document.querySelectorAll('select[data-map]').length})"));
    ok('调整归属弹层能打开', asg.mask === true && asg.save === true);
    ok('列出全部节点行', asg.rows === 6 && asg.sel === 6, 'rows=' + asg.rows);
    ok('有批量归属入口', asg.bulk === true);
    await evalIn("document.querySelector('#condMask [data-close]').click()");
    await sleep(200);
    ok('弹层能关闭', (await evalIn("!document.querySelector('#condMask')")) === true);

    /* ---------- 目标 2：没有节点的空状态 ---------- */
    exceptions.length = 0;
    await send('Page.navigate', { url: BASE + '/#/g/2/conditions' });
    await sleep(3200);
    const empty = JSON.parse(await evalIn("JSON.stringify({err:((document.querySelector('#app')||{innerText:''}).innerText||'').indexOf('页面出错')>=0,box:!!document.querySelector('.emptyBox'),title:((document.querySelector('.ebTitle')||{}).textContent||''),txt:((document.querySelector('.ebText')||{}).textContent||''),page:!!document.querySelector('#condPage'),entries:document.querySelectorAll('[data-gen]').length,body:((document.querySelector('#app')||{innerText:''}).innerText||'').slice(0,200)})"));
    ok('空目标页无异常', !empty.err && empty.page === true);
    ok('空目标显示空状态', empty.box === true && (empty.title + empty.txt).indexOf('还没有路线图节点') >= 0, empty.title + ' / ' + empty.txt + ' / ' + empty.body);
    ok('空目标不显示生成按钮', empty.entries === 0, '实际 ' + empty.entries);

    ok('全程无 JS 异常', exceptions.length === 0, exceptions.join(' | '));
    await resetTestCondition();   /* 收尾：删掉冒烟期间新建的条件，保持沙箱数据可重复使用 */

    console.log('');
    console.log(passed + ' 通过 / ' + failed + ' 失败');
    if (failed) process.exitCode = 1;
  } finally {
    try { ws && ws.close(); } catch (e) {}
    try { execFileSync('pkill', ['-9', '-f', '--', '--user-data-dir=' + PROFILE], { stdio: 'ignore' }); } catch (e) {}
    try { edge.kill('SIGKILL'); } catch (e) {}
    try { rmSync(PROFILE, { recursive: true, force: true }); } catch (e) {}
  }
}

main().catch(e => { console.error('UI 冒烟失败：', e.message); process.exit(1); });
