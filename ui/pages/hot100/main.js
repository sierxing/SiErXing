import { createApp } from 'vue';
import App from './App.vue';
import ProblemApp from './ProblemApp.vue';

/** 由 legacy 每日刷题插件动态加载：每日页（列表/进度/勾选/复习排期）。 */
export function mountHot100Page(root, opts) {
  if (!root) throw new Error('缺少挂载节点');
  root.innerHTML = '';
  const app = createApp(App, { host: opts || {}, goalId: Number(opts && opts.goalId) || 0 });
  app.mount(root);
  return function unmount() { try { app.unmount(); } catch (e) {} try { root.innerHTML = ''; } catch (e) {} }
}
/** 由 legacy 每日刷题插件动态加载：题目详情页（题面/作答记录/完成/复习流）。 */
export function mountProblemPage(root, opts) {
  if (!root) throw new Error('缺少挂载节点');
  root.innerHTML = '';
  const app = createApp(ProblemApp, { host: opts || {}, problemId: Number(opts && opts.problemId) || 0, goalId: Number(opts && opts.goalId) || 0 });
  app.mount(root);
  return function unmount() { try { app.unmount(); } catch (e) {} try { root.innerHTML = ''; } catch (e) {} }
}
