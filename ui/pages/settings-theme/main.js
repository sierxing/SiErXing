import { createApp } from 'vue';
import App from './App.vue';

/** 设置页的「外观主题」子路由。 */
export function mountSettingsThemePage(root, opts) {
  if (!root) throw new Error('缺少挂载节点');
  root.innerHTML = '';
  const app = createApp(App, { host: opts || {} });
  app.mount(root);
  return function unmount() { try { app.unmount(); } catch (e) {} try { root.innerHTML = ''; } catch (e) {} };
}
