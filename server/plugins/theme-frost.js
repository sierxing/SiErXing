/**
 * 思而行 · 主题组件：霜白（theme-frost）
 * ------------------------------------------------------------------
 * 亮色现有四款的底色都带黄绿或米调（纸、暖、豆沙绿）。这一版底色走冷白，
   文字用近黑而非棕黑，对比拉到最高，适合白天强光下或需要长时间读字时。
 *
 * 主题组件只需提供样式（public/plugins/<id>.css）覆盖设计变量即可换肤。
 * 本文件仅用于声明元数据（服务端插件约定的最小结构）。
 */
'use strict';
module.exports = {
  id: 'theme-frost',
  name: '霜白',
  category: '主题与样式',
  icon: '🧊',
  kind: 'theme',
  mode: 'light',
  scope: 'theme',
  desc: '冷白 + 靛蓝：去掉米色与暖调的高清亮色，白天最清楚的一款',
  order: 208,
  version: '1.0.0',
  author: '思而行内置',
  goalToggle: false,
  defaultEnabled: false,
  client: '',
  api: []
};
