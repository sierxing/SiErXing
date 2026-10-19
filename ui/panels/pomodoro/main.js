import { createApp } from 'vue';
import App from './App.vue';

/** 番茄钟浮窗（可见 UI 由 Vue 接管；计时/通知状态机仍在 pomodoro.js）。 */
export function mountPomodoroPanel(root, opts) {
  if (!root) throw new Error('缺少挂载节点');
  root.innerHTML = '';
  const app = createApp(App, { host: opts || {} });
  app.mount(root);
  return function unmount() { try { app.unmount(); } catch (e) {} try { root.innerHTML = ''; } catch (e) {} }
}
