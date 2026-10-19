'use strict';
/**
 * 思而行 · 微型内核（P0）
 * ---------------------------------------------------------------------------
 * 目标：让「UI / 功能 / 内核能力」都变成可替换的组件，而不是长死在 server.js 里。
 * 这里只做最小的一组原语，保持零第三方依赖：
 *
 *   provide(name, impl)   声明一个能力（服务）
 *   get / has / require   取用能力
 *   inject(deps, fn)      依赖齐了才执行（立即执行版；缺依赖抛错）
 *   effect(fn)            注册副作用，fn 返回清理函数；卸载/重载时按逆序清理
 *   plugin(def)           装载一个插件（def.apply / def.init 二选一）
 *   loadPlugins(defs)     批量装载，按 requires/provides 做依赖优先排序
 *   reload / unload       重载 / 单独卸载（清理干净，避免重复监听、定时器泄漏）
 *   on / emit             内核事件（service / plugin / config 变化，供自检页与测试用）
 *   migrations(list)      插件自带的表结构迁移（{version, up(ctx)}，幂等）
 *   state()               自检快照：有哪些服务、插件什么状态、为什么被跳过
 *
 * 设计取舍（对齐 DSH 的 cordis 思路，但不引外部框架）：
 *  - 不做响应式代理对象（cordis 的 ctx 代理很优雅，但会拖慢老代码，且插件 99% 只需要一次性取服务）；
 *  - 依赖在装载时解析，缺依赖 = 跳过该插件并给出原因，绝不阻塞其它插件、绝不崩服务；
 *  - 生命周期只有一种：effect(fn) 返回 cleanup。重载 = 逆序清理 + 重新装载；
 *  - 兼容层：老式插件只需实现 init(ctx)，内核会把同一份宿主能力注入进去（不用改一个字符）。
 *
 * 约定：
 *  - 插件 id：/^[a-z0-9][a-z0-9._-]{0,63}$/，与目录名/前端插件 id 保持一致；
 *  - apiVersion 缺省视为兼容；写了就必须主版本一致，否则标记 incompatible 且不执行；
 *  - 插件可以声明 requires（服务名或别的插件 provides 的名字）、provides（能力名）、
 *    version、builtin、order、migrations、configSchema。
 */
const fs = require('node:fs');
const path = require('node:path');

const KERNEL_API = 'sierxing.kernel/1';
const ID_RE = /^[a-z0-9][a-z0-9._-]{0,63}$/;

/** 从 'sierxing.kernel/1' 这种字符串里取主版本号；取不到返回 null */
function apiMajor(v) {
  const m = String(v == null ? '' : v).match(/(\d+)\s*$/);
  return m ? Number(m[1]) : null;
}

function normalizeList(v) {
  if (v == null) return [];
  if (Array.isArray(v)) return v.map(function (x) { return String(x).trim(); }).filter(Boolean);
  return [String(v).trim()].filter(Boolean);
}

function createKernel(opts) {
  opts = opts || {};
  if (typeof opts === 'string') opts = { apiVersion: opts };   /* 兼容 createKernel('sierxing.kernel/1') */
  const log = typeof opts.log === 'function' ? opts.log : function () {};
  const kernelApi = opts.apiVersion || KERNEL_API;
  const allowIncompatible = !!opts.allowIncompatible;

  const services = new Map();        /* name -> { impl, meta } */
  const plugins = new Map();         /* id -> record */
  const provided = new Map();        /* 能力名 -> 提供它的插件 id */
  const effects = [];                /* { owner, fn } 逆序执行 */
  const listeners = new Map();       /* event -> Set<{fn, owner}> */
  let disposed = false;
  let loadOrder = 0;

  function assertLive() { if (disposed) throw new Error('内核已卸载（disposed）'); }

  /* ---------------- 服务 ---------------- */
  function provide(name, impl, meta) {
    assertLive();
    const n = String(name || '').trim();
    if (!n) throw new Error('服务名必须是非空字符串');
    if (services.has(n)) throw new Error('服务重复注册：' + n);
    services.set(n, { impl: impl, meta: meta || {} });
    emit('service', { action: 'provide', name: n });
    return function () {
      const cur = services.get(n);
      if (cur && cur.impl === impl) { services.delete(n); emit('service', { action: 'remove', name: n }); }
    };
  }
  function has(name) { return services.has(String(name)); }
  function get(name) { const s = services.get(String(name)); return s ? s.impl : undefined; }
  function requireService(name) {
    const s = services.get(String(name));
    if (!s) throw new Error('缺少服务：' + name);
    return s.impl;
  }
  function serviceNames() { return Array.from(services.keys()); }

  /* ---------------- 事件 ---------------- */
  function on(event, fn, owner) {
    assertLive();
    const e = String(event);
    if (!listeners.has(e)) listeners.set(e, new Set());
    const rec = { fn: fn, owner: owner || '' };
    listeners.get(e).add(rec);
    return function () { const set = listeners.get(e); if (set) set.delete(rec); };
  }
  function emit(event, payload) {
    const set = listeners.get(String(event));
    if (!set || !set.size) return;
    for (const rec of Array.from(set)) {
      try { rec.fn(payload || {}); } catch (e) { log('[kernel] 事件处理失败 ' + event + '：' + (e && e.message)); }
    }
  }

  /* ---------------- 生命周期 ---------------- */
  function effect(fn, owner) {
    assertLive();
    if (typeof fn !== 'function') throw new Error('effect 需要函数');
    const cleanup = fn();
    if (typeof cleanup === 'function') effects.push({ owner: owner || '', fn: cleanup });
    return cleanup;
  }
  function runEffects(owner) {
    const keep = [];
    for (let i = effects.length - 1; i >= 0; i--) {
      const rec = effects[i];
      if (owner && rec.owner !== owner) { keep.unshift(rec); continue; }
      try { rec.fn(); } catch (e) { log('[kernel] 清理失败 ' + rec.owner + '：' + (e && e.message)); }
    }
    effects.length = 0;
    for (const rec of keep) effects.push(rec);
  }

  /* ---------------- 插件 ---------------- */
  function normalizeDef(raw) {
    if (!raw || typeof raw !== 'object') return null;
    const id = String(raw.id || '').trim();
    if (!ID_RE.test(id)) { log('[kernel] 跳过插件（id 非法）：' + id); return null; }
    const apply = typeof raw.apply === 'function' ? raw.apply
      : (typeof raw.init === 'function' ? raw.init : null);
    if (!apply) { log('[kernel] 跳过插件（缺 apply/init）：' + id); return null; }
    return {
      def: raw,
      id: id,
      name: String(raw.name || id),
      version: String(raw.version || '0.0.0'),
      apiVersion: raw.apiVersion ? String(raw.apiVersion) : '',
      requires: normalizeList(raw.requires),
      provides: normalizeList(raw.provides),
      order: Number.isFinite(Number(raw.order)) ? Number(raw.order) : 100,
      builtin: !!raw.builtin,
      apply: apply,
      migrations: Array.isArray(raw.migrations) ? raw.migrations : [],
      configSchema: raw.configSchema || null
    };
  }

  /** requires 里可以写「服务名」「别的插件 provides 的能力名」，也可以直接写「别的插件 id」（= 先装载它）。 */
  function depReady(name) {
    if (services.has(name) || provided.has(name)) return true;
    const pl = plugins.get(name);
    return !!(pl && pl.status === 'loaded');
  }
  function canLoad(p) {
    for (const r of p.requires) {
      if (depReady(r)) continue;
      return { ok: false, missing: r };
    }
    return { ok: true };
  }

  function loadOne(rawDef, config) {
    assertLive();
    const p = normalizeDef(rawDef);
    if (!p) return null;
    if (plugins.has(p.id)) return plugins.get(p.id);
    const majorWanted = apiMajor(p.apiVersion);
    const majorHave = apiMajor(kernelApi);
    if (p.apiVersion && majorWanted != null && majorWanted !== majorHave && !allowIncompatible) {
      const rec = writeRecord(p, 'incompatible', 'apiVersion 不兼容：插件 ' + p.apiVersion + '，内核 ' + kernelApi);
      return rec;
    }
    const gate = canLoad(p);
    if (!gate.ok) return writeRecord(p, 'skipped', '缺少依赖：' + gate.missing);

    const ctx = makeCtx(p, config);
    try {
      p.apply(ctx, config);
      /* 插件声明的迁移在内核里统一执行：版本升序、幂等、有 db 才有意义（没 db 就跳过）。 */
      if (p.migrations.length && services.has('db')) runMigrations(p.id, p.migrations);
    } catch (e) {
      runEffects(p.id);
      return writeRecord(p, 'failed', '装载失败：' + (e && e.message ? e.message : e));
    }
    const rec = writeRecord(p, 'loaded', '');
    for (const name of p.provides) {
      if (provided.has(name) && provided.get(name) !== p.id) {
        log('[kernel] 能力重复提供：' + name + '（' + provided.get(name) + ' / ' + p.id + '）');
        continue;
      }
      provided.set(name, p.id);
    }
    log('[kernel] 插件已装载：' + p.id + ' v' + p.version);
    emit('plugin', { action: 'load', id: p.id });
    return rec;
  }

  function makeCtx(p, config) {
    /* 服务用「原型 getter」暴露：ctx.db / ctx.ai 直接可用；保留字段（log/get/require…）
       放自有属性，同名服务（如 log）不会覆盖插件上下文本身，需要时用 ctx.get('log') 取。 */
    const dynamic = {};
    for (const name of services.keys()) {
      if (name in { id: 1, name: 1, version: 1, config: 1, log: 1, kernel: 1, provide: 1, get: 1, has: 1, require: 1, on: 1, effect: 1, emit: 1, migrations: 1 }) continue;
      Object.defineProperty(dynamic, name, {
        enumerable: true, configurable: true,
        get: function () { return services.get(name).impl; }
      });
    }
    return Object.assign(Object.create(dynamic), {
      id: p.id,
      name: p.name,
      version: p.version,
      config: config || {},
      log: function () { log.apply(null, ['[' + p.id + ']'].concat(Array.from(arguments))); },
      kernel: api,
      provide: function (name, impl, meta) { return provide(name, impl, Object.assign({ plugin: p.id }, meta || {})); },
      get: get,
      has: has,
      require: requireService,
      on: function (event, fn) { return on(event, fn, p.id); },
      effect: function (fn) { return effect(fn, p.id); },
      emit: emit,
      migrations: function (list) { return runMigrations(p.id, list); }
    });
  }

  function writeRecord(p, status, reason) {
    const rec = {
      id: p.id, name: p.name, version: p.version, apiVersion: p.apiVersion,
      requires: p.requires.slice(), provides: p.provides.slice(),
      builtin: p.builtin, order: p.order, seq: ++loadOrder,
      status: status, reason: reason || '', def: p.def
    };
    plugins.set(p.id, rec);
    if (status !== 'loaded') log('[kernel] 插件状态 ' + status + '：' + p.id + (reason ? ' — ' + reason : ''));
    return rec;
  }

  function loadPlugins(defs, configFor) {
    assertLive();
    const list = (Array.isArray(defs) ? defs : []).map(normalizeDef).filter(Boolean);
    list.sort(function (a, b) { return (a.order - b.order) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0); });
    const pending = list.slice();
    const getCfg = typeof configFor === 'function' ? configFor : function (p) { return {}; };
    let guard = 0;
    while (pending.length && guard++ < 200) {
      let progressed = false;
      for (let i = 0; i < pending.length; i++) {
        const p = pending[i];
        if (!canLoad(p).ok) continue;
        pending.splice(i, 1); i--;
        progressed = true;
        loadOne(p.def, getCfg(p));
      }
      if (!progressed) break;
    }
    for (const p of pending) loadOne(p.def, getCfg(p));   /* 剩下的会以 skipped 记录原因 */
    return state();
  }

  function unload(id) {
    const sid = String(id);
    const rec = plugins.get(sid);
    if (!rec) return false;
    runEffects(sid);
    for (const [name, owner] of Array.from(provided.entries())) if (owner === sid) provided.delete(name);
    plugins.delete(sid);
    emit('plugin', { action: 'unload', id: sid });
    return true;
  }

  function dispose() {
    if (disposed) return;
    const ids = Array.from(plugins.keys()).reverse();
    for (const id of ids) runEffects(id);
    runEffects('');
    plugins.clear();
    provided.clear();
    services.clear();
    listeners.clear();
    disposed = true;
    emit('dispose', {});
  }

  function reload(defs, configFor) {
    const list = Array.isArray(defs) ? defs : Array.from(plugins.values()).map(function (r) { return r.def; });
    runEffects('');
    for (const id of Array.from(plugins.keys())) unload(id);
    loadPlugins(list, configFor);
    emit('reload', { count: plugins.size });
    return state();
  }

  function state() {
    return {
      apiVersion: kernelApi,
      disposed: disposed,
      services: Array.from(services.entries()).map(function (e) {
        return { name: e[0], plugin: (e[1].meta && e[1].meta.plugin) || '', title: (e[1].meta && e[1].meta.title) || '' };
      }),
      plugins: Array.from(plugins.values()).map(function (r) {
        return {
          id: r.id, name: r.name, version: r.version, apiVersion: r.apiVersion,
          requires: r.requires, provides: r.provides, builtin: r.builtin,
          status: r.status, reason: r.reason
        };
      })
    };
  }

  /* ---------------- 迁移 ---------------- */
  function runMigrations(pluginId, migrations) {
    const db = get('db');
    if (!db || typeof db.exec !== 'function' || typeof db.prepare !== 'function') throw new Error('迁移需要 db 服务（sqlite 兼容）');
    const list = (Array.isArray(migrations) ? migrations : []).slice().sort(function (a, b) { return Number(a.version) - Number(b.version); });
    db.exec('CREATE TABLE IF NOT EXISTS kernel_migrations (plugin_id TEXT NOT NULL, version INTEGER NOT NULL, applied_at TEXT NOT NULL, PRIMARY KEY (plugin_id, version))');
    let done = [];
    try { done = db.prepare('SELECT version FROM kernel_migrations WHERE plugin_id = ?').all(String(pluginId)).map(function (r) { return Number(r.version); }); } catch (e) { done = []; }
    const applied = [];
    for (const m of list) {
      const v = Number(m.version);
      if (!Number.isFinite(v)) throw new Error('迁移版本号非法：' + m.version);
      if (done.includes(v)) continue;
      const run = function () {
        if (typeof m.up === 'function') m.up({ db: db, pluginId: pluginId, version: v, log: log });
        db.prepare('INSERT INTO kernel_migrations (plugin_id, version, applied_at) VALUES (?,?,?)').run(String(pluginId), v, new Date().toISOString());
      };
      if (typeof db.transaction === 'function') db.transaction(run)(); else run();
      applied.push(v);
      log('[kernel] 迁移已应用：' + pluginId + ' v' + v);
    }
    return applied;
  }

  /* ---------------- 配置：服务/插件清单落盘（供自检与升级差异） ---------------- */
  function writeStateFile(file) {
    const data = state();
    try {
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, JSON.stringify({ at: new Date().toISOString(), apiVersion: data.apiVersion, plugins: data.plugins, services: data.services }, null, 2), 'utf8');
      return true;
    } catch (e) { log('[kernel] 写状态文件失败：' + e.message); return false; }
  }
  function readStateFile(file) {
    try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch (e) { return null; }
  }

  const api = {
    apiVersion: kernelApi,
    provide: provide, has: has, get: get, require: requireService, services: serviceNames,
    on: on, emit: emit,
    effect: effect,
    plugin: loadOne, loadPlugins: loadPlugins, unload: unload, reload: reload, dispose: dispose,
    state: state,
    migrations: runMigrations,
    writeStateFile: writeStateFile, readStateFile: readStateFile,
    get disposed() { return disposed; }
  };
  return api;
}

module.exports = { createKernel: createKernel, KERNEL_API: KERNEL_API, ID_RE: ID_RE, apiMajor: apiMajor };
