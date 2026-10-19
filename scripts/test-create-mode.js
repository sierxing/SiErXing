#!/usr/bin/env node
'use strict';
/**
 * 创造模式回归（不花钱：不调 AI）
 * ---------------------------------------------------------------------------
 * 1. 纯函数：parseCreateOutput / validateArtifact（围栏解析、id/page 校验、红线拦截、语法检查）
 * 2. HTTP e2e（沙箱实例 + SIERXING_CREATE_DEBUG=1 的 /api/create/stage 测试钩子）：
 *    暂存 → 读回 → 未确认拒绝安装 → 安装 → 文件落点/接口可用 → 覆盖更新 → 回滚 → 放弃
 *    覆盖三种产物：ui-page / skin / component
 *
 * 跑法：node scripts/test-create-mode.js
 */
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const net = require('node:net');
const http = require('node:http');
const { spawn } = require('node:child_process');
const createMode = require('../server/create-mode.js');

const BASE = path.resolve(__dirname, '..');
let passed = 0;
function ok(name, fn) {
  return Promise.resolve().then(fn).then(function () { passed++; console.log('  ✓ ' + name); },
    function (e) { console.error('  ✗ ' + name); throw e; });
}
function freePort() {
  return new Promise(function (resolve, reject) {
    const s = net.createServer();
    s.unref();
    s.on('error', reject);
    s.listen(0, '127.0.0.1', function () { const p = s.address().port; s.close(function () { resolve(p); }); });
  });
}
function req(port, method, p, body) {
  return new Promise(function (resolve, reject) {
    const data = body == null ? null : JSON.stringify(body);
    const r = http.request({ host: '127.0.0.1', port: port, method: method, path: p, headers: data ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) } : {} }, function (res) {
      let s = '';
      res.on('data', function (c) { s += c; });
      res.on('end', function () {
        let json = null;
        try { json = JSON.parse(s); } catch (e) {}
        resolve({ status: res.statusCode, text: s, json: json });
      });
    });
    r.on('error', reject);
    if (data) r.write(data);
    r.end();
  });
}
function waitHealth(port) {
  return new Promise(function (resolve, reject) {
    let n = 0;
    (function tick() {
      req(port, 'GET', '/api/health').then(function (r) {
        if (r.status === 200 && r.json && r.json.ok) return resolve();
        if (++n > 60) return reject(new Error('服务 15 秒内没起来'));
        setTimeout(tick, 250);
      }).catch(function () {
        if (++n > 60) return reject(new Error('服务 15 秒内没起来'));
        setTimeout(tick, 250);
      });
    })();
  });
}
function readFileSafe(f) { try { return fs.readFileSync(f, 'utf8'); } catch (e) { return ''; } }

(async function main() {
  console.log('== 创造模式：纯函数 ==');
  await ok('parseCreateOutput：识别 create 围栏并把正文留下', function () {
    const fence = String.fromCharCode(96, 96, 96);
    const text = '我准备给首页加一张卡片。\n\n' + fence + 'create\n{"kind":"skin","id":"warm","name":"暖色","files":{"skin.css":":root{}"}}\n' + fence;
    const r = createMode.parseCreateOutput(text);
    assert.strictEqual(r.found, true);
    assert.strictEqual(r.artifact.kind, 'skin');
    assert.ok(r.reply.indexOf('我准备') === 0 && r.reply.indexOf('kind') < 0);
  });
  await ok('parseCreateOutput：没有围栏时不误报', function () {
    const r = createMode.parseCreateOutput('先问一句：你想改哪个页面？');
    assert.strictEqual(r.found, false);
    assert.strictEqual(r.artifact, null);
  });
  await ok('validateArtifact：ui-page 正常通过并补 manifest', function () {
    const v = createMode.validateArtifact({
      kind: 'ui-page', page: 'home', id: 'my-home', name: '我的首页',
      files: { 'index.js': 'export default { setup() { return () => null; } };' }
    });
    assert.strictEqual(v.page, 'home');
    assert.strictEqual(v.manifest.id, 'my-home');
    assert.strictEqual(v.manifest.page, 'home');
    assert.ok(v.manifest.apiVersion);
  });
  await ok('validateArtifact：page 不在白名单 / id 不合法 → 拒绝', function () {
    assert.throws(function () { createMode.validateArtifact({ kind: 'ui-page', page: 'nope', id: 'x1', files: { 'index.js': 'export default {}' } }); }, /page/);
    assert.throws(function () { createMode.validateArtifact({ kind: 'skin', id: 'Bad_ID', files: { 'skin.css': '' } }); }, /id 不合法/);
  });
  await ok('validateArtifact：联网 / eval / 子进程 → 拒绝', function () {
    const mk = function (js) { return createMode.validateArtifact({ kind: 'ui-page', page: 'home', id: 'evil-page', files: { 'index.js': js } }); };
    assert.throws(function () { mk('export default {}; fetch("https://evil.example/x");'); }, /fetch 外部地址/);
    assert.throws(function () { mk('export default {}; eval("1+1");'); }, /eval/);
    assert.throws(function () { mk('export default {}; const cp = require("child_process");'); }, /子进程/);
  });
  await ok('validateArtifact：语法错误 → 拒绝', function () {
    assert.throws(function () { createMode.validateArtifact({ kind: 'ui-page', page: 'home', id: 'bad-syntax', files: { 'index.js': 'export default { setup( {' } }); }, /语法/);
  });
  await ok('validateArtifact：skin 拦截外部 @import', function () {
    assert.throws(function () { createMode.validateArtifact({ kind: 'skin', id: 'bad-skin', files: { 'skin.css': '@import url("https://x/y.css");' } }); }, /@import/);
  });

  console.log('\n== 创造模式：HTTP e2e（沙箱实例） ==');
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sx-create-test-'));
  const port = await freePort();
  let log = '';
  const child = spawn(process.execPath, ['--no-warnings', '--experimental-sqlite', path.join(BASE, 'server', 'server.js')], {
    cwd: BASE,
    env: Object.assign({}, process.env, { NO_OPEN: '1', PORT: String(port), SIERXING_DATA_DIR: dataDir, SIERXING_CREATE_DEBUG: '1' }),
    stdio: ['ignore', 'pipe', 'pipe']
  });
  child.stdout.on('data', function (d) { log += d; });
  child.stderr.on('data', function (d) { log += d; });
  try {
    await waitHealth(port);
    let uiId = '', skinId = '', compId = '';
    let uiChange = '', skinChange = '', compChange = '';

    await ok('GET /api/create/meta 返回页面表 + 限额', async function () {
      const r = await req(port, 'GET', '/api/create/meta');
      assert.strictEqual(r.status, 200);
      assert.strictEqual(r.json.apiVersion, 'sierxing.create/1');
      assert.ok(r.json.pages.home && r.json.pages.components);
    });
    await ok('ui-page：暂存 → 读回 → 未确认拒绝安装', async function () {
      uiId = 'test-home-' + Date.now().toString(36);
      const st = await req(port, 'POST', '/api/create/stage', { artifact: {
        kind: 'ui-page', page: 'home', id: uiId, name: '测试首页', summary: 'e2e',
        files: { 'index.js': "export default {\n  setup() {\n    const { h } = window.SiErXingUI.vue;\n    return () => h('div', { class: 'page' }, 'hello-create');\n  }\n};\n" }
      } });
      assert.strictEqual(st.status, 200, st.text);
      assert.strictEqual(st.json.create.kind, 'ui-page');
      assert.strictEqual(st.json.create.route, '#/');
      uiChange = st.json.create.changeId;
      const get = await req(port, 'GET', '/api/create/changes/' + uiChange);
      assert.strictEqual(get.status, 200);
      const manifestFile = get.json.change.files.find(function (f) { return f.name === 'manifest.json'; });
      assert.ok(manifestFile && JSON.parse(manifestFile.code).page === 'home');
      const bad = await req(port, 'POST', '/api/create/changes/' + uiChange + '/install', {});
      assert.strictEqual(bad.status, 400);
      assert.ok(!fs.existsSync(path.join(dataDir, 'ui-plugins', uiId)));
    });
    await ok('ui-page：确认安装 → 落盘 + 注册表可见 + 入口可读', async function () {
      const r = await req(port, 'POST', '/api/create/changes/' + uiChange + '/install', { confirm: true });
      assert.strictEqual(r.status, 200, r.text);
      assert.strictEqual(r.json.ok, true);
      assert.strictEqual(r.json.kind, 'ui-page');
      assert.ok(fs.existsSync(path.join(dataDir, 'ui-plugins', uiId, 'index.js')));
      const manifest = JSON.parse(readFileSafe(path.join(dataDir, 'ui-plugins', uiId, 'manifest.json')));
      assert.strictEqual(manifest.page, 'home');
      const list = await req(port, 'GET', '/api/ui/plugins');
      const mine = (list.json.plugins || []).find(function (p) { return p.id === uiId; });
      assert.ok(mine && mine.source === 'user' && mine.enabled !== false);
      const entry = await req(port, 'GET', '/api/ui/plugins/' + uiId + '/entry');
      assert.strictEqual(entry.status, 200);
      assert.ok(entry.text.indexOf('hello-create') >= 0);
    });
    await ok('ui-page：再次安装同一 change 被拒（409）', async function () {
      const r = await req(port, 'POST', '/api/create/changes/' + uiChange + '/install', { confirm: true });
      assert.strictEqual(r.status, 409);
    });
    await ok('skin：安装 → /api/ui/skin.css 出现变量 → 回滚删除', async function () {
      skinId = 'test-skin-' + Date.now().toString(36);
      const st = await req(port, 'POST', '/api/create/stage', { artifact: {
        kind: 'skin', id: skinId, name: '测试皮肤', summary: 'e2e',
        files: { 'skin.css': ':root { --test-card-radius: 21px; }\n.page { letter-spacing: .3px; }' }
      } });
      assert.strictEqual(st.status, 200, st.text);
      skinChange = st.json.create.changeId;
      let css = await req(port, 'GET', '/api/ui/skin.css');
      assert.ok(css.text.indexOf('--test-card-radius') < 0);
      const ins = await req(port, 'POST', '/api/create/changes/' + skinChange + '/install', { confirm: true });
      assert.strictEqual(ins.status, 200, ins.text);
      css = await req(port, 'GET', '/api/ui/skin.css');
      assert.ok(css.text.indexOf('--test-card-radius') >= 0);
      const rb = await req(port, 'POST', '/api/create/changes/' + skinChange + '/rollback');
      assert.strictEqual(rb.status, 200, rb.text);
      assert.ok(!fs.existsSync(path.join(dataDir, 'ui-plugins', skinId)));
      css = await req(port, 'GET', '/api/ui/skin.css');
      assert.ok(css.text.indexOf('--test-card-radius') < 0);
    });
    await ok('ui-page：回滚 → 用户插件目录删除 + 注册表列表移除', async function () {
      const rb = await req(port, 'POST', '/api/create/changes/' + uiChange + '/rollback');
      assert.strictEqual(rb.status, 200, rb.text);
      assert.ok(!fs.existsSync(path.join(dataDir, 'ui-plugins', uiId)));
      const list = await req(port, 'GET', '/api/ui/plugins');
      assert.ok(!(list.json.plugins || []).some(function (p) { return p.id === uiId; }));
    });
    await ok('component：安装 → 数据目录落盘 + /plugins 路由 + 组件列表 → 覆盖更新 → 回滚', async function () {
      compId = 'test-tool-' + Date.now().toString(36);
      const mkArt = function (title) {
        return {
          kind: 'component', id: compId, name: title, summary: 'e2e', icon: '🧪', category: '其它',
          files: {
            'server.js': 'module.exports = { id: "' + compId + '", name: "' + title + '", icon: "🧪", desc: "e2e", category: "其它", client: "/plugins/' + compId + '.js", defaultEnabled: false, init: function (ctx) {} };\n',
            'client.js': 'SiErXing.registerPlugin({ id: "' + compId + '", goalEntry: { label: "' + title + '", icon: "🧪", hash: function (gid) { return "#/g/" + gid + "/' + compId + '"; } } });\n'
          }
        };
      };
      const st = await req(port, 'POST', '/api/create/stage', { artifact: mkArt('测试组件') });
      assert.strictEqual(st.status, 200, st.text);
      compChange = st.json.create.changeId;
      const ins = await req(port, 'POST', '/api/create/changes/' + compChange + '/install', { confirm: true });
      assert.strictEqual(ins.status, 200, ins.text);
      assert.ok(fs.existsSync(path.join(dataDir, 'plugins', compId + '.js')));
      assert.ok(fs.existsSync(path.join(dataDir, 'plugins-client', compId + '.js')));
      const served = await req(port, 'GET', '/plugins/' + compId + '.js');
      assert.strictEqual(served.status, 200);
      assert.ok(served.text.indexOf(compId) >= 0);
      let comps = await req(port, 'GET', '/api/components');
      let mine = (comps.json.components || []).find(function (c) { return c.id === compId; });
      assert.ok(mine, '组件列表里应有新组件');
      assert.strictEqual(mine.builtin, false);
      assert.strictEqual(mine.removable, true);

      /* 同名再生成 = 更新（用户组件允许覆盖自己） */
      const st2 = await req(port, 'POST', '/api/create/stage', { artifact: mkArt('测试组件2') });
      assert.strictEqual(st2.status, 200, st2.text);
      const ins2 = await req(port, 'POST', '/api/create/changes/' + st2.json.create.changeId + '/install', { confirm: true });
      assert.strictEqual(ins2.status, 200, ins2.text);
      const served2 = await req(port, 'GET', '/plugins/' + compId + '.js');
      assert.ok(served2.text.indexOf('测试组件2') >= 0);

      const rb = await req(port, 'POST', '/api/create/changes/' + st2.json.create.changeId + '/rollback');
      assert.strictEqual(rb.status, 200, rb.text);
      /* 回滚到上一版（不是删光）：旧代码回来了 */
      const servedBack = await req(port, 'GET', '/plugins/' + compId + '.js');
      assert.ok(servedBack.text.indexOf('测试组件') >= 0 && servedBack.text.indexOf('测试组件2') < 0);
      /* 再把最初那版回滚掉 = 删光 */
      const rb1 = await req(port, 'POST', '/api/create/changes/' + compChange + '/rollback');
      assert.strictEqual(rb1.status, 200, rb1.text);
      assert.ok(!fs.existsSync(path.join(dataDir, 'plugins', compId + '.js')));
      comps = await req(port, 'GET', '/api/components');
      assert.ok(!(comps.json.components || []).some(function (c) { return c.id === compId; }));
    });
    await ok('component：不能占用内置组件 id', async function () {
      const r = await req(port, 'POST', '/api/create/stage', { artifact: {
        kind: 'component', id: 'conditions', name: '冒名', files: {
          'server.js': 'module.exports = { id: "conditions", name: "x" };',
          'client.js': 'SiErXing.registerPlugin({ id: "conditions" });'
        }
      } });
      assert.strictEqual(r.status, 400);
      assert.ok(/同名|内置/.test(r.text));
    });
    await ok('discard：放弃后暂存记录读不到', async function () {
      const st = await req(port, 'POST', '/api/create/stage', { artifact: { kind: 'skin', id: 'test-discard-' + Date.now().toString(36), name: '放弃', files: { 'skin.css': '.x{}' } } });
      assert.strictEqual(st.status, 200, st.text);
      const cid = st.json.create.changeId;
      const d = await req(port, 'POST', '/api/create/changes/' + cid + '/discard');
      assert.strictEqual(d.status, 200, d.text);
      const get = await req(port, 'GET', '/api/create/changes/' + cid);
      assert.strictEqual(get.status, 404);
    });
    await ok('不存在 / 非法请求：404 / 400（不是 500）', async function () {
      assert.strictEqual((await req(port, 'GET', '/api/create/changes/chg_nope')).status, 404);
      const bad = await req(port, 'POST', '/api/create/stage', { artifact: { kind: 'ui-page', page: 'home', id: 'x', files: { 'index.js': 'export default {}' } } });
      assert.strictEqual(bad.status, 400);
      const wrongMethod = await req(port, 'PUT', '/api/create/changes/' + skinChange);
      assert.strictEqual(wrongMethod.status, 405);
    });
  } finally {
    try { child.kill('SIGKILL'); } catch (e) {}
    await new Promise(function (r) { setTimeout(r, 300); });
    try { fs.rmSync(dataDir, { recursive: true, force: true }); } catch (e) {}
    if (process.exitCode) console.error('\n--- 服务日志 ---\n' + log.slice(-4000));
  }
  console.log('\n全部通过：' + passed + ' 项');
})().catch(function (e) {
  console.error('\n失败：' + ((e && e.stack) || e));
  process.exit(1);
});
