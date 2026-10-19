import { createApp } from 'vue';
import App from './App.vue';

/** 由 legacy ragbench 插件动态加载：把检索增强评测页挂到宿主提供的根节点。 */
export function mountRagbenchPage(root, opts) {
  if (!root) throw new Error('缺少挂载节点');
  root.innerHTML = '';
  const app = createApp(App, { host: opts || {}, goalId: Number(opts && opts.goalId) || 0 });
  app.mount(root);
  return function unmount() {
    try { app.unmount(); } catch (e) {}
    try { root.innerHTML = ''; } catch (e) {}
  };
}
