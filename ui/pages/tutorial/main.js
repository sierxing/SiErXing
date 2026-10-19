import { createApp } from 'vue';
import App from './App.vue';

/** 教程阅读页（#/t/:id）：正文/目录/笔记/书签/内部化入口；编辑类操作暂留旧版。 */
export function mountTutorialPage(root, opts) {
  if (!root) throw new Error('缺少挂载节点');
  root.innerHTML = '';
  const app = createApp(App, { host: opts || {} });
  app.mount(root);
  return function unmount() { try { app.unmount(); } catch (e) {} try { root.innerHTML = ''; } catch (e) {} };
}
