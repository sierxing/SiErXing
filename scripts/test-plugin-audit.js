#!/usr/bin/env node
'use strict';
/**
 * 全页面控件级功能审计（插件化回归用）。
 *
 * 为什么需要：像素一致 / 插件接管都不代表「点得动」。插件化把渲染代码搬进模块作用域后，
 * 任何依赖全局函数名的内联处理器、被改坏的 data-* 属性、漏绑的事件委托，都表现为
 * 「页面长得对、点了没反应」—— 只能逐个点出来。
 * 真实案例：构建器把 data-go= 改成了 data-H.go=，首页目标卡片全部点不动，
 * 而像素对比、插件接管测试全是绿的。
 *
 * 做法：每条路由只整页加载一次，逐个点击「安全控件」，每点一个就比对页面签名
 * （hash / 元素数 / 文本长度 / 弹层数，含 body 级浮层），捕获 JS 异常，
 * 输出「点了没反应」清单。只点不写库的控件，危险词默认跳过。
 *
 * 用法：node scripts/test-plugin-audit.js [路由...]
 *      AUDIT_MAX=15           每页最多点几个控件
 *      AUDIT_ALLOW_DANGER=1   连危险控件都点（别在真实数据上用）
 */
const { spawn, execFileSync } = require('node:child_process');
const { rmSync } = require('node:fs');

const PORT = Number(process.env.PORT || 3213);
const BASE = 'http://localhost:' + PORT;
const CDP_PORT = Number(process.env.CDP_PORT || 9802);
const PROFILE = '/tmp/sx-audit-' + process.pid;
const MAX = Number(process.env.AUDIT_MAX || 15);
const ALLOW_DANGER = process.env.AUDIT_ALLOW_DANGER === '1';
const sleep = ms => new Promise(r => setTimeout(r, ms));

const ROUTES = ['/', '/components', '/library', '/aitasks', '/studystats', '/g/166', '/g/166/map',
  '/g/166/versions', '/g/166/diff/285', '/g/166/chat', '/t/142', '/settings', '/guide/1'];

const DANGER = ['删除', '清空', '卸载', '重置', '更新', '升级', '生成', '运行', '开始', '停止',
  '重试', '导入', '保存', '提交', '分享', '打包', '导出', '安装', '移除', '覆盖', '同步'];

/* ---------- 送进浏览器执行的函数（序列化后 eval） ---------- */

/** 列出可点控件，打上 data-audit-idx */
function bSnapshot() {
  var SEL = 'button, [role=button], a[href^="#"], summary, select, input[type=checkbox], .goalCard, [data-go], [data-fold], [data-childtoggle], [data-vf], [data-libtab], [data-cmp]';
  var root = document.getElementById('app') || document.body;
  var els = Array.prototype.slice.call(root.querySelectorAll(SEL));
  var danger = window.__AUDIT_DANGER || [];
  var out = [];
  for (var i = 0; i < els.length; i++) {
    var el = els[i];
    var r = el.getBoundingClientRect();
    if (r.width < 6 || r.height < 6) continue;
    if (el.disabled) continue;
    var label = ((el.textContent || '') + ' ' + (el.getAttribute('title') || '') + ' ' + (el.getAttribute('aria-label') || '')).replace(/\s+/g, ' ').trim().slice(0, 28);
    var hit = null;
    for (var d = 0; d < danger.length; d++) { if (label.indexOf(danger[d]) >= 0) { hit = danger[d]; break; } }
    var same = false;
    if (el.tagName === 'A') { var href = el.getAttribute('href') || ''; if (href && href === location.hash) same = true; }
    el.setAttribute('data-audit-idx', String(out.length));
    out.push({ idx: out.length, tag: el.tagName, label: label, danger: hit, same: same });
  }
  return out;
}

/** 页面状态签名：判断「点了有没有反应」。
 * 用 DOM 骨架摘要（tag + class + hidden + data-* 名）而不是简单计数：
 * 计数会漏掉「同样的数量、换了个元素」的变化（如设置页切页签：hidden 数量不变、只是换了哪块被隐藏）。
 */
function bSig() {
  var a = document.getElementById('app');
  var txt = a ? String(a.textContent || '') : '';
  var parts = [];
  var els = document.querySelectorAll('#app *');
  for (var i = 0; i < els.length; i++) {
    var el = els[i];
    var cls = String(el.className || '');
    var dataNames = '';
    for (var j = 0; j < el.attributes.length; j++) {
      var nm = el.attributes[j].name;
      if (nm.indexOf('data-') === 0) dataNames += nm + ',';
    }
    parts.push(el.tagName + '|' + cls + '|' + (el.hidden ? 'H' : '') + '|' + dataNames);
  }
  var str = parts.join(';');
  var h = 5381;
  for (var k = 0; k < str.length; k++) h = ((h * 33) ^ str.charCodeAt(k)) >>> 0;
  var th = 5381;
  for (var q = 0; q < txt.length; q++) th = ((th * 33) ^ txt.charCodeAt(q)) >>> 0;
  var detOpen = document.querySelectorAll('#app details[open]').length;
  var drawer = document.querySelectorAll('#aiDrawer.open,#guideMask,.modal,.dlg,.moreMenu,.pop,.ovl').length;
  var toastEl = document.getElementById('toast');
  var hiddenN = document.querySelectorAll('#app [hidden]').length;
  var openedN = document.querySelectorAll('.aitErrBox:not([hidden]),.ctxMenu,.tutDialog,.sxiPop,.sxiGoalPop').length;
  return { h: location.hash, sk: h, n: els.length, t: txt.length, th: th, detOpen: detOpen, d: drawer, bn: document.body.querySelectorAll('*').length, tt: toastEl ? String(toastEl.textContent || '').length : 0, y: Math.round(window.scrollY), hn: hiddenN, on: openedN, errs: (window.__errs || []).slice(0, 3) };
}

/** 点击第 idx 个控件 */
function bClick(idx) {
  var el = document.querySelector('[data-audit-idx="' + idx + '"]');
  if (!el) return 'gone';
  el.scrollIntoView({ block: 'center' });
  el.click();
  return 'clicked';
}

/** 索引失效后按「标签 + 文案」重新找同一个控件（页面重画会把 data-audit-idx 冲掉）。
 *  用**宽松匹配**：只比前 8 个字符，且忽略开头的箭头/圆点（▸▾✓⏹ 这类状态图标会在展开后变化，
 *  严格等值会匹配不上，于是控件被当成 GONE 跳过、后面又误报 NOOP）。 */
function bClickByLabel(tag, label) {
  var norm = function (s) {
    return String(s || '')
      .replace(/^[\s\u25B8\u25BE\u2713\u2717\u23F9\u25CF\u2022\u00B7>v\-+]+/g, '')
      .replace(/\s+/g, ' ')
      .trim();
  };
  var want = norm(label).slice(0, 8);
  if (!want) return 'gone';
  var els = document.querySelectorAll('#app button, #app summary, #app a[href^="#"]');
  var best = null, bestLen = 1e9;
  for (var i = 0; i < els.length; i++) {
    var el = els[i];
    if (tag && el.tagName !== tag) continue;
    var r = el.getBoundingClientRect();
    if (r.width < 6 || r.height < 6) continue;
    var t = norm((el.textContent || '') + ' ' + (el.getAttribute('title') || ''));
    if (t.slice(0, 8) !== want) continue;
    /* 候选可能不止一个：取文案最短的（更可能是那个「纯标题」控件，而不是包住整块的父容器） */
    if (t.length < bestLen) { bestLen = t.length; best = el; }
  }
  if (!best) return 'gone';
  best.scrollIntoView({ block: 'center' });
  best.click();
  return 'clicked';
}

/** 清引导蒙层 + 装错误收集器 */
function bReset() {
  var m = document.getElementById('guideMask');
  if (m) m.remove();
  document.body.classList.remove('guideOpen');
  window.__errs = [];
  window.addEventListener('error', function (e) { window.__errs.push(String(e.message || '').slice(0, 140)); });
  return true;
}

/** 关掉上一步打开的弹层/抽屉/菜单，返回关掉了几个 */
function bCleanup() {
  var closed = 0;
  var ov = document.querySelectorAll('.modal,.dlg,.ovl,[class*=overlay],#aiDrawer.open,.moreMenu');
  for (var i = 0; i < ov.length; i++) {
    var box = ov[i];
    var btn = box.querySelector('[data-close],.close,.dlgClose,.btn.js-cancel,[data-cancel]');
    if (btn) { btn.click(); closed++; }
    else if (box.parentNode) { box.parentNode.removeChild(box); closed++; }
  }
  var gm = document.getElementById('guideMask');
  if (gm) { gm.remove(); closed++; }
  return closed;
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
  const thrown = [];
  const dialogs = [];
  const logs = [];
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
  const goto = async route => {
    await send('Page.navigate', { url: BASE + '/#' + route });
    await sleep(3600);
    await evalIn('window.__AUDIT_DANGER = ' + JSON.stringify(DANGER));
    await runFn(bReset);
    return await runFn(bSnapshot);
  };

  const rows = [];
  let pass = 0, noop = 0, fail = 0, skipped = 0;

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
      } else if (m.method === 'Page.javascriptDialogOpening') {
        send('Page.handleJavaScriptDialog', { accept: false }).catch(function () {});
        dialogs.push(String(m.params.message || '').slice(0, 80));
      } else if (m.method === 'Runtime.exceptionThrown') {
        const d = m.params.exceptionDetails;
        thrown.push(String(((d.exception && d.exception.description) || d.text || '')).split('\n')[0].slice(0, 150));
      } else if (m.method === 'Log.entryAdded') {
        const e = m.params.entry;
        if (e.level === 'error') {
          const text = String(e.text || '').split('\n')[0].slice(0, 150);
          if (text.indexOf('Failed to load resource') < 0 && text.indexOf('404') < 0) logs.push(text);
        }
      }
    });
    await send('Page.enable');
    await send('Runtime.enable');
    await send('Log.enable');
    await send('Page.navigate', { url: BASE + '/' });
    await sleep(4500);
    await evalIn("localStorage.setItem('sierxing-guide-done','1'); localStorage.setItem('sierxing-ai-open','0');");

    const routes = process.argv.slice(2).length ? process.argv.slice(2) : ROUTES;
    for (const route of routes) {
      let controls = await goto(route);
      console.log('');
      console.log('== ' + route + '  (' + (controls || []).length + ' 个控件) ==');
      let clicked = 0;
      for (let i = 0; i < (controls || []).length && clicked < MAX; i++) {
        const c = controls[i];
        if (!c) continue;
        if (c.same) continue;
        if (c.danger && !ALLOW_DANGER) {
          skipped++;
          console.log('  SKIP  ' + c.tag + '  ' + c.label + '  [' + c.danger + ']');
          continue;
        }
        clicked++;
        const errBase = thrown.length + logs.length;
        const dialogBase = dialogs.length;
        const before = await runFn(bSig);
        let clickRes = await evalIn('(' + bClick.toString() + ')(' + c.idx + ')');
        /* ⚠️ 前面某个控件点击会让整块 DOM 重画（例如任务中心的「展开全部」会重画整个历史区），
           这时本轮缓存的 data-audit-idx 已经指向被替换掉的旧元素 —— bClick 返回 'gone'。
           以前直接当 GONE 跳过，于是那些控件**从来没被真正点过**，后面还会误报 NOOP。
           现在按「标签 + 文案」重新定位重点一次（同一页内按钮文案基本唯一）。 */
        if (clickRes === 'gone') {
          /* ⚠️ 参数要一次传两个：曾经写成 (tag)(label)，等于先调用一次、再把返回值当函数调用 → */
          /* 永远落在 'gone' 分支，那些控件一次都没真点过（白名单式漏测，实测踩到）。 */
          const retry = await evalIn('(' + bClickByLabel.toString() + ')(' + JSON.stringify(c.tag) + ',' + JSON.stringify(c.label) + ')');
          clickRes = retry || 'gone';
        }
        await sleep(950);
        const after = await runFn(bSig);
        /* Esc 复位：关掉上一步打开的弹层/抽屉/菜单，避免遮挡后续控件 */
        try {
          await send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 });
          await send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 });
        } catch (e2) {}
        await sleep(200);
        await runFn(bCleanup);
        await sleep(150);
        const errNow = thrown.length + logs.length;
        const pageErrs = (after && after.errs) || [];
        const b = before || {}, a = after || {};
        const dialogOpened = dialogs.length > dialogBase;
        const changed = dialogOpened || b.h !== a.h || b.sk !== a.sk || b.n !== a.n || b.t !== a.t || b.th !== a.th || b.d !== a.d || b.bn !== a.bn || b.tt !== a.tt || b.detOpen !== a.detOpen || b.y !== a.y || b.hn !== a.hn || b.on !== a.on;
        const errText = pageErrs[0] || (errNow > errBase ? (thrown[errBase] || logs[errBase] || '') : '');
        if (process.env.AUDIT_TRACE) console.log('  [trace] ' + c.tag + ' | ' + c.label + ' | clickRes=' + clickRes + ' | changed=' + changed + ' | before=' + JSON.stringify({ n: b.n, sk: b.sk, th: b.th, hn: b.hn }) + ' | after=' + JSON.stringify({ n: a.n, sk: a.sk, th: a.th, hn: a.hn }));
        if (clickRes === 'gone') {
          console.log('  GONE  ' + c.tag + '  ' + c.label + '  （重载后重建索引）');
          controls = await goto(route);
        } else if (errText) {
          fail++;
          console.log('  ERR   ' + c.tag + '  ' + c.label + '  -> ' + errText);
        } else if (!changed) {
          noop++;
          console.log('  NOOP  ' + c.tag + '  ' + c.label);
        } else {
          pass++;
          console.log('  OK    ' + c.tag + '  ' + c.label);
          /* 点击导致页面跳转/重绘：回到原路由重载，索引才有效 */
          controls = await goto(route);
        }
      }
    }

    console.log('');
    console.log('=== 汇总 ===');
    console.log('有反应 ' + pass + ' · 无反应 ' + noop + ' · 异常 ' + fail + ' · 跳过危险 ' + skipped);
    if (dialogs.length) {
      console.log('');
      console.log('点击触发的原生确认框（已自动拒绝，不算失败）: ' + dialogs.length);
      dialogs.slice(0, 5).forEach(d => console.log('  - ' + d));
    }
    if (fail) process.exitCode = 1;
  } catch (e) {
    console.error('审计异常: ' + e.message);
    process.exitCode = 1;
  } finally {
    try { ws && ws.close(); } catch (e) {}
    try { edge.kill('SIGKILL'); } catch (e) {}
    try { execFileSync('pkill', ['-9', '-f', '--', '--user-data-dir=' + PROFILE], { stdio: 'ignore' }); } catch (e) {}
    rmSync(PROFILE, { recursive: true, force: true });
  }
})();
