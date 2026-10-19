'use strict';
/* 浏览器侧宿主入口（Vite 产物：/ui-dist/uihost.js）
   ------------------------------------------------------------------
   app.js 只有在「用户真的装了一个 Vue 页面插件」时才按需 import 这个文件，
   所以内置页面零开销、老浏览器不会因为多加载一个 Vue chunk 而变慢。

   对外：
     mountVuePage(component, root, ctx) -> { unmount, app }
     installHost(extra) / vue / UI_HOST_API / HOST_VERSION / nextTick
*/
import { createApp, nextTick } from 'vue';
import { installHost, vue, UI_HOST_API, HOST_VERSION } from './host.js';

export { installHost, vue, UI_HOST_API, HOST_VERSION, createApp, nextTick };

/**
 * 把一个 Vue 组件挂到宿主的 #app 上。
 * @param {object|Function} component 用户插件的默认导出（Vue 组件）
 * @param {Element} root 挂载点（宿主传 #app）
 * @param {object} ctx  { page, manifest, host, api, toast, esc, go, state }
 */
export function mountVuePage(component, root, ctx) {
  if (!component || (typeof component !== 'object' && typeof component !== 'function')) {
    throw new Error('mountVuePage：组件为空');
  }
  if (!root) throw new Error('mountVuePage：挂载点不存在');
  const info = ctx || {};
  installHost({ host: info.host || {}, page: info.page || '', manifest: info.manifest || null });
  /* 清掉宿主上一页的静态内容；Vue 自己负责画内容区 */
  root.innerHTML = '';
  root.setAttribute('data-ui-user-plugin', info.page || '');
  const app = createApp(component, {
    host: info.host || {},
    ctx: info,
    page: info.page || ''
  });
  app.config.errorHandler = function (err, instance, trace) {
    try { console.error('[SiErXingUI] 用户插件渲染出错：', err, trace); } catch (e) {}
    /* 不 toast 刷屏：错误已经 console 出来；页面渲染失败会由宿主回退内置界面 */
  };
  app.mount(root);
  let dead = false;
  return {
    app: app,
    unmount: function () {
      if (dead) return;
      dead = true;
      try { app.unmount(); } catch (e) {}
      try { root.innerHTML = ''; } catch (e) {}
      try { root.removeAttribute('data-ui-user-plugin'); } catch (e) {}
      try { delete window.SiErXingUI; } catch (e) {}
    }
  };
}

/** 给「导出 mount(root, ctx) 自己接管 DOM」的插件用：统一包成同样的 unmount 形状 */
export function wrapFunctionMount(fn, root, ctx) {
  return function () {
    const ret = fn(root, ctx);
    return typeof ret === 'function' ? ret : (ret && typeof ret.unmount === 'function' ? ret.unmount : null);
  };
}
