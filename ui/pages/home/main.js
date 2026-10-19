import { createApp } from 'vue';
import App from './App.vue';

/** 由 app.js 动态加载：主页（我的目标 / 新建 / 导入分享）。 */
export function mountHomePage(root, opts) {
  if (!root) throw new Error('缺少挂载节点');
  root.innerHTML = '';
  const app = createApp(App, { host: opts || {} });
  app.mount(root);
  return function unmount() { try { app.unmount(); } catch (e) {} try { root.innerHTML = ''; } catch (e) {} }
}
