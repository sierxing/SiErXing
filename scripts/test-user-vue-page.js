#!/usr/bin/env node
'use strict';
/**
 * 用户界面插件端到端验收（P2）：node scripts/test-user-vue-page.js
 *
 * 验的是「用户真的能换掉我们的界面」这条链路，不是文件是否存在：
 *   ① 用户插件是 ESM + Vue 组件 → 整页渲染、Vue 响应式可用、standalone 不注入内置样式；
 *   ② 用户插件 export function mount(root) → 自接管 DOM，离开页面时 unmount 被调用；
 *   ③ 停用用户插件（POST /api/ui/plugins/<id>/state）→ 回退内置界面；
 *   ④ 管理页 #/ui-plugins 能打开并列出页面；
 *   ⑤ /api/kernel 显示服务端插件已装载（P1 回归）。
 *
 * 自起沙箱实例（随机端口 + 临时 DATA_DIR），不碰真实数据、不需要 AI、不开真窗口。
 */
const { spawn, execFileSync } = require('node:child_process');
const { mkdtempSync, writeFileSync, mkdirSync, rmSync } = require('node:fs');
const path = require('node:path');
const os = require('node:os');

const ROOT = path.join(__dirname, '..');
const PORT = Number(process.env.UIP_TEST_PORT || 3477);
const CDP_PORT = Number(process.env.UIP_CDP_PORT || 9799);
const BASE = 'http://127.0.0.1:' + PORT;
const PROFILE = '/tmp/sx-uip-' + process.pid;
const DATA = mkdtempSync(path.join(os.tmpdir(), 'sx-uip-data-'));
const sleep = ms => new Promise(r => setTimeout(r, ms));

let pass = 0, fail = 0;
function ok(name, cond, extra) {
  if (cond) { pass++; console.log('  ✓ ' + name); }
  else { fail++; console.log('  ✗ ' + name + (extra ? '  → ' + extra : '')); }
}

function writeUserPlugin(id, manifest, entry) {
  const dir = path.join(DATA, 'ui-plugins', id);
  mkdirSync(dir, { recursive: true });
  writeFileSync(path.join(dir, 'manifest.json'), JSON.stringify(Object.assign({ id: id, apiVersion: 'sierxing.ui/1', entry: 'index.js' }, manifest), null, 2));
  writeFileSync(path.join(dir, 'index.js'), entry);
}

/* ① Vue 组件契约（不构建、不裸导入 vue：走 window.SiErXingUI.vue） */
writeUserPlugin('home', { name: '我的主页', format: 'esm', standalone: true, version: '1.0.0' }, String.raw`
export default {
  setup() {
    const { h, ref, onMounted } = window.SiErXingUI.vue;
    const n = ref(0);
    onMounted(() => { window.__userHomeMounted = true; });
    return () => h('div', { class: 'page', id: 'userHome' }, [
      h('h1', null, '我的自定义主页'),
      h('button', { id: 'userHomeBtn', class: 'btn', onClick: () => { n.value += 1; } }, '点我 ' + n.value)
    ]);
  }
};
`);

/* ② 自接管 DOM 契约 */
writeUserPlugin('library', { name: '我的资源库', format: 'esm', version: '1.0.0' }, String.raw`
export function mount(root) {
  window.__userLibraryMounted = true;
  root.innerHTML = '<div class="page" id="userLibrary"><h1>我的资源库</h1></div>';
  return function unmount() {
    window.__userLibraryUnmounted = true;
    try { root.innerHTML = ''; } catch (e) {}
  };
}
`);

async function waitHealth() {
  for (let i = 0; i < 100; i++) {
    try { const r = await fetch(BASE + '/api/health'); if (r.ok) return true; } catch (e) {}
    await sleep(200);
  }
  return false;
}

async function waitTargets() {
  for (let i = 0; i < 100; i++) {
    try {
      const r = await fetch('http://127.0.0.1:' + CDP_PORT + '/json/list');
      if (r.ok) {
        const list = await r.json();
        const page = list.find(t => t.type === 'page');
        if (page) return page;
      }
    } catch (e) {}
    await sleep(250);
  }
  throw new Error('CDP 未就绪');
}

(async () => {
  console.log('沙箱数据目录：' + DATA);
  const server = spawn(process.execPath, ['--no-warnings', '--experimental-sqlite', path.join(ROOT, 'server', 'server.js')], {
    env: Object.assign({}, process.env, { NO_OPEN: '1', PORT: String(PORT), SIERXING_DATA_DIR: DATA }),
    stdio: 'ignore'
  });
  let edge = null, ws = null;
  const errors = [];
  try {
    ok('沙箱实例启动', await waitHealth());

    /* 服务端接口先行（不依赖浏览器） */
    const uiList = await (await fetch(BASE + '/api/ui/plugins')).json();
    const homeEntry = (uiList.plugins || []).find(p => p.id === 'home');
    ok('/api/ui/plugins 能看到用户插件（source=user/enabled）', !!homeEntry && homeEntry.source === 'user' && homeEntry.enabled === true, JSON.stringify(homeEntry));
    ok('内置页面也在列表里（source=builtin）', (uiList.plugins || []).some(p => p.id === 'home' && p.source === 'builtin') === false && (uiList.plugins || []).some(p => p.id === 'settings' && p.source === 'builtin'), '同 id 被用户覆盖后只留用户版本，其它内置页仍在');
    const kernel = await (await fetch(BASE + '/api/kernel')).json();
    ok('/api/kernel 服务端插件已装载', Array.isArray(kernel.plugins) && kernel.plugins.length > 20 && kernel.plugins.every(p => !!p.status), 'plugins=' + (kernel.plugins || []).length);
    ok('/api/kernel 服务清单可用', Array.isArray(kernel.services) && kernel.services.length > 20, 'services=' + (kernel.services || []).length);

    edge = spawn('microsoft-edge', [
      '--headless=new', '--disable-gpu', '--no-sandbox', '--remote-allow-origins=*',
      '--remote-debugging-port=' + CDP_PORT, '--user-data-dir=' + PROFILE,
      '--window-size=1440,900', 'about:blank'
    ], { stdio: 'ignore' });

    let seq = 0;
    const pending = new Map();
    const send = (method, params) => new Promise((resolve, reject) => {
      const id = ++seq;
      pending.set(id, { resolve, reject });
      ws.send(JSON.stringify({ id, method, params: params || {} }));
      setTimeout(() => { if (pending.has(id)) { pending.delete(id); reject(new Error('timeout ' + method)); } }, 20000);
    });
    const evalIn = async expr => {
      const r = await send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true });
      if (r && r.exceptionDetails) throw new Error((r.exceptionDetails.exception && r.exceptionDetails.exception.description) || r.exceptionDetails.text);
      return r && r.result && r.result.value;
    };

    const page = await waitTargets();
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

    /* 关掉首次引导，避免蒙层挡住/干扰 */
    await send('Page.navigate', { url: BASE + '/' });
    await sleep(2500);
    await evalIn("localStorage.setItem('sierxing-guide-done','1'); localStorage.setItem('sierxing-ai-open','0');");

    /* ① Vue 用户插件整页接管 */
    await send('Page.navigate', { url: BASE + '/#/' });
    await sleep(3500);
    const homeInfo = await evalIn(`(function(){
      return {
        source: (window.__sxPluginSource || {}).home || '',
        hasUser: !!document.getElementById('userHome'),
        hasBuiltin: !!document.querySelector('.homeDeskGrid'),
        mounted: !!window.__userHomeMounted,
        builtinStyle: !!document.querySelector('link[data-ui-plugin-style="home"]'),
        text: (document.getElementById('app') || {}).textContent || ''
      };
    })()`);
    ok('Vue 用户插件整页接管（source=user:esm-vue）', homeInfo.source === 'user:esm-vue', homeInfo.source);
    ok('用户组件真的渲染出来了', homeInfo.hasUser === true);
    ok('Vue onMounted 生命周期执行', homeInfo.mounted === true);
    ok('standalone 不注入内置页面样式', homeInfo.builtinStyle === false);
    ok('内置首页 DOM 已不存在（确实是整页替换）', homeInfo.hasBuiltin === false);
    await evalIn("document.getElementById('userHomeBtn').click(); document.getElementById('userHomeBtn').click();");
    await sleep(400);
    const btnText = await evalIn("(document.getElementById('userHomeBtn')||{}).textContent || ''");
    ok('用户组件响应式生效（点两次 → 2）', /2/.test(btnText), btnText);

    /* ② mount(root) 契约 */
    await send('Page.navigate', { url: BASE + '/#/library' });
    await sleep(2600);
    const libInfo = await evalIn(`(function(){
      return {
        source: (window.__sxPluginSource || {}).library || '',
        hasUser: !!document.getElementById('userLibrary'),
        mounted: !!window.__userLibraryMounted
      };
    })()`);
    ok('mount(root) 契约接管（source=user:esm-mount）', libInfo.source === 'user:esm-mount', libInfo.source);
    ok('mount(root) 自己画的 DOM 在页面上', libInfo.hasUser === true && libInfo.mounted === true);
    await send('Page.navigate', { url: BASE + '/#/' });
    await sleep(1800);
    ok('离开页面时 unmount 被调用', await evalIn('!!window.__userLibraryUnmounted') === true);

    /* ③ 停用用户插件 → 回退内置 */
    const off = await (await fetch(BASE + '/api/ui/plugins/home/state', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ enabled: false })
    })).json();
    ok('停用接口返回 ok', off && off.ok === true && off.plugin && off.plugin.enabled === false, JSON.stringify(off));
    const afterOff = await (await fetch(BASE + '/api/ui/plugins')).json();
    const homeOff = (afterOff.plugins || []).find(p => p.id === 'home');
    ok('停用状态已落盘（enabled=false）', !!homeOff && homeOff.enabled === false, JSON.stringify(homeOff));
    await send('Page.navigate', { url: BASE + '/?t=' + Date.now() + '#/' });
    await sleep(3000);
    const fallback = await evalIn(`(function(){
      return {
        source: (window.__sxPluginSource || {}).home || '',
        hasUser: !!document.getElementById('userHome'),
        hasBuiltin: !!document.querySelector('.homeDeskGrid') || ((document.getElementById('app')||{}).textContent||'').length > 40
      };
    })()`);
    ok('停用后回退内置界面（source=builtin）', fallback.source === 'builtin', fallback.source);
    ok('停用后用户 DOM 消失、内置内容回来了', fallback.hasUser === false && fallback.hasBuiltin === true);

    /* ③b 重新启用 → 用户插件立刻恢复 */
    await fetch(BASE + '/api/ui/plugins/home/state', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ enabled: true })
    });
    await send('Page.navigate', { url: BASE + '/?t=' + Date.now() + '#/' });
    await sleep(3200);
    const backOn = await evalIn("(window.__sxPluginSource || {}).home || ''");
    ok('重新启用后用户插件恢复（source=user:esm-vue）', backOn === 'user:esm-vue', backOn);

    /* ④ 管理页 */
    await send('Page.navigate', { url: BASE + '/#/ui-plugins' });
    await sleep(3000);
    const mgr = await evalIn(`(function(){
      var root = document.getElementById('app');
      return {
        text: (root || {}).textContent || '',
        cards: document.querySelectorAll('.uipCard').length,
        hasToggle: !!document.querySelector('[data-uip-toggle]'),
        hasKernelFold: !!document.querySelector('.uipFold')
      };
    })()`);
    ok('管理页渲染出页面卡片', mgr.cards >= 10, 'cards=' + mgr.cards);
    ok('管理页有启停按钮与内核自检', mgr.hasToggle === true && mgr.hasKernelFold === true);
    ok('管理页标题与说明', /界面管理/.test(mgr.text) && /回退/.test(mgr.text));

    if (errors.length) {
      console.log('\n页面异常 ' + errors.length + ' 条:');
      errors.slice(0, 5).forEach(e => console.log('  - ' + e.split('\n')[0]));
      fail++;
    } else {
      ok('无未捕获页面异常', true);
    }
  } catch (e) {
    fail++;
    console.error('测试异常：' + e.message);
  } finally {
    try { ws && ws.close(); } catch (e) {}
    try { edge && edge.kill('SIGKILL'); } catch (e) {}
    try { execFileSync('pkill', ['-9', '-f', '--', '--user-data-dir=' + PROFILE], { stdio: 'ignore' }); } catch (e) {}
    try { rmSync(PROFILE, { recursive: true, force: true }); } catch (e) {}
    try { server.kill('SIGKILL'); } catch (e) {}
    try { execFileSync('pkill', ['-9', '-f', '--', 'SIERXING_DATA_DIR=' + DATA], { stdio: 'ignore' }); } catch (e) {}
    try { rmSync(DATA, { recursive: true, force: true }); } catch (e) {}
    console.log('\n结果：' + pass + ' 通过 / ' + fail + ' 失败');
    process.exit(fail ? 1 : 0);
  }
})();
