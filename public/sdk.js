'use strict';
/**
 * 思而行 · 前端插件 SDK
 * ------------------------------------------------------------------
 * 前端插件是一个普通 JS 文件（放在 public/plugins/ 下），加载后调用：
 *
 *   SiErXing.registerPlugin({
 *     id: 'myplugin',                      // 与服务端插件 id 一致
 *     // 目标级入口：左侧栏 + 目标页按钮（可选）
 *     goalEntry: {
 *       label: '我的功能', icon: '✨', order: 50,
 *       hash: goalId => '#/g/' + goalId + '/myplugin',
 *       show: goal => SiErXing.pluginEnabled(goal, 'myplugin')
 *     },
 *     // 页面路由（可选）
 *     routes: [
 *       { match: h => h.match(/^#\/g\/(\d+)\/myplugin$/),
 *         render: async (m, host) => { host.app.innerHTML = '...'; } }
 *     ],
 *     // 目标被删除前的清理（可选，一般不需要）
 *     onGoalDelete: goalId => {}
 *   });
 *
 * 宿主能力（SiErXing.xxx）：
 *   app        —— 主内容容器（DOM）
 *   api(path, opts) —— 请求后端并解析 JSON（失败抛错）
 *   esc(s)     —— HTML 转义
 *   toast(msg) —— 右下角提示
 *   go(hash)   —— 切换路由
 *   state      —— 全局状态（含 state.goal / state.sources）
 *   mdToHTML(md) —— Markdown 渲染
 *   fmtDate(s) —— 时间格式化
 *   safeParse(s, dflt) —— 安全 JSON 解析
 *   parseRoute() —— 解析当前 hash
 *   rerender()  —— 重新渲染当前页
 *   serverPlugins() —— 服务端插件元数据（含 goalConfig 等）
 */
window.SiErXing = (function () {
  const plugins = [];
  let host = null;

  const api = {
    version: 1,
    registerPlugin(p) {
      if (!p || !p.id) return console.warn('[plugin] 缺少 id，已忽略');
      if (plugins.some(x => x.id === p.id)) return;
      plugins.push(p);
      plugins.sort((a, b) => ((a.goalEntry && a.goalEntry.order) || 100) - ((b.goalEntry && b.goalEntry.order) || 100));
      if (host && host.ready) {
        try { host.mount(); } catch (e) { console.warn('[plugin] mount 失败', e); }
      }
    },
    getPlugins() { return plugins.slice(); },
    findPlugin(id) { return plugins.find(p => p.id === id) || null; },

    /* 目标是否启用了某插件 */
    pluginEnabled(goal, id) {
      let obj = {};
      try { obj = JSON.parse((goal && goal.plugins) || '{}') || {}; } catch (e) { obj = {}; }
      if (obj[id] != null) return !!obj[id];
      const meta = (api.serverPlugins() || []).find(p => p.id === id);
      return !!(meta && meta.defaultEnabled);
    },
    /* 当前目标可见的插件入口 */
    goalEntries(goal) {
      return plugins
        .filter(p => p.goalEntry && (!p.goalEntry.show || p.goalEntry.show(goal)))
        .map(p => {
          // 自动补齐服务端元数据（分类、图标、名称）：插件里没写也能正确分组
          const meta = (serverPlugins || []).find(x => x.id === p.id) || {};
          const base = { id: p.id, icon: meta.icon || '🧩', label: meta.name || p.id, category: meta.category || '其它' };
          return Object.assign(base, p.goalEntry);
        });
    },
    /* 匹配插件页面路由 */
    matchRoute(hash) {
      for (const p of plugins) {
        for (const r of (p.routes || [])) {
          const m = r.match(hash);
          if (m) return { plugin: p, route: r, match: m };
        }
      }
      return null;
    },
    /* 服务端插件元数据（app.js 启动时注入） */
    setServerPlugins(list) { serverPlugins = list || []; },
    serverPlugins() { return serverPlugins; },

    /* 宿主注入 */
    provide(h) { host = h; },
    host() { return host; }
  };

  let serverPlugins = [];

  /* 把宿主能力平铺到 SiErXing 上，插件里可直接解构使用 */
  /* mdPickOffset：把「鼠标点到的那块 → 它在 Markdown 源码里的字符偏移」交给组件用
     （笔记栏的"点哪改哪"就靠它）。和 app.js 里画悬停描边用的是同一套判断，
     组件不必自己再猜一遍文本位置。 */
  const HOST_KEYS = ['app', 'api', 'esc', 'toast', 'go', 'state', 'mdToHTML', 'fmtDate', 'safeParse', 'parseRoute', 'rerender', 'loadGoal', 'ensureGoal', 'aiToggle', 'mdPickOffset',
    /* 「就地编辑单块」共用能力（教程正文 / 笔记栏）：范围切片 + 编辑框生命周期 + 快捷键 */
    'mdPickTarget', 'mdSrcRange', 'mdInlineEdit', 'editKeysBind'];
  function bridge() {
    if (!host) return;
    for (const k of HOST_KEYS) {
      if (host[k] !== undefined) api[k] = host[k];
    }
    api.ready = true;
  }
  const origProvide = api.provide;
  api.provide = function (h) { origProvide(h); bridge(); if (h && h.ready) { try { h.mount(); } catch (e) {} } };

  return api;
})();
