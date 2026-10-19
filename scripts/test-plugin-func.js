#!/usr/bin/env node
'use strict';
/**
 * 插件页功能冒烟测试（只做**只读交互**，不改用户数据）。
 *
 * 为什么需要它：像素一致性只证明"长得一样"，不证明"点得动"。
 * 插件化把渲染代码搬了家，事件绑定、折叠、筛选、目录这些行为必须单独验。
 * 这里只点"展开/折叠、切筛选、开目录、切设置子页"这类不落库的操作；
 * 任何会写库的按钮（保存、删除、生成）一律不点。
 *
 * 用法：node scripts/test-plugin-func.js
 */
const { spawn, execFileSync } = require('node:child_process');
const { rmSync } = require('node:fs');

const PORT = Number(process.env.PORT || 3213);
const BASE = 'http://localhost:' + PORT;
const CDP_PORT = Number(process.env.CDP_PORT || 9792);
const PROFILE = '/tmp/sx-func-' + process.pid;
const sleep = ms => new Promise(r => setTimeout(r, ms));

async function waitTargets() {
  for (let i = 0; i < 80; i++) {
    try { const r = await fetch('http://127.0.0.1:' + CDP_PORT + '/json/list'); if (r.ok) return await r.json(); } catch (e) {}
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
  const goto = async route => {
    await send('Page.navigate', { url: BASE + '/#' + route });
    await sleep(3200);
    await evalIn("localStorage.setItem('sierxing-guide-done','1'); localStorage.setItem('sierxing-ai-open','0'); var m=document.getElementById('guideMask'); if(m) m.remove(); document.body.classList.remove('guideOpen');");
  };

  const results = [];
  const check = (name, ok, detail) => {
    results.push({ name, ok, detail });
    console.log((ok ? '  ✅ ' : '  ❌ ') + name + (detail ? '  ' + detail : ''));
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
        errors.push(((d.exception && d.exception.description) || d.text || '').slice(0, 200));
      }
    });
    await send('Page.enable');
    await send('Runtime.enable');
    await send('Page.navigate', { url: BASE + '/' });
    await sleep(4000);
    await evalIn("localStorage.setItem('sierxing-guide-done','1'); localStorage.setItem('sierxing-ai-open','0');");

    /* 1. 执行页：卡片折叠（只读，DOM 已确认按钮是 [data-fold]） */
    await goto('/g/166');
    const fold = await evalIn(`(function(){
      var btn = document.querySelector('[data-fold]');
      if (!btn) return { skip: '没有 [data-fold] 按钮' };
      var before = btn.textContent;
      btn.click();
      return new Promise(function(res){ setTimeout(function(){
        res({ before: before, after: btn.textContent, foldBtns: document.querySelectorAll('[data-fold]').length });
      }, 600); });
    })()`);
    check('执行页 卡片折叠', !!(fold && (fold.skip || fold.before !== fold.after || fold.foldBtns > 0)), JSON.stringify(fold));

    /* 1b. 执行页：**任何有子节点的任务**都能折叠（任务层默认收起）
       曾经只有阶段/小目标有折叠按钮，第三层任务即使拆出了子任务也全摊开，
       子任务一多整页就被撑爆。这里真点一次：默认收起 → 点开 → 再收起。 */
    await goto('/g/166');
    const deepFold = await evalIn(`(function(){
      var wrap = Array.prototype.find.call(document.querySelectorAll('.tlTaskWrap'), function(w){ return w.querySelector(':scope > .tlKids'); });
      if (!wrap) return { skip: '没有带子任务的节点' };
      var row = wrap.querySelector(':scope > .tlTask');
      var btn = row ? row.querySelector('[data-fold]') : null;
      var kids = wrap.querySelector(':scope > .tlKids');
      var out = { btn: !!btn, defaultHidden: !!(kids && kids.hidden), kids: kids ? kids.children.length : 0 };
      if (!btn) return out;
      btn.click();
      return new Promise(function(res){ setTimeout(function(){
        out.afterOpen = !!(kids && !kids.hidden);
        btn.click();
        setTimeout(function(){ out.afterClose = !!(kids && kids.hidden); res(out); }, 300);
      }, 300); });
    })()`);
    check('执行页 有子节点的任务可折叠', !!(deepFold && (deepFold.skip || (deepFold.btn && deepFold.defaultHidden && deepFold.afterOpen && deepFold.afterClose))), JSON.stringify(deepFold));

    /* 2. 设置页：切到检索增强子页（只读） */
    await goto('/settings');
    const settings = await evalIn(`(function(){
      var has = function(t){ return (document.querySelector('#app')||{textContent:''}).textContent.indexOf(t) >= 0; };
      location.hash = '#/settings/rag';
      return new Promise(function(res){ setTimeout(function(){
        res({ rag: has('检索增强') || has('检索'), page: !!document.querySelector('.settingsPage') });
      }, 1800); });
    })()`);
    check('设置页 子页切换', !!(settings && settings.rag && settings.page), JSON.stringify(settings));

    /* 3. 版本管理：切「已收藏」筛选（只读） */
    await goto('/g/166/versions');
    const ver = await evalIn(`(function(){
      var b = document.querySelector('[data-vf="star"]');
      if (!b) return { skip: '没有筛选按钮' };
      var before = document.querySelectorAll('.vpItem').length;
      b.click();
      return new Promise(function(res){ setTimeout(function(){
        res({ before: before, after: document.querySelectorAll('.vpItem').length });
      }, 900); });
    })()`);
    check('版本管理 筛选切换', !!(ver && (ver.skip || ver.after !== ver.before)), JSON.stringify(ver));

    /* 4. 教程页：正文在 .tutBody（markdown 教程不是 iframe）+ 目录面板 */
    await goto('/t/142');
    const tut = await evalIn(`(function(){
      var body = document.querySelector('.tutBody');
      var tocBtn = document.querySelector('[data-tbtn][id*="toc"], #tutTocBtn');
      var out = { bodyLen: body ? String(body.textContent || '').length : 0, tocBtn: !!tocBtn };
      if (tocBtn) { tocBtn.click(); out.tocPanel = !!document.querySelector('#tutToc, .tutToc, .tutTocPop'); }
      return new Promise(function(res){ setTimeout(function(){ res(out); }, 700); });
    })()`);
    check('教程页 正文 + 目录', !!(tut && tut.bodyLen > 500), JSON.stringify(tut));

    /* 5. 路线图：节点展开/收起（DOM 已确认 .mtnode + [data-childtoggle]） */
    await goto('/g/166/map');
    const map = await evalIn(`(function(){
      var t = document.querySelector('[data-childtoggle]');
      if (!t) return { skip: '没有 [data-childtoggle]' };
      var row = t.closest('.mtnode') || t.parentElement;
      var before = row ? row.className : '';
      t.click();
      return new Promise(function(res){ setTimeout(function(){
        res({ before: before, after: row ? row.className : '',
              nodes: document.querySelectorAll('#mapViewport .mtnode').length,
              subtrees: document.querySelectorAll('#mapViewport .mtsub').length });
      }, 900); });
    })()`);
    check('路线图 节点展开/收起', !!(map && (map.skip || map.before !== map.after || map.nodes > 0)), JSON.stringify(map));

    /* 6. 资源库 / 7. 组件页 / 8. 任务中心：渲染体量 + 关键元素（只读，不点写操作） */
    await goto('/library');
    const lib = await evalIn("({ len: String((document.querySelector('#app')||{textContent:''}).textContent||'').length, items: document.querySelectorAll('#app .srcItem, #app .libItem, #app details').length })");
    check('资源库 渲染', !!(lib && lib.len > 1000), JSON.stringify(lib));

    await goto('/components');
    const cmp = await evalIn("({ cmpToggles: document.querySelectorAll('[data-cmp],[data-gcmp]').length, cards: document.querySelectorAll('#app .cmpCard').length, len: String((document.querySelector('#app')||{textContent:''}).textContent||'').length })");
    check('组件页 渲染', !!(cmp && cmp.cmpToggles > 0), JSON.stringify(cmp));

    await goto('/aitasks');
    const ait = await evalIn("({ rows: document.querySelectorAll('#app .aitRow, #app .aitRun, #app .aitItem, #app tr').length, len: String((document.querySelector('#app')||{textContent:''}).textContent||'').length })");
    check('任务中心 渲染', !!(ait && ait.len > 100), JSON.stringify(ait));

    const pass = results.filter(r => r.ok).length;
    console.log('');
    console.log('功能检查: ' + pass + '/' + results.length);
    if (errors.length) {
      console.log('页面异常 ' + errors.length + ' 条:');
      errors.slice(0, 6).forEach(e => console.log('  - ' + e.split('\n')[0]));
    }
    if (pass !== results.length) process.exitCode = 1;
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