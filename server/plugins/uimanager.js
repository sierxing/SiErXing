'use strict';
/**
 * 思而行 · 界面管理（P2）
 * ------------------------------------------------------------------
 * 一个「能看见插件化本身」的页面：列出内置页面与用户覆盖、启停、回退、看内核状态。
 * 它本身也是组件（server/plugins + public/plugins）。
 *
 * ⚠️ 它是 scope:'core'（核心组件，不可关闭）：
 *    - 这是用户遇到「装了个坏插件 / 界面打不开」时唯一能回去停用、回退的入口，
 *      一旦被关掉就没有恢复路径了（用户 2026-10-19 明确要求归为核心组件）。
 *    - 左侧栏「界面管理」按钮是常驻硬编码入口，也不依赖组件开关。
 */
module.exports = {
  id: 'uimanager',
  name: '界面管理',
  icon: '🧱',
  desc: '统一管理系统界面：查看哪些页面可被替换、启用/停用用户页面插件与皮肤、回退内置界面、看内核自检（核心组件，不可关闭）',
  scope: 'core',
  category: '核心组件',
  order: 96,
  goalToggle: false,
  defaultEnabled: true,
  builtin: true,
  client: '/plugins/uimanager.js',
  init(ctx) {},
  api: []
};
