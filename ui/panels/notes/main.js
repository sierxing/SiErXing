import { createApp } from 'vue';
import App from './App.vue';

/** 教程页右侧笔记栏（Markdown 页签 Vue；划线页签委托 TutNotes.renderInto）。 */
export function mountNotesPanel(root, opts) {
  if (!root) throw new Error('缺少挂载节点');
  root.innerHTML = '';
  const app = createApp(App, { host: opts || {}, tutorialId: Number(opts && opts.tutorialId) || 0, nodeId: Number(opts && opts.nodeId) || 0, nodeTitle: String(opts && opts.nodeTitle || '') });
  app.mount(root);
  return function unmount() { try { app.unmount(); } catch (e) {} try { root.innerHTML = ''; } catch (e) {} }
}
