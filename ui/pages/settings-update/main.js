import { createApp } from 'vue';
import App from './App.vue';

/** 设置 → 版本与更新（状态/检查/立即更新）。 */
export function mountSettingsUpdatePage(root, opts) {
  if (!root) throw new Error('缺少挂载节点');
  root.innerHTML = '';
  const app = createApp(App, { host: opts || {} });
  app.mount(root);
  return function unmount() { try { app.unmount(); } catch (e) {} try { root.innerHTML = ''; } catch (e) {} };
}
