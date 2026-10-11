/**
 * 思而行 · 主题组件：砚墨（theme-inkwell）
 * ------------------------------------------------------------------
 * 夜间长时间使用时，纯冷黑容易显得冷硬。这一版把底色改成带一点暖调的墨色，
   点缀色用柿橙而非亮青，整体像在灯下看宣纸，久看不冷。
 *
 * 主题组件只需提供样式（public/plugins/<id>.css）覆盖设计变量即可换肤。
 * 本文件仅用于声明元数据（服务端插件约定的最小结构）。
 */
'use strict';
module.exports = {
  id: 'theme-inkwell',
  name: '砚墨',
  category: '主题与样式',
  icon: '🌒',
  kind: 'theme',
  mode: 'dark',
  scope: 'theme',
  desc: '暖黑墨色 + 柿橙点缀：夜里不冷冰冰的暗色，长读不累，适合深夜赶工',
  order: 206,
  version: '1.0.0',
  author: '思而行内置',
  goalToggle: false,
  defaultEnabled: false,
  client: '',
  api: []
};
