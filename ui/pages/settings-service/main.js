import { createApp } from 'vue';
import App from './App.vue';

/** 设置 → 服务与启动（地址/桌面图标/终端命令/开机自启）。 */
export function mountSettingsServicePage(root, opts) {
  if (!root) throw new Error('缺少挂载节点');
  root.innerHTML = '';
  const app = createApp(App, { host: opts || {} });
  app.mount(root);
  return function unmount() { try { app.unmount(); } catch (e) {} try { root.innerHTML = ''; } catch (e) {} };
}
