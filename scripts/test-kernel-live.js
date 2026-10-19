#!/usr/bin/env node
'use strict';
/**
 * 分层配置端到端验收（P3）：node scripts/test-kernel-live.js
 *
 * 验的是「用户只改 DATA_DIR/config/user.json，就能决定用不用我们的界面」：
 *   ① ui.pagePlugins=false  → 连内置页面插件都不走，回到原版 render*；
 *   ② ui.userPlugins=false  → 即使用户插件放着也不接管；
 *   ③ ui.skins=false        → 不加载用户 skin.css；
 *   ④ 启动时写升级快照；第二次启动能认出「不是首次」且差异为空；
 *   ⑤ 配置告警（未知键）在 /api/kernel 里可见。
 *
 * 自起沙箱实例（随机端口 + 临时 DATA_DIR），不碰真实数据、不起真窗口。
 */
const { spawn, execFileSync } = require('node:child_process');
const { mkdtempSync, writeFileSync, mkdirSync, readFileSync, rmSync } = require('node:fs');
const path = require('node:path');
const os = require('node:os');

const ROOT = path.join(__dirname, '..');
const PORT = Number(process.env.KCFG_TEST_PORT || 3478);
const CDP_PORT = Number(process.env.KCFG_CDP_PORT || 9800);
const BASE = 'http://127.0.0.1:' + PORT;
const PROFILE = '/tmp/sx-kcfg-' + process.pid;
const DATA = mkdtempSync(path.join(os.tmpdir(), 'sx-kcfg-data-'));
const sleep = ms => new Promise(r => setTimeout(r, ms));

let pass = 0, fail = 0;
function ok(name, cond, extra) {
  if (cond) { pass++; console.log('  ✓ ' + name); }
  else { fail++; console.log('  ✗ ' + name + (extra ? '  → ' + extra : '')); }
}

/* 用户配置：关掉页面插件 / 用户插件 / 皮肤，并故意写一个不存在的键验告警 */
mkdirSync(path.join(DATA, 'config'), { recursive: true });
writeFileSync(path.join(DATA, 'config', 'user.json'), JSON.stringify({
  '$schema': '../../config/kernel.schema.json',
  ui: { pagePlugins: false, userPlugins: false, skins: false },
  ui2: { oldKey: true }
}, null, 2));
/* 一个用户插件 + 皮肤：放在这里证明「文件在也不生效」 */
const pluginDir = path.join(DATA, 'ui-plugins', 'home');
mkdirSync(pluginDir, { recursive: true });
writeFileSync(path.join(pluginDir, 'manifest.json'), JSON.stringify({ id: 'home', name: '不该生效的主页', apiVersion: 'sierxing.ui/1', entry: 'index.js', format: 'esm', standalone: true }, null, 2));
writeFileSync(path.join(pluginDir, 'index.js'), 'export default { setup() { return () => window.SiErXingUI.vue.h("div", { id: "shouldNotRender" }, "x"); } };\n');
writeFileSync(path.join(pluginDir, 'skin.css'), 'body { outline: 3px solid red !important; }\n');

function startServer() {
  return spawn(process.execPath, ['--no-warnings', '--experimental-sqlite', path.join(ROOT, 'server', 'server.js')], {
    env: Object.assign({}, process.env, { NO_OPEN: '1', PORT: String(PORT), SIERXING_DATA_DIR: DATA }),
    stdio: 'ignore'
  });
}
async function waitHealth() {
  for (let i = 0; i < 120; i++) {
    try { const r = await fetch(BASE + '/api/health'); if (r.ok) return true; } catch (e) {}
    await sleep(200);
  }
  return false;
}
async function waitGone() {
  for (let i = 0; i < 80; i++) {
    try { await fetch(BASE + '/api/health'); } catch (e) { return true; }
    await sleep(150);
  }
  return false;
}

(async () => {
  console.log('沙箱数据目录：' + DATA);
  let server = startServer();
  let edge = null, ws = null;
  const errors = [];
  try {
    ok('沙箱实例启动（第一次）', await waitHealth());

    const k1 = await (await fetch(BASE + '/api/kernel')).json();
    const cfg = k1.config || {};
    ok('/api/kernel 带分层配置', !!cfg.values && cfg.values['ui.pagePlugins'] === false, JSON.stringify(cfg.values));
    ok('用户配置来源被记录（user）', cfg.provenance && cfg.provenance['ui.pagePlugins'] === 'user');
    ok('未知配置键产生告警（升级不静默）', (cfg.warnings || []).some(w => w.key === 'ui2.oldKey' && /已不存在/.test(w.message)), JSON.stringify(cfg.warnings));
    ok('第一次启动 upgrade.firstRun=true', cfg.upgrade && cfg.upgrade.firstRun === true);
    ok('升级快照已落盘', (() => { try { return JSON.parse(readFileSync(path.join(DATA, 'kernel', 'builtin-snapshot.json'), 'utf8')).plugins.length > 0; } catch (e) { return false; } })());
    const skinCss = await (await fetch(BASE + '/api/ui/skin.css')).text();
    ok('ui.skins=false → 皮肤接口返回空', skinCss === '', JSON.stringify(skinCss.slice(0, 40)));

    /* 浏览器：确认真的回到原版渲染，用户插件与皮肤都没生效 */
    edge = spawn('microsoft-edge', [
      '--headless=new', '--disable-gpu', '--no-sandbox', '--remote-allow-origins=*',
      '--remote-debugging-port=' + CDP_PORT, '--user-data-dir=' + PROFILE,
      '--window-size=1440,900', 'about:blank'
    ], { stdio: 'ignore' });
    let seq = 0;
    const pending = new Map();
    let pageTarget = null;
    for (let i = 0; i < 100 && !pageTarget; i++) {
      try {
        const list = await (await fetch('http://127.0.0.1:' + CDP_PORT + '/json/list')).json();
        pageTarget = list.find(t => t.type === 'page');
      } catch (e) {}
      if (!pageTarget) await sleep(250);
    }
    if (!pageTarget) throw new Error('CDP 未就绪');
    ws = new WebSocket(pageTarget.webSocketDebuggerUrl);
    await new Promise((res, rej) => { ws.addEventListener('open', res); ws.addEventListener('error', rej); });
    const send = (method, params) => new Promise((resolve, reject) => {
      const id = ++seq;
      pending.set(id, { resolve, reject });
      ws.send(JSON.stringify({ id, method, params: params || {} }));
      setTimeout(() => { if (pending.has(id)) { pending.delete(id); reject(new Error('timeout ' + method)); } }, 20000);
    });
    ws.addEventListener('message', ev => {
      const m = JSON.parse(ev.data);
      if (m.id && pending.has(m.id)) {
        const p = pending.get(m.id); pending.delete(m.id);
        if (m.error) p.reject(new Error(m.error.message)); else p.resolve(m.result);
      } else if (m.method === 'Runtime.exceptionThrown') {
        errors.push((m.params.exceptionDetails.text || '').slice(0, 160));
      }
    });
    await send('Page.enable');
    await send('Runtime.enable');
    const evalIn = async expr => {
      const r = await send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true });
      return r && r.result && r.result.value;
    };
    await send('Page.navigate', { url: BASE + '/' });
    await sleep(3000);
    await evalIn("localStorage.setItem('sierxing-guide-done','1'); localStorage.setItem('sierxing-ai-open','0');");
    await send('Page.navigate', { url: BASE + '/?t=' + Date.now() + '#/' });
    await sleep(3200);
    const state = await evalIn(`(function(){
      var root = document.getElementById('app');
      return {
        used: !!(window.__sxPluginUsed && window.__sxPluginUsed.home),
        source: (window.__sxPluginSource || {}).home || '',
        shouldNotRender: !!document.getElementById('shouldNotRender'),
        userSkin: !!document.querySelector('link[data-ui-skin="user"]'),
        textLen: ((root || {}).textContent || '').length,
        cfg: !!(window.__sxKernelConfig && window.__sxKernelConfig['ui.pagePlugins'] === false)
      };
    })()`);
    ok('前端读到了分层配置', state.cfg === true);
    ok('ui.pagePlugins=false → 内置页面插件也没接管（回原版）', state.used === false && state.source === '', JSON.stringify(state));
    ok('用户插件文件在也不生效', state.shouldNotRender === false);
    ok('ui.skins=false → 不挂用户皮肤', state.userSkin === false);
    ok('页面仍有内容（不是白屏）', state.textLen > 40, 'textLen=' + state.textLen);
    if (errors.length) { fail++; console.log('  ✗ 页面异常：' + errors[0]); } else { ok('无未捕获页面异常', true); }

    /* 第二次启动：同一数据目录，upgrade 应认得出「不是首次」 */
    try { ws && ws.close(); } catch (e) {}
    try { execFileSync('pkill', ['-9', '-f', '--', '--user-data-dir=' + PROFILE], { stdio: 'ignore' }); } catch (e) {}
    try { edge.kill('SIGKILL'); } catch (e) {}
    edge = null; ws = null;
    server.kill('SIGKILL');
    await waitGone();
    server = startServer();
    ok('沙箱实例启动（第二次，同一数据目录）', await waitHealth());
    const k2 = await (await fetch(BASE + '/api/kernel')).json();
    const cfg2 = (k2.config || {});
    ok('第二次启动 upgrade.firstRun=false', cfg2.upgrade && cfg2.upgrade.firstRun === false, JSON.stringify(cfg2.upgrade));
    ok('配置键/插件与上次一致（无增删）', cfg2.upgrade && cfg2.upgrade.addedKeys.length === 0 && cfg2.upgrade.removedKeys.length === 0 && cfg2.upgrade.addedPlugins.length === 0 && cfg2.upgrade.removedPlugins.length === 0, JSON.stringify(cfg2.upgrade));
  } catch (e) {
    fail++;
    console.error('测试异常：' + e.message);
  } finally {
    try { ws && ws.close(); } catch (e) {}
    try { edge && edge.kill('SIGKILL'); } catch (e) {}
    try { execFileSync('pkill', ['-9', '-f', '--', '--user-data-dir=' + PROFILE], { stdio: 'ignore' }); } catch (e) {}
    try { server.kill('SIGKILL'); } catch (e) {}
    try { rmSync(PROFILE, { recursive: true, force: true }); } catch (e) {}
    try { rmSync(DATA, { recursive: true, force: true }); } catch (e) {}
    console.log('\n结果：' + pass + ' 通过 / ' + fail + ' 失败');
    process.exit(fail ? 1 : 0);
  }
})();
