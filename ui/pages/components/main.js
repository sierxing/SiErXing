import { createApp } from 'vue';
import App from './App.vue';

/** 由 app.js 动态加载：组件管理页。 */
export function mountComponentsPage(root, opts) {
  if (!root) throw new Error('缺少挂载节点');
  root.innerHTML = '';
  const app = createApp(App, { host: opts || {} });
  app.mount(root);
  return function unmount() { try { app.unmount(); } catch (e) {} try { root.innerHTML = ''; } catch (e) {} }
}
