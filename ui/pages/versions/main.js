import { createApp } from 'vue';
import App from './App.vue';

/** 由 app.js 动态加载：目标版本管理页。 */
export function mountVersionsPage(root, opts) {
  if (!root) throw new Error('缺少挂载节点');
  root.innerHTML = '';
  const app = createApp(App, { host: opts || {}, goalId: Number(opts && opts.goalId) || 0, goalTitle: String(opts && opts.goalTitle || '') });
  app.mount(root);
  return function unmount() { try { app.unmount(); } catch (e) {} try { root.innerHTML = ''; } catch (e) {} };
}
