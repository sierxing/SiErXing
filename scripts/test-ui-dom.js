#!/usr/bin/env node
'use strict';
/**
 * DOM 结构对齐检查：插件版 vs 原版（?ui=legacy）。
 *
 * 为什么像素对比不够：属性名被改坏（如 data-go= 变成 data-H.go=）不会改变外观，
 * 像素一致性照样全绿，但事件委托的选择器全部失配 → 控件点不动。
 * 真实翻车：构建器的赋值改写把 HTML 属性名改掉了，首页目标卡片全部点不动。
 * 所以必须单独比「结构骨架」：标签、class 集合、data-* 属性名。
 *
 * 比较内容（每页）：对 #app 内每个元素按文档顺序记录
 *   标签名 + 排序后的 class 集合 + 排序后的 data-* 属性名集合
 * 两边序列逐项比对，报告第一处差异。
 * 忽略：属性值、style、动态 id、文本（文本由像素/既有测试覆盖）。
 *
 * 用法：node scripts/test-ui-dom.js [路由...]
 */
const { spawn, execFileSync } = require('node:child_process');
const { rmSync } = require('node:fs');

const PORT = Number(process.env.PORT || 3213);
const BASE = 'http://localhost:' + PORT;
const CDP_PORT = Number(process.env.CDP_PORT || 9806);
const PROFILE = '/tmp/sx-domcmp-' + process.pid;
const sleep = ms => new Promise(r => setTimeout(r, ms));

const ROUTES = ['/', '/components', '/library', '/aitasks', '/g/166', '/g/166/map',
  '/g/166/versions', '/g/166/diff/285', '/t/142', '/settings', '/settings/ai', '/guide/1'];

/** 在浏览器里抓骨架 */
function bSkeleton() {
  var root = document.getElementById('app');
  if (!root) return [];
  var out = [];
  var all = root.querySelectorAll('*');
  for (var i = 0; i < all.length; i++) {
    var el = all[i];
    var cls = String(el.className || '').split(/\s+/).filter(Boolean).sort().join('.');
    var dataNames = [];
    for (var j = 0; j < el.attributes.length; j++) {
      var nm = el.attributes[j].name;
      if (nm.indexOf('data-') === 0) dataNames.push(nm);
    }
    dataNames.sort();
    out.push(el.tagName.toLowerCase() + (cls ? '.' + cls : '') + (dataNames.length ? '[' + dataNames.join(',') + ']' : ''));
  }
  return out;
}

/** 等页面稳定（无「加载中」且文本长度连续两次一致） */
function bStable() {
  var a = document.getElementById('app');
  var t = a ? String(a.textContent || '') : '';
  if (!a) return { ok: false, len: 0, loading: true };
  return { ok: t.indexOf('加载中') < 0, len: t.length, loading: t.indexOf('加载中') >= 0 };
}

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
  const send = (method, params) => new Promise((resolve, reject) => {
    const id = ++seq;
    pending.set(id, { resolve, reject });
    ws.send(JSON.stringify({ id, method, params: params || {} }));
    setTimeout(() => { if (pending.has(id)) { pending.delete(id); reject(new Error('timeout ' + method)); } }, 25000);
  });
  const evalIn = async expr => {
    const r = await send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true });
    if (r && r.exceptionDetails) return null;
    return r && r.result ? r.result.value : null;
  };
  const runFn = async fn => evalIn('(' + fn.toString() + ')()');

  const capture = async url => {
    await send('Page.navigate', { url: url });
    let prev = -1;
    for (let i = 0; i < 24; i++) {
      await sleep(420);
      const st = await runFn(bStable);
      if (st && st.ok && st.len === prev && st.len > 0) break;
      prev = st ? st.len : -1;
    }
    return (await runFn(bSkeleton)) || [];
  };

  let pass = 0, failCount = 0;
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
      }
    });
    await send('Page.enable');
    await send('Runtime.enable');
    await send('Page.navigate', { url: BASE + '/' });
    await sleep(4500);
    await evalIn("localStorage.setItem('sierxing-guide-done','1'); localStorage.setItem('sierxing-ai-open','0');");

    const routes = process.argv.slice(2).length ? process.argv.slice(2) : ROUTES;
    for (const route of routes) {
      const plugin = await capture(BASE + '/#' + route);
      const legacy = await capture(BASE + '/?ui=legacy#' + route);
      let diffAt = -1;
      const n = Math.max(plugin.length, legacy.length);
      for (let i = 0; i < n; i++) {
        if ((plugin[i] || '') !== (legacy[i] || '')) { diffAt = i; break; }
      }
      if (diffAt < 0) {
        pass++;
        console.log('  ✅ 结构一致  ' + route + '  (' + plugin.length + ' 个元素)');
      } else {
        failCount++;
        console.log('  ❌ 结构不同  ' + route + '  (' + plugin.length + ' vs ' + legacy.length + ' 元素，首处差异 #' + diffAt + ')');
        console.log('       插件: ' + String(plugin[diffAt] || '(无)').slice(0, 120));
        console.log('       原版: ' + String(legacy[diffAt] || '(无)').slice(0, 120));
        for (let k = Math.max(0, diffAt - 1); k < Math.min(n, diffAt + 3); k++) {
          if ((plugin[k] || '') !== (legacy[k] || '')) {
            console.log('       #' + k + ' 插件=' + String(plugin[k] || '(无)').slice(0, 90));
            console.log('       #' + k + ' 原版=' + String(legacy[k] || '(无)').slice(0, 90));
          }
        }
      }
    }
    console.log('');
    console.log('结构一致: ' + pass + '/' + (pass + failCount));
    if (failCount) process.exitCode = 1;
  } catch (e) {
    console.error('检查异常: ' + e.message);
    process.exitCode = 1;
  } finally {
    try { ws && ws.close(); } catch (e) {}
    try { edge.kill('SIGKILL'); } catch (e) {}
    try { execFileSync('pkill', ['-9', '-f', '--', '--user-data-dir=' + PROFILE], { stdio: 'ignore' }); } catch (e) {}
    rmSync(PROFILE, { recursive: true, force: true });
  }
})();
