import { createApp } from 'vue';
import App from './App.vue';

/** 由 legacy 提示词库组件动态加载：挂载弹窗。 */
export function mountAiPromptsPanel(root, opts) {
  if (!root) throw new Error('缺少挂载节点');
  root.innerHTML = '';
  const app = createApp(App, { host: opts || {} });
  app.mount(root);
  return function unmount() { try { app.unmount(); } catch (e) {} try { root.innerHTML = ''; } catch (e) {} };
}
