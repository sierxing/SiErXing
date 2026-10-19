import { createApp } from 'vue';
import App from './App.vue';

/** 由 app.js 动态加载：路线版本对比图。 */
export function mountDiffPage(root, opts) {
  if (!root) throw new Error('缺少挂载节点');
  root.innerHTML = '';
  const app = createApp(App, { host: opts || {}, goalId: Number(opts && opts.goalId) || 0, versionId: Number(opts && opts.versionId) || 0 });
  app.mount(root);
  return function unmount() { try { app.unmount(); } catch (e) {} try { root.innerHTML = ''; } catch (e) {} };
}
