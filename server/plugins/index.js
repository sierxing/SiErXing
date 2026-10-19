'use strict';
/**
 * 思而行 · 插件加载器（P1：已切到内核）
 * ---------------------------------------------------------------------------
 * 对外契约没变（server.js 只依赖 loadPlugins / pluginMeta / matchRoute），
 * 内部从「for 循环 require + init」换成了内核装载：
 *
 *   - 插件文件仍放在 server/plugins/，导出对象契约完全不变（id/name/init/api/…）；
 *   - 新增可选字段（不写照样跑）：
 *       requires: ['db','ai']   声明依赖（服务名 / 别的插件 id / 别的插件 provides 的能力）
 *       provides: ['mycap']     声明自己提供的能力
 *       apiVersion              内核主版本不一致 → 不执行，标记 incompatible
 *       migrations: [{version, up(ctx)}] 版本升序、幂等，由内核统一执行
 *       builtin: true           标记内置插件（升级差异检测用）
 *   - 缺依赖的插件会被跳过并在日志 / /api/kernel 里给出原因，不会拖垮整站；
 *   - 每次 reload 先 dispose 旧内核（清理 effect、事件监听），避免重复注册；
 *   - 状态快照走 kernelState()，自检页与测试都读它。
 *
 * 老插件不需要改一行：init(ctx) 照旧收到原来那份宿主 ctx（额外多 kernel / services / pluginId）。
 */
const fs = require('node:fs');
const path = require('node:path');
const { createKernel } = require('../kernel.js');
const { provideContext, KERNEL_API } = require('../kernel-services.js');

/** 每个目录一个内核实例（目前只有 server/plugins 一个目录；保留 map 便于测试多实例） */
const kernels = new Map();

function _files(dir) {
  try {
    return fs.readdirSync(dir).filter(function (f) { return f.endsWith('.js') && f !== 'index.js'; }).sort();
  } catch (e) { return []; }
}

function _log(ctx) {
  return function () {
    const args = Array.prototype.slice.call(arguments);
    if (ctx && typeof ctx.log === 'function') { try { ctx.log.apply(null, args); return; } catch (e) {} }
    console.log.apply(console, args);
  };
}

/**
 * 装载目录下全部插件。
 * @param {string} dir  插件目录
 * @param {object} ctx  宿主能力（原 pluginCtx()）
 * @param {object} [opts] { log, apiVersion, configFor(id) }
 * @returns {Array} 已成功装载的插件对象（原样返回，排序与老实现一致）
 */
function loadPlugins(dir, ctx, opts) {
  opts = opts || {};
  disposePlugins(dir);
  const log = opts.log || _log(ctx);
  const kernel = createKernel({ log: log, apiVersion: opts.apiVersion || KERNEL_API });
  provideContext(kernel, ctx);
  kernels.set(dir, kernel);

  const entries = [];
  for (const f of _files(dir)) {
    try {
      const mod = require(path.join(dir, f));
      if (!mod || !mod.id) { log('[plugin] 跳过（缺少 id）:', f); continue; }
      entries.push({ file: f, mod: mod });
    } catch (e) {
      log('[plugin] 加载失败:', f, '—', e.message);
    }
  }

  const defs = entries.map(function (e) {
    const mod = e.mod;
    return {
      id: String(mod.id),
      name: mod.name,
      version: mod.version || mod.componentVersion || '0.0.0',
      apiVersion: mod.apiVersion || mod.kernelApiVersion || '',
      requires: mod.requires || [],
      provides: mod.provides || [],
      builtin: mod.builtin !== false,
      order: mod.order,
      migrations: Array.isArray(mod.migrations) ? mod.migrations : null,
      apply: function (kctx) {
        const legacy = Object.assign({}, ctx, {
          kernel: kctx.kernel,
          services: kctx,
          pluginId: mod.id,
          config: kctx.config
        });
        if (typeof mod.init === 'function') mod.init(legacy);
      }
    };
  });

  const snap = kernel.loadPlugins(defs, opts.configFor);
  const statusById = {};
  for (const p of snap.plugins) statusById[p.id] = p;
  const loaded = [];
  for (const e of entries) {
    const st = statusById[e.mod.id];
    if (!st || st.status !== 'loaded') {
      log('[plugin] 跳过:', e.mod.id, '—', (st && st.reason) || '未装载');
      continue;
    }
    loaded.push(e.mod);
  }
  loaded.sort(function (a, b) {
    return (Number(a.order) || 100) - (Number(b.order) || 100) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
  });
  for (const mod of loaded) log('[plugin] 已加载:', mod.id, '—', mod.name || '');
  kernel.emit('plugins-ready', { count: loaded.length });
  return loaded;
}

/** 卸载某目录的内核（reload / 测试收尾用） */
function disposePlugins(dir) {
  const k = kernels.get(dir);
  if (!k) return false;
  try { k.dispose(); } catch (e) {}
  kernels.delete(dir);
  return true;
}

function getKernel(dir) { return kernels.get(dir) || null; }

/** 自检快照：服务 + 插件状态 + 为什么跳过 */
function kernelState(dir) {
  const k = kernels.get(dir);
  if (!k) return { ok: false, apiVersion: KERNEL_API, services: [], plugins: [] };
  return Object.assign({ ok: true }, k.state());
}

function pluginMeta(p) {
  return {
    id: p.id,
    name: p.name || p.id,
    icon: p.icon || '✨',
    desc: p.desc || '',
    category: p.category || (p.kind === 'theme' ? '外观主题' : '其它'),
    order: p.order || 100,
    goalToggle: p.goalToggle !== false,
    defaultEnabled: !!p.defaultEnabled,
    client: p.client || '',
    builtin: p.builtin !== false,
    provides: p.provides || [],
    requires: p.requires || [],
    goalConfig: typeof p.goalConfig === 'function' ? p.goalConfig : null
  };
}

/** 在插件路由中查找匹配项 */
function matchRoute(plugins, method, pathname) {
  for (const p of plugins) {
    for (const r of (p.api || [])) {
      if (String(r.method).toUpperCase() !== method) continue;
      if (r.path != null && r.path === pathname) return { plugin: p, route: r };
      if (r.pattern && r.pattern.test(pathname)) return { plugin: p, route: r };
    }
  }
  return null;
}

module.exports = {
  loadPlugins: loadPlugins,
  pluginMeta: pluginMeta,
  matchRoute: matchRoute,
  disposePlugins: disposePlugins,
  getKernel: getKernel,
  kernelState: kernelState
};
