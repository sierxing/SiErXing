import { createApp } from 'vue';
import App from './App.vue';

/** 由 legacy 随堂测验插件动态加载。 */
export function mountQuizPage(root, opts) {
  if (!root) throw new Error('缺少挂载节点');
  root.innerHTML = '';
  const app = createApp(App, { host: opts || {}, tid: Number(opts && opts.tid) || 0 });
  app.mount(root);
  return function unmount() {
    try { app.unmount(); } catch (e) {}
    try { root.innerHTML = ''; } catch (e) {}
  };
}
