import { createApp } from 'vue';
import App from './App.vue';

/** 设置 → 系统信息（数据存储路径状态/帮助/关于）。 */
export function mountSettingsSystemPage(root, opts) {
  if (!root) throw new Error('缺少挂载节点');
  root.innerHTML = '';
  const app = createApp(App, { host: opts || {} });
  app.mount(root);
  return function unmount() { try { app.unmount(); } catch (e) {} try { root.innerHTML = ''; } catch (e) {} };
}
