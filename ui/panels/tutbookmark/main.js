import { createApp } from 'vue';
import App from './App.vue';

/** 由 legacy 教程书签组件动态加载：挂载浮动面板。 */
export function mountTutBookmarkPanel(root, opts) {
  if (!root) throw new Error('缺少挂载节点');
  root.innerHTML = '';
  const app = createApp(App, { host: opts || {} });
  app.mount(root);
  return function unmount() { try { app.unmount(); } catch (e) {} try { root.innerHTML = ''; } catch (e) {} };
}
