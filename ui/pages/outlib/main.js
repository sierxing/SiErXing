import { createApp } from 'vue';
import App from './App.vue';

/** 由 legacy 产出库插件动态加载：只读版挂载器。 */
export function mountOutlibPage(root, opts) {
  if (!root) throw new Error('缺少挂载节点');
  root.innerHTML = '';
  const app = createApp(App, { host: opts || {}, goalId: Number(opts && opts.goalId) || 0 });
  app.mount(root);
  return function unmount() {
    try { app.unmount(); } catch (e) {}
    try { root.innerHTML = ''; } catch (e) {}
  };
}
