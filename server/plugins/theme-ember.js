/**
 * 思而行 · 主题组件：炽焰（theme-ember）
 * ------------------------------------------------------------------
 * 六款已有暗色/亮色主题的点缀色都偏灰偏稳。这一版反过来做：底色压到极深，
   只让点缀色亮起来 —— 需要集中注意力、或者想一眼看出当前选中项时用它。
 *
 * 主题组件只需提供样式（public/plugins/<id>.css）覆盖设计变量即可换肤。
 * 本文件仅用于声明元数据（服务端插件约定的最小结构）。
 */
'use strict';
module.exports = {
  id: 'theme-ember',
  name: '炽焰',
  category: '主题与样式',
  icon: '🔥',
  kind: 'theme',
  mode: 'dark',
  scope: 'theme',
  desc: '深黑 + 烈焰橙红：高饱和点缀的暗色，注意力要聚焦时用它',
  order: 207,
  version: '1.0.0',
  author: '思而行内置',
  goalToggle: false,
  defaultEnabled: false,
  client: '',
  api: []
};
