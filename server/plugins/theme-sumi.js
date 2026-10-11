/**
 * 思而行 · 主题组件：素墨（theme-sumi）
 * ------------------------------------------------------------------
 * 介于霜白(冷)与纸(暖)之间：底色做成不带倾向的中性灰白，点缀用偏暗的群青，
   整体克制、不抢注意力，适合只想安安静静看字的人。
 *
 * 主题组件只需提供样式（public/plugins/<id>.css）覆盖设计变量即可换肤。
 * 本文件仅用于声明元数据（服务端插件约定的最小结构）。
 */
'use strict';
module.exports = {
  id: 'theme-sumi',
  name: '素墨',
  category: '主题与样式',
  icon: '🖋',
  kind: 'theme',
  mode: 'light',
  scope: 'theme',
  desc: '中性纸灰 + 群青：不带冷暖倾向的克制亮色，字最清楚',
  order: 209,
  version: '1.0.0',
  author: '思而行内置',
  goalToggle: false,
  defaultEnabled: false,
  client: '',
  api: []
};
