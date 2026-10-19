#!/usr/bin/env node
'use strict';
/**
 * 内核回归（P0）：node scripts/test-kernel.js
 * 可选迁移用例：node --no-warnings --experimental-sqlite scripts/test-kernel.js
 *
 * 只测纯内存逻辑，不碰真实数据、不起服务。
 */
const assert = require('node:assert');
const { createKernel, KERNEL_API, apiMajor } = require('../server/kernel.js');

let pass = 0, fail = 0;
function ok(name, fn) {
  try { fn(); pass++; console.log('  ✓ ' + name); }
  catch (e) { fail++; console.log('  ✗ ' + name + '\n      ' + (e && e.message)); }
}
function section(t) { console.log('\n' + t); }

/* 1. 服务原语 */
section('服务（provide / get / has / require）');
ok('注册后能取到', () => {
  const k = createKernel();
  k.provide('db', { name: 'db' });
  assert.equal(k.get('db').name, 'db');
  assert.equal(k.has('db'), true);
  assert.deepEqual(k.services(), ['db']);
});
ok('重复注册抛错（不允许静默覆盖）', () => {
  const k = createKernel();
  k.provide('db', {});
  assert.throws(() => k.provide('db', {}), /重复注册/);
});
ok('缺服务时 require 抛错，get 返回 undefined', () => {
  const k = createKernel();
  assert.equal(k.get('nope'), undefined);
  assert.throws(() => k.require('nope'), /缺少服务/);
});
ok('取消注册后消失', () => {
  const k = createKernel();
  const off = k.provide('x', 1);
  off();
  assert.equal(k.has('x'), false);
});

/* 2. 插件装载 / 依赖 */
section('插件（依赖优先 / 缺依赖跳过 / 失败隔离）');
ok('按 requires 做依赖优先排序（与注册顺序无关）', () => {
  const k = createKernel();
  const order = [];
  k.loadPlugins([
    { id: 'b', requires: ['a'], apply: () => order.push('b') },
    { id: 'a', apply: () => order.push('a') }
  ]);
  assert.deepEqual(order, ['a', 'b']);
  assert.equal(k.state().plugins.find(p => p.id === 'b').status, 'loaded');
});
ok('缺依赖 → skipped 并给出原因，其它插件照常装载', () => {
  const k = createKernel();
  k.loadPlugins([
    { id: 'need', requires: ['db'], apply: () => { throw new Error('不该执行'); } },
    { id: 'free', apply: () => {} }
  ]);
  const st = k.state();
  assert.equal(st.plugins.find(p => p.id === 'need').status, 'skipped');
  assert.match(st.plugins.find(p => p.id === 'need').reason, /缺少依赖：db/);
  assert.equal(st.plugins.find(p => p.id === 'free').status, 'loaded');
});
ok('插件 provides 的能力可以被后续插件 requires', () => {
  const k = createKernel();
  const seen = [];
  k.loadPlugins([
    { id: 'consumer', requires: ['cap'], apply: () => seen.push('consumer') },
    { id: 'provider', provides: ['cap'], apply: () => seen.push('provider') }
  ]);
  assert.deepEqual(seen, ['provider', 'consumer']);
});
ok('apply 抛错 → failed，但不影响其它插件', () => {
  const k = createKernel();
  const logs = [];
  k.loadPlugins([
    { id: 'boom', apply: () => { throw new Error('炸了'); } },
    { id: 'fine', apply: () => {} }
  ], null);
  assert.equal(k.state().plugins.find(p => p.id === 'boom').status, 'failed');
  assert.match(k.state().plugins.find(p => p.id === 'boom').reason, /炸了/);
  assert.equal(k.state().plugins.find(p => p.id === 'fine').status, 'loaded');
});
ok('apiVersion 主版本不同 → incompatible 且不执行', () => {
  const k = createKernel();
  let ran = false;
  k.loadPlugins([{ id: 'old', apiVersion: 'sierxing.kernel/0', apply: () => { ran = true; } }]);
  assert.equal(ran, false);
  assert.equal(k.state().plugins.find(p => p.id === 'old').status, 'incompatible');
});
ok('apiVersion 相同 → 正常装载', () => {
  const k = createKernel();
  let ran = false;
  k.loadPlugins([{ id: 'new', apiVersion: KERNEL_API, apply: () => { ran = true; } }]);
  assert.equal(ran, true);
});
ok('非法 id 与缺 apply 的插件被忽略，不抛错', () => {
  const k = createKernel();
  k.loadPlugins([
    { id: 'Bad ID', apply: () => {} },
    { id: 'noapply' },
    null
  ]);
  assert.equal(k.state().plugins.length, 0);
});
ok('兼容 init(ctx) 老契约', () => {
  const k = createKernel();
  k.provide('db', { v: 1 });
  let got = null;
  k.loadPlugins([{ id: 'legacy', init: (ctx) => { got = ctx.db.v; } }]);
  assert.equal(got, 1);
  assert.equal(k.state().plugins[0].status, 'loaded');
});

/* 3. 生命周期 */
section('生命周期（effect / unload / reload / dispose）');
ok('effect 清理函数在 dispose 时逆序执行', () => {
  const k = createKernel();
  const out = [];
  k.loadPlugins([{
    id: 'p', apply: (ctx) => {
      ctx.effect(() => { out.push('a'); return () => out.push('a-clean'); });
      ctx.effect(() => { out.push('b'); return () => out.push('b-clean'); });
    }
  }]);
  assert.deepEqual(out, ['a', 'b']);
  k.dispose();
  assert.deepEqual(out, ['a', 'b', 'b-clean', 'a-clean']);
});
ok('unload 只清理该插件，服务与其它插件不受影响', () => {
  const k = createKernel();
  k.provide('svc', {});
  const out = [];
  k.loadPlugins([
    { id: 'a', provides: ['cap'], apply: (ctx) => { ctx.effect(() => () => out.push('a-clean')); } },
    { id: 'b', apply: (ctx) => { ctx.effect(() => () => out.push('b-clean')); } }
  ]);
  assert.equal(k.unload('a'), true);
  assert.deepEqual(out, ['a-clean']);
  assert.equal(k.has('svc'), true);
  assert.deepEqual(k.state().plugins.map(p => p.id), ['b']);
});
ok('reload 会先清理再全量重装（不会重复注册服务）', () => {
  const k = createKernel();
  let n = 0, clean = 0;
  const defs = [{
    id: 'p', apply: (ctx) => {
      n++;
      ctx.effect(() => () => clean++);
    }
  }];
  k.loadPlugins(defs);
  k.reload(defs);
  assert.equal(n, 2);
  assert.equal(clean, 1);
  assert.equal(k.state().plugins.length, 1);
});
ok('dispose 后内核不可再用', () => {
  const k = createKernel();
  k.dispose();
  assert.throws(() => k.provide('x', 1), /已卸载/);
});

/* 4. 事件 */
section('事件');
ok('on / emit / 取消订阅', () => {
  const k = createKernel();
  const got = [];
  const off = k.on('ping', (p) => got.push(p.n));
  k.emit('ping', { n: 1 });
  off();
  k.emit('ping', { n: 2 });
  assert.deepEqual(got, [1]);
});
ok('事件回调抛错不会拖垮内核', () => {
  const k = createKernel();
  k.on('x', () => { throw new Error('bad'); });
  assert.doesNotThrow(() => k.emit('x', {}));
});

/* 5. 迁移（可选，需要 node:sqlite） */
section('插件自带迁移（需要 --experimental-sqlite）');
let sqlite = null;
try { sqlite = require('node:sqlite'); } catch (e) { sqlite = null; }
if (!sqlite) {
  console.log('  - 跳过（当前 Node 不支持 node:sqlite，或不带 --experimental-sqlite）');
} else {
  function freshDb() {
    const db = new sqlite.DatabaseSync(':memory:');
    return db;
  }
  ok('迁移按版本号升序执行，记录在 kernel_migrations', () => {
    const k = createKernel();
    const db = freshDb();
    k.provide('db', db);
    const ran = [];
    k.loadPlugins([{
      id: 'm',
      migrations: [
        { version: 2, up: (c) => { ran.push(2); c.db.exec('ALTER TABLE t ADD COLUMN b TEXT DEFAULT ""'); } },
        { version: 1, up: (c) => { ran.push(1); c.db.exec('CREATE TABLE t (a TEXT)'); } }
      ],
      apply: () => {}
    }]);
    assert.deepEqual(ran, [1, 2]);
    const rows = db.prepare('SELECT version FROM kernel_migrations ORDER BY version').all();
    assert.deepEqual(rows.map(r => r.version), [1, 2]);
  });
  ok('重复执行迁移是幂等的（重载 / 重启不会重复加列）', () => {
    const k = createKernel();
    const db = freshDb();
    k.provide('db', db);
    const ran = [];
    const defs = [{
      id: 'm',
      migrations: [{ version: 1, up: (c) => { ran.push(1); c.db.exec('CREATE TABLE t (a TEXT)'); } }],
      apply: () => {}
    }];
    k.loadPlugins(defs);
    k.reload(defs);
    assert.deepEqual(ran, [1]);
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM kernel_migrations').get().n, 1);
  });
}

/* 6. 状态快照 */
section('自检快照 state()');
ok('包含服务与插件状态，可序列化', () => {
  const k = createKernel();
  k.provide('db', {});
  k.loadPlugins([
    { id: 'a', builtin: true, provides: ['cap'], apply: () => {} },
    { id: 'b', requires: ['nope'], apply: () => {} }
  ]);
  const st = k.state();
  assert.equal(st.apiVersion, KERNEL_API);
  assert.ok(Array.isArray(st.services));
  assert.deepEqual(st.plugins.map(p => p.id), ['a', 'b']);
  assert.equal(JSON.parse(JSON.stringify(st)).plugins.length, 2);
});
ok('apiMajor 解析', () => {
  assert.equal(apiMajor('sierxing.kernel/1'), 1);
  assert.equal(apiMajor('2'), 2);
  assert.equal(apiMajor(''), null);
});

console.log('\n结果：' + pass + ' 通过 / ' + fail + ' 失败');
process.exit(fail ? 1 : 0);
