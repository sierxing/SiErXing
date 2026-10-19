'use strict';
/**
 * UI 插件注册表回归：node --no-warnings scripts/test-ui-plugins.js
 * 临时目录 + 假插件，不碰真实数据。
 */
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createUiPluginRegistry } = require('../server/ui-plugins.js');

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sx-ui-plugins-'));
const pluginsDir = path.join(root, 'ui-plugins');
fs.mkdirSync(pluginsDir, { recursive: true });
function mk(id, manifest, entry) {
  const d = path.join(pluginsDir, id);
  fs.mkdirSync(d, { recursive: true });
  if (manifest !== null) fs.writeFileSync(path.join(d, 'manifest.json'), typeof manifest === 'string' ? manifest : JSON.stringify(manifest));
  if (entry != null) fs.writeFileSync(path.join(d, entry.name || 'index.js'), entry.body || 'export default {}');
}
mk('demo-card', { id: 'demo-card', name: '演示', apiVersion: 'sierxing.ui/1', entry: 'index.js', version: '1.2.3' }, { name: 'index.js', body: 'export default { name: "demo" };' });
mk('broken-json', '{oops', { name: 'index.js' });
mk('no-manifest', null, { name: 'index.js' });
mk('bad-id', { id: 'Bad ID', entry: 'index.js' }, { name: 'index.js' });
mk('mismatch', { id: 'not-folder', entry: 'index.js' }, { name: 'index.js' });
mk('escape', { id: 'escape', entry: '../outside.js' }, { name: 'index.js' });
fs.writeFileSync(path.join(root, 'outside.js'), 'export default {}');

const reg = createUiPluginRegistry({ dir: pluginsDir });
let n = 0;
function ok(name, cond) { assert.ok(cond, name); console.log('  ✓ ' + name); n++; }

const list = reg.list();
ok('只列出合法插件（坏 JSON/缺 manifest/id 不合法/目录不匹配都跳过）', list.length === 1 && list[0].id === 'demo-card');
ok('manifest 字段规范化', list[0].name === '演示' && list[0].version === '1.2.3' && list[0].apiVersion === 'sierxing.ui/1' && list[0].source === 'user');
ok('get 合法；get 非法 id 返回 null', reg.get('demo-card').id === 'demo-card' && reg.get('Bad ID') === null && reg.get('..') === null);
ok('entryPath 解析到插件目录内', reg.entryPath(reg.get('demo-card')) === fs.realpathSync(path.join(pluginsDir, 'demo-card', 'index.js')));
const entry = reg.readEntry('demo-card');
ok('readEntry 返回入口代码与 JS MIME', entry && entry.contentType.indexOf('application/javascript') === 0 && entry.body.toString().indexOf('name: "demo"') >= 0);
ok('entry 越界（../）不会进 list', list.every(function (m) { return m.id !== 'escape'; }));
ok('不存在的插件读不到入口', reg.readEntry('nope') === null);

fs.rmSync(root, { recursive: true, force: true });
console.log('\n7 项全部通过');
