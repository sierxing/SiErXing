'use strict';
/**
 * 命令总线回归：node scripts/test-commands.js
 *
 * 钉住：register/list/describe/run、write 直接执行、admin 需要审批、
 * 审批匹配/一次性/事件/审计/manifest。
 */
const assert = require('node:assert');
const { createBus, hashInput } = require('../server/commands/bus.js');
let n = 0;
function ok(name, cond, extra) { if (!cond) throw new Error(name + (extra ? ' → ' + extra : '')); console.log('  ✓ ' + name); n++; }

(async function () {
  const store = new Map();
  let auditCount = 0;
  let eventCount = 0;
  const approvals = {
    create: function (a) {
      const id = 'ap_test_' + (store.size + 1);
      store.set(id, { id: id, command: a.command, input: a.input, input_hash: hashInput(a.input), status: 'pending', approveUrl: 'http://x/approve/' + id });
      return { id: id, approveUrl: 'http://x/approve/' + id, expiresAt: '' };
    },
    get: function (id) { return store.get(id) || null; },
    markUsed: function (id) { const a = store.get(id); if (a) a.status = 'used'; }
  };
  const bus = createBus({
    approvals: approvals,
    audit: function () { auditCount++; },
    onEvent: function () { eventCount++; }
  });
  bus.define({
    name: 'demo.read', title: '读演示', category: 'demo', risk: 'read',
    inputSchema: { type: 'object', properties: { x: { type: 'integer' } } },
    handler: function (input) { return { ok: true, x: input.x || 0 }; }
  });
  bus.define({ name: 'demo.write', title: '写演示', category: 'demo', risk: 'write', handler: function () { return { ok: true }; } });
  bus.define({ name: 'demo.admin', title: '管理演示', category: 'demo', risk: 'admin', handler: function () { return { ok: true, admin: true }; } });

  ok('list 返回摘要而不是 handler', (function () {
    const l = bus.list();
    return l.length === 3 && l[0].name && l[0].handler === undefined;
  })());
  ok('list 按 category/risk/query 过滤', (function () {
    return bus.list({ category: 'demo' }).length === 3
      && bus.list({ risk: 'admin' }).length === 1
      && bus.list({ query: '管理' }).length === 1;
  })());
  ok('describe 命中返回 schema，未命中返回 null', (function () {
    const d = bus.describe('demo.read');
    return d && d.inputSchema && bus.describe('nope') === null;
  })());

  const r = await bus.run('demo.read', { x: 7 }, { actor: 'agent:test' });
  ok('read 直接执行', r.ok === true && r.x === 7);

  const w = await bus.run('demo.write', { y: 1 }, { actor: 'agent:test' });
  ok('write 直接执行（不要求审批）', w.ok === true);

  let e = null;
  try { await bus.run('demo.admin', { z: 1 }, { actor: 'agent:test' }); } catch (err) { e = err; }
  ok('admin 无审批 → approval_required + details', e && e.code === 'approval_required' && e.details && e.details.approvalId);
  const approvalId = e.details.approvalId;
  ok('审批创建为 pending', store.get(approvalId).status === 'pending');

  let e2 = null;
  try { await bus.run('demo.admin', { z: 1 }, { actor: 'agent:test', approvalId: approvalId }); } catch (err) { e2 = err; }
  ok('审批未通过时不能执行', e2 && e2.code === 'approval_required');

  store.get(approvalId).status = 'approved';
  const admin = await bus.run('demo.admin', { z: 1 }, { actor: 'agent:test', approvalId: approvalId });
  ok('审批通过后执行成功', admin.ok === true && admin.admin === true);
  ok('审批用后标记 used', store.get(approvalId).status === 'used');

  let e3 = null;
  try { await bus.run('demo.admin', { z: 1 }, { actor: 'agent:test', approvalId: approvalId }); } catch (err) { e3 = err; }
  ok('同一个审批不能复用', e3 && e3.code === 'approval_required');

  const ap2 = approvals.create({ command: 'demo.admin', input: { z: 2 } });
  store.get(ap2.id).status = 'approved';
  let e4 = null;
  try { await bus.run('demo.admin', { z: 999 }, { actor: 'agent:test', approvalId: ap2.id }); } catch (err) { e4 = err; }
  ok('入参不一致 → forbidden', e4 && e4.code === 'forbidden');

  ok('审计与事件都被调用', auditCount >= 3 && eventCount >= 6);
  ok('manifest 带命令清单', (function () {
    const m = bus.manifest({ app: { name: 'X' } });
    return m.app.name === 'X' && m.commands.length === 3;
  })());
  let dup = false;
  try { bus.define({ name: 'demo.read', handler: function () {} }); } catch (err) { dup = true; }
  ok('重复命令名被拒绝', dup);

  console.log('\n' + n + ' 项全部通过');
})().catch(function (err) { console.error('\n✗ ' + (err && err.message)); process.exit(1); });
