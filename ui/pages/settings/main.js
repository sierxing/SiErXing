import { createApp } from 'vue';
import App from './App.vue';

/** 设置概览页（只读；编辑仍可进旧版设置）。 */
export function mountSettingsPage(root, opts) {
  if (!root) throw new Error('缺少挂载节点');
  root.innerHTML = '';
  const app = createApp(App, { host: opts || {} });
  app.mount(root);
  return function unmount() { try { app.unmount(); } catch (e) {} try { root.innerHTML = ''; } catch (e) {} };
}
