import { createApp } from 'vue';
import App from './App.vue';

/** 由 legacy 插件动态加载：把学习统计页挂到宿主提供的根节点。 */
export function mountStudystatsPage(root, host) {
  if (!root) throw new Error('缺少挂载节点');
  root.innerHTML = '';
  const app = createApp(App, { host: host || {} });
  app.mount(root);
  return function unmount() {
    try { app.unmount(); } catch (e) {}
    try { root.innerHTML = ''; } catch (e) {}
  };
}
