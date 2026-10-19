import { createApp } from 'vue';
import App from './App.vue';

/** 由 app.js 动态加载：目标对话页（#/g/:id/chat）。 */
export function mountChatPage(root, opts) {
  if (!root) throw new Error('缺少挂载节点');
  root.innerHTML = '';
  const app = createApp(App, { host: opts || {}, gid: Number(opts && opts.gid) || 0 });
  app.mount(root);
  return function unmount() { try { app.unmount(); } catch (e) {} try { root.innerHTML = ''; } catch (e) {} };
}
