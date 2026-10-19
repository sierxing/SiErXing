'use strict';
/**
 * 思而行 · UI 插件注册表（P2：内置 + 用户 + 启用状态）
 * ---------------------------------------------------------------------------
 * 只负责：扫描目录、校验路径、读 manifest/入口/皮肤、记录「用户插件启停」。
 * 不做安装/构建/审批（安装走 component pipeline；这里只管已放在目录里的东西）。
 *
 * 目录约定：
 *   - 内置页面插件：APP_DIR/ui/plugins/builtin/<id>/manifest.json + entry（随程序升级）
 *   - 用户页面插件：DATA_DIR/ui-plugins/<id>/manifest.json + entry（升级永不覆盖）
 *   - 启用状态：DATA_DIR/ui-plugins/.state.json（{ "<id>": { "enabled": false } }）
 *
 * 清单可选字段（不写也有默认值，老插件照样能用）：
 *   format: 'esm' | 'classic' | 'auto'   入口类型；默认 auto（先按 ESM 试，失败回退经典脚本）
 *   standalone: true                     用户完全接管内容区：宿主不再注入内置页面样式
 *   route: '#/xxx'                       自定义页面路由（DIY 管理页展示用；内置页有默认表）
 *   apiVersion / version / name / description / skin / skinPriority
 *
 * 安全边界（不变）：
 *   - id 只允许 [a-z0-9._-]，且必须等于目录名；
 *   - entry 必须是插件目录内的相对 .js/.mjs，拒绝 ..、绝对路径、符号链接逃逸；
 *   - manifest 有大小上限，坏 JSON 直接跳过，不影响其它插件。
 */
const fs = require('node:fs');
const path = require('node:path');

const UI_HOST_API = 'sierxing.ui/1';
const SKIN_MAX = 512 * 1024;   /* 用户皮肤 CSS 上限 */
const ID_RE = /^[a-z0-9][a-z0-9._-]{0,63}$/;
const MANIFEST_MAX = 64 * 1024;
const ENTRY_MAX = 5 * 1024 * 1024;
const STATE_FILE = '.state.json';

/* 内置页面的默认路由（管理页「打开页面」用；带 :id 的会在前端换成示例 id） */
const BUILTIN_ROUTES = {
  home: '#/', guide: '#/guide/1', settings: '#/settings', components: '#/components',
  library: '#/library', aitasks: '#/aitasks', versions: '#/g/:id/versions',
  diff: '#/g/:id/diff/:vid', roadmap: '#/g/:id/map', tutorial: '#/t/:id',
  goal: '#/g/:id', chat: '#/g/:id/chat'
};

function createUiPluginRegistry(opts) {
  const dir = path.resolve(opts.dir);
  const builtinDir = opts.builtinDir ? path.resolve(opts.builtinDir) : '';

  function ensureDir() {
    try { fs.mkdirSync(dir, { recursive: true }); } catch (e) {}
  }

  /* ---------------- 启用状态 ---------------- */
  function readState() {
    ensureDir();
    try {
      const raw = JSON.parse(fs.readFileSync(path.join(dir, STATE_FILE), 'utf8'));
      if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {};
      const out = {};
      for (const k of Object.keys(raw)) {
        if (!ID_RE.test(k) || !raw[k] || typeof raw[k] !== 'object') continue;
        out[k] = { enabled: raw[k].enabled !== false };
      }
      return out;
    } catch (e) { return {}; }
  }
  function writeState(obj) {
    ensureDir();
    const file = path.join(dir, STATE_FILE);
    const tmp = file + '.tmp-' + process.pid;
    fs.writeFileSync(tmp, JSON.stringify(obj, null, 2), 'utf8');
    fs.renameSync(tmp, file);
  }
  function isEnabled(id) {
    const st = readState();
    return !(st[id] && st[id].enabled === false);
  }
  /** 只允许对「用户插件」启停：内置插件要改就改代码/覆盖，不在这里关（否则页面会整块空掉） */
  function setEnabled(id, enabled) {
    const sid = String(id || '');
    if (!ID_RE.test(sid)) return null;
    if (!_scan(dir, 'user', []).some(function (m) { return m.id === sid; })) return null;
    const st = readState();
    if (enabled) delete st[sid];
    else st[sid] = { enabled: false };
    writeState(st);
    return { id: sid, enabled: !!enabled };
  }

  /* ---------------- 清单 ---------------- */
  function normalizeManifest(raw, folder, source) {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
    const id = String(raw.id || folder || '').trim();
    if (!ID_RE.test(id) || (folder && id !== folder)) return null;
    const entry = String(raw.entry || 'index.js').replace(/^\.?\//, '').trim();
    if (!entry || entry.startsWith('/') || entry.indexOf('..') >= 0) return null;
    if (!/\.(js|mjs|vue)$/i.test(entry)) return null;
    const apiVersion = String(raw.apiVersion || UI_HOST_API);
    const format = ['esm', 'classic', 'auto'].includes(String(raw.format || '')) ? String(raw.format) : 'auto';
    return {
      id: id,
      name: String(raw.name || id).slice(0, 80),
      apiVersion: apiVersion,
      version: String(raw.version || '0.0.0').slice(0, 40),
      description: String(raw.description || '').slice(0, 300),
      entry: entry,
      format: format,
      standalone: !!raw.standalone,
      route: String(raw.route || (source === 'builtin' ? (BUILTIN_ROUTES[id] || '') : '')).slice(0, 200),
      skin: String(raw.skin || 'skin.css').slice(0, 120),
      skinPriority: Number(raw.skinPriority) || 0,
      source: source,
      builtin: source === 'builtin',
      enabled: source === 'builtin' ? true : isEnabled(id)
    };
  }

  function _scan(root, source, out) {
    if (!root) return out;
    let ents;
    try { ents = fs.readdirSync(root, { withFileTypes: true }); } catch (e) { return out; }
    for (const e of ents) {
      if (!e.isDirectory() || !ID_RE.test(e.name)) continue;
      const mf = path.join(root, e.name, 'manifest.json');
      try {
        const st = fs.statSync(mf);
        if (!st.isFile() || st.size > MANIFEST_MAX) continue;
        const raw = JSON.parse(fs.readFileSync(mf, 'utf8'));
        const m = normalizeManifest(raw, e.name, source);
        if (m) out.push(m);
      } catch (err) { /* 跳过坏插件 */ }
    }
    return out;
  }
  function sortById(a, b) { return a.id < b.id ? -1 : a.id > b.id ? 1 : 0; }

  /** 只列用户插件（老接口语义，保持兼容） */
  function list() {
    return _scan(dir, 'user', []).sort(sortById);
  }
  /** 只列内置页面插件 */
  function listBuiltin() {
    return _scan(builtinDir, 'builtin', []).sort(sortById);
  }
  /** 内置 + 用户：同 id 时用户覆盖内置，并标记 overrides / overriddenBy */
  function listAll() {
    const byId = new Map();
    for (const m of listBuiltin()) byId.set(m.id, m);
    for (const m of list()) {
      const base = byId.get(m.id);
      if (base) { base.overriddenBy = 'user'; m.overrides = true; }
      byId.set(m.id, m);
    }
    return Array.from(byId.values()).sort(sortById);
  }
  function get(id) {
    const sid = String(id || '');
    if (!ID_RE.test(sid)) return null;
    return listAll().find(function (m) { return m.id === sid; }) || null;
  }

  /** 读取原始 manifest（管理页展示 format/standalone/skin 等编辑器字段用） */
  function manifestRaw(id) {
    const m = get(id);
    if (!m) return null;
    const root = m.source === 'builtin' ? builtinDir : dir;
    try {
      const raw = JSON.parse(fs.readFileSync(path.join(root, m.id, 'manifest.json'), 'utf8'));
      return Object.assign({}, raw, { id: m.id, source: m.source, enabled: m.enabled, route: m.route, builtin: m.builtin });
    } catch (e) { return m; }
  }

  /** 解析入口文件的绝对路径；所有逃逸路径返回 null。 */
  function entryPath(manifest) {
    if (!manifest) return null;
    const root = manifest.source === 'builtin' ? builtinDir : dir;
    if (!root) return null;
    const pluginDir = path.join(root, manifest.id);
    const full = path.resolve(pluginDir, manifest.entry);
    const rel = path.relative(pluginDir, full);
    if (!rel || rel.startsWith('..') || path.isAbsolute(rel)) return null;
    let real;
    try { real = fs.realpathSync(full); } catch (e) { return null; }
    let baseReal;
    try { baseReal = fs.realpathSync(pluginDir); } catch (e) { return null; }
    const rel2 = path.relative(baseReal, real);
    if (!rel2 || rel2.startsWith('..') || path.isAbsolute(rel2)) return null;
    try { if (!fs.statSync(real).isFile()) return null; } catch (e) { return null; }
    return real;
  }

  /** 读入口代码；返回 {contentType, body, format} 或 null。 */
  function readEntry(id) {
    const m = get(id);
    const file = entryPath(m);
    if (!file) return null;
    try {
      const st = fs.statSync(file);
      if (st.size > ENTRY_MAX) return null;
      return {
        contentType: /\.(mjs|vue)$/i.test(file) || m.format === 'esm' ? 'application/javascript; charset=utf-8' : 'application/javascript; charset=utf-8',
        format: m.format,
        body: fs.readFileSync(file)
      };
    } catch (e) { return null; }
  }

  /**
   * 读用户皮肤 CSS。
   * 约定：DATA_DIR/ui-plugins/<id>/skin.css，或 manifest 里写 "skin": "xxx.css"。
   * 多个插件都提供皮肤时按 skinPriority 从低到高叠加 —— 这就是「用户随意改 UI」的入口。
   */
  function listSkins() {
    const out = [];
    for (const m of list()) {
      const pluginDir = path.join(dir, m.id);
      try {
        const mf = JSON.parse(fs.readFileSync(path.join(pluginDir, 'manifest.json'), 'utf8'));
        const rel = String((mf && mf.skin) || 'skin.css').replace(/^\.?\//, '').trim();
        if (!rel || rel.startsWith('/') || rel.indexOf('..') >= 0 || !/\.css$/i.test(rel)) continue;
        const full = path.resolve(pluginDir, rel);
        const relCheck = path.relative(pluginDir, full);
        if (!relCheck || relCheck.startsWith('..') || path.isAbsolute(relCheck)) continue;
        let real;
        try { real = fs.realpathSync(full); } catch (e) { continue; }
        const baseReal = fs.realpathSync(pluginDir);
        const rel2 = path.relative(baseReal, real);
        if (!rel2 || rel2.startsWith('..') || path.isAbsolute(rel2)) continue;
        const st = fs.statSync(real);
        if (!st.isFile() || st.size > SKIN_MAX) continue;
        out.push({ id: m.id, name: m.name, priority: Number(mf.skinPriority) || 0, css: fs.readFileSync(real, 'utf8') });
      } catch (e) { continue; }
    }
    out.sort(function (a, b) { return a.priority - b.priority || (a.id < b.id ? -1 : 1); });
    return out;
  }

  return {
    dir: dir, builtinDir: builtinDir, apiVersion: UI_HOST_API,
    list: list, listBuiltin: listBuiltin, listAll: listAll, get: get, manifestRaw: manifestRaw,
    entryPath: entryPath, readEntry: readEntry, listSkins: listSkins,
    isEnabled: isEnabled, setEnabled: setEnabled, state: readState
  };
}

module.exports = {
  createUiPluginRegistry: createUiPluginRegistry,
  UI_HOST_API: UI_HOST_API,
  ID_RE: ID_RE,
  BUILTIN_ROUTES: BUILTIN_ROUTES
};
