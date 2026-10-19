'use strict';
/**
 * 核心组件回归（uimanager / 界面管理）：node --no-warnings scripts/test-core-components.js
 *
 * 钉住用户 2026-10-19 的要求：左侧栏「界面管理」是核心能力 ——
 *   ① 它必须是核心组件（scope=core，归在「核心组件」分类，不可卸载）；
 *   ② 不可关闭：全局开关接口拒绝，目标的按目标开关接口也拒绝；
 *   ③ 关不掉也不会影响恢复路径（页面/客户端脚本仍由 /api/plugins 提供）。
 *
 * 沙箱：临时 SIERXING_DATA_DIR + 独立端口 + NO_OPEN=1，不碰真实数据。
 */
const { spawn } = require('node:child_process');
const net = require('node:net');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'sx-core-ui-'));
const sleep = ms => new Promise(r => setTimeout(r, ms));
let passed = 0, failed = 0;
function ok(name, cond, detail) {
  if (cond) { passed++; console.log('  ✓', name); }
  else { failed++; console.log('  ✗', name, detail == null ? '' : '→ ' + detail); }
}

function freePort() {
  return new Promise((resolve, reject) => {
    const s = net.createServer();
    s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => resolve(p)); });
    s.on('error', reject);
  });
}
async function jget(url) { const r = await fetch(url); const t = await r.text(); try { return { status: r.status, body: JSON.parse(t) }; } catch (e) { return { status: r.status, body: t }; } }
async function jpost(url, body) {
  const r = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body || {}) });
  const t = await r.text(); try { return { status: r.status, body: JSON.parse(t) }; } catch (e) { return { status: r.status, body: t }; }
}

(async function () {
  const PORT = await freePort();
  const BASE = 'http://127.0.0.1:' + PORT;
  const app = spawn(process.execPath, ['--no-warnings', '--experimental-sqlite', 'server/server.js'], {
    cwd: ROOT,
    env: Object.assign({}, process.env, { PORT: String(PORT), NO_OPEN: '1', SIERXING_DATA_DIR: DATA_DIR }),
    stdio: 'ignore'
  });
  try {
    let up = false;
    for (let i = 0; i < 80; i++) {
      await sleep(250);
      try { const h = await jget(BASE + '/api/health'); if (h.body && h.body.ok) { up = true; break; } } catch (e) {}
    }
    if (!up) throw new Error('测试实例没起来（端口 ' + PORT + '）');

    const imp = await jpost(BASE + '/api/import/json', { goals: [{ id: 1, title: '核心组件回归目标', status: 'active' }] });
    if (!imp.body || !imp.body.ok) throw new Error('导入种子失败：' + JSON.stringify(imp.body).slice(0, 200));

    const r1 = await jget(BASE + '/api/components');
    const comps = (r1.body && r1.body.components) || [];
    const ui = comps.find(c => c.id === 'uimanager');
    ok('清单里有「界面管理」组件', !!ui, JSON.stringify(comps.map(c => c.id)));
    ok('显示名已经是「界面管理」（不再叫「界面插件」）', !!ui && ui.name === '界面管理' && String(ui.desc || '').indexOf('统一管理') >= 0, ui && (ui.name + ' / ' + ui.desc));
    ok('它是核心组件（scope=core，归在「核心组件」分类）', !!ui && ui.scope === 'core' && ui.category === '核心组件', ui && (ui.scope + ' / ' + ui.category));
    ok('它标记为不可卸载（removable=false）', !!ui && ui.removable === false);
    ok('它默认开启且当前是开启状态', !!ui && ui.defaultEnabled === true && !!((r1.body.enabled || {}).uimanager));

    const t1 = await jpost(BASE + '/api/components/uimanager/toggle', { enabled: false });
    ok('全局开关接口拒绝关闭它（核心组件不可关闭）', t1.status === 400 && String(t1.body.error || '').indexOf('核心组件不可关闭') >= 0, t1.status + ' ' + JSON.stringify(t1.body).slice(0, 120));
    const r2 = await jget(BASE + '/api/components');
    ok('被拒后仍然是开启的，没写进用户设置', !!((r2.body.enabled || {}).uimanager) && !Object.prototype.hasOwnProperty.call((r2.body.settings || {}), 'uimanager'));

    const t2 = await jpost(BASE + '/api/goals/1/plugins', { plugin_id: 'uimanager', enabled: false });
    ok('目标级开关接口也拒绝它（不能按目标关）', t2.status === 404, t2.status + ' ' + JSON.stringify(t2.body).slice(0, 120));
    const g1 = await jget(BASE + '/api/goals/1/plugins');
    ok('目标级配置里没有它', !((g1.body && g1.body.config) || {}).uimanager);

    /* 关不掉 ≠ 恢复路径受影响：前端客户端脚本仍随 /api/plugins 下发 */
    const r3 = await jget(BASE + '/api/components');
    const p3 = ((r3.body && r3.body.plugins) || []).find(p => p.id === 'uimanager');
    ok('客户端脚本仍随 /api/plugins 下发（页面可正常打开）', !!p3 && p3.client === '/plugins/uimanager.js', p3 && p3.client);

    console.log('');
    console.log(passed + ' 通过 / ' + failed + ' 失败');
    if (failed) process.exitCode = 1;
  } finally {
    try { app.kill('SIGKILL'); } catch (e) {}
    try { fs.rmSync(DATA_DIR, { recursive: true, force: true }); } catch (e) {}
  }
})().catch(e => { console.error('失败：' + ((e && e.stack) || e)); process.exit(1); });
