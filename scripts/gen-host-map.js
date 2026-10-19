#!/usr/bin/env node
'use strict';
/**
 * 生成 app.js 的「插件 host 依赖表」：把真实的顶层声明暴露给插件。
 *
 * 三条设计约束（都是踩坑换来的）：
 *   ① 必须复用 build-page-plugin 的**字面扫描**索引：行首正则会把模板字符串里的
 *      示例代码当顶层声明（真实踩到 'const card = ...' → host 表里多一个不存在的
 *      名字 → 每次插件渲染 ReferenceError: card is not defined）。
 *   ② 必须**惰性构建**：对象字面量里引用 const/let 会踩定义顺序上的 TDZ。
 *   ③ let/var 必须用 getter/setter：设置页会写 AI_PROVIDERS / AI_AGENTS 这类全局
 *      变量，插件里 H.AI_PROVIDERS = x 要能真正写回原版全局（否则别处读到旧值）。
 *      const / function 用普通属性即可。
 *
 * 用法：node scripts/gen-host-map.js
 */
const fs = require('node:fs');
const path = require('node:path');
const { buildIndex } = require('./build-page-plugin.js');

const APP = path.join(path.resolve(__dirname, '..'), 'public', 'app.js');
const text = fs.readFileSync(APP, 'utf8');
const decls = buildIndex(text);

const EXCLUDE = new Set([
  '_sxPageHostMap', 'sxPageHostMap', 'pagePluginHost', 'renderPagePlugin',
  'pagePluginEnabled', 'PAGE_PLUGINS', 'PAGE_PLUGIN_UIKEY', 'pagePluginUnmount',
  'renderRoadmapPlugin'
]);

const plain = [];      /* function / const → 直接取值 */
const mutable = [];    /* let / var → getter/setter */
for (const [name, info] of decls) {
  if (EXCLUDE.has(name)) continue;
  if (info.kind === 'let' || info.kind === 'var') mutable.push(name);
  else plain.push(name);
}
console.log('顶层声明 ' + decls.size + ' 个：直接取值 ' + plain.length + '，可写 ' + mutable.length);
if (mutable.length) console.log('  可写: ' + mutable.join(', '));

const BLOCK_START = '/* <sx-host-map:begin> 自动生成，勿手改（scripts/gen-host-map.js） */';
const BLOCK_END = '/* <sx-host-map:end> */';
const lines = [
  BLOCK_START,
  'let _sxPageHostMap = null;',
  '/**',
  ' * 插件可用的原版依赖表（app.js 真实顶层声明）。首次渲染时惰性构建，避开 TDZ。',
  ' * let/var 用取值器/设值器：插件里 H.AI_PROVIDERS = x 要真正写回原版全局变量。',
  ' */',
  'function sxPageHostMap() {',
  '  if (_sxPageHostMap) return _sxPageHostMap;',
  '  const h = {'
];
/* 每行若干个，避免单行过长 */
for (let i = 0; i < plain.length; i += 8) {
  lines.push('    ' + plain.slice(i, i + 8).join(', ') + (i + 8 < plain.length ? ',' : ''));
}
lines.push('  };');
for (const name of mutable) {
  lines.push('  Object.defineProperty(h, ' + JSON.stringify(name) + ', {');
  lines.push('    get: function () { return ' + name + '; },');
  lines.push('    set: function (v) { ' + name + ' = v; },');
  lines.push('    enumerable: true, configurable: true');
  lines.push('  });');
}
lines.push('  _sxPageHostMap = h;');
lines.push('  return _sxPageHostMap;');
lines.push('}');
lines.push(BLOCK_END);
const block = lines.join('\n');

let src = fs.readFileSync(APP, 'utf8');
const s = src.indexOf(BLOCK_START);
if (s >= 0) {
  const e = src.indexOf(BLOCK_END);
  src = src.slice(0, s) + block + src.slice(e + BLOCK_END.length);
  console.log('已更新 host map 块');
} else {
  const anchor = 'function pagePluginHost(extra) {';
  const idx = src.indexOf(anchor);
  if (idx < 0) { console.error('找不到 pagePluginHost 锚点'); process.exit(1); }
  src = src.slice(0, idx) + block + '\n' + src.slice(idx);
  console.log('已插入 host map 块');
}
fs.writeFileSync(APP, src);
