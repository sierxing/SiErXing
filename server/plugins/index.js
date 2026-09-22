'use strict';
/**
 * 思而行 · 插件加载器
 * ------------------------------------------------------------------
 * 插件放在 server/plugins/ 目录下，每个 .js 文件导出一个插件对象：
 *
 *   module.exports = {
 *     id: 'myplugin',            // 唯一标识（用于目标级开关、目录名）
 *     name: '我的功能',           // 显示名
 *     icon: '✨',                // 图标（emoji 或单字）
 *     desc: '一句话说明',         // 说明（新建目标时的提示）
 *     order: 50,                 // 排序（左侧栏顺序）
 *     goalToggle: true,          // 是否可在「新建目标」里勾选
 *     defaultEnabled: false,     // 新建目标时默认是否勾选
 *     client: '/plugins/x.js',   // 前端脚本路径（可选，提供才显示界面入口）
 *
 *     init(ctx) {},              // 启动时调用一次：建表、初始化（可选）
 *     onGoalDelete(goalId, ctx) {}, // 目标被删除时清理该目标的数据（可选）
 *     exportData(ctx) {},        // 导出全部数据时附带（可选）
 *     importData(data, ctx) {},  // 导入数据时恢复（可选）
 *
 *     // 路由：pattern 为正则（匹配 pathname）或 path 为精确路径
 *     api: [
 *       { method: 'GET', path: '/api/foo', handler: async (req, res, u, ctx) => {...} },
 *       { method: 'POST', pattern: /^\/api\/bar\/(\d+)$/, handler: async (req, res, u, ctx) => {...} }
 *     ]
 *   };
 *
 * ctx（宿主能力）：
 *   db / nowISO / safeParse / sendJSON / readBody / getSetting / setSetting / backup / log
 *   fs / path / os / spawn / APP_DIR / DATA_DIR / UPLOAD_DIR / PUBLIC_DIR
 *   getGoal / sourcesOf / aiText / aiTextFiles / currentModel / currentVisionModel
 */

const fs = require('node:fs');
const path = require('node:path');

function loadPlugins(dir, ctx) {
  const plugins = [];
  let files = [];
  try { files = fs.readdirSync(dir).filter(f => f.endsWith('.js') && f !== 'index.js').sort(); } catch (e) { return plugins; }
  for (const f of files) {
    try {
      const mod = require(path.join(dir, f));
      if (!mod || !mod.id) { ctx.log('[plugin] 跳过（缺少 id）:', f); continue; }
      if (typeof mod.init === 'function') mod.init(ctx);
      plugins.push(mod);
      ctx.log('[plugin] 已加载:', mod.id, '—', mod.name || '');
    } catch (e) {
      ctx.log('[plugin] 加载失败:', f, '—', e.message);
    }
  }
  plugins.sort((a, b) => (a.order || 100) - (b.order || 100));
  return plugins;
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

module.exports = { loadPlugins, pluginMeta, matchRoute };
