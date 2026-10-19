import { createApp } from 'vue';
import App from './App.vue';

/** 设置 → 多端同步（状态/设置/保存测试/上传拉取/冲突）。 */
export function mountSettingsSyncPage(root, opts) {
  if (!root) throw new Error('缺少挂载节点');
  root.innerHTML = '';
  const app = createApp(App, { host: opts || {} });
  app.mount(root);
  return function unmount() { try { app.unmount(); } catch (e) {} try { root.innerHTML = ''; } catch (e) {} };
}
