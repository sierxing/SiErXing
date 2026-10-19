#!/usr/bin/env node
'use strict';
/**
 * 分层配置回归（P3）：node --no-warnings scripts/test-kernel-config.js
 * 纯文件 + 纯内存，不起服务、不碰真实数据。
 */
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createKernelConfig } = require('../server/kernel-config.js');

let pass = 0, fail = 0;
function ok(name, fn) {
  try { fn(); pass++; console.log('  ✓ ' + name); }
  catch (e) { fail++; console.log('  ✗ ' + name + '\n      ' + (e && e.message)); }
}
function section(t) { console.log('\n' + t); }

const ROOT = path.join(__dirname, '..');
const SCHEMA = path.join(ROOT, 'config', 'kernel.schema.json');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sx-cfg-'));
let seq = 0;
function fresh() {
  const dir = path.join(tmp, 'd' + (++seq));
  fs.mkdirSync(path.join(dir, 'config'), { recursive: true });
  return dir;
}
function writeJson(file, obj) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(obj, null, 2), 'utf8');
}
function cfgFor(dir, extra) {
  return createKernelConfig(Object.assign({ schemaPath: SCHEMA, dataDir: dir }, extra || {}));
}

section('内置默认值');
ok('没有配置文件时全部取 schema 默认', () => {
  const c = cfgFor(fresh());
  assert.equal(c.get('ui.pagePlugins'), true);
  assert.equal(c.get('ui.userPlugins'), true);
  assert.equal(c.get('kernel.logLevel'), 'normal');
  assert.deepEqual(c.warnings(), []);
});

section('分层覆盖（profile < user）');
ok('user 覆盖内置，并记录来源', () => {
  const dir = fresh();
  writeJson(path.join(dir, 'config', 'user.json'), { ui: { pagePlugins: false } });
  const c = cfgFor(dir);
  assert.equal(c.get('ui.pagePlugins'), false);
  assert.equal(c.state().provenance['ui.pagePlugins'], 'user');
  assert.equal(c.get('ui.skins'), true);
});
ok('profile 覆盖内置、user 再覆盖 profile', () => {
  const dir = fresh();
  writeJson(path.join(dir, 'config', 'profile.json'), { ui: { pagePlugins: false, skins: false } });
  writeJson(path.join(dir, 'config', 'user.json'), { ui: { skins: true } });
  const c = cfgFor(dir);
  assert.equal(c.get('ui.pagePlugins'), false);
  assert.equal(c.get('ui.skins'), true);
  assert.equal(c.state().provenance['ui.pagePlugins'], 'profile');
  assert.equal(c.state().provenance['ui.skins'], 'user');
});
ok('支持扁平的 "ui.pagePlugins" 写法', () => {
  const dir = fresh();
  writeJson(path.join(dir, 'config', 'user.json'), { 'ui.pagePlugins': false });
  assert.equal(cfgFor(dir).get('ui.pagePlugins'), false);
});
ok('写 null = 恢复内置默认（而不是删不掉）', () => {
  const dir = fresh();
  writeJson(path.join(dir, 'config', 'profile.json'), { ui: { pagePlugins: false } });
  writeJson(path.join(dir, 'config', 'user.json'), { ui: { pagePlugins: null } });
  const c = cfgFor(dir);
  assert.equal(c.get('ui.pagePlugins'), true);
  assert.equal(c.state().provenance['ui.pagePlugins'], 'builtin');
});

section('容错（升级不崩的关键）');
ok('未知键只告警、被忽略，其它值照常生效', () => {
  const dir = fresh();
  writeJson(path.join(dir, 'config', 'user.json'), { ui: { pagePlugins: false, removedInV2: true } });
  const c = cfgFor(dir);
  assert.equal(c.get('ui.pagePlugins'), false);
  const w = c.warnings().find(x => x.key === 'ui.removedInV2');
  assert.ok(w && /已不存在/.test(w.message));
  assert.deepEqual(c.upgrade().orphanUserKeys, [{ layer: 'user', key: 'ui.removedInV2' }]);
});
ok('类型不对只告警、忽略该值', () => {
  const dir = fresh();
  writeJson(path.join(dir, 'config', 'user.json'), { ui: { pagePlugins: 'yes' } });
  const c = cfgFor(dir);
  assert.equal(c.get('ui.pagePlugins'), true);
  assert.ok(c.warnings().some(w => /类型不对/.test(w.message)));
});
ok('枚举值不合法只告警、忽略', () => {
  const dir = fresh();
  writeJson(path.join(dir, 'config', 'user.json'), { kernel: { logLevel: 'loud' } });
  const c = cfgFor(dir);
  assert.equal(c.get('kernel.logLevel'), 'normal');
  assert.ok(c.warnings().some(w => /允许范围/.test(w.message)));
});
ok('坏 JSON 文件：记录错误、继续用默认值（不让整站起不来）', () => {
  const dir = fresh();
  fs.writeFileSync(path.join(dir, 'config', 'user.json'), '{ 这不是 JSON', 'utf8');
  const c = cfgFor(dir);
  assert.equal(c.get('ui.pagePlugins'), true);
  assert.ok(c.warnings().some(w => w.level === 'error' && /解析失败/.test(w.message)));
});
ok('strictConfig=true 时坏配置会抛错（显式要求严格才拦）', () => {
  const dir = fresh();
  writeJson(path.join(dir, 'config', 'user.json'), { kernel: { strictConfig: true } });
  fs.writeFileSync(path.join(dir, 'config', 'profile.json'), '{ bad', 'utf8');
  assert.throws(() => cfgFor(dir), /配置校验失败/);
});

section('升级差异（键 / 插件 / 孤儿配置）');
ok('首次启动标记 firstRun 并写快照', () => {
  const dir = fresh();
  const c = cfgFor(dir);
  assert.equal(c.upgrade().firstRun, true);
  assert.equal(c.writeSnapshot(['a', 'b']), true);
  const snap = JSON.parse(fs.readFileSync(path.join(dir, 'kernel', 'builtin-snapshot.json'), 'utf8'));
  assert.deepEqual(snap.plugins, ['a', 'b']);
  assert.ok(snap.keys.includes('ui.pagePlugins'));
});
ok('第二次启动：插件增删能被识别出来', () => {
  const dir = fresh();
  const c1 = cfgFor(dir);
  c1.checkUpgrade(['a', 'b']);
  c1.writeSnapshot(['a', 'b']);
  const c2 = cfgFor(dir);
  const r = c2.checkUpgrade(['a', 'c']);
  assert.equal(r.upgrade.firstRun, false);
  assert.deepEqual(r.upgrade.addedPlugins, ['c']);
  assert.deepEqual(r.upgrade.removedPlugins, ['b']);
});
ok('新版本删掉配置键：旧用户配置被标成「已移除」并告警', () => {
  const dir = fresh();
  /* 用一份“新版本” schema：删掉 ui.skins */
  const schema2 = JSON.parse(fs.readFileSync(SCHEMA, 'utf8'));
  delete schema2.sections.ui.keys.skins;
  const schema2Path = path.join(dir, 'schema-v2.json');
  writeJson(schema2Path, schema2);
  /* 旧用户配置里还写着 ui.skins */
  writeJson(path.join(dir, 'config', 'user.json'), { ui: { skins: false } });
  const c = createKernelConfig({ schemaPath: schema2Path, dataDir: dir });
  assert.equal(c.get('ui.skins'), undefined);
  assert.ok(c.upgrade().orphanUserKeys.some(o => o.key === 'ui.skins'));
  assert.ok(c.warnings().some(w => w.key === 'ui.skins'));
  /* 服务端启动时会调用 checkUpgrade()：孤儿键信息不能被升级差异覆盖掉 */
  c.checkUpgrade(['x']);
  assert.ok(c.upgrade().orphanUserKeys.some(o => o.key === 'ui.skins'));
  assert.ok(c.warnings().some(w => w.key === 'ui.skins'));
});

section('其它');
ok('explain 能看到每层写了什么', () => {
  const dir = fresh();
  writeJson(path.join(dir, 'config', 'profile.json'), { ui: { pagePlugins: false } });
  writeJson(path.join(dir, 'config', 'user.json'), { ui: { pagePlugins: true } });
  const c = cfgFor(dir);
  const e = c.explain('ui.pagePlugins');
  assert.equal(e.from, 'user');
  assert.deepEqual(e.layers.map(l => l.layer), ['builtin', 'profile', 'user']);
  assert.deepEqual(e.layers.map(l => l.value), [true, false, true]);
});
ok('reload 能读到新写入的配置', () => {
  const dir = fresh();
  const c = cfgFor(dir);
  assert.equal(c.get('ui.pagePlugins'), true);
  writeJson(path.join(dir, 'config', 'user.json'), { ui: { pagePlugins: false } });
  c.load();
  assert.equal(c.get('ui.pagePlugins'), false);
});
ok('数组值整组替换（不合并）', () => {
  const dir = fresh();
  const schema3 = { schemaVersion: 1, sections: { test: { keys: { list: { type: 'array', default: [1, 2, 3] } } } } };
  const p = path.join(dir, 'schema3.json');
  writeJson(p, schema3);
  writeJson(path.join(dir, 'config', 'user.json'), { test: { list: [9] } });
  const c = createKernelConfig({ schemaPath: p, dataDir: dir });
  assert.deepEqual(c.get('test.list'), [9]);
});

fs.rmSync(tmp, { recursive: true, force: true });
console.log('\n结果：' + pass + ' 通过 / ' + fail + ' 失败');
process.exit(fail ? 1 : 0);
