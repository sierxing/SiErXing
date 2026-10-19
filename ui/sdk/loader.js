'use strict';
/* UI 插件解析：
   1. 先问服务端要用户插件（DATA_DIR/ui-plugins/<id>）的 manifest；
   2. 没有 / 版本不兼容 / 加载失败 → 回退内置组件；
   3. 用户插件用运行时 ESM 加载，宿主通过 window.SiErXingUI 提供 Vue。
   服务端只暴露 manifest 与入口文件，不暴露数据目录路径。 */
import { UI_HOST_API } from './host.js';

export async function resolveUiPlugin(opts) {
  const id = opts.id;
  const builtin = opts.builtin;
  if (opts.forceBuiltin) return { component: builtin, source: 'builtin', reason: '已强制使用内置（?builtin=1）' };
  const apiBase = '/api/ui/plugins/' + encodeURIComponent(id);
  const base = '/api/ui/plugins/' + encodeURIComponent(id) + '/';
  try {
    const mf = await fetch(apiBase + '/manifest', { cache: 'no-store' });
    if (!mf.ok) return { component: builtin, source: 'builtin', reason: '没有用户插件，使用内置' };
    const manifest = await mf.json();
    if (!manifest || manifest.id !== id) throw new Error('manifest id 不匹配');
    if (manifest.apiVersion && manifest.apiVersion !== UI_HOST_API) {
      throw new Error('apiVersion 不兼容：' + manifest.apiVersion + '（宿主 ' + UI_HOST_API + '）');
    }
    const entry = String(manifest.entry || 'index.js').replace(/^\.?\//, '');
    const mod = await import(base + 'entry?v=' + Date.now());
    if (!mod || !mod.default) throw new Error('插件没有导出默认组件');
    return { component: mod.default, source: 'user', manifest: manifest, reason: '' };
  } catch (e) {
    return { component: builtin, source: 'builtin', reason: '用户插件不可用，已回退：' + (e && e.message ? e.message : e) };
  }
}