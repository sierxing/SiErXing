#!/usr/bin/env node
'use strict';
/**
 * 「用自己的话」收尾页文本清洗回归（不花钱：不调 AI）
 * ---------------------------------------------------------------------------
 * 用户真实反馈：收尾页「和关键要点的差距（3）」里直接显示出
 *   ```js\ninterview.js\n``` 后端插件作为执行入口
 * —— AI 把标识符包成围栏/行内代码，以前 esc() 后原样进 <b>/<span>，反引号和换行都露出来。
 *
 * 这里守住三层：
 *   ① 纯函数 cleanInline（server/plugins/lib/inline-text.js）：剥围栏 / 压一行 / 丢纯标点；
 *   ② 服务端出口（roundOut / roundsOf / notes）：库里存着的旧记录也洗干净；
 *   ③ 真实页面（无头浏览器）：收尾页不再出现反引号/换行，成对行内代码渲染成 <code>。
 *
 * 跑法：node --no-warnings --experimental-sqlite scripts/test-restate-clean.js
 * 沙箱：临时 DATA_DIR + 独立端口，不碰真实数据。
 */
const assert = require('node:assert');
const { spawn } = require('node:child_process');
const { DatabaseSync } = require('node:sqlite');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const net = require('node:net');

const ROOT = path.join(__dirname, '..');
const DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'sx-restate-clean-'));
const HOME_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'sx-restate-home-'));
const PROFILE = path.join(os.tmpdir(), 'sx-restate-prof-' + process.pid);
const CDP_PORT = Number(process.env.CDP_PORT || 9799);
const FENCE3 = String.fromCharCode(96, 96, 96);
const sleep = ms => new Promise(r => setTimeout(r, ms));
const BASE = { url: '' };

let passed = 0, failed = 0;
function ok(name, cond, detail) {
  if (cond) { passed++; console.log('  ✓ ' + name); }
  else { failed++; console.log('  ✗ ' + name, detail == null ? '' : '→ ' + detail); }
}
function freePort() {
  return new Promise(function (resolve, reject) {
    const s = net.createServer();
    s.unref();
    s.on('error', reject);
    s.listen(0, '127.0.0.1', function () { const p = s.address().port; s.close(function () { resolve(p); }); });
  });
}
async function jget(url) {
  const r = await fetch(url);
  const t = await r.text();
  try { return JSON.parse(t); } catch (e) { return t; }
}

(async function main() {
  console.log('== 用自己的话：文本清洗 ==');
  const { cleanInline } = require('../server/plugins/lib/inline-text.js');

  ok('围栏包裹的标识符 → 只留内容（没有反引号/换行）', (function () {
    const r = cleanInline(FENCE3 + 'js\ninterview.js\n' + FENCE3 + ' 后端插件作为执行入口');
    return r === 'interview.js 后端插件作为执行入口';
  })(), cleanInline(FENCE3 + 'js\ninterview.js\n' + FENCE3 + ' 后端插件作为执行入口'));
  ok('只有标点/空白的条目 → 空（不占一条「差距」）', cleanInline(FENCE3 + '\n，\n' + FENCE3) === '' && cleanInline('，。') === '');
  ok('成对的行内代码保留反引号（前端渲染成 <code>）', cleanInline('`cfg.profiles` 要和 `base` 配合') === '`cfg.profiles` 要和 `base` 配合');
  ok('落单的反引号直接删掉', cleanInline('没闭合 `code 文本') === '没闭合 code 文本');
  ok('多行压成一行的同时保留原有空格', cleanInline('第一行\n第二行') === '第一行 第二行');

  const port = await freePort();
  const app = spawn(process.execPath, ['--no-warnings', '--experimental-sqlite', path.join(ROOT, 'server', 'server.js')], {
    cwd: ROOT,
    env: Object.assign({}, process.env, { PORT: String(port), NO_OPEN: '1', SIERXING_DATA_DIR: DATA_DIR }),
    stdio: 'ignore'
  });
  let edge = null, ws = null;
  try {
    let up = false;
    for (let i = 0; i < 60; i++) {
      await sleep(250);
      try { const h = await jget('http://127.0.0.1:' + port + '/api/health'); if (h && h.ok) { up = true; break; } } catch (e) {}
    }
    if (!up) throw new Error('测试实例没起来（端口 ' + port + '）');
    BASE.url = 'http://127.0.0.1:' + port;

    /* 直接往沙箱库里塞「旧格式」记录（AI 当时就是把这些围栏原样存进去的） */
    const db = new DatabaseSync(path.join(DATA_DIR, 'sierxing.db'));
    db.exec('PRAGMA busy_timeout = 3000');
    const now = new Date().toISOString();
    db.prepare('INSERT INTO goals (id,title,status,created_at,updated_at) VALUES (?,?,?,?,?)').run(1, '清洗回归目标', 'active', now, now);
    db.prepare('INSERT INTO nodes (id,goal_id,parent_id,level,title,status,sort_order,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?)').run(1, 1, null, 0, '任务', 'todo', 1, now, now);
    db.prepare('INSERT INTO tutorials (id,goal_id,node_id,title,format,content,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?)')
      .run(1, 1, 1, '清洗回归教程', 'md', '# 标题\n\n正文', now, now);
    const points = [{ title: '知识点一', summary: '摘要', key_points: ['a', 'b'], dims: [
      { key: 'd1', name: '为什么', ask: '' }, { key: 'd2', name: '怎么做', ask: '' }, { key: 'd3', name: '边界', ask: '' }
    ] }];
    db.prepare('INSERT INTO restate_points (tutorial_id,points,created_at,updated_at) VALUES (?,?,?,?)')
      .run(1, JSON.stringify(points), now, now);
    const gaps = [
      { key: FENCE3 + 'js\ninterview.js\n' + FENCE3 + ' 后端插件作为执行入口', why: FENCE3 + '\n，\n' + FENCE3 },
      { key: '`cfg.profiles` 要和 `base` 配合', why: '配置里 `profiles` 没讲清' }
    ];
    const kept = ['`interview.js` 讲清了', '，', FENCE3 + '\nstate\n' + FENCE3 + ' 提到了'];
    const info = db.prepare('INSERT INTO restate_rounds (tutorial_id,node_id,goal_id,point_idx,point_title,status,mine,gaps,line,draft,kept,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)')
      .run(1, 1, 1, 0, '知识点一', 'done', '我的话内容', JSON.stringify(gaps), FENCE3 + '\n一句话总结\n' + FENCE3, '整理稿', JSON.stringify(kept), now, now);
    const roundId = Number(info.lastInsertRowid);
    db.close();

    const one = await jget(BASE.url + '/api/restate-round/' + roundId);
    const r1 = one && one.round;
    ok('接口：gaps.key 的围栏被剥掉、压成一行', !!r1 && r1.gaps[0].key === 'interview.js 后端插件作为执行入口', r1 && JSON.stringify(r1.gaps));
    ok('接口：纯标点的 why 被丢掉（不占一条差距）', !!r1 && r1.gaps[0].why === '', r1 && JSON.stringify(r1.gaps[0]));
    ok('接口：成对行内代码保留（交给前端渲染 <code>）', !!r1 && r1.gaps[1].key === '`cfg.profiles` 要和 `base` 配合', r1 && JSON.stringify(r1.gaps[1]));
    ok('接口：kept 洗掉围栏与纯标点条目', !!r1 && r1.kept.length === 2 && r1.kept[1] === 'state 提到了', r1 && JSON.stringify(r1.kept));
    ok('接口：line 也压成一行', !!r1 && r1.line === '一句话总结', r1 && r1.line);

    const list = await jget(BASE.url + '/api/tutorials/1/restate/points');
    const row = (list.rounds || []).find(x => Number(x.id) === roundId);
    ok('接口：对话列表里的 gaps/kept 已经是数组（不是 JSON 字符串）', !!row && Array.isArray(row.gaps) && Array.isArray(row.kept), row && JSON.stringify(row && row.gaps).slice(0, 80));
    ok('接口：对话列表里的 gaps 也已清洗', !!row && row.gaps[0].key === 'interview.js 后端插件作为执行入口');

    const notes = await jget(BASE.url + '/api/tutorials/1/restate/notes');
    const note = (notes.notes || []).find(x => Number(x.id) === roundId);
    ok('接口：「看我沉淀的话」里的 gaps 也清洗过', !!note && note.gaps[0].key === 'interview.js 后端插件作为执行入口');

    /* ---- 真实页面：打开收尾页看渲染 ---- */
    edge = spawn('microsoft-edge', [
      '--headless=new', '--disable-gpu', '--no-sandbox', '--disable-crash-reporter', '--disable-breakpad',
      '--remote-allow-origins=*', '--remote-debugging-port=' + CDP_PORT, '--user-data-dir=' + PROFILE,
      '--window-size=1440,1000', 'about:blank'
    ], { stdio: 'ignore', env: Object.assign({}, process.env, { HOME: HOME_DIR }) });

    let listPages = null;
    for (let i = 0; i < 120; i++) {
      try { const r = await fetch('http://127.0.0.1:' + CDP_PORT + '/json/list'); if (r.ok) { listPages = await r.json(); break; } } catch (e) {}
      await sleep(250);
    }
    if (!listPages) throw new Error('CDP 未就绪（浏览器没起来？）');
    let seq = 0;
    const pending = new Map();
    const exceptions = [];
    ws = new WebSocket(listPages.find(t => t.type === 'page').webSocketDebuggerUrl);
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
    await send('Page.enable'); await send('Runtime.enable');
    await send('Page.navigate', { url: BASE.url + '/' });
    await sleep(1800);
    await evalIn("localStorage.setItem('sierxing-guide-done','1'); localStorage.setItem('sierxing-guide','1');");
    exceptions.length = 0;
    await send('Page.navigate', { url: BASE.url + '/#/t/1/restate' });
    await sleep(3000);

    let view = null;
    for (let i = 0; i < 40; i++) {
      const st = await evalIn("(function(){var g=document.querySelectorAll('.rsGap'); var k=document.querySelectorAll('.rsKeptI'); if(!g.length && !k.length) return ''; return JSON.stringify({gaps:Array.from(g).map(function(x){return x.innerText;}), gapCode:Array.from(document.querySelectorAll('.rsGap code')).map(function(x){return x.textContent;}), gapWhy:Array.from(document.querySelectorAll('.rsGap span')).map(function(x){return x.innerText;}), kept:Array.from(k).map(function(x){return x.innerText;}), keptCode:Array.from(document.querySelectorAll('.rsKeptI code')).map(function(x){return x.textContent;}), body:((document.querySelector('.rsPage')||{}).innerText||'').slice(0,2000)});})()");
      if (st) { view = JSON.parse(st); break; }
      await sleep(250);
    }
    if (!view) throw new Error('收尾页没渲染出差距/kept 区块：' + (await evalIn('document.body.innerText.slice(0,300)')));
    const full = view.gaps.join('\n') + '\n' + view.kept.join('\n') + '\n' + view.body;
    ok('页面：差距区不再出现围栏/反引号', view.gaps.every(t => t.indexOf('`') < 0 && t.indexOf(FENCE3) < 0), JSON.stringify(view.gaps));
    ok('页面：差距说明是压好的一行（AI 原文里的换行不直接露出来）', view.gapWhy.every(t => t.indexOf('\n') < 0), JSON.stringify(view.gapWhy));
    ok('页面：差距标题仍是「和关键要点的差距（2）」', view.body.indexOf('和关键要点的差距（2）') >= 0, view.body.slice(0, 200));
    ok('页面：被洗掉 why 的那条差距只剩 key（不出现只有标点的一行）', view.gaps[0] && view.gaps[0].indexOf('interview.js 后端插件作为执行入口') >= 0 && view.gaps[0].indexOf('，') < 0, view.gaps[0]);
    ok('页面：成对行内代码渲染成真正的 <code>', view.gapCode.indexOf('cfg.profiles') >= 0 && view.gapCode.indexOf('base') >= 0, JSON.stringify(view.gapCode));
    ok('页面：kept 区不出现反引号和纯标点条目', view.kept.every(t => t.indexOf('`') < 0) && !view.kept.some(t => t.replace('✓', '').trim() === '，'), JSON.stringify(view.kept));
    ok('页面：kept 区行内代码也渲染成 <code>', view.keptCode.indexOf('interview.js') >= 0, JSON.stringify(view.keptCode));
    ok('页面：不再整页出现三反引号', full.indexOf(FENCE3) < 0);
    ok('页面：无 JS 异常', exceptions.length === 0, exceptions.join(' | '));

    /* ---- Vue 版（?ui=vue）读同一份数据：确认重建后的 ui-dist 也做了行内清洗 ---- */
    exceptions.length = 0;
    await send('Page.navigate', { url: BASE.url + '/?ui=vue#/t/1/restate' });
    await sleep(3200);
    let vueView = null;
    for (let i = 0; i < 40; i++) {
      const st = await evalIn("(function(){var g=document.querySelectorAll('.rsGap'); if(!g.length) return ''; return JSON.stringify({gaps:Array.from(g).map(function(x){return x.innerText;}), code:Array.from(document.querySelectorAll('.rsGap code')).map(function(x){return x.textContent;})});})()");
      if (st) { vueView = JSON.parse(st); break; }
      await sleep(250);
    }
    if (!vueView) throw new Error('Vue 版收尾页没渲染出差距区块：' + (await evalIn('document.body.innerText.slice(0,300)')));
    ok('Vue 版：差距区清洗后不出现围栏/反引号', vueView.gaps.every(function (t) { return t.indexOf(String.fromCharCode(96)) < 0; }), JSON.stringify(vueView.gaps));
    ok('Vue 版：行内代码渲染成 <code>', vueView.code.indexOf('cfg.profiles') >= 0, JSON.stringify(vueView.code));
    ok('Vue 版：无 JS 异常', exceptions.length === 0, exceptions.join(' | '));

    console.log('');
    console.log(passed + ' 通过 / ' + failed + ' 失败');
    if (failed) process.exitCode = 1;
  } finally {
    try { if (ws) ws.close(); } catch (e) {}
    try { if (edge) edge.kill('SIGKILL'); } catch (e) {}
    try { app.kill('SIGKILL'); } catch (e) {}
    await sleep(400);
    try { fs.rmSync(DATA_DIR, { recursive: true, force: true }); } catch (e) {}
    try { fs.rmSync(HOME_DIR, { recursive: true, force: true }); } catch (e) {}
    try { fs.rmSync(PROFILE, { recursive: true, force: true }); } catch (e) {}
  }
})().catch(function (e) { console.error('\n失败：' + ((e && e.stack) || e)); process.exit(1); });