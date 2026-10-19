#!/usr/bin/env node
'use strict';
/**
 * 内核分层配置 CLI（P3）
 * ------------------------------------------------------------------
 *   node scripts/kernel-config.js --dump              看最终生效值 + 来源 + 告警
 *   node scripts/kernel-config.js --diff              看本次升级与上次快照的差异
 *   node scripts/kernel-config.js --explain ui.pagePlugins   看某一项每层写了什么
 *   node scripts/kernel-config.js --init              生成 DATA_DIR/config/user.json 模板
 *
 * 数据目录：默认 <程序>/data；可用 SIERXING_DATA_DIR 指向别的实例（测试沙箱）。
 */
const fs = require('node:fs');
const path = require('node:path');
const { createKernelConfig } = require('../server/kernel-config.js');

const APP_DIR = path.join(__dirname, '..');
const DATA_DIR = process.env.SIERXING_DATA_DIR ? path.resolve(process.env.SIERXING_DATA_DIR) : path.join(APP_DIR, 'data');
const SCHEMA = path.join(APP_DIR, 'config', 'kernel.schema.json');

function usage() {
  console.log([
    '用法：node scripts/kernel-config.js [--dump | --diff | --explain <key> | --init]',
    '',
    '  --dump              打印最终配置（含每项来自哪一层、告警、升级差异）',
    '  --diff              只打印升级差异（配置键 / 服务端插件的增删）',
    '  --explain <key>     解释某一项：builtin/profile/user 各写了什么',
    '  --init              生成配置模板 DATA_DIR/config/user.json（已存在则不动）',
    '',
    '数据目录：' + DATA_DIR
  ].join('\n'));
}

function main() {
  const argv = process.argv.slice(2);
  const cmd = argv[0] || '--dump';
  if (cmd === '-h' || cmd === '--help') { usage(); return 0; }

  let cfg;
  try {
    cfg = createKernelConfig({ schemaPath: SCHEMA, dataDir: DATA_DIR, log: (...a) => console.error(...a) });
  } catch (e) {
    console.error('配置加载失败：' + e.message);
    return 1;
  }

  if (cmd === '--init') {
    const dir = path.join(DATA_DIR, 'config');
    const file = path.join(dir, 'user.json');
    if (fs.existsSync(file)) { console.log('已存在，不覆盖：' + file); return 0; }
    fs.mkdirSync(dir, { recursive: true });
    const tpl = {
      '$schema': '../../config/kernel.schema.json',
      'ui': { 'pagePlugins': true, 'userPlugins': true, 'skins': true },
      'kernel': { 'logLevel': 'normal', 'strictConfig': false }
    };
    fs.writeFileSync(file, JSON.stringify(tpl, null, 2) + '\n', 'utf8');
    console.log('已生成配置模板：' + file);
    console.log('改完重启思而行（或在设置里重启服务）生效。');
    return 0;
  }

  if (cmd === '--explain') {
    const key = argv[1];
    if (!key) { console.error('--explain 需要配置项，例如 ui.pagePlugins'); return 1; }
    const e = cfg.explain(key);
    if (!e) { console.error('没有这个配置项：' + key); console.error('可用项：' + Object.keys(cfg.state().values).join(', ')); return 1; }
    console.log(JSON.stringify(e, null, 2));
    return 0;
  }

  /* 升级差异（插件 id 需要由服务端提供；CLI 单跑时用快照里的上次值对比当前 schema 键） */
  cfg.checkUpgrade([]);
  const st = cfg.state();

  if (cmd === '--diff') {
    const u = st.upgrade;
    if (u.firstRun) { console.log('首次运行：还没有升级快照，本次启动会写入。'); return 0; }
    console.log('上次快照时间：' + (u.at || '（未知）'));
    console.log('新增配置键：' + (u.addedKeys.length ? u.addedKeys.join(', ') : '（无）'));
    console.log('移除配置键：' + (u.removedKeys.length ? u.removedKeys.join(', ') : '（无）'));
    console.log('新增服务端插件：' + (u.addedPlugins.length ? u.addedPlugins.join(', ') : '（无）'));
    console.log('移除服务端插件：' + (u.removedPlugins.length ? u.removedPlugins.join(', ') : '（无）'));
    if (u.orphanUserKeys.length) {
      console.log('用户配置里已失效的项：' + u.orphanUserKeys.map(o => o.layer + ':' + o.key).join(', '));
    }
    return 0;
  }

  if (cmd !== '--dump') { usage(); return 1; }

  console.log('数据目录：' + DATA_DIR);
  console.log('配置生效值（来源）：');
  const vals = st.values;
  for (const key of Object.keys(vals).sort()) {
    console.log('  ' + key + ' = ' + JSON.stringify(vals[key]) + '   ← ' + (st.provenance[key] || 'builtin'));
  }
  if (st.warnings.length) {
    console.log('\n告警 ' + st.warnings.length + ' 条：');
    for (const w of st.warnings) console.log('  [' + w.level + '] ' + (w.layer || '') + ' ' + (w.key || '') + ' ' + w.message);
  } else {
    console.log('\n没有告警。');
  }
  const u = st.upgrade;
  if (!u.firstRun) {
    const bits = [];
    if (u.addedKeys.length) bits.push('新增配置键 ' + u.addedKeys.length);
    if (u.removedKeys.length) bits.push('移除配置键 ' + u.removedKeys.length);
    if (u.addedPlugins.length) bits.push('新增插件 ' + u.addedPlugins.length);
    if (u.removedPlugins.length) bits.push('移除插件 ' + u.removedPlugins.length);
    console.log('\n升级差异：' + (bits.length ? bits.join('，') : '与上次一致') + '（用 --diff 看明细）');
  }
  return 0;
}

process.exit(main());
