#!/usr/bin/env node
'use strict';
/**
 * 界面语言（i18n）无头浏览器验收 —— 不花钱、不碰真实数据
 * ============================================================================
 *   node --no-warnings scripts/test-language-ui.js
 *
 * 它做三件事：
 *  ① 起一个沙箱实例（SIERXING_DATA_DIR 指向 .tmp-dev，端口/数据都不碰真实的 3213）；
 *  ② 把界面语言切成英文，用无头浏览器逐路由扫「残留中文」（文本节点 + 会显示的属性）；
 *  ③ 断言：html lang / 文档标题是英文、左侧栏不再有中文、各页面没有「页面出错」、
 *     残留中文总数不超过预算。
 *
 * ⚠️ 无头浏览器必须能被收尸（见 AGENTS.md §2）：按 profile 杀整棵树 + 删 profile；
 *    服务实例与沙箱数据也一起清理。端口可用 APP_PORT / CDP_PORT 覆盖。
 */
const { spawn, execFileSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const APP_DIR = path.resolve(__dirname, '..');
const APP_PORT = Number(process.env.APP_PORT || 3398);
const CDP_PORT = Number(process.env.CDP_PORT || 9806);
const BASE = 'http://127.0.0.1:' + APP_PORT;
const WORK = path.join(APP_DIR, '.tmp-dev', 'lang-ui-' + process.pid);
const DATA_DIR = path.join(WORK, 'data');
const PROFILE = path.join(WORK, 'cdp-profile');
const ALLOW_LEFTOVER = Number(process.env.ALLOW_LEFTOVER || 60);

const sleep = ms => new Promise(r => setTimeout(r, ms));
let server = null;
let browser = null;
const pageErrors = [];

function cleanDir(p) { try { fs.rmSync(p, { recursive: true, force: true }); } catch (e) {} }
function killServer() {
  try { if (server && !server.killed) server.kill('SIGKILL'); } catch (e) {}
  /* 端口兜底：只杀监听这个测试端口的进程（不碰真实的 3213） */
  try {
    const out = execFileSync('bash', ['-lc', "ss -ltnp 2>/dev/null | grep ':" + APP_PORT + " ' | grep -oP 'pid=\\K[0-9]+' | head -1"], { encoding: 'utf8' }).trim();
    if (out) execFileSync('kill', ['-9', out], { stdio: 'ignore' });
  } catch (e) {}
}
function killBrowser() {
  try { execFileSync('pkill', ['-9', '-f', '--', PROFILE], { stdio: 'ignore' }); } catch (e) {}
  cleanDir(PROFILE);
}

async function api(method, p, body) {
  const r = await fetch(BASE + p, {
    method: method,
    headers: { 'Content-Type': 'application/json' },
    body: body == null ? undefined : JSON.stringify(body)
  });
  const text = await r.text();
  let j = null;
  try { j = JSON.parse(text); } catch (e) {}
  return { status: r.status, json: j, text: text };
}

let passed = 0;
function ok(name) { passed++; console.log('  ✓ ' + name); }
function fail(name, detail) { failures++; console.error('  ✗ ' + name + (detail ? '：' + String(detail).slice(0, 300) : '')); }

async function waitServer() {
  for (let i = 0; i < 80; i++) {
    try {
      const r = await fetch(BASE + '/api/health');
      if (r.ok) return;
    } catch (e) {}
    await sleep(250);
  }
  throw new Error('沙箱服务没起来（端口 ' + APP_PORT + '）');
}

/* ---------- 浏览器：优先用 playwright-core 的 firefox ----------
   为什么不用 CDP + msedge：在部分受限环境（沙箱/只读 HOME）里 edge headless 会崩，
   而 playwright 的 firefox 稳定。没有安装 playwright 时本测试自动跳过（不影响其它回归）。 */
function loadPlaywright() {
  const names = ['playwright-core', 'playwright'];
  for (const n of names) { try { return require(n); } catch (e) {} }
  const roots = [];
  try { roots.push(execFileSync('npm', ['root', '-g'], { encoding: 'utf8' }).trim()); } catch (e) {}
  roots.push(path.join(os.homedir(), '.nvm', 'versions', 'node', process.version, 'lib', 'node_modules'));
  for (const root of roots) for (const n of names) { try { return require(path.join(root, n)); } catch (e) {} }
  /* 本机 DSH 全局装了 openclaw（内含 playwright-core）时的兜底 */
  try {
    const base = path.join(os.homedir(), '.nvm', 'versions', 'node', process.version, 'lib', 'node_modules', 'openclaw', 'node_modules');
    return require(path.join(base, 'playwright-core'));
  } catch (e) {}
  return null;
}
function findFirefoxExe() {
  const cache = path.join(os.homedir(), '.cache', 'ms-playwright');
  let found = '';
  try {
    for (const d of fs.readdirSync(cache)) {
      if (!/^firefox-/.test(d)) continue;
      const p = path.join(cache, d, 'firefox', 'firefox');
      if (fs.existsSync(p)) found = p;
    }
  } catch (e) {}
  return found;
}

/** 在页面里扫「还没被翻译的中文」：文本节点 + hint/title/placeholder 等属性 */
const AUDIT_JS = `(function () {
  var CJK = /[\\u3400-\\u4dbf\\u4e00-\\u9fff\\uf900-\\ufaff]/;
  var SKIP = '[data-i18n-skip],.no-i18n,#tutFrame,.tutBody,#adMsgs,.mdBody,.hljs,svg,script,style,code,pre,textarea';
  function skipEl(el) {
    try { return !!(el && el.closest && el.closest(SKIP)); } catch (e) { return true; }
  }
  var out = [];
  var outCtx = {};
  function push(s, el) {
    s = String(s == null ? '' : s).replace(/\\s+/g, ' ').trim();
    if (!s || !CJK.test(s) || s.length > 160) return;
    if (out.indexOf(s) < 0) {
      out.push(s);
      var tag = el && el.tagName ? String(el.tagName).toLowerCase() : '';
      var cls = el && el.className && typeof el.className === 'string' ? el.className.split(/\\s+/).slice(0, 3).join('.') : '';
      outCtx[s] = (tag || 'text') + (cls ? '.' + cls : '');
    }
  }
  var walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT, null);
  var n = walker.nextNode();
  while (n) {
    if (!skipEl(n.parentElement)) push(n.nodeValue, n.parentElement);
    n = walker.nextNode();
  }
  document.querySelectorAll('[title],[placeholder],[aria-label],[alt]').forEach(function (el) {
    if (skipEl(el)) return;
    ['title', 'placeholder', 'aria-label', 'alt'].forEach(function (a) {
      if (el.hasAttribute(a)) push(el.getAttribute(a), el);
    });
  });
  var rail = document.querySelector('#rail');
  var app = document.querySelector('#app');
  return {
    lang: document.documentElement.lang,
    title: document.title,
    leftover: out,
    leftoverCtx: outCtx,
    railText: rail ? String(rail.textContent || '').replace(/\\s+/g, ' ').trim() : '',
    appHead: app ? String(app.textContent || '').replace(/\\s+/g, ' ').trim().slice(0, 80) : '',
    langSection: (function () {
      var sec = document.querySelector('#set-lang');
      if (!sec || sec.hidden || !sec.offsetParent) return '';
      return String(sec.textContent || '').replace(/\\s+/g, ' ').trim().slice(0, 400);
    })(),
    broken: app ? String(app.textContent || '').indexOf('页面出错') >= 0 : true
  };
})()`;

(async () => {
  const results = [];
  let failures = 0;
  try {
    cleanDir(WORK);
    fs.mkdirSync(DATA_DIR, { recursive: true });
    fs.mkdirSync(PROFILE, { recursive: true });

    /* 1) 沙箱服务 */
    console.log('▶ 启动沙箱实例（端口 ' + APP_PORT + '，数据 ' + path.relative(APP_DIR, DATA_DIR) + '）');
    server = spawn(process.execPath, ['--no-warnings', '--experimental-sqlite', path.join(APP_DIR, 'server/server.js')], {
      cwd: APP_DIR,
      env: Object.assign({}, process.env, { NO_OPEN: '1', PORT: String(APP_PORT), SIERXING_DATA_DIR: DATA_DIR }),
      stdio: 'ignore'
    });
    await waitServer();

    /* 2) 造一点数据（目标/节点/教程），让页面有东西可渲染；全部通过 HTTP，不碰真实库 */
    const g1 = await api('POST', '/api/goals', { title: '转行成为数据分析师', profile: '零基础，每周能学 10 小时', weekly_hours: '10', deadline: '3 个月' });
    const g2 = await api('POST', '/api/goals', { title: '搞懂我自己项目的源码', profile: '会一点 JS', weekly_hours: '6', deadline: '6 周' });
    const gid = (g1.json && (g1.json.id || (g1.json.goal && g1.json.goal.id))) || 1;
    const gid2 = (g2.json && (g2.json.id || (g2.json.goal && g2.json.goal.id))) || 2;

    /* 3) 切成英文 */
    const sw = await api('POST', '/api/language/active', { code: 'en-US' });
    if (!sw.json || !sw.json.ok) throw new Error('切换英文失败：' + JSON.stringify(sw.json || sw.text));
    console.log('▶ 界面语言已切到 en-US');

    /* 4) 浏览器（playwright firefox） */
    const pw = loadPlaywright();
    if (!pw || !pw.firefox) {
      console.log('▶ 跳过：没有找到 playwright（npm i -D playwright-core 或全局安装后可用）');
      throw { skip: true };
    }
    const exe = findFirefoxExe();
    browser = await pw.firefox.launch(Object.assign({ headless: true }, exe ? { executablePath: exe } : {}));
    const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 }, locale: 'en-US' });
    const page = await ctx.newPage();
    page.on('pageerror', e => pageErrors.push(String(e && e.message || e).slice(0, 200)));
    await page.addInitScript(() => {
      try {
        localStorage.setItem('sierxing-guide-done', '1');
        localStorage.setItem('sierxing-onboard-v1', '1');
        localStorage.setItem('sierxing-ai-open', '0');
      } catch (e) {}
    });
    await page.goto(BASE + '/', { waitUntil: 'load' });
    await page.waitForTimeout(2500);

    const routes = [
      { name: '首页', hash: '/' },
      { name: '设置', hash: '/settings' },
      { name: '组件管理', hash: '/components' },
      { name: '资源库', hash: '/library' },
      { name: '任务中心', hash: '/aitasks' },
      { name: '界面管理', hash: '/ui-plugins' },
      { name: '学习统计', hash: '/studystats' },
      { name: '目标执行页', hash: '/g/' + gid },
      { name: '路线图', hash: '/g/' + gid + '/map' },
      { name: '目标2', hash: '/g/' + gid2 },
      { name: '设置·语言页签', hash: '/settings', click: '[data-tab="set-lang"]' }
    ];

    let totalLeft = 0;
    for (const r of routes) {
      await page.goto(BASE + '/#' + r.hash, { waitUntil: 'load' });
      await page.waitForTimeout(2400);
      await page.evaluate(() => {
        const m = document.getElementById('guideMask');
        if (m) m.remove();
        try { localStorage.setItem('sierxing-ai-open', '0'); } catch (e) {}
      });
      if (r.click) {
        try {
          await page.click(r.click, { timeout: 3000 });
          await page.waitForTimeout(1200);
        } catch (e) { fail(r.name + '：点不到 ' + r.click + '（' + e.message.slice(0, 60) + '）'); }
      }
      if (process.env.SAVE_SHOTS) {
        try {
          const shots = path.join(APP_DIR, '.tmp-dev', 'shots');
          fs.mkdirSync(shots, { recursive: true });
          await page.screenshot({ path: path.join(shots, String(routes.indexOf(r) + 1).padStart(2, '0') + '-' + r.name.replace(/[\/\s·]+/g, '_') + '-en.png'), fullPage: true });
        } catch (e) {}
      }
      const info = await page.evaluate(AUDIT_JS);
      if (info.broken) fail(r.name + '：页面出错');
      if (!info.lang || info.lang.indexOf('en') !== 0) fail(r.name + '：html lang 不是 en（' + info.lang + '）');
      if (/[\u3400-\u4dbf\u4e00-\u9fff]/.test(info.railText)) fail(r.name + '：左侧栏还有中文：' + JSON.stringify(info.railText).slice(0, 160));
      if (r.name === '设置·语言页签') {
        if (!info.langSection) fail('语言页签：语言区块没有显示出来（#set-lang 不可见）');
        else if (info.langSection.indexOf('Language') < 0) fail('语言页签：语言区块里没看到 Language 字样');
        const ui = await page.evaluate(() => ({
          cards: document.querySelectorAll('#langList .langCard').length,
          chips: document.querySelectorAll('#langChips [data-lang-gen]').length,
          current: !!(document.querySelector('.langNow') && document.querySelector('.langNow').textContent.trim())
        }));
        if (ui.cards < 2) fail('语言页签：已安装语言列表少于 2 项（应至少 中文 + English）');
        if (!ui.chips) fail('语言页签：没有渲染「可选语言清单」（chips）');
        if (!ui.current) fail('语言页签：没有显示"当前界面语言"');
      }
      /* 种子数据（目标标题/现状）本来就是用户内容，切英文也不该被翻译 —— 审计时排除 */
      const seedData = ['转行成为数据分析师', '搞懂我自己项目的源码', '零基础，每周能学 10 小时', '会一点 JS', '6 周', '3 个月', '10 小时', '日本語 / Français / Türkçe / 한국어 / العربية'];
      info.leftover = info.leftover.filter(x => !seedData.some(d => x.indexOf(d) >= 0));
      totalLeft += info.leftover.length;
      results.push({ route: r.name, leftovers: info.leftover, ctx: info.leftoverCtx || {} });
      console.log('  · ' + r.name + '：残留中文 ' + info.leftover.length + ' 条'
        + (info.leftover.length ? '（例：' + info.leftover.slice(0, 3).map(x => JSON.stringify(x).slice(0, 60)).join('、') + '）' : ''));
    }

    /* 文档标题 / meta */
    await page.goto(BASE + '/', { waitUntil: 'load' });
    await page.waitForTimeout(1500);
    const doc = await page.evaluate(() => ({
      lang: document.documentElement.lang,
      title: document.title,
      desc: (document.querySelector('meta[name=description]') || {}).content || ''
    }));
    if (doc.lang.indexOf('en') !== 0) fail('文档 lang 不是英文：' + doc.lang);
    if (/[\u3400-\u9fff]/.test(doc.title)) fail('文档标题还有中文：' + doc.title);
    if (doc.title.indexOf('SiErXing') < 0) fail('文档标题不像英文标题：' + doc.title);

    /* 手动切换：在 设置 → 语言 列表里点「中文」，整页应切回中文（再切回英文方便后续） */
    await page.goto(BASE + '/#/settings', { waitUntil: 'load' });
    await page.waitForTimeout(2200);
    await page.click('[data-tab="set-lang"]', { timeout: 4000 }).catch(() => {});
    await page.waitForTimeout(800);
    const zhClicked = await page.evaluate(() => {
      const card = Array.from(document.querySelectorAll('#langList [data-lang]')).find(el => el.getAttribute('data-lang') === 'zh-CN');
      if (!card) return false;
      card.click();
      return true;
    });
    if (!zhClicked) fail('手动切换：语言列表里没有「中文」卡片');
    await page.waitForTimeout(3200);
    const zhState = await page.evaluate(() => ({ lang: document.documentElement.lang, rail: (document.querySelector('#rail') || {}).textContent || '' }));
    if (zhState.lang !== 'zh-CN' && zhState.lang.indexOf('zh') !== 0) fail('手动切换到中文没生效（lang=' + zhState.lang + '）');
    else ok('手动切换：中文列表项点一下即整页切回中文');
    if (!/[\u3400-\u9fff]/.test(zhState.rail)) fail('切换回中文后左侧栏没有中文（可能语言包/字典没加载）');
    else ok('切换回中文后界面恢复正常');
    if (process.env.SAVE_SHOTS) {
      try {
        await page.click('[data-tab="set-lang"]', { timeout: 4000 }).catch(() => {});
        await page.waitForTimeout(900);
        const shots = path.join(APP_DIR, '.tmp-dev', 'shots');
        fs.mkdirSync(shots, { recursive: true });
        await page.screenshot({ path: path.join(shots, 'zz-settings-language-zh.png'), fullPage: true });
      } catch (e) {}
    }
    await api('POST', '/api/language/active', { code: 'en-US' }).catch(() => {});
    await browser.close();
    browser = null;

    if (totalLeft > ALLOW_LEFTOVER) fail('残留中文合计 ' + totalLeft + ' 条，超过预算 ' + ALLOW_LEFTOVER + ' 条');
    if (pageErrors.length) fail('页面有未捕获异常：' + pageErrors.slice(0, 3).join(' | '));

    const detailed = results.filter(r => r.leftovers.length);
    if (detailed.length) {
      console.log('\n残留中文明细（供补翻译/补模式用）：');
      for (const r of detailed) for (const x of r.leftovers.slice(0, 14)) {
        const ctx = r.ctx && r.ctx[x] ? ' <' + r.ctx[x] + '>' : '';
        console.log('  [' + r.route + ']' + ctx + ' ' + JSON.stringify(x).slice(0, 140));
      }
    }
    if (failures) {
      console.error('\n✗ i18n UI 验收失败：' + failures + ' 项（残留中文合计 ' + totalLeft + ' 条）');
      process.exitCode = 1;
    } else {
      console.log('\n✓ i18n UI 验收通过：' + passed + ' 项通过（残留中文合计 ' + totalLeft + ' 条，预算 ' + ALLOW_LEFTOVER + '）');
    }
  } catch (e) {
    if (e && e.skip) {
      console.log('▶ 已跳过 i18n UI 验收（环境里没有可用的 playwright/firefox）');
    } else {
      console.error('✗ 测试异常：' + (e && e.stack || e));
      process.exitCode = 1;
    }
  } finally {
    try { if (browser) await browser.close(); } catch (e) {}
    killBrowser();
    killServer();
    await sleep(500);
    await fetch(BASE + '/api/health').then(() => console.error('⚠ 测试服务还活着，请检查端口 ' + APP_PORT)).catch(() => {});
    cleanDir(WORK);
  }
})();
