'use strict';
/**
 * 思而行 · 分层配置（P3）
 * ---------------------------------------------------------------------------
 * 目标：用户改配置永远「只加一层」，我们升级只动下层 —— 两边不会互相覆盖。
 *
 *   builtin  = config/kernel.schema.json 里的 default（随程序升级）
 *   profile  = DATA_DIR/config/profile.json（用户选的组合包 / 设备级覆盖）
 *   user     = DATA_DIR/config/user.json   （用户自己的覆盖，优先级最高）
 *
 * 三条规则（与 DSH 的 patch 层同构）：
 *   1. 后一层只写「要改的键」，不用复制整份配置；
 *   2. 值写 null = 明确恢复内置默认（而不是删不掉）；
 *   3. 出现「当前版本已不存在的键」= 告警并忽略 + 在 /api/kernel 的 upgrade 里列出。
 *      —— 这是升级不崩的关键：我们删键也不会让旧配置把新版本搞死。
 *
 * 额外提供面向用户的检查：
 *   - provenance：每个值最终来自哪一层（builtin/profile/user）；
 *   - upgradeDiff：与上次快照比，内置配置键 / 插件 id 增减了什么；
 *   - orphanUserKeys：用户配置里写了、但当前版本已没有的键。
 */
const fs = require('node:fs');
const path = require('node:path');

const LAYERS = ['builtin', 'profile', 'user'];
const SNAPSHOT_REL = path.join('kernel', 'builtin-snapshot.json');

function isPlainObject(v) { return !!v && typeof v === 'object' && !Array.isArray(v); }
function clone(v) { return JSON.parse(JSON.stringify(v)); }
function typeOf(v) {
  if (Array.isArray(v)) return 'array';
  if (v === null) return 'null';
  return typeof v;
}
function typeOk(spec, v) {
  const want = spec && spec.type;
  if (!want) return true;
  const got = typeOf(v);
  if (want === 'number') return got === 'number' && Number.isFinite(v);
  if (want === 'array') return got === 'array';
  return got === want;
}
/** 'ui.pagePlugins' -> ['ui','pagePlugins'] */
function splitPath(p) { return String(p).split('.').filter(Boolean); }
function setPath(obj, p, v) {
  const parts = splitPath(p);
  let cur = obj;
  for (let i = 0; i < parts.length - 1; i++) {
    if (!isPlainObject(cur[parts[i]])) cur[parts[i]] = {};
    cur = cur[parts[i]];
  }
  cur[parts[parts.length - 1]] = v;
}
function getPath(obj, p) {
  let cur = obj;
  for (const part of splitPath(p)) {
    if (!isPlainObject(cur) || !(part in cur)) return undefined;
    cur = cur[part];
  }
  return cur;
}
/** 把嵌套配置摊平成 path -> value（同时支持用户直接写 "ui.pagePlugins": false） */
function flattenLayer(obj, out, prefix) {
  out = out || {};
  if (!isPlainObject(obj)) return out;
  for (const k of Object.keys(obj)) {
    if (k === '$schema' || k === '__comment' || k.startsWith('//')) continue;
    const v = obj[k];
    const key = prefix ? prefix + '.' + k : k;
    if (isPlainObject(v)) flattenLayer(v, out, key);
    else out[key] = v;
  }
  return out;
}

function createKernelConfig(opts) {
  opts = opts || {};
  if (!opts.schemaPath) throw new Error('createKernelConfig 需要 schemaPath');
  const dataDir = path.resolve(opts.dataDir || '.');
  const configDir = path.join(dataDir, 'config');
  const profileFile = path.join(configDir, 'profile.json');
  const userFile = path.join(configDir, 'user.json');
  const snapshotFile = path.join(dataDir, SNAPSHOT_REL);
  const log = typeof opts.log === 'function' ? opts.log : function () {};

  let schema = { schemaVersion: 1, sections: {} };
  let schemaIndex = {};      /* flat path -> spec（含 section/key 元数据） */
  let flat = {};             /* 生效值 */
  let tree = {};             /* 嵌套形态（前端/调试更顺手） */
  let provenance = {};       /* flat path -> layer */
  let warnings = [];
  let layerFlat = { builtin: {}, profile: {}, user: {} };
  let upgrade = { firstRun: true, addedKeys: [], removedKeys: [], addedPlugins: [], removedPlugins: [], orphanUserKeys: [] };

  function loadSchema() {
    const raw = fs.readFileSync(opts.schemaPath, 'utf8');
    const s = JSON.parse(raw);
    if (!isPlainObject(s) || !isPlainObject(s.sections)) throw new Error('schema 格式不对：缺 sections');
    schema = s;
    schemaIndex = {};
    for (const section of Object.keys(s.sections)) {
      const sec = s.sections[section] || {};
      for (const key of Object.keys(sec.keys || {})) {
        const spec = Object.assign({ section: section, key: key }, sec.keys[key] || {});
        schemaIndex[section + '.' + key] = spec;
      }
    }
  }

  function readLayer(name, file) {
    try {
      if (!fs.existsSync(file)) return {};
      const obj = JSON.parse(fs.readFileSync(file, 'utf8'));
      if (!isPlainObject(obj)) {
        warnings.push({ level: 'error', layer: name, file: file, message: '配置文件必须是 JSON 对象，已忽略' });
        return {};
      }
      return flattenLayer(obj);
    } catch (e) {
      warnings.push({ level: 'error', layer: name, file: file, message: '配置文件解析失败，已忽略：' + (e && e.message) });
      return {};
    }
  }

  function validateFlat(name, rawFlat) {
    const out = {};
    for (const key of Object.keys(rawFlat)) {
      const v = rawFlat[key];
      const spec = schemaIndex[key];
      if (!spec) {
        warnings.push({
          level: 'warn', layer: name, key: key,
          message: '配置项在当前版本已不存在（可能被新版本移除），已忽略 —— 请在升级说明里核对'
        });
        continue;
      }
      if (v === null) { out[key] = { reset: true }; continue; }
      if (!typeOk(spec, v)) {
        warnings.push({ level: 'warn', layer: name, key: key, message: '类型不对（期望 ' + spec.type + '，实际 ' + typeOf(v) + '），已忽略' });
        continue;
      }
      if (Array.isArray(spec.enum) && !spec.enum.includes(v)) {
        warnings.push({ level: 'warn', layer: name, key: key, message: '值不在允许范围（' + spec.enum.join(' / ') + '），已忽略' });
        continue;
      }
      out[key] = { reset: false, value: v };
    }
    return out;
  }

  function resolve() {
    warnings = [];
    /* builtin 层：schema 默认值 */
    const builtinFlat = {};
    for (const key of Object.keys(schemaIndex)) builtinFlat[key] = clone(schemaIndex[key].default);
    flat = clone(builtinFlat);
    provenance = {};
    for (const key of Object.keys(builtinFlat)) provenance[key] = 'builtin';

    layerFlat = { builtin: builtinFlat, profile: {}, user: {} };
    const rawLayers = { profile: readLayer('profile', profileFile), user: readLayer('user', userFile) };
    for (const name of ['profile', 'user']) {
      const valid = validateFlat(name, rawLayers[name]);
      layerFlat[name] = {};
      for (const key of Object.keys(valid)) {
        const entry = valid[key];
        if (entry.reset) {
          flat[key] = clone(schemaIndex[key].default);
          provenance[key] = 'builtin';
          layerFlat[name][key] = null;
        } else {
          flat[key] = clone(entry.value);
          provenance[key] = name;
          layerFlat[name][key] = clone(entry.value);
        }
      }
    }
    tree = {};
    for (const key of Object.keys(flat)) setPath(tree, key, flat[key]);

    /* 用户配置里写了、但 schema 已没有的键（= 升级会“孤儿化”的键） */
    const orphan = [];
    for (const name of ['profile', 'user']) {
      for (const key of Object.keys(rawLayers[name])) if (!schemaIndex[key]) orphan.push({ layer: name, key: key });
    }
    upgrade.orphanUserKeys = orphan;
  }

  function load() {
    loadSchema();
    resolve();
    /* strictConfig：只影响「启动时是否把告警当错误」，不影响已生效的值 */
    const strict = !opts.ignoreStrict && flat['kernel.strictConfig'] === true;
    const hard = warnings.filter(function (w) { return w.level === 'error'; });
    if (strict && hard.length) throw new Error('配置校验失败（kernel.strictConfig=true）：' + hard.map(function (w) { return w.message; }).join('；'));
    return state();
  }

  function get(key, fallback) {
    const v = flat[key];
    return v === undefined ? fallback : v;
  }
  function section(name) {
    const out = {};
    for (const key of Object.keys(flat)) {
      if (key.indexOf(name + '.') === 0) out[key.slice(name.length + 1)] = flat[key];
    }
    return out;
  }
  function explain(key) {
    const spec = schemaIndex[key];
    if (!spec) return null;
    const layers = [{ layer: 'builtin', value: clone(spec.default) }];
    for (const name of ['profile', 'user']) {
      if (Object.prototype.hasOwnProperty.call(layerFlat[name], key)) layers.push({ layer: name, value: clone(layerFlat[name][key]) });
    }
    return { key: key, value: clone(flat[key]), from: provenance[key] || 'builtin', title: spec.description || '', layers: layers };
  }

  /**
   * 升级差异：与上次启动保存的快照比较「内置配置键」和「服务端插件 id」。
   * 只在内存里算；writeSnapshot() 才落盘（避免测试/只读场景写文件）。
   */
  function checkUpgrade(currentPlugins) {
    /* 注意：下面会整体替换 upgrade 对象，先把"用户配置里已失效的键"捞出来 */
    const orphans = (upgrade && upgrade.orphanUserKeys) || [];
    let prev = null;
    try { prev = JSON.parse(fs.readFileSync(snapshotFile, 'utf8')); } catch (e) { prev = null; }
    const curKeys = Object.keys(schemaIndex).sort();
    const curPlugins = (Array.isArray(currentPlugins) ? currentPlugins : []).map(String).sort();
    const prevKeys = (prev && Array.isArray(prev.keys)) ? prev.keys.slice().sort() : null;
    const prevPlugins = (prev && Array.isArray(prev.plugins)) ? prev.plugins.slice().sort() : null;
    upgrade = {
      firstRun: !prev,
      at: prev && prev.at ? prev.at : '',
      addedKeys: prevKeys ? curKeys.filter(function (k) { return prevKeys.indexOf(k) < 0; }) : [],
      removedKeys: prevKeys ? prevKeys.filter(function (k) { return curKeys.indexOf(k) < 0; }) : [],
      addedPlugins: prevPlugins ? curPlugins.filter(function (p) { return prevPlugins.indexOf(p) < 0; }) : [],
      removedPlugins: prevPlugins ? prevPlugins.filter(function (p) { return curPlugins.indexOf(p) < 0; }) : [],
      orphanUserKeys: orphans
    };
    /* 升级后配置里还写着被删掉的键 → 明确告警（用户能看懂的那句话） */
    for (const o of upgrade.orphanUserKeys) {
      if (!warnings.some(function (w) { return w.key === o.key && w.layer === o.layer; })) {
        warnings.push({ level: 'warn', layer: o.layer, key: o.key, message: '配置项在本次升级中已被移除，当前不生效' });
      }
    }
    return { keys: curKeys, plugins: curPlugins, upgrade: upgrade };
  }

  /** 落盘升级快照（在 checkUpgrade 之后调用；失败只记日志，不影响启动） */
  function writeSnapshot(currentPlugins) {
    try {
      fs.mkdirSync(path.dirname(snapshotFile), { recursive: true });
      const data = {
        schemaVersion: schema.schemaVersion || 1,
        at: new Date().toISOString(),
        keys: Object.keys(schemaIndex).sort(),
        plugins: (Array.isArray(currentPlugins) ? currentPlugins : []).map(String).sort()
      };
      fs.writeFileSync(snapshotFile, JSON.stringify(data, null, 2), 'utf8');
      return true;
    } catch (e) {
      log('[config] 写升级快照失败：' + (e && e.message));
      return false;
    }
  }

  function state() {
    return {
      schemaVersion: schema.schemaVersion || 1,
      schemaFile: opts.schemaPath,
      files: { profile: profileFile, user: userFile, snapshot: snapshotFile },
      values: clone(flat),
      tree: clone(tree),
      provenance: clone(provenance),
      warnings: clone(warnings),
      upgrade: clone(upgrade)
    };
  }

  load();

  return {
    state: state, load: load, get: get, section: section, explain: explain,
    checkUpgrade: checkUpgrade, writeSnapshot: writeSnapshot,
    values: function () { return clone(flat); },
    tree: function () { return clone(tree); },
    warnings: function () { return clone(warnings); },
    upgrade: function () { return clone(upgrade); },
    schema: function () { return clone(schema); },
    paths: { dataDir: dataDir, configDir: configDir, profile: profileFile, user: userFile, snapshot: snapshotFile }
  };
}

module.exports = { createKernelConfig, LAYERS, SNAPSHOT_REL };
