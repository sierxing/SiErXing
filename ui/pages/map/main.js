import { createApp } from 'vue';
import App from './App.vue';

/** 路线图页（#/g/:id/map，大纲视图 + 节点详情；写操作暂留旧版）。 */
export function mountMapPage(root, opts) {
  if (!root) throw new Error('缺少挂载节点');
  root.innerHTML = '';
  const app = createApp(App, { host: opts || {} });
  app.mount(root);
  return function unmount() { try { app.unmount(); } catch (e) {} try { root.innerHTML = ''; } catch (e) {} };
}
