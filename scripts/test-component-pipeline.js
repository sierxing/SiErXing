'use strict';
/**
 * 组件包校验回归：node scripts/test-component-pipeline.js
 * 纯函数，不写文件、不碰真实数据。
 */
const assert = require('node:assert');
const { validateBundle, LIMITS } = require('../server/component-pipeline.js');

let n = 0;
function ok(name, cond, extra) { assert.ok(cond, name + (extra ? ' -> ' + extra : '')); console.log('  ✓ ' + name); n++; }
function throws(fn, code, match) {
  try { fn(); } catch (e) { return e.code === code && (!match || e.message.indexOf(match) >= 0); }
  return false;
}
const server = 'module.exports = { id: "demo-plugin", name: "演示", init: function () {} };';
const base = { format: 'sierxing-component', id: 'demo-plugin', name: '演示组件', server: server };

const s = validateBundle(base, { builtinIds: ['plan'] });
ok('合法组件通过并返回 summary', s.id === 'demo-plugin' && s.sizes.server === server.length && /^[0-9a-f]{16}$/.test(s.hash));
ok('内置 id 被拒绝', throws(function () { validateBundle(Object.assign({}, base, { id: 'plan', server: server.replace('demo-plugin', 'plan') }), { builtinIds: ['plan'] }); }, 'bad_input', '内置'));
ok('非法 id 被拒绝', throws(function () { validateBundle(Object.assign({}, base, { id: 'Bad Id!' })); }, 'bad_input', 'id'));
ok('缺少 module.exports 被拒绝', throws(function () { validateBundle(Object.assign({}, base, { server: 'var x = 1;' })); }, 'bad_input', 'module.exports'));
ok('服务端语法错误被拒绝', throws(function () { validateBundle(Object.assign({}, base, { server: 'module.exports = {\n  id: "demo-plugin",\n  init: function () {\n' })); }, 'bad_input', '语法错误'));
ok('前端语法错误被拒绝', throws(function () { validateBundle(Object.assign({}, base, { client: 'SiErXing.registerPlugin({' })); }, 'bad_input', '前端'));
ok('超大服务端代码被拒绝', throws(function () { validateBundle(Object.assign({}, base, { server: 'module.exports = {}; // ' + 'x'.repeat(LIMITS.server) })); }, 'bad_input', '太大'));
const h1 = validateBundle(base).hash;
const h2 = validateBundle(Object.assign({}, base, { style: '.demo{color:red}' })).hash;
ok('内容哈希随文件变化', h1 !== h2);

console.log('\n8 项全部通过');
