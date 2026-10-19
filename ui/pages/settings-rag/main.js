import { createApp } from 'vue';
import App from './App.vue';

/** 设置 → 检索增强（RAG 开关/向量模型/索引/检索预览）。 */
export function mountSettingsRagPage(root, opts) {
  if (!root) throw new Error('缺少挂载节点');
  root.innerHTML = '';
  const app = createApp(App, { host: opts || {} });
  app.mount(root);
  return function unmount() { try { app.unmount(); } catch (e) {} try { root.innerHTML = ''; } catch (e) {} };
}
