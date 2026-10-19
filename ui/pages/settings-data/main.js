import { createApp } from 'vue';
import App from './App.vue';

/** 设置 → 数据备份（列表/备份/对比/恢复/删除/保留份数/导入导出）。 */
export function mountSettingsDataPage(root, opts) {
  if (!root) throw new Error('缺少挂载节点');
  root.innerHTML = '';
  const app = createApp(App, { host: opts || {} });
  app.mount(root);
  return function unmount() { try { app.unmount(); } catch (e) {} try { root.innerHTML = ''; } catch (e) {} };
}
