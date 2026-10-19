#!/usr/bin/env node
'use strict';
/**
 * 首页「目标桌面」功能回归：最近目标栏 / 拖拽排序 / 「📁 收进收藏夹」按钮合并 / 三档大小 /
 * 收藏夹内拖拽排序 / 右键移出 / 新目标追加到末尾 / 布局持久化。
 *
 * 为什么留：这套交互横跨「按下即拖 vs 触摸长按 → 插入位置 hit test → 显式「📁」按钮合并 →
 * localStorage 布局对账 → 重绘」，只做像素对比证明不了能拖、能排序、能合并、能记住顺序。
 * 这里用**沙箱数据目录**起一个独立实例（不碰真实数据），真鼠标事件拖一遍，断言 DOM 与 localStorage。
 *
 * 用法：node --no-warnings scripts/test-home-launcher.js
 * 环境变量：APP_PORT（默认 3317）、CDP_PORT（默认 9786）
 * ⚠️ 无头浏览器收尾按 profile 杀整棵树（见 AGENTS.md「起测试实例的两条铁律」）。
 */
const { spawn, execFileSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const APP_PORT = Number(process.env.APP_PORT || 3317);
const CDP_PORT = Number(process.env.CDP_PORT || 9786);
const BASE = 'http://127.0.0.1:' + APP_PORT;
const DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'sx-home-launcher-'));
const PROFILE = '/tmp/sx-home-launcher-' + process.pid;
const sleep = ms => new Promise(r => setTimeout(r, ms));

let server = null;
let edge = null;
let ws = null;

async function jget(url) {
  const r = await fetch(url);
  return r.json();
}
async function jpost(url, body) {
  const r = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body || {}) });
  return r.json();
}
async function waitServer() {
  for (let i = 0; i < 80; i++) {
    await sleep(250);
    try { const h = await jget(BASE + '/api/health'); if (h && h.ok) return true; } catch (e) {}
  }
  return false;
}
async function waitTargets() {
  for (let i = 0; i < 80; i++) {
    try { const r = await fetch('http://127.0.0.1:' + CDP_PORT + '/json/list'); if (r.ok) return await r.json(); } catch (e) {}
    await sleep(250);
  }
  throw new Error('CDP 未就绪');
}

(async () => {
  let seq = 0;
  const pending = new Map();
  const pageErrors = [];
  const results = [];
  const send = (method, params) => new Promise((resolve, reject) => {
    const id = ++seq;
    pending.set(id, { resolve, reject });
    ws.send(JSON.stringify({ id, method, params: params || {} }));
    setTimeout(() => { if (pending.has(id)) { pending.delete(id); reject(new Error('CDP 超时 ' + method)); } }, 20000);
  });
  const evalIn = async expr => {
    const r = await send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true });
    return r && r.result && r.result.value;
  };
  const check = (name, ok, detail) => {
    results.push({ name, ok: !!ok });
    console.log((ok ? '  ✅ ' : '  ❌ ') + name + (detail ? '  ' + detail : ''));
  };
  const center = async sel => evalIn(`(function(){var el=document.querySelector(${JSON.stringify(sel)});if(!el)return null;var r=el.getBoundingClientRect();return {x:r.left+r.width/2,y:r.top+r.height/2};})()`);
  const keys = async () => evalIn(`Array.from(document.querySelectorAll('#homeDeskGrid [data-tile-key]')).map(function(t){ return t.getAttribute('data-tile-key'); })`);

  /* ---------- 真鼠标事件 ---------- */
  const pressAt = p => send('Input.dispatchMouseEvent', { type: 'mousePressed', x: p.x, y: p.y, button: 'left', clickCount: 1 });
  const moveTo = p => send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: p.x, y: p.y, button: 'left', buttons: 1 });
  const releaseAt = p => send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: p.x, y: p.y, button: 'left', clickCount: 1 });
  async function dragPath(from, to, steps, delay) {
    for (let i = 1; i <= steps; i++) {
      await moveTo({ x: from.x + (to.x - from.x) * i / steps, y: from.y + (to.y - from.y) * i / steps });
      await sleep(delay);
    }
  }
  /* 鼠标按下就拖（桌面默认动作，也是这次修的回归点：之前必须按住 300ms，鼠标用户拖不动） */
  async function quickDrag(from, to) {
    await pressAt(from);
    await sleep(40);
    await dragPath(from, to, 6, 45);
    await releaseAt(to);
    await sleep(950);
  }
  /* 拖动中「📁 收进收藏夹」按钮的位置（只在压着另一张卡片时存在） */
  const chipPos = () => evalIn(`(function(){
    var c = document.querySelector('.htMergeChip');
    if (!c) return null;
    var r = c.getBoundingClientRect();
    return { x: r.left + r.width / 2, y: r.top + r.height / 2, text: c.textContent };
  })()`);
  /* 目标卡片上「不在按钮上」的松手点：右半区、卡片上部（保证落点是排序而不是融合） */
  const sortPointOn = sel => evalIn(`(function(){
    var t = document.querySelector(${JSON.stringify(sel)});
    if (!t) return null;
    var r = t.getBoundingClientRect();
    return { x: r.left + r.width * 0.72, y: r.top + r.height * 0.3 };
  })()`);
  async function clickAt(p) {
    await pressAt(p);
    await releaseAt(p);
    await sleep(1400);
  }
  async function rightClickAt(p) {
    await send('Input.dispatchMouseEvent', { type: 'mousePressed', x: p.x, y: p.y, button: 'right', buttons: 2, clickCount: 1 });
    await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: p.x, y: p.y, button: 'right', buttons: 0, clickCount: 1 });
    await sleep(450);
  }

  try {
    /* ---------- 沙箱实例 + 预置 6 个目标 ---------- */
    server = spawn(process.execPath, ['--no-warnings', '--experimental-sqlite', 'server/server.js'], {
      cwd: ROOT,
      env: Object.assign({}, process.env, { PORT: String(APP_PORT), NO_OPEN: '1', SIERXING_DATA_DIR: DATA_DIR }),
      stdio: ['ignore', 'ignore', 'pipe']
    });
    let serverErr = '';
    server.stderr.on('data', d => { serverErr += String(d); });
    if (!await waitServer()) throw new Error('沙箱实例没起来（端口 ' + APP_PORT + '）' + (serverErr ? '\n' + serverErr.slice(-500) : ''));
    const titles = ['转行做数据分析师', '三个月学会前端', '考研上岸', '摄影后期', '英语口语', '做个个人作品集'];
    const titleToId = {};
    for (const title of titles) {
      const r = await jpost(BASE + '/api/goals', { title, profile: '零基础', weekly_hours: '8', deadline: '3 个月' });
      if (!r || !r.goal || !r.goal.id) throw new Error('建目标失败：' + JSON.stringify(r).slice(0, 200));
      titleToId[title] = r.goal.id;
    }
    console.log('  · 沙箱实例已启动（' + BASE + '，' + titles.length + ' 个目标）');

    /* ---------- 无头浏览器 ---------- */
    edge = spawn('microsoft-edge', [
      '--headless=new', '--disable-gpu', '--no-sandbox', '--remote-allow-origins=*',
      '--remote-debugging-port=' + CDP_PORT, '--user-data-dir=' + PROFILE,
      '--window-size=1440,900', 'about:blank'
    ], { stdio: 'ignore' });
    const list = await waitTargets();
    const page = list.find(t => t.type === 'page');
    if (!page) throw new Error('没有可用的 page target');
    ws = new WebSocket(page.webSocketDebuggerUrl);
    await new Promise((res, rej) => { ws.addEventListener('open', res); ws.addEventListener('error', rej); });
    ws.addEventListener('message', ev => {
      const m = JSON.parse(ev.data);
      if (m.id && pending.has(m.id)) {
        const p = pending.get(m.id); pending.delete(m.id);
        if (m.error) p.reject(new Error(m.error.message)); else p.resolve(m.result);
      } else if (m.method === 'Runtime.exceptionThrown') {
        const d = m.params.exceptionDetails;
        pageErrors.push(((d.exception && d.exception.description) || d.text || '').slice(0, 240));
      }
    });
    await send('Page.enable');
    await send('Runtime.enable');

    const clearGuide = "localStorage.setItem('sierxing-guide-done','1'); localStorage.setItem('sierxing-guide','1'); localStorage.setItem('sierxing-ai-open','0'); var m=document.getElementById('guideMask'); if(m)m.remove(); document.querySelectorAll('.guideMask').forEach(function(n){n.remove();}); document.body.classList.remove('guideOpen');";
    const gotoHome = async (full) => {
      await send('Page.navigate', { url: full ? (BASE + '/?r=' + Date.now() + '#/') : (BASE + '/#/') });
      await sleep(full ? 3200 : 2200);
      await evalIn(clearGuide);
      await sleep(250);
    };
    await gotoHome(true);
    await gotoHome(false);

    /* 0. 干净状态：没有最近目标记录、没有布局记录 */
    await evalIn("localStorage.removeItem('sierxing-home-recent-v1'); localStorage.removeItem('sierxing-home-layout-v1');");
    await gotoHome(true);

    /* 1. 默认桌面：6 张「中」卡 + 工具栏；没有开过目标 → 不显示最近目标栏 */
    const first = await evalIn(`(function(){
      var grid = document.getElementById('homeDeskGrid');
      if (!grid) return { grid: false };
      var tiles = Array.from(grid.querySelectorAll('[data-tile-key]'));
      return {
        grid: true,
        count: tiles.length,
        sizes: tiles.map(function(t){ return t.getAttribute('data-size'); }),
        folders: tiles.filter(function(t){ return t.getAttribute('data-tile-type') === 'folder'; }).length,
        hasBar: !!document.getElementById('homeSizeSeg'),
        recent: !!document.getElementById('homeRecent'),
        recentKey: localStorage.getItem('sierxing-home-recent-v1')
      };
    })()`);
    check('首页渲染成目标桌面（6 张卡片 + 批量大小工具栏）',
      first && first.grid && first.count === titles.length && first.hasBar, JSON.stringify(first));
    check('默认卡片都是「中」档，且没有最近目标记录时不出最近栏',
      first && first.sizes.every(s => s === 'm') && first.folders === 0 && first.recent === false, JSON.stringify(first));

    /* 2. 批量改「小」并落 localStorage */
    await evalIn("document.querySelector('[data-home-size-all=\"s\"]').click()");
    await sleep(900);
    const small = await evalIn(`(function(){
      var tiles = Array.from(document.querySelectorAll('#homeDeskGrid [data-tile-key]'));
      var layout = null; try { layout = JSON.parse(localStorage.getItem('sierxing-home-layout-v1') || 'null'); } catch (e) {}
      return { sizes: tiles.map(function(t){ return t.getAttribute('data-size'); }), layout: layout };
    })()`);
    check('「全部小」把卡片切到小档并持久化',
      small && small.sizes.every(s => s === 's') && small.layout && small.layout.items.every(it => it.size === 's'),
      JSON.stringify(small && small.sizes));

    /* 3. 鼠标按下直接拖到另一张卡片上松手（不停留）→ 排序，而不是生成收藏夹 */
    let ks = await keys();
    const from3 = await center('[data-tile-key="' + ks[0] + '"]');
    const to3 = await center('[data-tile-key="' + ks[3] + '"]');
    await pressAt(from3);
    await sleep(40);
    await dragPath(from3, to3, 6, 45);
    const during3 = await evalIn(`(function(){
      return { ghost: document.querySelectorAll('.homeTileGhost').length,
               line: document.querySelectorAll('.htDropBefore, .htDropAfter').length,
               into: document.querySelectorAll('.htDropInto').length };
    })()`);
    await releaseAt(to3);
    await sleep(950);
    const ks3 = await keys();
    const expect3 = [ks[1], ks[2], ks[3], ks[0], ks[4], ks[5]];
    check('按下即拖（不等长按）会出现拖拽 ghost 与插入线', during3 && during3.ghost === 1 && during3.line === 1 && during3.into === 0, JSON.stringify(during3));
    check('拖到另一张卡片上松手 → 按落点排序（不会误生成收藏夹）',
      JSON.stringify(ks3) === JSON.stringify(expect3) && (await evalIn("document.querySelectorAll('.homeTile-folder').length")) === 0,
      JSON.stringify(ks3) + ' 期望 ' + JSON.stringify(expect3));

    /* 3.5 停在目标卡片上 900ms 再松手：不该自动融合（用户反馈的老问题：想排序、手一慢就被判成合并） */
    ks = await keys();
    const fromP = await center('[data-tile-key="' + ks[1] + '"]');
    const toP = await center('[data-tile-key="' + ks[2] + '"]');
    await pressAt(fromP);
    await sleep(40);
    await dragPath(fromP, toP, 6, 45);
    await sleep(900);
    const paused = await evalIn(`(function(){
      var g = document.getElementById('homeDeskGrid');
      return { chip: document.querySelectorAll('#homeDeskGrid .htMergeChip').length,
               chipText: (document.querySelector('#homeDeskGrid .htMergeChip') || {}).textContent || '',
               into: document.querySelectorAll('#homeDeskGrid .htDropInto').length,
               line: document.querySelectorAll('#homeDeskGrid .htDropBefore, #homeDeskGrid .htDropAfter').length };
    })()`);
    const releaseP = await sortPointOn('[data-tile-key="' + ks[2] + '"]');
    if (!releaseP) throw new Error('找不到停顿测试的松手点');
    await moveTo(releaseP);
    await sleep(120);
    await releaseAt(releaseP);
    await sleep(950);
    const ks35 = await keys();
    const expect35 = [ks[0], ks[2], ks[1], ks[3], ks[4], ks[5]];
    const noFolder35 = await evalIn("document.querySelectorAll('#homeDeskGrid .homeTile-folder').length");
    check('在卡片上停顿不会自动融合（只出现「📁」按钮；松在卡片上 = 排序）',
      paused && paused.chip === 1 && paused.chipText.indexOf('收进') >= 0 && paused.into === 0 &&
      paused.line === 1 && JSON.stringify(ks35) === JSON.stringify(expect35) && noFolder35 === 0 &&
      (await evalIn("document.querySelectorAll('.htMergeChip').length")) === 0,
      JSON.stringify({ paused: paused, order: ks35 }));

    /* 4. 拖动压到卡片上 → 移动「📁 收进收藏夹」按钮上松手 → 两张收进新建收藏夹 */
    ks = await keys();
    const from4 = await center('[data-tile-key="' + ks[1] + '"]');
    const to4 = await center('[data-tile-key="' + ks[0] + '"]');
    await pressAt(from4);
    await sleep(40);
    await dragPath(from4, to4, 6, 45);
    const chip4 = await chipPos();
    if (!chip4) throw new Error('压到卡片上后没出现「📁 收进收藏夹」按钮');

    /* 可落区必须够大：按钮做满卡片宽度 + 有高度，而且外扩一圈（slop）也算命中，
       用户不该为了融合去像素级对准一个小点（用户反馈「区域太小，很难受」）。 */
    const chipArea = await evalIn(`(function(){
      var c = document.querySelector('.htMergeChip');
      var t = c && c.closest('.homeTile');
      if (!c || !t) return null;
      var cr = c.getBoundingClientRect(), tr = t.getBoundingClientRect();
      return { chipW: Math.round(cr.width), chipH: Math.round(cr.height),
               tileW: Math.round(tr.width), ratio: +(cr.width / tr.width).toFixed(2),
               slopTop: Math.round(cr.top - tr.top) };
    })()`);
    check('「📁」可落区够大：按钮约占满卡片宽度（≥60%）、高度 ≥28px',
      chipArea && chipArea.ratio >= 0.6 && chipArea.chipH >= 28, JSON.stringify(chipArea));

    /* 指针停在按钮左边缘外 6px（仍在卡片内，并不在按钮本身上，靠横向外扩判定命中）
       → 仍算压住、高亮，松手融合。用户不必精确对准按钮边缘。 */
    const chipSlop = await evalIn(`(function(){
      var c = document.querySelector('.htMergeChip');
      var r = c.getBoundingClientRect();
      return { x: r.left - 6, y: r.top + r.height / 2 };
    })()`);
    await moveTo(chipSlop);
    await sleep(200);
    const chipState = await evalIn(`(function(){
      var c = document.querySelector('.htMergeChip');
      var g = document.getElementById('homeDeskGrid');
      return { on: !!c && c.classList.contains('on'), chipHover: g.classList.contains('htChipHover'),
               line: g.querySelectorAll('.htDropBefore, .htDropAfter').length };
    })()`);
    await releaseAt(chipSlop);
    await sleep(1000);
    check('指针压在「📁」上时按钮高亮、插入线隐去（此刻松手 = 融合）',
      chipState && chipState.on && chipState.chipHover && chipState.line === 0, JSON.stringify(chipState));
    check('按钮左右外扩的一圈也算命中（差 6px 没对准也能融合）',
      chipState && chipState.on === true, JSON.stringify(chipState));
    const merged = await evalIn(`(function(){
      var tiles = Array.from(document.querySelectorAll('#homeDeskGrid [data-tile-key]'));
      var folderTile = document.querySelector('#homeDeskGrid .homeTile-folder');
      var layout = null; try { layout = JSON.parse(localStorage.getItem('sierxing-home-layout-v1') || 'null'); } catch (e) {}
      var folderItem = layout && layout.items.filter(function(it){ return it.type === 'folder'; })[0];
      return {
        tiles: tiles.length,
        folders: tiles.filter(function(t){ return t.getAttribute('data-tile-type') === 'folder'; }).length,
        goals: folderItem ? folderItem.goals.slice() : [],
        name: folderItem ? folderItem.name : '',
        mini: folderTile ? folderTile.querySelectorAll('.htMini').length : 0,
        chipsLeft: document.querySelectorAll('.htMergeChip').length
      };
    })()`);
    check('松在「📁 收进收藏夹」按钮上 → 收进新建收藏夹（2 个目标，按钮不残留）',
      merged && merged.folders === 1 && merged.tiles === titles.length - 1 && merged.goals.length === 2 &&
      merged.mini >= 2 && merged.chipsLeft === 0,
      JSON.stringify(merged));
    const folderGoalIds = merged && merged.goals ? merged.goals.slice() : [];

    /* 收藏夹卡片会被同行更高的卡片拉伸：预览必须从标题下面**顶部开始、逐行向下**，
       不能贴卡片底部（那会让第一行在底下、新增行往上叠，看起来像「从下往上排列」）。 */
    const preview = await evalIn(`(function(){
      var tile = document.querySelector('#homeDeskGrid .homeTile-folder');
      if (!tile) return null;
      var head = tile.querySelector('.htHead'), box = tile.querySelector('.htFolderMini');
      var hr = head.getBoundingClientRect(), br = box.getBoundingClientRect();
      var mins = Array.from(box.querySelectorAll('.htMini')).map(function(m){
        var r = m.getBoundingClientRect(); return { top: Math.round(r.top), left: Math.round(r.left) };
      });
      return { gap: Math.round(br.top - hr.bottom), tileH: Math.round(tile.getBoundingClientRect().height),
               gapBottom: Math.round(tile.getBoundingClientRect().bottom - br.bottom), minis: mins };
    })()`);
    check('收藏夹预览从标题下方开始、逐行向下排（不贴卡片底部）',
      preview && preview.gap >= 0 && preview.gap < 40 && preview.minis.length === 2 &&
      preview.minis[0].left < preview.minis[1].left && preview.minis[0].top === preview.minis[1].top,
      JSON.stringify(preview));

    /* 5. 点开收藏夹 → 弹层里 2 张卡 */
    await evalIn("document.querySelector('#homeDeskGrid .homeTile-folder').click()");
    await sleep(700);
    const dialog = await evalIn(`(function(){
      var mask = document.querySelector('.homeFolderMask');
      return { open: !!mask, cards: mask ? mask.querySelectorAll('[data-hf-goal]').length : 0,
               title: mask ? (mask.querySelector('.hfTitle') || {}).textContent : '' };
    })()`);
    check('收藏夹弹层可打开（含 2 张目标卡）', dialog && dialog.open && dialog.cards === 2, JSON.stringify(dialog));

    /* 6. 弹层内拖拽排序：把第 1 张拖到第 2 张上松手 → 顺序对调并持久化 */
    const c0 = await center('[data-hf-goal="' + folderGoalIds[0] + '"]');
    const c1 = await center('[data-hf-goal="' + folderGoalIds[1] + '"]');
    await quickDrag(c0, c1);
    const reordered = await evalIn(`(function(){
      var layout = null; try { layout = JSON.parse(localStorage.getItem('sierxing-home-layout-v1') || 'null'); } catch (e) {}
      var folderItem = layout && layout.items.filter(function(it){ return it.type === 'folder'; })[0];
      var cards = Array.from(document.querySelectorAll('[data-hf-goal]')).map(function(c){ return Number(c.getAttribute('data-hf-goal')); });
      return { goals: folderItem ? folderItem.goals.slice() : [], cards: cards, open: !!document.querySelector('.homeFolderMask') };
    })()`);
    check('收藏夹内部拖动卡片可排序（松手写回 localStorage）',
      reordered && reordered.open && JSON.stringify(reordered.goals) === JSON.stringify([folderGoalIds[1], folderGoalIds[0]]) &&
      JSON.stringify(reordered.cards) === JSON.stringify([folderGoalIds[1], folderGoalIds[0]]),
      JSON.stringify(reordered));

    /* 7. Esc 关闭弹层：标题栏计数/size 都是次要，关键是首页被重画且收藏夹还在 */
    await send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 });
    await send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 });
    await sleep(1500);
    const afterEsc = await evalIn(`(function(){
      return { open: !!document.querySelector('.homeFolderMask'),
               tiles: document.querySelectorAll('#homeDeskGrid [data-tile-key]').length,
               folders: document.querySelectorAll('#homeDeskGrid .homeTile-folder').length };
    })()`);
    check('Esc 关闭弹层后首页重画，收藏夹保留',
      afterEsc && !afterEsc.open && afterEsc.tiles === titles.length - 1 && afterEsc.folders === 1, JSON.stringify(afterEsc));

    /* 8. 整页刷新后顺序 / 收藏夹都在 */
    await gotoHome(true);
    const persisted = await evalIn(`(function(){
      var layout = null; try { layout = JSON.parse(localStorage.getItem('sierxing-home-layout-v1') || 'null'); } catch (e) {}
      var folderItem = layout && layout.items.filter(function(it){ return it.type === 'folder'; })[0];
      return {
        tiles: document.querySelectorAll('#homeDeskGrid [data-tile-key]').length,
        folders: document.querySelectorAll('#homeDeskGrid .homeTile-folder').length,
        goals: folderItem ? folderItem.goals.slice() : []
      };
    })()`);
    check('整页刷新后收藏夹与内部排序都保留',
      persisted && persisted.folders === 1 && persisted.tiles === titles.length - 1 &&
      JSON.stringify(persisted.goals) === JSON.stringify([folderGoalIds[1], folderGoalIds[0]]),
      JSON.stringify(persisted));

    /* 9. 弹层里右键卡片 → 菜单出现 → 「移出收藏夹」回到桌面 */
    await evalIn("document.querySelector('#homeDeskGrid .homeTile-folder').click()");
    await sleep(700);
    const ejectId = folderGoalIds[1];
    const cardPos = await center('[data-hf-goal="' + ejectId + '"]');
    await rightClickAt(cardPos);
    let menu = await evalIn("(function(){var m=document.querySelector('.homeTileMenu');return m?m.innerText:'';})()");
    if (!menu) {
      /* 不同平台的 contextmenu 触发时机不同：CDP 右键没弹时用合成事件兜底（同一处理函数） */
      await evalIn(`(function(){var c=document.querySelector('[data-hf-goal="${ejectId}"]'); if(!c) return; var r=c.getBoundingClientRect(); c.dispatchEvent(new MouseEvent('contextmenu',{bubbles:true,cancelable:true,clientX:r.left+r.width/2,clientY:r.top+r.height/2}));})()`);
      await sleep(300);
      menu = await evalIn("(function(){var m=document.querySelector('.homeTileMenu');return m?m.innerText:'';})()");
    }
    check('收藏夹里右键卡片会弹出菜单（含「移出收藏夹」）',
      !!menu && menu.indexOf('移出收藏夹') >= 0, JSON.stringify(menu));
    await evalIn("(function(){var b=document.querySelector('[data-hf-menu-eject]'); if(b) b.click();})()");
    await sleep(1700);
    const afterEject = await evalIn(`(function(){
      var layout = null; try { layout = JSON.parse(localStorage.getItem('sierxing-home-layout-v1') || 'null'); } catch (e) {}
      var ids = layout ? layout.items.map(function(it){ return it.type === 'folder' ? 'folder' : 'goal:' + it.id; }) : [];
      return {
        open: !!document.querySelector('.homeFolderMask'),
        tiles: document.querySelectorAll('#homeDeskGrid [data-tile-key]').length,
        folders: document.querySelectorAll('#homeDeskGrid .homeTile-folder').length,
        hasEjected: !!document.querySelector('#homeDeskGrid [data-tile-key="goal:${ejectId}"]'),
        items: ids
      };
    })()`);
    check('右键「移出收藏夹」把目标放回桌面（只剩 1 个目标的收藏夹自动摊平）',
      afterEject && !afterEject.open && afterEject.tiles === titles.length && afterEject.folders === 0 && afterEject.hasEjected,
      JSON.stringify(afterEject));

    /* 10. 最近目标栏：点卡片进目标页 → 回首页出现这一栏；点 pill 又能进去 */
    const ks10 = await keys();
    const visitGoalId = Number(String(ks10[0]).replace('goal:', ''));
    const firstTilePos = await center('[data-tile-key="' + ks10[0] + '"]');
    await clickAt(firstTilePos);
    const hash10 = await evalIn('location.hash');
    await gotoHome(false);
    const recent = await evalIn(`(function(){
      var row = document.getElementById('homeRecent');
      if (!row) return { shown: false };
      var pills = Array.from(row.querySelectorAll('.hrCard'));
      return { shown: true, count: pills.length, first: pills[0] ? pills[0].getAttribute('data-go') : '', go: location.hash };
    })()`);
    check('打开过目标后首页顶部出现「最近目标」，最近打开的排第一',
      hash10 === '#/g/' + visitGoalId && recent && recent.shown && recent.first === '#/g/' + visitGoalId,
      JSON.stringify({ hash10: hash10, recent: recent }));
    await evalIn("(function(){var p=document.querySelector('#homeRecent .hrCard'); if(p) p.click();})()");
    await sleep(1600);
    check('点「最近目标」卡片可以直接回到该目标',
      (await evalIn('location.hash')) === '#/g/' + visitGoalId, String(await evalIn('location.hash')));

    /* 11. 新目标追加到「所有目标」末尾，不冲乱已有顺序 */
    await gotoHome(false);
    const beforeNew = await keys();
    const nr = await jpost(BASE + '/api/goals', { title: '新加的目标（应排最后）', profile: '零基础', weekly_hours: '5', deadline: '1 个月' });
    if (!nr || !nr.goal || !nr.goal.id) throw new Error('新目标创建失败');
    const newGoalKey = 'goal:' + nr.goal.id;
    await gotoHome(true);
    const afterNew = await keys();
    check('新加的目标排到最后，已有顺序前缀不变（顺序由用户拖动决定）',
      afterNew.length === beforeNew.length + 1 &&
      JSON.stringify(afterNew.slice(0, beforeNew.length)) === JSON.stringify(beforeNew) &&
      afterNew[afterNew.length - 1] === newGoalKey,
      JSON.stringify({ before: beforeNew, after: afterNew }));

    /* 12. 恢复默认：解散收藏夹、清掉布局键、所有目标按默认大小回桌面 */
    await evalIn("window.confirm=function(){return true;}; document.getElementById('homeLayoutReset').click()");
    await sleep(1500);
    const reset = await evalIn(`(function(){
      var layout = null; try { layout = JSON.parse(localStorage.getItem('sierxing-home-layout-v1') || 'null'); } catch (e) {}
      return {
        tiles: document.querySelectorAll('#homeDeskGrid [data-tile-key]').length,
        folders: document.querySelectorAll('#homeDeskGrid .homeTile-folder').length,
        sizes: Array.from(document.querySelectorAll('#homeDeskGrid [data-tile-key]')).map(function(t){ return t.getAttribute('data-size'); }),
        cleared: layout === null
      };
    })()`);
    check('「恢复默认」解散收藏夹并清掉本地布局',
      reset && reset.tiles === titles.length + 1 && reset.folders === 0 && reset.cleared && reset.sizes.every(s => s === 'm'),
      JSON.stringify(reset));

    /* 13. 全程无未捕获异常 */
    check('全程无页面异常', pageErrors.length === 0, pageErrors.slice(0, 3).join(' | '));

    const pass = results.filter(r => r.ok).length;
    console.log('');
    console.log('首页目标桌面: ' + pass + '/' + results.length);
    if (pass !== results.length) process.exitCode = 1;
  } catch (e) {
    console.error('❌ 测试失败：', e && e.stack || e);
    process.exitCode = 1;
  } finally {
    try { ws && ws.close(); } catch (e) {}
    try { edge && edge.kill('SIGKILL'); } catch (e) {}
    try { execFileSync('pkill', ['-9', '-f', '--', '--user-data-dir=' + PROFILE], { stdio: 'ignore' }); } catch (e) {}
    try { fs.rmSync(PROFILE, { recursive: true, force: true }); } catch (e) {}
    try { server && server.kill('SIGKILL'); } catch (e) {}
    try { fs.rmSync(DATA_DIR, { recursive: true, force: true }); } catch (e) {}
  }
})();