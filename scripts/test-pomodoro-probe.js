'use strict';
/**
 * 番茄钟「前台窗口探测」的回归：`node scripts/test-pomodoro-probe.js`
 *
 * 为什么留：本应用常以开机自启的 systemd 用户服务运行，那个进程的环境里
 * **没有 DISPLAY / XAUTHORITY**。而 xdotool / wmctrl 是 X 客户端，不补显示环境
 * 就只会回 “Can't open display: (null)”，接口返回 ok:false。前端以前把探测失败
 * 当成“切走就算休息”，于是配了 bilibili，切到任何页面都在休息（线上反馈）。
 *
 * 这里钉住两件事：
 *   ① spawn 探测进程时必须带 gui-env.js 补出来的 DISPLAY / XAUTHORITY；
 *   ② 探测失败要如实返回 ok:false + 原因，不能抛异常、不能假装成功。
 *
 * 纯本地、零依赖、秒级：把 child_process.spawn 换成假的，不真去调 xdotool。
 */
const assert = require('node:assert');
const fs = require('node:fs');
const { EventEmitter } = require('node:events');
const cp = require('node:child_process');

const PLUGIN = require.resolve('../server/plugins/pomodoro.js');
let n = 0;
const T = (name, fn) => { fn(); console.log('  ✓ ' + name); n++; };

const savedEnv = { DISPLAY: process.env.DISPLAY, XAUTHORITY: process.env.XAUTHORITY, WAYLAND_DISPLAY: process.env.WAYLAND_DISPLAY };
const origSpawn = cp.spawn;

/* 和 systemd 服务一样的进程环境：显示变量都不在 */
function stripDisplayEnv() {
  delete process.env.DISPLAY;
  delete process.env.XAUTHORITY;
  delete process.env.WAYLAND_DISPLAY;
}
function restoreEnv() {
  for (const k of ['DISPLAY', 'XAUTHORITY', 'WAYLAND_DISPLAY']) {
    if (savedEnv[k] == null) delete process.env[k];
    else process.env[k] = savedEnv[k];
  }
}

/* 假 spawn：记录 options，按 nextTick 发 stdout + close；errorMode 时只发 error */
function fakeSpawn(calls, opts) {
  opts = opts || {};
  cp.spawn = (cmd, args, o) => {
    calls.push({ cmd, args, env: (o && o.env) || null });
    const child = new EventEmitter();
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    child.kill = () => {};
    process.nextTick(() => {
      if (opts.errorMode) { child.emit('error', new Error('spawn ENOENT')); return; }
      if (opts.stdout) child.stdout.emit('data', opts.stdout);
      child.emit('close');
    });
    return child;
  };
}

function freshPlugin() { delete require.cache[PLUGIN]; return require(PLUGIN); }
function callApi(plugin, which, query) {
  let payload = null;
  const ctx = { sendJSON: (res, code, obj) => { payload = obj; } };
  const u = new URL('http://localhost/api' + (query || ''));
  return plugin.api[which].handler({ method: 'GET' }, {}, u, ctx).then(handled => ({ handled, payload }));
}

(async () => {
  console.log('探测进程的启动环境：');
  stripDisplayEnv();
  const calls = [];
  fakeSpawn(calls, { stdout: 'DeepSeek 开放平台 - 个人 - Microsoft Edge\n--PN--msedge\n' });
  let r = await callApi(freshPlugin(), 0, '/pomodoro/activewin?maxAge=1');
  assert.equal(r.handled, true);
  assert.equal(r.payload.ok, true, '窗口标题应拿到');
  assert.ok(/DeepSeek/.test(r.payload.title), r.payload.title);
  const xCalls = calls.filter(c => c.cmd === 'xdotool' || c.cmd === 'wmctrl');
  assert.ok(xCalls.length > 0, '应调用 xdotool/wmctrl');
  T('xdotool / wmctrl 的 spawn 都带了显示环境', () => {
    for (const c of xCalls) {
      assert.ok(c.env && typeof c.env === 'object', c.cmd + ' 没带 env');
      const hasX = !!c.env.DISPLAY;
      const hasWl = !!c.env.WAYLAND_DISPLAY;
      assert.ok(hasX || hasWl, c.cmd + ' 的 env 里没有 DISPLAY / WAYLAND_DISPLAY（没补 guiEnv？）');
    }
  });
  T('补出来的 DISPLAY 来自真实 X 会话（/tmp/.X11-unix 有 socket 时）', () => {
    let socks = [];
    try { socks = fs.readdirSync('/tmp/.X11-unix').filter(x => /^X\d+$/.test(x)); } catch (e) {}
    if (!socks.length) { console.log('    （本机没有 X11 socket，跳过）'); return; }
    assert.match(xCalls[0].env.DISPLAY, /^:\d+$/);
    if (xCalls[0].env.XAUTHORITY) assert.ok(fs.existsSync(xCalls[0].env.XAUTHORITY), 'XAUTHORITY 指向的文件不存在：' + xCalls[0].env.XAUTHORITY);
  });

  console.log('探测失败时：');
  stripDisplayEnv();
  const calls2 = [];
  fakeSpawn(calls2, { errorMode: true });
  r = await callApi(freshPlugin(), 1, '/pomodoro/winprobe');
  assert.equal(r.handled, true);
  assert.equal(r.payload.ok, false, '命令跑不起来时应当 ok:false，而不是假装拿到窗口');
  T('如实返回 ok:false，并带上失败原因', () => {
    assert.ok(typeof r.payload.err === 'string' && r.payload.err.length > 0, '缺少 err：' + JSON.stringify(r.payload));
  });
  T('探测失败不影响接口本身（不抛异常、仍然有响应）', () => {
    assert.equal(r.payload.platform, process.platform);
  });

  restoreEnv();
  cp.spawn = origSpawn;
  console.log('\n' + n + ' 项全部通过');
})().catch(e => {
  restoreEnv();
  cp.spawn = origSpawn;
  console.error('\n✗ 失败：' + (e && e.message || e));
  if (e && e.stack) console.error(e.stack);
  process.exitCode = 1;
});
