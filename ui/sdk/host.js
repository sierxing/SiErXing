'use strict';
/* UI 宿主的全局能力入口（用户插件唯一应该依赖的桥）。
   ------------------------------------------------------------------
   为什么要有它：用户想自己写一套界面，但又不该直接摸 app.js 内部变量（我们每次
   升级都可能改）。所以这里只暴露「稳定契约」：
     - window.SiErXingUI.api     契约版本（sierxing.ui/1）
     - window.SiErXingUI.vue     Vue 构造器（h/ref/createApp/nextTick…）
     - window.SiErXingUI.toast   宿主的轻提示
     - window.SiErXingUI.host    当前页面的宿主能力（api / go / state / esc …）
   用户插件可以用「ESM + Vue 组件」写（推荐），也可以导出 mount(root, ctx) 自己接管 DOM。
   ⚠️ 不要从 'vue' 裸导入：用户的插件没有构建步骤，拿不到 node_modules；一律走 SiErXingUI.vue。
*/
import {
  createApp, h, ref, reactive, computed, watch,
  onMounted, onUnmounted, onBeforeUnmount, nextTick,
  defineComponent, shallowRef, toRef, toRefs, provide, inject
} from 'vue';

export const UI_HOST_API = 'sierxing.ui/1';
export const HOST_VERSION = '0.2.0';

/** 暴露给插件的 Vue 构造器集合（与宿主同一个 Vue 实例，不会出现双实例/响应式不通） */
export const vue = {
  version: '3',
  createApp, h, ref, reactive, computed, watch,
  onMounted, onUnmounted, onBeforeUnmount, nextTick,
  defineComponent, shallowRef, toRef, toRefs, provide, inject
};

function hostToast(msg) {
  try {
    if (typeof window.toast === 'function') return window.toast(msg);
  } catch (e) {}
  try { console.log('[SiErXingUI]', msg); } catch (e) {}
}

/**
 * 安装/刷新全局宿主桥。
 * @param {object} [extra] 额外挂到 window.SiErXingUI 上的能力（宿主每次挂载页面都可以传新的）
 */
export function installHost(extra) {
  const prev = (typeof window !== 'undefined' && window.SiErXingUI) || {};
  const next = Object.assign({}, prev, {
    api: UI_HOST_API,
    version: HOST_VERSION,
    vue: vue,
    toast: hostToast
  }, extra || {});
  if (typeof window !== 'undefined') window.SiErXingUI = next;
  return next;
}
