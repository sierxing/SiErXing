import { createApp } from 'vue';
import App from './App.vue';

/** 设置 → AI 连接（连接/模型编辑、取模型、测试）。 */
export function mountSettingsAiPage(root, opts) {
  if (!root) throw new Error('缺少挂载节点');
  root.innerHTML = '';
  const app = createApp(App, { host: opts || {} });
  app.mount(root);
  return function unmount() { try { app.unmount(); } catch (e) {} try { root.innerHTML = ''; } catch (e) {} };
}
