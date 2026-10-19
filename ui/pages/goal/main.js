import { createApp } from 'vue';
import App from './App.vue';

/** 目标概览页（#/g/:id，只读；写操作进旧版执行页）。 */
export function mountGoalPage(root, opts) {
  if (!root) throw new Error('缺少挂载节点');
  root.innerHTML = '';
  const app = createApp(App, { host: opts || {} });
  app.mount(root);
  return function unmount() { try { app.unmount(); } catch (e) {} try { root.innerHTML = ''; } catch (e) {} };
}
