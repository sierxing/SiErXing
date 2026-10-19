# demo-card（UI 插件示例）

一个最小的用户 UI 插件，用于验证：

- 用户插件覆盖同 id 的内置组件；
- 加载失败 / 渲染异常时回退内置；
- 宿主通过 `window.SiErXingUI` 提供 Vue 与 toast。

安装：

```bash
# 找到数据目录（默认程序目录下 data/；设置里可改）
mkdir -p "<DATA_DIR>/ui-plugins"
cp -r examples/ui-plugins/demo-card "<DATA_DIR>/ui-plugins/"
```

然后打开 `http://localhost:3213/uilab.html`，状态应显示「用户插件」。
删除 `<DATA_DIR>/ui-plugins/demo-card` 即恢复内置版本。

manifest：

```json
{
  "id": "demo-card",
  "apiVersion": "sierxing.ui/1",
  "entry": "index.js"
}
```
