import { createApp } from 'vue';
import App from './App.vue';

/** 由 legacy 看懂代码插件动态加载：列表/准备页（第一段）。 */
export function mountExplainPage(root, opts) {
  if (!root) throw new Error('缺少挂载节点');
  root.innerHTML = '';
  const app = createApp(App, { host: opts || {}, tutorialId: Number(opts && opts.tutorialId) || 0, goalId: Number(opts && opts.goalId) || 0 });
  app.mount(root);
  return function unmount() { try { app.unmount(); } catch (e) {} try { root.innerHTML = ''; } catch (e) {} };
}
