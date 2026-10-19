# home（用户页面插件示例 · 整页接管首页）

最小可用的「整页改 UI」示例：不构建、不依赖第三方包，只用一个 ESM 文件。

## 安装

先在界面里找到数据目录（「设置 → 数据存储路径」），然后：

    mkdir -p "<数据目录>/ui-plugins"
    cp -r examples/ui-plugins/home "<数据目录>/ui-plugins/"

刷新 http://localhost:3213/ 应该直接看到「我的主页」（顶部会写「用户插件 · home」）。
更省事的方式：左栏「🧱 界面管理」→「打开插件目录」，把 home 目录丢进去即可。

## 验证它真的接管了

- 页面右边内容区出现「用户插件 · home」；
- 控制台里 window.__sxPluginSource.home 的值是 user:esm-vue；
- 打开「界面管理」页会看到 home 显示「用户覆盖」。

## 恢复内置首页

三种方式任选：

1. 「界面管理」页里点 home 的「停用」（不删文件，随时再启用）；
2. 删掉 <数据目录>/ui-plugins/home 目录；
3. 临时看内置版：http://localhost:3213/?ui=legacy#/

## 契约要点

- 默认导出 Vue 组件，Vue 从 window.SiErXingUI.vue 取（不要 import 'vue'）；
- manifest.json 里 format: esm、standalone: true（standalone = 完全接管内容区，不再叠加内置页面样式）；
- 只能用宿主提供的 api/go/goal 等能力，不要直接摸 app.js 内部变量；
- 渲染异常时宿主会 console.warn 并静默回退内置页面，不会白屏。

完整契约见 docs/ui-plugin/kernel-contract.md。
